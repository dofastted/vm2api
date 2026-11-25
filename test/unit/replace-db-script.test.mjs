import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

test('docker-compose.yml pins PGDATA for postgres:18-alpine and binds PG/Redis strictly to 127.0.0.1', () => {
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8')
  assert.match(compose, /PGDATA:\s*\/var\/lib\/postgresql\/data/)
  assert.match(compose, /127\.0\.0\.1:\$\{VM2API_PG_PORT:-5432\}:5432/)
  assert.match(compose, /127\.0\.0\.1:\$\{VM2API_REDIS_PORT:-6379\}:6379/)
  assert.match(compose, /network_mode:\s*host/)
})

test('docker-compose.local.yml mounts local PG and Redis directories cleanly', () => {
  const local = fs.readFileSync(path.join(ROOT, 'docker-compose.local.yml'), 'utf8')
  assert.match(local, /\/var\/lib\/postgresql\/data/)
  assert.match(local, /:\/data/)
})

test('both amd64 and arm64 control-plane Dockerfiles install postgresql-client for pg_dump/pg_restore/pg_isready', () => {
  const amd64 = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
  const arm64 = fs.readFileSync(path.join(ROOT, 'deploy/Dockerfile.arm64-control'), 'utf8')
  assert.match(amd64, /postgresql-client/)
  assert.match(arm64, /postgresql-client/)
})

test('scripts/docker-entrypoint.sh protects unmigrated SQLite and waits for DATABASE_URL via pg_isready -d', () => {
  const entry = fs.readFileSync(path.join(ROOT, 'scripts/docker-entrypoint.sh'), 'utf8')
  assert.match(entry, /data\/kin\.db/)
  assert.match(entry, /VM2API_DB_DRIVER=sqlite/)
  assert.match(entry, /pg_isready -d "\$pg_url"/)
})

test('deploy/replace-db-to-pg.sh enforces pre-stop dependency/connectivity checks, exact container matching, and safe rollback', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/replace-db-to-pg.sh'), 'utf8')
  assert.match(script, /--database-url/)
  assert.match(script, /--redis-url/)
  assert.match(script, /--pg-runtime/)
  assert.match(script, /--local-data/)
  assert.match(script, /--check-deps/)
  assert.match(script, /--preflight/)
  assert.match(script, /--no-install-deps/)
  assert.match(script, /--auto-pull/)
  assert.match(script, /--dry-run/)
  assert.match(script, /--rollback/)
  assert.match(script, /--status/)
  assert.match(script, /systemd_env_get/)
  assert.match(script, /ensure_host_migrator_script/)
  assert.match(script, /run_sqlite_preflight/)
  assert.match(script, /EnvironmentFile=/)
  assert.match(script, /\.env\.postgres/)
  assert.match(script, /--maxmemory 256mb --maxmemory-policy allkeys-lru/)
  assert.match(script, /GRANT ALL ON SCHEMA public/)
  assert.match(script, /ensure_base_host_deps/)
  assert.match(script, /ensure_docker_runtime/)
  assert.match(script, /ensure_native_pg_redis_deps/)
  assert.match(script, /ensure_host_node_pg_deps/)
  assert.match(script, /verify_docker_migrator_image/)
  assert.match(script, /probe_pg_connectivity/)
  assert.match(script, /probe_redis_connectivity/)
  assert.match(script, /resolve_safe_local_port/)
  assert.match(script, /wal_checkpoint\(TRUNCATE\)/)
  assert.match(script, /--force-recreate/)
  assert.match(script, /migrate-sqlite-to-pg\.mjs/)
  assert.match(script, /--verify/)
  assert.match(script, /--rollup/)
  // Must NEVER use loose substring container matching that could hit another Postgres container on host
  assert.doesNotMatch(script, /--filter "name=postgres"/)
  assert.match(script, /name=\^\/\$\{fallback_name\}\$/)
  // Systemd mode must resolve unit KIN_API_KEY before falling back to stale .env VM2API_API_KEY
  assert.match(script, /systemd_env_get KIN_API_KEY/)
  // Rollback trap must stop an already-started control plane before restarting onto SQLite
  assert.match(script, /cleanup_on_failure\(\)[\s\S]*stop_control_plane "\$MODE" "\$BG_ACTIVE"[\s\S]*start_control_plane "\$MODE" "\$BG_ACTIVE" 1/)
})

test('deploy/install.sh auto-installs PG dependencies, guards SQLite upgrades, and exposes PG flags + db-migrate', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/install.sh'), 'utf8')
  assert.match(script, /ensure_host_dependencies/)
  assert.match(script, /postgresql-client/)
  assert.match(script, /prepare-deps/)
  assert.match(script, /--database-url/)
  assert.match(script, /--redis-url/)
  assert.match(script, /--no-redis/)
  assert.match(script, /--pg-port/)
  assert.match(script, /--local-data/)
  assert.match(script, /--auto-migrate/)
  assert.match(script, /--no-install-deps/)
  assert.match(script, /need_local_pg/)
  assert.match(script, /need_local_redis/)
  assert.match(script, /resolve_local_db_ports/)
  assert.match(script, /ensure_migrate_script/)
  assert.match(script, /db-migrate/)
  assert.match(script, /db-status/)
  assert.match(script, /db-rollback/)
  assert.match(script, /replace-db-to-pg\.sh/)
  assert.match(script, /POSTGRES_PASSWORD/)
  assert.match(script, /REDIS_PASSWORD/)
})

test('deploy/install-pg.sh provides a unified one-click PG installer and seamless SQLite migration entrypoint', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/install-pg.sh'), 'utf8')
  assert.match(script, /--auto-migrate/)
  assert.match(script, /install --db postgres/)
  assert.match(script, /db-migrate/)
  assert.match(script, /db-rollback/)
  assert.match(script, /db-status/)
  assert.match(script, /--check-deps/)
  assert.match(script, /--preflight/)
  assert.match(script, /--dry-run/)
  assert.match(script, /is_systemd_host/)
})

test('deploy/bluegreen/bg-deploy.sh guards PG migrations, uses --no-deps, and preserves local PG/Redis during --bootstrap', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/bluegreen/bg-deploy.sh'), 'utf8')
  assert.match(script, /pg-migrations/)
  assert.match(script, /--no-deps/)
  // Must stop only the single vm2api container during bootstrap, never `docker compose down` (which stops postgres/redis)
  assert.doesNotMatch(script, /docker compose down --timeout 100/)
  assert.match(script, /docker stop -t 100 "\$BG_NAME"/)
})
