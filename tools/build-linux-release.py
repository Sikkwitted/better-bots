#!/usr/bin/env python3
"""Export the current harness without private applications, state, or Git history."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/linux-release'
NAME = 'better-bots-mint-22-alpha'
DEST = OUT / NAME

def export(*, archives=True):
    OUT.mkdir(parents=True, exist_ok=True)
    if DEST.exists():
        if DEST.is_symlink():
            raise RuntimeError('Refusing symlink output')
        shutil.rmtree(DEST)
    DEST.mkdir()
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    selected = []
    # Only tracked files ship, so anything local and ignored stays behind.
    for name in tracked:
        if name.startswith(('src/', 'web/')):
            selected.append(name)
    selected += ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY.md',
                 'SECURITY.md', 'docs/MEMORY-CONTRACT.md', 'deploy/better-bots.service',
                 'deploy/backup.sh', 'deploy/consolidate.sh']
    for name in selected:
        source = ROOT / name
        if source.is_symlink() or not source.is_file():
            raise RuntimeError('Expected regular release source: ' + name)
        target = DEST / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    # verify-release.mjs confirms no local state or untracked files came along.
    for name in ['install.sh', 'configure-memory.py', 'window.py', 'README.md', 'verify-release.mjs']:
        shutil.copyfile(ROOT / 'deploy/linux' / name, DEST / name)
    shutil.copyfile(ROOT / 'tools/app/icon.png', DEST / 'icon.png')
    for name in ['install.sh', 'configure-memory.py', 'window.py', 'deploy/backup.sh', 'deploy/consolidate.sh']:
        (DEST / name).chmod(0o755)
    package = json.loads((DEST / 'package.json').read_text())
    package['scripts'] = {'gui': 'node src/server.js', 'cli': 'node src/cli.js', 'test': 'node verify-release.mjs'}
    (DEST / 'package.json').write_text(json.dumps(package, indent=2) + '\n')
    lock = json.loads((DEST / 'package-lock.json').read_text())
    lock['version'] = package['version']
    lock['packages']['']['version'] = package['version']
    (DEST / 'package-lock.json').write_text(json.dumps(lock, indent=2) + '\n')
    # Explicitly inventory all bytes shipped. No recursive checkout copy.
    (DEST / 'BUILD.json').write_text(json.dumps({'source_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip(),
        'source_revision_note': 'Base commit; SHA256SUMS identifies the exported working-tree bytes and harness transformations',
        'edition': 'harness-only', 'target': 'Linux Mint 22.x x86_64', 'status': 'alpha; installed and checked on Linux Mint 22.3 with SQLite memory (2026-10-13); not yet on a freshly installed machine'}, indent=2) + '\n')
    files = sorted(p for p in DEST.rglob('*') if p.is_file())
    (DEST / 'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.relative_to(DEST).as_posix() + '\n' for p in files))
    if not archives:
        return DEST
    archive = OUT / (NAME + '.tar.gz')
    def archive_metadata(info):
        info.uid = info.gid = 0
        info.uname = info.gname = 'root'
        info.mtime = 0
        return info
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(DEST, arcname=NAME, filter=archive_metadata)
    (OUT / (archive.name + '.sha256')).write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')
    installer = OUT / (NAME + '.run')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    stub = f"""#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = Linux ] || {{ echo 'Run this installer on Linux Mint 22.x.' >&2; exit 1; }}
TEMP_RELEASE=$(mktemp -d)
trap 'rm -rf -- "$TEMP_RELEASE"' EXIT
PAYLOAD_LINE=$(awk '/^__BETTER_BOTS_PAYLOAD__$/ {{ print NR + 1; exit }}' "$0")
tail -n +"$PAYLOAD_LINE" "$0" > "$TEMP_RELEASE/payload.tar.gz"
printf '%s  %s\n' '{digest}' "$TEMP_RELEASE/payload.tar.gz" | sha256sum --check --quiet
tar -xzf "$TEMP_RELEASE/payload.tar.gz" -C "$TEMP_RELEASE"
bash "$TEMP_RELEASE/{NAME}/install.sh" "$@"
exit 0
__BETTER_BOTS_PAYLOAD__
"""
    installer.write_bytes(stub.encode() + archive.read_bytes())
    installer.chmod(0o755)
    (OUT / (installer.name + '.sha256')).write_text(hashlib.sha256(installer.read_bytes()).hexdigest() + '  ' + installer.name + '\n')
    print(installer)
    print(archive)
    print(f'{len(files)} files; {archive.stat().st_size / 1024 / 1024:.1f} MiB')

if __name__ == '__main__':
    export()
