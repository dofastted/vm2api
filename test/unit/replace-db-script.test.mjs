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

test('deploy/replace-db-to-pg.sh supports docker, systemd, external PG, dry-run, and rollback', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/replace-db-to-pg.sh'), 'utf8')
  assert.match(script, /--database-url/)
  assert.match(script, /--redis-url/)
  assert.match(script, /--dry-run/)
  assert.match(script, /--rollback/)
  assert.match(script, /--status/)
  assert.match(script, /systemd/)
  assert.match(script, /migrate-sqlite-to-pg\.mjs/)
  assert.match(script, /--verify/)
  assert.match(script, /--rollup/)
})

test('deploy/install.sh guards existing SQLite upgrades and exposes db-migrate/db-status/db-rollback', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/install.sh'), 'utf8')
  assert.match(script, /db-migrate/)
  assert.match(script, /db-status/)
  assert.match(script, /db-rollback/)
  assert.match(script, /replace-db-to-pg\.sh/)
  assert.match(script, /POSTGRES_PASSWORD/)
  assert.match(script, /REDIS_PASSWORD/)
})

test('deploy/bluegreen/bg-deploy.sh guards PG migrations and uses --no-deps for app colors', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/bluegreen/bg-deploy.sh'), 'utf8')
  assert.match(script, /pg-migrations/)
  assert.match(script, /--no-deps/)
})
