import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// The archive a run just wrote: seeded fixtures carry 2020-/2099- stamps or "manual".
const newArchive = (files) => files.find(f => f.startsWith('better-bots-') && f.endsWith('.tgz') && !/2020-|2099-|manual/.test(f));

function probe(mode, { writerDuringArchive = false, copyFailure = null, trailingSource = false, cleanupFailure = false, snapshotMode = null, env = {}, setup = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-backup-'));
  const bin = path.join(root, 'bin'), source = path.join(root, 'state'), dest = path.join(root, 'backups');
  fs.mkdirSync(bin); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'fact.txt'), 'retained locally');
  fs.mkdirSync(dest);
  const abandoned = path.join(dest, '.backup-stage-2020-01-01T041500Z.abc123');
  fs.mkdirSync(abandoned);
  fs.writeFileSync(path.join(abandoned, '.better-bots-backup-stage'), 'better-bots-backup-stage-v1\n');
  const unknown = path.join(dest, '.backup-stage-manual');
  fs.mkdirSync(unknown); fs.writeFileSync(path.join(unknown, 'note.txt'), 'keep');
  const old = new Date(Date.now() - 18 * 86400_000);
  fs.mkdirSync(path.join(dest, 'manual-snapshot'));
  for (const name of ['better-bots-2020-01-01T0415Z.tgz', 'hindsight-2020-01-01T0415Z.dump', 'before-repair.tar', 'better-bots-manual.tgz', 'manual-snapshot/better-bots-2020-01-01T0415Z.tgz']) {
    const file = path.join(dest, name); fs.writeFileSync(file, 'preserved backup'); fs.utimesSync(file, old, old);
  }
  fs.writeFileSync(path.join(dest, 'better-bots-2099-01-01T0415Z.tgz'), 'recent backup');
  fs.writeFileSync(path.join(dest, 'hindsight-2099-01-01T0415Z.dump'), 'recent dump');
  setup?.({source, dest, old});
  // Only the database transport and Linux advisory lock are substituted. The
  // production script creates real archives, manifests and file permissions.
  fs.writeFileSync(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n', {mode:0o755});
  fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh
shift 2
[ -z "$BACKUP_TEST_SUDO_LOG" ] || echo "$*" >> "$BACKUP_TEST_SUDO_LOG"
case "$1" in
psql) case "$*" in *pg_database*) [ "$BACKUP_TEST_MODE" = no_database ] || echo 1 ;; esac; [ "$BACKUP_TEST_MODE" != unavailable ] ;;
pg_dump) printf 'database contents'; [ "$BACKUP_TEST_MODE" != dump_failure ] ;;
pg_restore) cat >/dev/null; [ "$BACKUP_TEST_MODE" != unreadable_dump ] ;;
*) exit 99 ;;
esac
`, {mode:0o755});
  if (writerDuringArchive) {
    const live = path.join(source, 'data', 'live');
    fs.mkdirSync(live, {recursive:true});
    fs.writeFileSync(path.join(live, 'status.json'), '{"generation":-1}\n');
    fs.writeFileSync(path.join(live, 'events.jsonl'), '{"generation":-1}\n');
    fs.writeFileSync(path.join(source, 'filler.bin'), Buffer.alloc(4 * 1024 * 1024, 0x5a));
    fs.writeFileSync(path.join(bin, 'tar'), `#!/bin/sh
set -eu
live="$BACKUP_TEST_SOURCE/data/live"
# The live source changes after the copy and throughout compression. A tar of
# the live directory would capture the newer status or fail on a changing file.
printf '{"generation":0}\\n' > "$live/status.json.tmp"
mv "$live/status.json.tmp" "$live/status.json"
printf '{"generation":0}\\n' >> "$live/events.jsonl"
(
  i=1
  while [ "$i" -le 40 ]; do
    printf '{"generation":%s}\\n' "$i" > "$live/status.json.tmp"
    mv "$live/status.json.tmp" "$live/status.json"
    printf '{"generation":%s}\\n' "$i" >> "$live/events.jsonl"
    i=$((i + 1))
    sleep 0.005
  done
) &
writer=$!
if "$BACKUP_TEST_REAL_TAR" "$@"; then result=0; else result=$?; fi
wait "$writer"
exit "$result"
`, {mode:0o755});
  }
  if (copyFailure) {
    fs.writeFileSync(path.join(bin, 'cp'), `#!/bin/sh
set -eu
if [ "$BACKUP_TEST_COPY_FAILURE" = always ] || [ ! -f "$BACKUP_TEST_COPY_MARKER" ]; then
  : > "$BACKUP_TEST_COPY_MARKER"
  echo 'cp: simulated disappearing status.json.tmp' >&2
  exit 1
fi
exec "$BACKUP_TEST_REAL_CP" "$@"
`, {mode:0o755});
  }
  if (cleanupFailure) {
    fs.writeFileSync(path.join(bin, 'rm'), `#!/bin/sh
for target in "$@"; do
  case "$target" in
    *.backup-stage-2020-*) ;;
    *.backup-stage-*) echo 'simulated staging cleanup failure' >&2; exit 1 ;;
  esac
done
exec /bin/rm "$@"
`, {mode:0o755});
  }
  const snapshotSource = path.join(root, 'snapshot');
  if (snapshotMode) {
    if(snapshotMode==='symlink')fs.symlinkSync(source,snapshotSource);
    else fs.cpSync(source, snapshotSource, {recursive:true});
    fs.writeFileSync(path.join(bin,'findmnt'), `#!/bin/sh\necho ${snapshotMode === 'readonly' ? 'ro' : 'rw'},relatime\n`, {mode:0o755});
    fs.writeFileSync(path.join(bin,'cp'), `#!/bin/sh
# A live writer changes state during capture; the configured snapshot stays fixed.
printf 'changed during capture' > "$BACKUP_TEST_SOURCE/fact.txt"
exec /bin/cp "$@"
`, {mode:0o755});
  }
  const result = spawnSync('bash', ['deploy/backup.sh'], {encoding:'utf8', env:{...process.env, PATH:`${bin}:${process.env.PATH}`, BETTER_BOTS_BACKUP_SOURCE:trailingSource ? `${source}/` : source, BETTER_BOTS_BACKUP_DEST:dest, BACKUP_TEST_MODE:mode,
    BETTER_BOTS_BACKUP_SNAPSHOT_SOURCE:snapshotMode ? snapshotSource : '', BACKUP_TEST_SOURCE:source, BACKUP_TEST_REAL_TAR:'/usr/bin/tar', BACKUP_TEST_REAL_CP:'/bin/cp', BACKUP_TEST_COPY_FAILURE:copyFailure ?? '', BACKUP_TEST_COPY_MARKER:path.join(root,'copy-failed'), BACKUP_TEST_SUDO_LOG:path.join(root,'sudo.log'), BETTER_BOTS_BACKUP_DATABASE:'hindsight', ...env}});
  return {root, dest, result, files:fs.readdirSync(dest)};
}
for (const mode of ['unavailable', 'dump_failure', 'unreadable_dump', 'success']) {
  test(`backup ${mode}: accurate completion and recoverable local archive`, () => {
    const p = probe(mode);
    try {
      assert.equal(p.result.status, mode === 'success' ? 0 : 1, p.result.stderr);
      const archive = newArchive(p.files);
      assert.ok(archive, 'completed local archive survives database failure');
      const restored = path.join(p.root, 'restored'); fs.mkdirSync(restored);
      assert.equal(spawnSync('tar', ['xzf', path.join(p.dest,archive), '-C',restored]).status, 0);
      assert.equal(fs.readFileSync(path.join(restored,'state','fact.txt'),'utf8'), 'retained locally');
      assert.equal(p.files.some(f => f.endsWith('.partial')), false);
      assert.equal(p.files.some(f => /^\.backup-stage-\d{4}-\d{2}-\d{2}T\d{6}Z\.[A-Za-z0-9]{6}$/.test(f)), false, 'private and abandoned snapshots are removed');
      assert.ok(p.files.includes('.backup-stage-manual'), 'unmarked directories are preserved');
      assert.equal(p.files.some(f => f.startsWith('hindsight-') && !f.includes('2020-') && !f.includes('2099-') && f.endsWith('.dump')), mode === 'success');
      const status = fs.readFileSync(path.join(p.dest,p.files.find(f => f.endsWith('.status'))),'utf8');
      assert.match(status, mode === 'success' ? /^COMPLETE/ : /^PARTIAL/);
      const reported = JSON.parse(fs.readFileSync(path.join(p.root,'state','backup-status.json'),'utf8'));
      assert.equal(reported.result, mode === 'success' ? 'complete' : 'partial', 'the host learns how the night went');
      if (mode === 'success') {
        const manifest = fs.readFileSync(path.join(p.dest,p.files.find(f=>f.endsWith('.manifest'))),'utf8');
        assert.match(manifest,/capture_consistency=online_copy_unverified/);
        assert.match(manifest,/local_sha256=[a-f0-9]{64}/);
        assert.match(manifest,/database_sha256=[a-f0-9]{64}/);
        assert.match(manifest,/restore_verified=false/);
      }
      assert.equal(fs.statSync(path.join(p.dest,archive)).mode & 0o777, 0o600);
      // Retention runs before the copy, so a failing night (e.g. a full disk) still cleans up.
      assert.equal(fs.existsSync(path.join(p.dest, 'better-bots-2020-01-01T0415Z.tgz')), false, 'expire old scheduled archives before archiving');
      assert.equal(fs.existsSync(path.join(p.dest, 'hindsight-2020-01-01T0415Z.dump')), false);
      assert.ok(fs.existsSync(path.join(p.dest, 'better-bots-2099-01-01T0415Z.tgz')), 'keep recent archives');
      assert.ok(fs.existsSync(path.join(p.dest, 'before-repair.tar')), 'keep manual repair archives');
      assert.ok(fs.existsSync(path.join(p.dest, 'better-bots-manual.tgz')), 'a product-name prefix alone does not make a file a scheduled backup');
      assert.ok(fs.existsSync(path.join(p.dest, 'manual-snapshot/better-bots-2020-01-01T0415Z.tgz')), 'never recurse into manual checkpoints');
    } finally {fs.rmSync(p.root,{recursive:true,force:true});}
  });
}

test('backup compresses a stable snapshot while the live status and journal keep changing', () => {
  const p = probe('success', {writerDuringArchive:true, trailingSource:true});
  try {
    assert.equal(p.result.status, 0, p.result.stderr);
    const archive = newArchive(p.files);
    const restored = path.join(p.root, 'restored'); fs.mkdirSync(restored);
    assert.equal(spawnSync('tar', ['xzf', path.join(p.dest,archive), '-C',restored]).status, 0);
    const live = path.join(restored, 'state', 'data', 'live');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live,'status.json'),'utf8')), {generation:-1});
    assert.equal(fs.readFileSync(path.join(live,'events.jsonl'),'utf8'), '{"generation":-1}\n');
    assert.equal(fs.readFileSync(path.join(restored,'state','fact.txt'),'utf8'), 'retained locally');
    assert.ok(JSON.parse(fs.readFileSync(path.join(p.root,'state','data','live','status.json'),'utf8')).generation >= 0);
    assert.equal(p.files.some(f => /^\.backup-stage-\d{4}-\d{2}-\d{2}T\d{6}Z\.[A-Za-z0-9]{6}$/.test(f)), false);
  } finally {fs.rmSync(p.root,{recursive:true,force:true});}
});

test('a replaced source file retries the whole snapshot; persistent copy failure stays partial', () => {
  for (const copyFailure of ['once','always']) {
    const p = probe('success', {copyFailure});
    try {
      assert.equal(p.result.status, copyFailure === 'once' ? 0 : 1, p.result.stderr);
      assert.match(p.result.stderr, /snapshot copy attempt 1 failed/);
      const archive = newArchive(p.files);
      assert.equal(Boolean(archive), copyFailure === 'once');
      const status = fs.readFileSync(path.join(p.dest,p.files.find(f => f.endsWith('.status'))),'utf8');
      assert.match(status, copyFailure === 'once' ? /^COMPLETE/ : /^PARTIAL\nlocal_archive=missing/);
      assert.equal(p.files.some(f => /^\.backup-stage-\d{4}-\d{2}-\d{2}T\d{6}Z\.[A-Za-z0-9]{6}$/.test(f)), false, 'failed staging is removed');
    } finally {fs.rmSync(p.root,{recursive:true,force:true});}
  }
});

test('failure to remove the private snapshot cannot claim a complete backup', () => {
  const p = probe('success', {cleanupFailure:true});
  try {
    assert.equal(p.result.status, 1, p.result.stderr);
    assert.match(p.result.stderr, /could not remove the private snapshot/);
    const status = fs.readFileSync(path.join(p.dest,p.files.find(f => f.endsWith('.status'))),'utf8');
    assert.match(status, /^PARTIAL\nlocal_archive=present\ndatabase_dump=missing/);
  } finally {fs.rmSync(p.root,{recursive:true,force:true});}
});

for (const snapshotMode of ['readonly','writable','symlink']) test(`backup snapshot source ${snapshotMode}`, () => {
  const p = probe('success', {snapshotMode});
  try {
    assert.equal(p.result.status,snapshotMode==='readonly'?0:1,p.result.stderr);
    if(snapshotMode==='readonly') {
      const archive=newArchive(p.files);
      const restored=path.join(p.root,'restored');fs.mkdirSync(restored);
      assert.equal(spawnSync('tar',['xzf',path.join(p.dest,archive),'-C',restored]).status,0);
      assert.equal(fs.readFileSync(path.join(restored,'state/fact.txt'),'utf8'),'retained locally');
      assert.equal(fs.readFileSync(path.join(p.root,'state/fact.txt'),'utf8'),'changed during capture');
      assert.match(fs.readFileSync(path.join(p.dest,p.files.find(f=>f.endsWith('.manifest'))),'utf8'),/capture_consistency=readonly_snapshot/);
    } else assert.match(p.result.stderr,snapshotMode==='symlink'?/symlink/:/read-only filesystem/);
  } finally {fs.rmSync(p.root,{recursive:true,force:true});}
});

test('after nights of failures, the newest archive and dump survive retention even when this run fails too', () => {
  const p = probe('success', {copyFailure:'always', setup:({dest, old}) => {
    for (const name of ['better-bots-2020-02-01T041500Z.tgz', 'hindsight-2020-02-01T041500Z.dump', 'backup-2020-02-01T041500Z.status',
      'better-bots-2020-01-15T041500Z.tgz', 'hindsight-2020-01-15T041500Z.dump']) {
      fs.writeFileSync(path.join(dest, name), 'old'); fs.utimesSync(path.join(dest, name), old, old);
    }
    for (const name of ['better-bots-2099-01-01T0415Z.tgz', 'hindsight-2099-01-01T0415Z.dump']) fs.rmSync(path.join(dest, name));
  }});
  try {
    assert.equal(p.result.status, 1);
    for (const kept of ['better-bots-2020-02-01T041500Z.tgz', 'hindsight-2020-02-01T041500Z.dump', 'backup-2020-02-01T041500Z.status'])
      assert.ok(p.files.includes(kept), `${kept} is the last restorable copy`);
    assert.equal(p.files.includes('better-bots-2020-01-15T041500Z.tgz'), false, 'older copies still expire');
    assert.equal(p.files.includes('hindsight-2020-01-15T041500Z.dump'), false);
  } finally {fs.rmSync(p.root,{recursive:true,force:true});}
});

test('configured exclusions leave bulk data out of the copy and archive but keep the state beside it', () => {
  const p = probe('success', {env:{BETTER_BOTS_BACKUP_EXCLUDE:'data/cache data/live/*.jsonl'}, setup:({source}) => {
    for (const [name, text] of [['data/cache/items.json', 'bulk'], ['data/live/2026-10-01.jsonl', 'bulk'],
      ['data/live/status.json', '{}'], ['data/catalog/records.sqlite', 'records']]) {
      fs.mkdirSync(path.dirname(path.join(source, name)), {recursive:true}); fs.writeFileSync(path.join(source, name), text);
    }
  }});
  try {
    assert.equal(p.result.status, 0, p.result.stderr);
    const archive = newArchive(p.files);
    const listed = spawnSync('tar', ['tzf', path.join(p.dest, archive)], {encoding:'utf8'}).stdout;
    assert.match(listed, /state\/data\/catalog\/records\.sqlite/);
    assert.match(listed, /state\/data\/live\/status\.json/);
    assert.match(listed, /state\/fact\.txt/);
    assert.doesNotMatch(listed, /items\.json|2026-10-01\.jsonl/);
    assert.match(fs.readFileSync(path.join(p.dest, p.files.find(f => f.endsWith('.manifest'))), 'utf8'), /excluded=data\/cache data\/live\/\*\.jsonl/);
  } finally {fs.rmSync(p.root,{recursive:true,force:true});}
  const bad = probe('success', {env:{BETTER_BOTS_BACKUP_EXCLUDE:'../etc'}});
  try { assert.equal(bad.result.status, 1); assert.match(bad.result.stderr, /relative path/); }
  finally {fs.rmSync(bad.root,{recursive:true,force:true});}
});

test('with no memory database configured, the local state alone is a complete backup and PostgreSQL is never touched', () => {
  // "unavailable" fails any database call, so success proves none was made.
  const p = probe('unavailable', {env:{BETTER_BOTS_BACKUP_DATABASE:'none'}});
  try {
    assert.equal(p.result.status, 0, p.result.stderr);
    assert.equal(fs.existsSync(path.join(p.root, 'sudo.log')), false);
    assert.equal(p.files.some(f => f.startsWith('hindsight-') && !f.includes('2020-') && !f.includes('2099-')), false);
    assert.match(fs.readFileSync(path.join(p.dest, p.files.find(f => f.endsWith('.status'))), 'utf8'), /^COMPLETE\n.*\ndatabase_dump=not_configured/s);
    assert.match(fs.readFileSync(path.join(p.dest, p.files.find(f => f.endsWith('.manifest'))), 'utf8'), /database_sha256=none/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'state', 'backup-status.json'), 'utf8')).result, 'complete');
    assert.match(p.result.stdout, /no memory database is configured/);
  } finally {fs.rmSync(p.root,{recursive:true,force:true});}
});

test('a named memory database on another PostgreSQL port is the one checked and dumped', () => {
  const p = probe('success', {env:{BETTER_BOTS_BACKUP_DATABASE:'better_bots_hindsight', BETTER_BOTS_BACKUP_PGPORT:'5433'}});
  try {
    assert.equal(p.result.status, 0, p.result.stderr);
    const calls = fs.readFileSync(path.join(p.root, 'sudo.log'), 'utf8');
    assert.match(calls, /^psql -X -p 5433 .*-d better_bots_hindsight /m);
    assert.match(calls, /^pg_dump -p 5433 -Fc better_bots_hindsight$/m);
    assert.doesNotMatch(calls, /-d hindsight|Fc hindsight$/m);
  } finally {fs.rmSync(p.root,{recursive:true,force:true});}
  for (const [name, value] of [['BETTER_BOTS_BACKUP_DATABASE', 'x; rm -rf /'], ['BETTER_BOTS_BACKUP_PGPORT', '54x']]) {
    const bad = probe('success', {env:{[name]:value}});
    try { assert.equal(bad.result.status, 1); assert.equal(Boolean(newArchive(bad.files)), false, 'refused before anything ran'); }
    finally {fs.rmSync(bad.root,{recursive:true,force:true});}
  }
});

test('unset, the database is dumped only when this machine has a hindsight database', () => {
  for (const [mode, dumped] of [['success', true], ['no_database', false]]) {
    const p = probe(mode, {env:{BETTER_BOTS_BACKUP_DATABASE:''}});
    try {
      assert.equal(p.result.status, 0, p.result.stderr);
      assert.equal(p.files.some(f => f.startsWith('hindsight-') && !f.includes('2020-') && !f.includes('2099-') && f.endsWith('.dump')), dumped, mode);
      assert.match(fs.readFileSync(path.join(p.dest,p.files.find(f => f.endsWith('.status'))),'utf8'), /^COMPLETE/);
    } finally { fs.rmSync(p.root, {recursive:true, force:true}); }
  }
});
