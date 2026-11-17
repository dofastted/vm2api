import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROACTIVE_REFRESH_SKEW_MS,
  REFRESH_SKEW_MS,
  ensureOfficialCredentialLink,
} from '../../src/lib/oauth/oauth-credentials.mjs'
import {
  createCredentialRefreshMonitor,
  isLocalCredentialLinkTarget,
  needsScheduledRefresh,
} from '../../src/lib/oauth/credential-refresh-monitor.mjs'
import { repairLocalCredentialLink } from '../../src/lib/transport/go-worker-client.mjs'

function slotHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-race-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'vms', 'cf-test', 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  return home
}

function grant(refreshToken, expiresAt, extra = {}) {
  return JSON.stringify({ claudeAiOauth: { accessToken: `at-${refreshToken}`, refreshToken, expiresAt, ...extra } })
}

const readGrant = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth

test('scheduled refresh is due before the in-slot CLI 5-minute window', () => {
  assert.ok(PROACTIVE_REFRESH_SKEW_MS >= REFRESH_SKEW_MS + 5 * 60 * 1000, 'must beat the CLI by a full monitor tick')
  const now = Date.now()
  const slot = (ms) => ({ id: 'vm', expires_at: now + ms })
  assert.equal(needsScheduledRefresh(slot(10 * 60 * 1000), now), true)
  assert.equal(needsScheduledRefresh(slot(20 * 60 * 1000), now), false)
  assert.equal(needsScheduledRefresh({ ...slot(60_000), refresh_error: 'invalid_grant' }, now), false)
})

test('rotation adopts the later grant the CLI wrote over a broken alias, then relinks', (t) => {
  const home = slotHome(t)
  const worker = path.join(home, '.claude', 'credentials.json')
  const official = path.join(home, '.claude', '.credentials.json')
  fs.writeFileSync(worker, grant('rt-old', 1000, { accountUuid: 'acct-1' }))
  fs.writeFileSync(official, grant('rt-new', 2000, { accountUuid: 'acct-1' }))
  const r = ensureOfficialCredentialLink(home, { adoptOfficial: 'rotation' })
  assert.equal(r.linked, true)
  assert.equal(r.adopted, true)
  assert.equal(fs.readlinkSync(official), 'credentials.json')
  assert.equal(readGrant(worker).refreshToken, 'rt-new')
})

test('rotation keeps the worker grant when the CLI copy is older or the same', (t) => {
  const home = slotHome(t)
  const worker = path.join(home, '.claude', 'credentials.json')
  const official = path.join(home, '.claude', '.credentials.json')
  fs.writeFileSync(worker, grant('rt-host', 2000))
  fs.writeFileSync(official, grant('rt-stale', 1000))
  assert.equal(ensureOfficialCredentialLink(home, { adoptOfficial: 'rotation' }).adopted, false)
  assert.equal(readGrant(worker).refreshToken, 'rt-host')
  assert.equal(fs.lstatSync(official).isSymbolicLink(), true)
})

test('rotation never adopts another account or seeds an empty slot', (t) => {
  const home = slotHome(t)
  const worker = path.join(home, '.claude', 'credentials.json')
  const official = path.join(home, '.claude', '.credentials.json')
  fs.writeFileSync(worker, grant('rt-host', 1000, { accountUuid: 'acct-1' }))
  fs.writeFileSync(official, grant('rt-other', 2000, { accountUuid: 'acct-2' }))
  assert.equal(ensureOfficialCredentialLink(home, { adoptOfficial: 'rotation' }).adopted, false)
  assert.equal(readGrant(worker).refreshToken, 'rt-host')

  const empty = slotHome(t)
  fs.writeFileSync(path.join(empty, '.claude', '.credentials.json'), grant('rt-loose', 2000))
  const r = ensureOfficialCredentialLink(empty, { adoptOfficial: 'rotation' })
  assert.equal(r.linked, undefined)
  assert.equal(fs.existsSync(path.join(empty, '.claude', 'credentials.json')), false)
})

test('repairLocalCredentialLink relinks a regular alias file without losing the grant', async (t) => {
  const home = slotHome(t)
  const worker = path.join(home, '.claude', 'credentials.json')
  const official = path.join(home, '.claude', '.credentials.json')
  fs.writeFileSync(worker, grant('rt-1', 1000))
  fs.writeFileSync(official, grant('rt-1', 1000, { rateLimitTier: 'default_claude_ai' }))
  const r = await repairLocalCredentialLink(home)
  assert.equal(r.linked, true)
  assert.equal(fs.readlinkSync(official), 'credentials.json')
  assert.equal(readGrant(official).refreshToken, 'rt-1')
})

test('monitor relinks idle local Claude slots every tick and reports failures', async () => {
  const base = { status: 'running', claude: { has_access: true, has_refresh: true }, expires_at: Date.now() + 3600_000 }
  const vms = [
    { ...base, id: 'local-ok' },
    { ...base, id: 'local-bad' },
    { ...base, id: 'remote', node_id: 'node-a' },
    { ...base, id: 'stopped', status: 'stopped' },
    { ...base, id: 'empty', claude: {} },
  ]
  assert.deepEqual(
    vms.filter(isLocalCredentialLinkTarget).map((v) => v.id),
    ['local-ok', 'local-bad'],
  )
  const seen = []
  const monitor = createCredentialRefreshMonitor({
    listTargets: () => vms,
    refreshOne: () => assert.fail('fresh grants must not be exchanged'),
    ensureLocalLink: async (vm) => {
      seen.push(vm.id)
      if (vm.id === 'local-bad') throw new Error('private diagnostic')
      return { linked: true }
    },
  })
  const snap = await monitor.runOnce()
  assert.deepEqual(seen.sort(), ['local-bad', 'local-ok'])
  assert.deepEqual(snap.link_failures, [{ vm_id: 'local-bad', reason: 'local_credential_link_failed' }])
})
