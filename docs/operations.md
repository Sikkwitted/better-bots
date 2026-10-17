# Operations

How to run Better Bots unattended on a server, keep it healthy, back it up, and
upgrade it. For a Linux Mint or Ubuntu desktop, the installer and package in
[deploy/linux](../deploy/linux/README.md) are simpler.

## Server install (Ubuntu 24.04)

`deploy/bootstrap.sh` provisions a fresh Ubuntu 24.04 machine. It expects the code
at `/opt/better-bots`:

```sh
sudo git clone <repository-url> /opt/better-bots
sudo bash /opt/better-bots/deploy/bootstrap.sh
```

The script is idempotent. It installs Node 22, Poppler, bubblewrap (with an
AppArmor profile that allows its user namespaces), desktop tools, the optional
Codex and uv command-line tools, and the locked dependencies. It creates the
`better-bots` service user and `/var/lib/better-bots`, runs the test suite as that
user before enabling anything, then installs and starts the systemd unit, a
nightly backup timer, and a `better-bots` command.

It writes no secrets. Put provider keys in
`/var/lib/better-bots/better-bots.env` (mode 600), or add them in the console
under **App settings → AI providers**, then `sudo systemctl restart better-bots`.

## Reaching the console

The service listens on `127.0.0.1:4173`. From your computer, open a tunnel and use
the login link the service printed:

```sh
ssh -N -L 4173:127.0.0.1:4173 you@server
journalctl -u better-bots | grep token=    # the login link
```

The console token is generated on first start and saved as `console-token` in the
data folder. Set `BETTER_BOTS_TOKEN` to choose your own (at least 32 characters,
for example from `openssl rand -base64 32`). The host refuses to bind
a non-loopback address (`BETTER_BOTS_HOST`) without a token. If you publish the
console instead of tunnelling, put TLS in front of it.

### macOS app wrapper

`tools/make-app.sh` builds **Better Bots.app**, a native window around the console
(`tools/BetterBots.swift`; needs the Xcode command line tools). On first launch it
asks for the host URL and, for a remote host, the SSH login; it opens and closes
the tunnel itself. To pre-fill both:

```sh
BB_URL=http://127.0.0.1:4173 BB_SSH=you@server tools/make-app.sh
```

The app holds no state of its own. It is a window over the same HTTP console.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `BETTER_BOTS_DIR` | `./.data` (`/var/lib/better-bots` for the service) | Data folder: bots, transcripts, memory, audit log, keys |
| `BETTER_BOTS_HOST` / `BETTER_BOTS_PORT` | `127.0.0.1` / `4173` | Bind address and port |
| `BETTER_BOTS_TOKEN` | generated, saved as `console-token` | Console login secret. Separate from model API keys |
| `BETTER_BOTS_MEMORY_ENGINE` | `sqlite` (`hindsight` when `HINDSIGHT_URL` is set) | `sqlite`, `hindsight`, or `local` (word overlap only) |
| `BETTER_BOTS_CONTEXT_WINDOW` | `128000` | Tokens. A turn is compacted at 70% of it. A bot's own setting wins |
| `BETTER_BOTS_CONSOLIDATE` | on | `off` stops the daily verified rewrite of standing knowledge |
| `BETTER_BOTS_TICK_MS` | `15000` | How often due routines are noticed |
| `BETTER_BOTS_SHOTS_KEPT` | `48` | Screenshots kept per bot desktop |
| `BETTER_BOTS_NOTIFY_WEBHOOK` | unset | An `http(s)://` URL that receives a short JSON payload when the host turns degraded |
| `BETTER_BOTS_REQUIRE_HINDSIGHT` | `1` in the service unit | Requires a memory engine (SQLite counts). The name is historical |

## Health

`GET /healthz` needs no token, so an uptime monitor can use it. It returns `ok`
or `degraded` (HTTP 200 or 503) with the failure classes behind the verdict:
recent provider, memory, and desktop failures, runs that need review, a failed or
overdue backup, and log corruption. Details are behind the token under `/api`.

With `BETTER_BOTS_NOTIFY_WEBHOOK` set, the host posts when it turns degraded, at
most once per fault per 30 minutes. A broken webhook never affects the host.

A healthy endpoint does not prove memory works. To check memory, follow the
acceptance steps in the [memory contract](MEMORY-CONTRACT.md).

## Recovery after a restart

State is durable. On boot the host re-arms queued runs and undelivered messages.
A turn interrupted mid-run is not retried blindly: it appears in the console's
**Attention** pane with its saved evidence. Record whether it completed, did not
run, or should be abandoned. Whole-run retries are refused when the run already
took recorded actions.

## Backups

The bootstrap installs `better-bots-backup.timer`, which runs `deploy/backup.sh`
nightly. Each run archives the data folder to `/var/backups/better-bots`, writes a
manifest with SHA-256 checksums, and writes `backup-status.json` to the data
folder; a failed or overdue backup makes `/healthz` report degraded.

On the default SQLite memory the data folder is the whole backup. If the machine
also has a PostgreSQL database named `hindsight`, the script dumps it too; set
`BETTER_BOTS_BACKUP_DATABASE` to name a different database, or `none` to skip it.

| Variable | Default | Meaning |
|---|---|---|
| `BETTER_BOTS_BACKUP_DEST` | `/var/backups/better-bots` | Where archives go |
| `BETTER_BOTS_BACKUP_SOURCE` | `/var/lib/better-bots` | The data folder |
| `BETTER_BOTS_BACKUP_KEEP_DAYS` | `7` | Older scheduled archives are removed first; the newest is always kept |
| `BETTER_BOTS_BACKUP_EXCLUDE` | unset | Space-separated paths inside the data folder to skip (needs `rsync`) |
| `BETTER_BOTS_BACKUP_DATABASE` | `hindsight` if it exists, else `none` | PostgreSQL database to dump, or `none` |
| `BETTER_BOTS_BACKUP_PGPORT` | `5432` | PostgreSQL port |
| `BETTER_BOTS_BACKUP_SNAPSHOT_SOURCE` | unset | A read-only filesystem snapshot of the whole data folder to copy from |

An ordinary run copies a live data folder, so the manifest records
`online_copy_unverified`: files are complete but may not be consistent with each
other. For a consistent capture, point `BETTER_BOTS_BACKUP_SNAPSHOT_SOURCE` at a
read-only snapshot you created. The script checks the mount is read-only; it
does not create the snapshot or pause services. Leave disk space for one
uncompressed copy plus the archive.

## Restore

An archive is not a backup until you have restored it once. To restore:

```sh
sudo systemctl stop better-bots
sudo mv /var/lib/better-bots /var/lib/better-bots.old
sudo tar xzf /var/backups/better-bots/better-bots-<stamp>.tgz -C /var/lib
sudo chown -R better-bots:better-bots /var/lib/better-bots
sudo systemctl start better-bots
```

With Hindsight, also restore its dump with `pg_restore`. Then check that your bots,
chats, and a scoped memory recall are back. SQLite memory can be rebuilt from the
memory files with `node tools/replay-memory.mjs --dir /var/lib/better-bots` if needed.

## Upgrades

Back up first. Then update the code and re-run the bootstrap, which installs the
locked dependencies, runs the tests as the service user, and restarts the service:

```sh
sudo git -C /opt/better-bots pull
sudo bash /opt/better-bots/deploy/bootstrap.sh
```

Read [CHANGELOG.md](../CHANGELOG.md) before upgrading. The data folder is kept.

To update from a reviewed checkout on your own machine instead, run
`deploy/push.sh user@host`. It copies the checkout to a staging folder on the
server, and `deploy/activate.sh` installs and tests it as the service user before
swapping it in. A failed test leaves the running version untouched, and a failed
readiness check after the swap restores the previous version. It copies the
whole checkout apart from data, `.env` files and `node_modules`, so push from a
clean tree.

## Optional: Hindsight

Hindsight adds model-based fact extraction and semantic recall. It costs a
PostgreSQL database and a model call for each retained exchange. Nothing requires
it. On the server:

```sh
sudo bash /opt/better-bots/deploy/hindsight-install.sh
```

The installer uses `DEEPSEEK_API_KEY` from the service's environment file for
extraction by default; set `HINDSIGHT_LLM_PROVIDER=zai` (with `GLM_API_KEY`) to use
Z.ai, and `HINDSIGHT_LLM_MODEL` to pick a model. It binds Hindsight to loopback
with key authentication and prints how to set `HINDSIGHT_URL` and
`HINDSIGHT_API_KEY`. Restart Better Bots afterwards, then run the
[memory acceptance steps](MEMORY-CONTRACT.md#memory-acceptance).
