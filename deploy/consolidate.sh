#!/usr/bin/env bash
#
# Consolidate every Hindsight bank once. Automatic consolidation after each
# retain is off (HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false) because it made
# a background model call per exchange; a nightly pass forms the same
# observations for a fraction of the tokens. Installed as better-bots-consolidate.timer.

set -euo pipefail
ENV_FILE=/var/lib/hindsight/hindsight.env
KEY=$(grep '^HINDSIGHT_API_TENANT_API_KEY=' "$ENV_FILE" | cut -d= -f2)
URL="http://127.0.0.1:$(grep '^HINDSIGHT_API_PORT=' "$ENV_FILE" | cut -d= -f2 || echo 8888)"
banks=$(curl -sf "$URL/v1/default/banks" -H "Authorization: Bearer $KEY" | python3 -c 'import json,sys; print("\n".join(b["bank_id"] for b in json.load(sys.stdin)["banks"]))')
n=0
for bank in $banks; do
  curl -sf -X POST "$URL/v1/default/banks/$bank/consolidate" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}' >/dev/null && n=$((n+1))
done
echo "consolidation queued for $n bank(s)"
