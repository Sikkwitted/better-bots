#!/usr/bin/env bash
# Back up the local state and, when one is in use, the Hindsight memory database.
# Preserve local archives on a database failure, but return failure and record
# PARTIAL rather than claiming success.
set -euo pipefail
umask 077
DEST="${BETTER_BOTS_BACKUP_DEST:-/var/backups/better-bots}"
SOURCE="${BETTER_BOTS_BACKUP_SOURCE:-/var/lib/better-bots}"
while [[ "$SOURCE" == */ && "$SOURCE" != / ]]; do SOURCE=${SOURCE%/}; done
KEEP_DAYS="${BETTER_BOTS_BACKUP_KEEP_DAYS:-7}"
# Paths inside the state directory to leave out, space separated (rsync patterns,
# e.g. "cache logs/*.old"). Only bulk data that can be
# fetched again belongs here; never a ledger or other irreplaceable state.
read -r -a EXCLUDES <<< "${BETTER_BOTS_BACKUP_EXCLUDE:-}"
for pattern in ${EXCLUDES[@]+"${EXCLUDES[@]}"}; do
  [[ "$pattern" != /* && "$pattern" != *..* ]] || { echo "backup exclusion must be a relative path: $pattern" >&2; exit 1; }
done
PG_PORT="${BETTER_BOTS_BACKUP_PGPORT:-5432}"
[[ "$PG_PORT" =~ ^[0-9]+$ ]] || { echo "backup PostgreSQL port must be a number: $PG_PORT" >&2; exit 1; }
# The PostgreSQL database behind Hindsight; "none" when memory runs on the
# built-in SQLite store and there is no database to dump. Unset, a database named
# hindsight is dumped only if this machine has one, so a default install backs up.
DATABASE_NAME="${BETTER_BOTS_BACKUP_DATABASE:-}"
if [ -z "$DATABASE_NAME" ]; then
  DATABASE_NAME=none
  if [ "$(sudo -u postgres psql -X -p "$PG_PORT" -tAc "SELECT 1 FROM pg_database WHERE datname = 'hindsight'" 2>/dev/null)" = 1 ]; then
    DATABASE_NAME=hindsight
  fi
fi
[[ "$DATABASE_NAME" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "backup database must be a PostgreSQL name or none: $DATABASE_NAME" >&2; exit 1; }
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
install -d -m 0700 "$DEST"
exec 9>"$DEST/.backup.lock"
flock -n 9 || { echo 'another backup is running' >&2; exit 1; }
LOCAL="$DEST/better-bots-$STAMP.tgz"
DATABASE="$DEST/hindsight-$STAMP.dump"
STATUS="$DEST/backup-$STAMP.status"
SNAPSHOT=''
# The host's health check reads this, so a failed night shows as degraded (and
# reaches BETTER_BOTS_NOTIFY_WEBHOOK) instead of failing silently.
report_to_host() {
  [ -d "$SOURCE" ] && [ "$SOURCE" != / ] || return 0
  local outcome=complete
  [ "$1" -eq 0 ] || outcome=partial
  local line
  line=$(printf '{"result":"%s","at":"%s"}' "$outcome" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
  # The state directory belongs to the service user, who could plant a link at
  # any name in it. Root writes there as that user, so a link reaches nothing the
  # service user could not already write.
  local owner as=()
  owner=$(stat -c %U "$SOURCE" 2>/dev/null || stat -f %Su "$SOURCE")
  if [ "$(id -u)" -eq 0 ] && [ "$owner" != root ]; then as=(runuser -u "$owner" --); fi
  ${as[@]+"${as[@]}"} sh -c 'umask 022; printf "%s\n" "$1" > "$2.tmp" && mv -f "$2.tmp" "$2"' _ "$line" "$SOURCE/backup-status.json" 2>/dev/null \
    || echo "backup $STAMP: could not record the result for the host" >&2
}
finish() {
  result=$?
  trap - EXIT
  if [ -n "$SNAPSHOT" ] && [ -d "$SNAPSHOT" ]; then
    if ! rm -rf -- "$SNAPSHOT"; then
      echo "backup $STAMP: could not remove the private snapshot $SNAPSHOT" >&2
      result=1
    fi
  fi
  if [ "$result" -ne 0 ]; then
    printf 'PARTIAL\nlocal_archive=%s\ndatabase_dump=%s\n' "$(test -s "$LOCAL" && echo present || echo missing)" "$(test -s "$DATABASE" && echo present || echo missing)" > "$STATUS"
    echo "backup $STAMP: PARTIAL — inspect the backup status and database; retained any completed local archive" >&2
  fi
  report_to_host "$result"
  rm -f "$LOCAL.partial" "$DATABASE.partial"
  exit "$result"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# A killed producer cannot run the EXIT trap. The lock proves there is no other
# scheduled backup, so remove only our marked abandoned staging directories.
while IFS= read -r -d '' abandoned; do
  name=$(basename "$abandoned")
  [[ "$name" =~ ^\.backup-stage-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.[A-Za-z0-9]{6}$ ]] || continue
  [ -f "$abandoned/.better-bots-backup-stage" ] || continue
  [ "$(cat "$abandoned/.better-bots-backup-stage")" = 'better-bots-backup-stage-v1' ] || continue
  rm -rf -- "$abandoned"
done < <(find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '.backup-stage-*' -print0)
# Only scheduled backup files belong to this policy. Manual repair checkpoints
# and nested snapshots may be unique recovery evidence and are never swept up.
# Retention runs before the copy so a full disk cannot block its own cleanup, but
# a folder's newest archive and newest dump are always kept: after a run of failed
# nights they may be the only restorable copies.
STAMP_RE='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}([0-9]{2})?Z'
newest_stamp() {
  local file name best=''
  while IFS= read -r -d '' file; do
    name=$(basename "$file")
    if [[ "$name" =~ $2 ]] && [[ "${BASH_REMATCH[2]}" > "$best" ]]; then best=${BASH_REMATCH[2]}; fi
  done < <(find "$1" -maxdepth 1 -type f -print0)
  printf '%s' "$best"
}
prune_scheduled() {
  [ -d "$1" ] || return 0
  local file name keep_archive keep_dump
  keep_archive=$(newest_stamp "$1" "^(better-bots)-(${STAMP_RE})\\.tgz$")
  keep_dump=$(newest_stamp "$1" "^(hindsight)-(${STAMP_RE})\\.dump$")
  while IFS= read -r -d '' file; do
    name=$(basename "$file")
    if [[ "$name" =~ ^(better-bots)-(${STAMP_RE})\.tgz$ ]] || \
       [[ "$name" =~ ^(hindsight)-(${STAMP_RE})\.dump$ ]] || \
       [[ "$name" =~ ^(backup)-(${STAMP_RE})\.(status|manifest)$ ]]; then
      [[ "${BASH_REMATCH[2]}" == "$keep_archive" || "${BASH_REMATCH[2]}" == "$keep_dump" ]] || rm -- "$file"
    fi
  done < <(find "$1" -maxdepth 1 -type f -mtime +"$KEEP_DAYS" -print0)
}
prune_scheduled "$DEST"
# Final filenames appear only after a successful producer exit.
[ "$SOURCE" != / ] && test -d "$SOURCE" || { echo "backup source is not a state directory: $SOURCE" >&2; exit 1; }
[ ! -L "$SOURCE" ] || { echo 'Backup source must be a directory, not a symlink' >&2; exit 1; }
SOURCE_NAME=$(basename "$SOURCE")
CAPTURE_SOURCE="${BETTER_BOTS_BACKUP_SNAPSHOT_SOURCE:-$SOURCE}"
CONSISTENCY=online_copy_unverified
if [ -n "${BETTER_BOTS_BACKUP_SNAPSHOT_SOURCE:-}" ]; then
  [ ! -L "$CAPTURE_SOURCE" ] || { echo 'Snapshot source must not be a symlink' >&2; exit 1; }
  [ -d "$CAPTURE_SOURCE" ] || { echo 'Configured snapshot source does not exist' >&2; exit 1; }
  options=$(findmnt -n -o OPTIONS --target "$CAPTURE_SOURCE")
  [[ ",$options," == *,ro,* ]] || { echo 'Snapshot source must be on a read-only filesystem' >&2; exit 1; }
  CONSISTENCY=readonly_snapshot
fi
CAPTURE_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Copy the running store before archiving it. Anything that rewrites files or
# appends to a journal while a backup runs must not be read live by tar. A
# replaced .tmp file can disappear during a copy, so retry a fresh, complete
# snapshot rather than accepting a partial tree.
SNAPSHOT=$(mktemp -d "$DEST/.backup-stage-$STAMP.XXXXXX")
printf 'better-bots-backup-stage-v1\n' > "$SNAPSHOT/.better-bots-backup-stage"
copy_state() {
  if [ ${#EXCLUDES[@]} -eq 0 ]; then cp -a "$CAPTURE_SOURCE" "$SNAPSHOT/$SOURCE_NAME"; return; fi
  rsync -a "${EXCLUDES[@]/#/--exclude=/}" "$CAPTURE_SOURCE/" "$SNAPSHOT/$SOURCE_NAME/"
}
copied=false
for attempt in 1 2 3; do
  if copy_state; then
    copied=true
    break
  fi
  echo "backup $STAMP: snapshot copy attempt $attempt failed" >&2
  rm -rf -- "$SNAPSHOT/$SOURCE_NAME"
done
if [ "$copied" != true ]; then
  echo "backup $STAMP: could not copy the full local state" >&2
  exit 1
fi
CAPTURE_FINISHED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
tar czf "$LOCAL.partial" --exclude="$SOURCE_NAME/.cache" -C "$SNAPSHOT" "$SOURCE_NAME"
mv "$LOCAL.partial" "$LOCAL"
rm -rf -- "$SNAPSHOT"
SNAPSHOT=''
LOCAL_SHA=$(sha256sum "$LOCAL" | cut -d ' ' -f 1)
if [ "$DATABASE_NAME" = none ]; then
  DATABASE_SHA=none
  DATABASE_SAVED=not_configured
  COVERAGE='local state saved; no memory database is configured'
else
  # The generic postgresql.service wrapper can be active with its cluster down.
  # Check the actual required database and fail visibly if it cannot be read.
  sudo -u postgres psql -X -p "$PG_PORT" -v ON_ERROR_STOP=1 -d "$DATABASE_NAME" -tAc 'SELECT 1' >/dev/null
  sudo -u postgres pg_dump -p "$PG_PORT" -Fc "$DATABASE_NAME" > "$DATABASE.partial"
  test -s "$DATABASE.partial"
  sudo -u postgres pg_restore --list < "$DATABASE.partial" >/dev/null
  mv "$DATABASE.partial" "$DATABASE"
  DATABASE_SHA=$(sha256sum "$DATABASE" | cut -d ' ' -f 1)
  DATABASE_SAVED=$(basename "$DATABASE")
  COVERAGE='local state and Hindsight database saved'
fi
printf 'capture_consistency=%s\ncapture_started=%s\ncapture_finished=%s\nlocal_sha256=%s\ndatabase_sha256=%s\nexcluded=%s\nrestore_verified=false\n' \
  "$CONSISTENCY" "$CAPTURE_STARTED" "$CAPTURE_FINISHED" "$LOCAL_SHA" "$DATABASE_SHA" "${EXCLUDES[*]:-none}" > "$DEST/backup-$STAMP.manifest"
printf 'COMPLETE\nlocal_archive=%s\ndatabase_dump=%s\n' "$(basename "$LOCAL")" "$DATABASE_SAVED" > "$STATUS"
echo "backup $STAMP: COMPLETE coverage — $COVERAGE; capture=$CONSISTENCY; restore not verified"
if [ "$CONSISTENCY" = online_copy_unverified ]; then
  echo 'Online copy does not establish cross-file consistency. For consistent capture, supply a read-only filesystem snapshot covering all local writers.' >&2
fi
