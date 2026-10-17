#!/usr/bin/env python3
"""Configure the optional Hindsight memory service without logging keys.

Everything it creates carries a Better Bots name, so a Hindsight or PostgreSQL
the owner already runs is left alone: its own account, state folder, database
and port.
"""
import getpass
import json
import os
from pathlib import Path
import pwd
import secrets
import subprocess
import sys
from urllib.parse import urlparse

ACCOUNT = 'better-bots-hindsight'
STATE = '/var/lib/better-bots-hindsight'
DATABASE = 'better_bots_hindsight'


def port(value):
    if not value.isdigit() or not 1024 <= int(value) <= 65535:
        raise SystemExit(f'Not a usable port: {value}')
    return value


def env_value(value):
    if any(ord(c) < 32 for c in value):
        raise ValueError('Settings cannot contain control characters')
    return json.dumps(value, ensure_ascii=False)


def private_env(path, values, owner):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    account = pwd.getpwnam(owner)
    with os.fdopen(fd, 'w') as file:
        os.fchown(file.fileno(), account.pw_uid, account.pw_gid)
        file.write(''.join(f'{key}={env_value(value)}\n' for key, value in values.items()))


def configure(hindsight_port, pg_port):
    if os.geteuid() != 0:
        raise SystemExit('Run through install.sh.')
    psql = ['sudo', '-u', 'postgres', 'psql', '-X', '-p', pg_port]
    print('\nMemory setup: choose your own OpenAI-compatible extraction model.')
    print('Agent models are configured separately in App settings after installation.')
    base = input('API base URL (include /v1 when required): ').strip().rstrip('/')
    url = urlparse(base)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise SystemExit('Use an HTTP(S) API base URL without credentials, query, or fragment.')
    if url.scheme == 'http' and url.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise SystemExit('Use HTTPS for remote model endpoints.')
    model = input('Model ID: ').strip()
    key = getpass.getpass('API key (hidden; enter local for a keyless local server): ').strip()
    if not model or not key:
        raise SystemExit('A model and key are required. No model request was sent.')
    for value in (base, model, key):
        env_value(value)
    dbpass, token = secrets.token_hex(24), secrets.token_hex(24)
    # Names and password alphabet are fixed. Never alter an existing database/role.
    existing = subprocess.check_output(psql + ['-tAc',
        f"SELECT EXISTS(SELECT FROM pg_roles WHERE rolname='{DATABASE}') OR EXISTS(SELECT FROM pg_database WHERE datname='{DATABASE}')"], text=True).strip()
    if existing != 'f':
        raise SystemExit(f'An existing {DATABASE} database or role needs manual review; left unchanged.')
    subprocess.run(psql + ['-v', 'ON_ERROR_STOP=1', '-q'],
        input=f"CREATE ROLE {DATABASE} LOGIN PASSWORD '{dbpass}';\nCREATE DATABASE {DATABASE} OWNER {DATABASE};\n", text=True, check=True)
    subprocess.run(psql + ['-v', 'ON_ERROR_STOP=1', '-q', '-d', DATABASE, '-c',
        'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;'], check=True)
    values = {
        'HINDSIGHT_API_HOST': '127.0.0.1', 'HINDSIGHT_API_PORT': hindsight_port,
        'HINDSIGHT_API_WORKER_ID': 'better-bots', 'HINDSIGHT_API_MCP_ENABLED': 'false',
        'HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION': 'false',
        'HINDSIGHT_API_DATABASE_URL': f'postgresql://{DATABASE}:{dbpass}@127.0.0.1:{pg_port}/{DATABASE}',
        'HINDSIGHT_API_TENANT_EXTENSION': 'hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension',
        'HINDSIGHT_API_TENANT_API_KEY': token,
        'HINDSIGHT_API_LLM_PROVIDER': 'openai', 'HINDSIGHT_API_LLM_API_KEY': key,
        'HINDSIGHT_API_LLM_MODEL': model, 'HINDSIGHT_API_LLM_BASE_URL': base,
        'HINDSIGHT_API_EMBEDDINGS_PROVIDER': 'onnx',
        'HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID': 'BAAI/bge-small-en-v1.5',
        'HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS': '384',
        'HINDSIGHT_API_RERANKER_PROVIDER': 'flashrank',
        'HINDSIGHT_API_RERANKER_FLASHRANK_MODEL': 'ms-marco-MiniLM-L-12-v2',
        'HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR': f'{STATE}/flashrank',
        'HINDSIGHT_API_RERANKER_MAX_CANDIDATES_LOW': '12',
        'HINDSIGHT_API_RERANKER_FLASHRANK_BATCH_SIZE': '1',
        'HINDSIGHT_API_ANN_ITERATIVE_SCAN': 'false',
        'HF_HOME': f'{STATE}/hf', 'HOME': STATE,
    }
    private_env(f'{STATE}/hindsight.env', values, ACCOUNT)
    private_env('/var/lib/better-bots/better-bots.env', {
        'HINDSIGHT_URL': f'http://127.0.0.1:{hindsight_port}', 'HINDSIGHT_API_KEY': token,
    }, 'better-bots')
    print('Memory configuration saved. No keys displayed and no agents created.')

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: configure-memory.py HINDSIGHT_PORT POSTGRES_PORT')
    configure(port(sys.argv[1]), port(sys.argv[2]))
