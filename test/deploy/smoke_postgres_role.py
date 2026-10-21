#!/usr/bin/env python3
"""Verify the Compose bootstrap role in a disposable PostgreSQL container."""
import os
from pathlib import Path
import secrets
import subprocess
import time
import uuid

name = 'vm2api-pg-role-test-' + uuid.uuid4().hex[:10]
root = Path(__file__).resolve().parents[2]
env = os.environ.copy()
env['VM2API_POSTGRES_PASSWORD'] = secrets.token_hex(32)
env['PGPASSWORD'] = env['VM2API_POSTGRES_PASSWORD']
env['POSTGRES_INITDB_ARGS'] = '--auth-host=scram-sha-256'


def run(args, check=True):
    return subprocess.run(['docker', *args], env=env, capture_output=True, text=True, check=check)


try:
    run(['run', '-d', '--name', name, '--network', 'none', '-e', 'VM2API_POSTGRES_PASSWORD', '-e', 'POSTGRES_INITDB_ARGS',
         '-v', str(root / 'deploy/postgres-entrypoint.sh') + ':/usr/local/bin/vm2api-postgres-entrypoint:ro',
         '-v', str(root / 'deploy/postgres-init.sh') + ':/docker-entrypoint-initdb.d/10-vm2api.sh:ro',
         '--entrypoint', '/bin/bash', 'postgres:17-bookworm',
         '/usr/local/bin/vm2api-postgres-entrypoint', 'postgres'])
    deadline = time.monotonic() + 60
    while run(['exec', name, 'psql', '-U', 'vm2api', '-d', 'vm2api', '-Atqc', 'SELECT 1'], False).returncode:
        if time.monotonic() > deadline:
            raise RuntimeError('isolated role test PostgreSQL did not become ready')
        time.sleep(0.25)
    flags = run(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atqc',
                 "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='vm2api'"]).stdout.strip()
    owner = run(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atqc',
                 "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='vm2api'"]).stdout.strip()
    assert flags == 'f|f|f|f', 'application role permissions differ'
    assert owner == 'vm2api', 'application database has a different owner'
    run(['exec', '-e', 'PGPASSWORD', name, 'psql', '-h', '127.0.0.1', '-U', 'vm2api', '-d', 'vm2api',
         '--no-password', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE TABLE role_check (id integer); DROP TABLE role_check;'])
    bootstrap = run(['exec', '-e', 'PGPASSWORD', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres',
                     '--no-password', '-Atqc', 'SELECT 1'], False)
    assert bootstrap.returncode != 0 and 'password authentication failed' in bootstrap.stderr, 'bootstrap must use a different password'
    denied = run(['exec', '-e', 'PGPASSWORD', name, 'psql', '-h', '127.0.0.1', '-U', 'vm2api', '-d', 'vm2api',
                  '--no-password', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE forbidden_role_test;'], False)
    assert denied.returncode != 0 and 'permission denied' in denied.stderr, 'application role must not create databases'
    print('PASS: app role has no superuser/createdb/createrole/replication; owns database; '
          'password auth and DDL work; bootstrap password differs; CREATE DATABASE denied')
finally:
    run(['rm', '-fv', name], False)
