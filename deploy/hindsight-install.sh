#!/usr/bin/env bash
#
# Put Hindsight (the memory engine behind MemoryService) on the better-bots box.
# Idempotent. Ubuntu 24.04. Run as root:
#
#   sudo bash /opt/better-bots/deploy/hindsight-install.sh
#
# Slim build: PostgreSQL 16 + pgvector from apt, embeddings in-process (ONNX,
# bge-small), reranking with flashrank (CPU), fact extraction on DeepSeek using
# the key already in /var/lib/better-bots/better-bots.env. Loopback only, API key required.
# Existing Hindsight env files retain their extraction provider. New installs may
# select HINDSIGHT_LLM_PROVIDER=zai and HINDSIGHT_LLM_MODEL explicitly.
# Never prints a secret.

set -euo pipefail

APP_DIR=/opt/hindsight
DATA_DIR=/var/lib/hindsight
ENV_FILE=$DATA_DIR/hindsight.env
SERVICE_USER=hindsight
BETTER_BOTS_ENV=/var/lib/better-bots/better-bots.env
PORT=8888

[ "$(id -u)" -eq 0 ] || { echo "run this with sudo" >&2; exit 1; }

echo "==> packages"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-16 postgresql-16-pgvector python3-venv python3-pip >/dev/null
# Watch the actual cluster, not only Debian's active/exited wrapper. Retry an
# unexpected database process failure; an intentional stop remains stopped.
install -d /etc/systemd/system/postgresql@16-main.service.d
cat > /etc/systemd/system/postgresql@16-main.service.d/better-bots-recovery.conf <<'PGEOF'
[Service]
Restart=on-failure
RestartSec=5
PGEOF
systemctl daemon-reload
systemctl enable --now postgresql postgresql@16-main.service >/dev/null
pg_isready -h 127.0.0.1 -p 5432 >/dev/null

echo "==> service user and dirs"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR" "$DATA_DIR/hf" "$DATA_DIR/flashrank"
install -d -m 0755 "$APP_DIR"

echo "==> database"
DB_PASS_FILE=$DATA_DIR/.dbpass
# openssl, not tr|head: under pipefail, head closing the pipe fails the line.
[ -f "$DB_PASS_FILE" ] || openssl rand -hex 20 > "$DB_PASS_FILE"
# The file belongs to the service user, and its contents go into superuser SQL
# below; anything but the 40 hex digits written here is replaced.
grep -qxE '[0-9a-f]{40}' "$DB_PASS_FILE" || openssl rand -hex 20 > "$DB_PASS_FILE"
chown "$SERVICE_USER":"$SERVICE_USER" "$DB_PASS_FILE"; chmod 600 "$DB_PASS_FILE"
DB_PASS=$(cat "$DB_PASS_FILE")
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hindsight') THEN
    CREATE ROLE hindsight LOGIN PASSWORD '$DB_PASS';
  ELSE
    ALTER ROLE hindsight PASSWORD '$DB_PASS';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE hindsight OWNER hindsight' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hindsight')\gexec
SQL
# Extensions need a superuser; the app role only needs to use them.
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d hindsight -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;'
echo "   postgres $(sudo -u postgres psql -tAc 'show server_version') with vector + pg_trgm"

echo "==> python environment"
[ -x "$APP_DIR/venv/bin/python" ] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q 'hindsight-api-slim[local-onnx]==0.9.2' 'flashrank==0.2.10'
echo "   $("$APP_DIR/venv/bin/pip" show hindsight-api-slim 2>/dev/null | grep -E '^(Name|Version)' | tr '\n' ' ')"

echo "==> $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  LLM_PROVIDER=${HINDSIGHT_LLM_PROVIDER:-deepseek}
  case "$LLM_PROVIDER" in
    deepseek)
      KEY_NAME=DEEPSEEK_API_KEY
      LLM_MODEL=${HINDSIGHT_LLM_MODEL:-deepseek-flash}
      LLM_BASE_URL=https://api.deepseek.com/v1
      LLM_EXTRA_BODY='{"thinking":{"type":"disabled"}}'
      ;;
    zai)
      KEY_NAME=GLM_API_KEY
      LLM_MODEL=${HINDSIGHT_LLM_MODEL:-glm-5.3-flash}
      LLM_BASE_URL=https://api.z.ai/api/coding/paas/v4
      LLM_EXTRA_BODY='{}'
      ;;
    *) echo "unsupported HINDSIGHT_LLM_PROVIDER: use deepseek or zai" >&2; exit 1 ;;
  esac
  LLM_KEY=$(sed -n "s/^${KEY_NAME}=//p" "$BETTER_BOTS_ENV" | tr -d '"'"'"' ')
  [ -n "$LLM_KEY" ] || { echo "no $KEY_NAME in $BETTER_BOTS_ENV" >&2; exit 1; }
  API_KEY=$(openssl rand -hex 24)
  cat > "$ENV_FILE" <<ENVEOF
# Hindsight memory engine. Read by systemd; never by git.
HINDSIGHT_API_HOST=127.0.0.1
HINDSIGHT_API_PORT=$PORT
HINDSIGHT_API_WORKER_ID=better-bots-vps
HINDSIGHT_API_MCP_ENABLED=false
# Consolidate nightly (deploy/consolidate.sh), not after every retain.
HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false
HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:$DB_PASS@127.0.0.1:5432/hindsight

# Only better-bots talks to it, and only with this key.
HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension
HINDSIGHT_API_TENANT_API_KEY=$API_KEY

# Extraction is separate from the Hindsight/PostgreSQL memory backend.
HINDSIGHT_API_LLM_PROVIDER=$LLM_PROVIDER
HINDSIGHT_API_LLM_API_KEY=$LLM_KEY
HINDSIGHT_API_LLM_MODEL=$LLM_MODEL
HINDSIGHT_API_LLM_BASE_URL=$LLM_BASE_URL
HINDSIGHT_API_LLM_EXTRA_BODY='$LLM_EXTRA_BODY'

# Embeddings in-process (no PyTorch), reranking on CPU.
HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx
HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID=BAAI/bge-small-en-v1.5
HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS=384
HINDSIGHT_API_EMBEDDINGS_ONNX_QUERY_PREFIX=
HINDSIGHT_API_EMBEDDINGS_ONNX_PASSAGE_PREFIX=
HINDSIGHT_API_RERANKER_PROVIDER=flashrank
HINDSIGHT_API_RERANKER_FLASHRANK_MODEL=ms-marco-MiniLM-L-12-v2
HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR=$DATA_DIR/flashrank
HF_HOME=$DATA_DIR/hf
HOME=$DATA_DIR
ENVEOF
  echo "   created"
else
  echo "   already exists, left alone"
fi
chown "$SERVICE_USER":"$SERVICE_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

# Existing env files predate this setting; add it rather than leave the churn on.
grep -q '^HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=' "$ENV_FILE" || echo 'HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false' >> "$ENV_FILE"

# Low-budget recalls must fit the host's four-second memory deadline on small
# servers. Higher budgets retain Hindsight's larger candidate pool.
grep -q '^HINDSIGHT_API_RERANKER_FLASHRANK_MODEL=' "$ENV_FILE" || echo 'HINDSIGHT_API_RERANKER_FLASHRANK_MODEL=ms-marco-MiniLM-L-12-v2' >> "$ENV_FILE"
grep -q '^HINDSIGHT_API_RERANKER_MAX_CANDIDATES_LOW=' "$ENV_FILE" || echo 'HINDSIGHT_API_RERANKER_MAX_CANDIDATES_LOW=12' >> "$ENV_FILE"
# FlashRank pads a batch to its longest passage. Small batches avoid making
# every candidate pay for one long memory; independent scores are unchanged.
grep -q '^HINDSIGHT_API_RERANKER_FLASHRANK_BATCH_SIZE=' "$ENV_FILE" || echo 'HINDSIGHT_API_RERANKER_FLASHRANK_BATCH_SIZE=1' >> "$ENV_FILE"
# Ubuntu 24.04 ships pgvector 0.6. Iterative HNSW scans need 0.8+, otherwise the
# final semantic-link pass rejects an unknown GUC. Ordinary ANN remains enabled.
VECTOR_VERSION=$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d hindsight -tAc "SELECT extversion FROM pg_extension WHERE extname = 'vector'")
if dpkg --compare-versions "$VECTOR_VERSION" lt 0.8; then
  if grep -q '^HINDSIGHT_API_ANN_ITERATIVE_SCAN=' "$ENV_FILE"; then
    sed -i 's/^HINDSIGHT_API_ANN_ITERATIVE_SCAN=.*/HINDSIGHT_API_ANN_ITERATIVE_SCAN=false/' "$ENV_FILE"
  else
    echo 'HINDSIGHT_API_ANN_ITERATIVE_SCAN=false' >> "$ENV_FILE"
  fi
fi

echo "==> nightly consolidation"
cat > /etc/systemd/system/better-bots-consolidate.service <<'CSEOF'
[Unit]
Description=Consolidate Hindsight memory banks
After=hindsight.service
[Service]
Type=oneshot
ExecStart=/opt/better-bots/deploy/consolidate.sh
CSEOF
cat > /etc/systemd/system/better-bots-consolidate.timer <<'CSEOF'
[Unit]
Description=Nightly memory consolidation
[Timer]
OnCalendar=*-*-* 03:30:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
CSEOF
chmod 755 /opt/better-bots/deploy/consolidate.sh
systemctl daemon-reload
systemctl enable --now better-bots-consolidate.timer >/dev/null 2>&1

echo "==> service"
cat > /etc/systemd/system/hindsight.service <<UNITEOF
[Unit]
Description=Hindsight — memory engine for Better Bots
After=network-online.target postgresql@16-main.service
Wants=network-online.target
Requires=postgresql@16-main.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$DATA_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/venv/bin/hindsight-api
Restart=always
RestartSec=5
TimeoutStartSec=600
KillSignal=SIGTERM
TimeoutStopSec=30

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable hindsight >/dev/null
systemctl restart hindsight

echo "==> waiting for it to come up (first start downloads two small models)"
for i in $(seq 1 120); do
  if curl -sf -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo "   up after ${i}x5s"; break; fi
  systemctl is-active --quiet hindsight || { journalctl -u hindsight -n 40 --no-pager; exit 1; }
  sleep 5
done
curl -sf -m 3 "http://127.0.0.1:$PORT/health" >/dev/null || { echo "not healthy"; journalctl -u hindsight -n 40 --no-pager; exit 1; }

cat <<'DONE'

Done. Hindsight is on 127.0.0.1:8888, API key in /var/lib/hindsight/hindsight.env
(HINDSIGHT_API_TENANT_API_KEY). Give better-bots the same values:

  HINDSIGHT_URL=http://127.0.0.1:8888
  HINDSIGHT_API_KEY=<that key>

in /var/lib/better-bots/better-bots.env, then: systemctl restart better-bots
DONE
