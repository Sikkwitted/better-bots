"""Host-only file transactions. stdin/stdout JSON; no agent-supplied code executes."""
import copy
import fcntl
import hashlib
import json
import os
import stat
import sys
import time
import uuid
import unicodedata


def phase(name):
    """Crash-test seam; production does not inject a callback."""


def fail(code):
    raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def revision(data):
    return 'missing' if data is None else digest(data)


def packed(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def atomic(directory, name, data, mode=0o600):
    temporary = '.transaction-' + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        phase('staged')
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def read_at(directory, name, max_bytes=None):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as inp:
        info = os.fstat(inp.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            fail('unsafe_file_alias')
        if max_bytes is not None and (not isinstance(max_bytes, int) or max_bytes < 0 or info.st_size > max_bytes):
            fail('file_too_large')
        if max_bytes is not None:
            data = inp.read(max_bytes + 1)
            if len(data) > max_bytes:
                fail('file_too_large')
            return data
        return inp.read()


def canonical_name(directory, name):
    normalized = unicodedata.normalize('NFC', name).casefold()
    if any(entry != name and unicodedata.normalize('NFC', entry).casefold() == normalized for entry in os.listdir(directory)):
        fail('unsafe_file_alias')


def parent(root, parts, create):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            canonical_name(fd, part)
            if create:
                try:
                    os.mkdir(part, mode=0o755, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def preserve_owners(before, after, actor):
    # Explicit owner declarations cannot be changed or bypassed by replacing a parent.
    if isinstance(before, dict):
        owner = before.get('owner_agent_id')
        if owner and (not isinstance(after, dict) or after.get('owner_agent_id') != owner):
            fail('ownership_change_denied')
        if owner and owner != actor and before != after:
            fail('not_yours')
        for key, value in before.items():
            preserve_owners(value, after.get(key) if isinstance(after, dict) else None, actor)
    elif isinstance(before, list):
        for index, item in enumerate(before):
            preserve_owners(item, after[index] if isinstance(after, list) and index < len(after) else None, actor)


def patch_json(data, changes, actor):
    value = json.loads(data) if data is not None else {}
    before = copy.deepcopy(value)
    if not isinstance(value, dict) or not isinstance(changes, list) or not changes:
        fail('invalid_patch')
    for change in changes:
        keys = change.get('path')
        if not isinstance(keys, list) or not keys or any(not isinstance(k, str) or not k or k in ('__proto__', 'prototype', 'constructor') for k in keys):
            fail('invalid_patch_path')
        node = value
        for key in keys[:-1]:
            if not isinstance(node, dict) or key not in node or not isinstance(node[key], dict):
                fail('patch_parent_missing')
            node = node[key]
        exists = keys[-1] in node
        expected = change.get('expected')
        if not isinstance(expected, dict) or expected.get('exists') is not exists:
            fail('conflict')
        if exists and ('value' not in expected or packed(node[keys[-1]]) != packed(expected['value'])):
            fail('conflict')
        if change.get('delete') is True:
            if not exists:
                fail('conflict')
            del node[keys[-1]]
        elif 'value' in change:
            node[keys[-1]] = change['value']
        else:
            fail('invalid_patch')
    preserve_owners(before, value, actor)
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode() + b'\n'


def execute(request):
    root = request['workspace']
    relative = request['path']
    parts = relative.split('/')
    if os.path.isabs(relative) or any(p in ('', '.', '..') for p in parts):
        fail('outside_workspace')
    actor = request['actor']
    if not isinstance(actor, str) or not actor or '/' in actor or actor in ('.', '..'):
        fail('invalid_actor')
    own = len(parts) > 2 and parts[0] == 'agents'
    if parts[0] == 'agents' and (not own or parts[1] != actor) and request['action'] != 'read':
        fail('not_yours')
    state = request['state_dir']
    os.makedirs(state, mode=0o700, exist_ok=True)
    transaction_dir = os.path.join(state, digest(relative.encode()))
    os.makedirs(transaction_dir, mode=0o700, exist_ok=True)
    state_fd = os.open(state, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(state_fd)
    finally:
        os.close(state_fd)
    journal = os.open(transaction_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = os.open('lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=journal)
    target = None
    try:
        deadline = time.monotonic() + 2
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    fail('locked')
                time.sleep(.01)
        phase('locked')
        pending_data = read_at(journal, 'pending.json')
        pending = json.loads(pending_data) if pending_data else None
        try:
            target = parent(root, parts, request['action'] != 'read' or pending is not None)
        except FileNotFoundError:
            return {'ok': False, 'error': 'not_found', 'revision': 'missing', 'path': relative}
        name = parts[-1]
        canonical_name(target, name)
        current = read_at(target, name, request.get('max_bytes') if request['action'] == 'read' else None)
        if pending:
            if revision(current) not in (pending['before'], pending['after']):
                fail('reconciliation_required')
            if revision(current) == pending['before']:
                atomic(target, name, pending['content'].encode(), pending['mode'])
            atomic(journal, pending['receipt'], packed(pending['result']))
            os.unlink('pending.json', dir_fd=journal)
            os.fsync(journal)
            current = read_at(target, name, request.get('max_bytes') if request['action'] == 'read' else None)
        if request['action'] == 'read':
            return {'ok': current is not None, **({'error': 'not_found'} if current is None else {'content': current.decode()}), 'revision': revision(current), 'path': relative}
        operation = request.get('operation_id')
        if not isinstance(operation, str) or not operation or len(operation) > 200:
            fail('operation_id_required')
        receipt = digest(packed([actor, operation])) + '.json'
        fingerprint = digest(packed({k: request.get(k) for k in ('actor', 'action', 'path', 'content', 'changes', 'expected_revision')}))
        previous = read_at(journal, receipt)
        if previous:
            result = json.loads(previous)
            if result['fingerprint'] != fingerprint:
                fail('idempotency_conflict')
            return {**result, 'duplicate': True}
        before = revision(current)
        if request['action'] == 'write':
            # Owned files keep their existing single-writer contract; shared replacements require CAS.
            if not own and request.get('expected_revision') != before:
                fail('revision_required' if 'expected_revision' not in request else 'conflict')
            updated = request['content'].encode()
            before_json = None
            is_json = relative.endswith('.json')
            if current is not None:
                try:
                    before_json = json.loads(current)
                    is_json = True
                except json.JSONDecodeError:
                    if is_json:
                        fail('invalid_json')
            if is_json:
                after_json = json.loads(updated)
                preserve_owners(before_json, after_json, actor)
        elif request['action'] == 'patch':
            updated = patch_json(current, request['changes'], actor)
        else:
            fail('unknown_action')
        result = {'ok': True, 'path': relative, 'revision': revision(updated), 'bytes': len(updated), 'shared': not own, 'operation_id': operation, 'fingerprint': fingerprint, 'duplicate': False}
        mode = stat.S_IMODE(os.stat(name, dir_fd=target, follow_symlinks=False).st_mode) if current is not None else 0o644
        pending = {'before': before, 'after': revision(updated), 'content': updated.decode(), 'mode': mode, 'receipt': receipt, 'result': result}
        atomic(journal, 'pending.json', packed(pending))
        phase('prepared')
        atomic(target, name, updated, mode)
        phase('replaced')
        if read_at(target, name) != updated:
            fail('verification_failed')
        atomic(journal, receipt, packed(result))
        phase('receipted')
        os.unlink('pending.json', dir_fd=journal)
        os.fsync(journal)
        return result
    finally:
        if target is not None:
            os.close(target)
        os.close(lock)  # Kernel releases ownership on normal exit AND process death.
        os.close(journal)


def main():
    try:
        print(json.dumps(execute(json.load(sys.stdin))))
    except (ValueError, OSError, KeyError, TypeError) as error:
        code = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else ('invalid_json' if isinstance(error, json.JSONDecodeError) else 'unsafe_path_or_io_error')
        print(json.dumps({'ok': False, 'error': code}))


if __name__ == '__main__':
    main()
