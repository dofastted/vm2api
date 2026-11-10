import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evaluateCredentialEligibility } from '../../src/lib/pool/schedule-eligibility.mjs'
import { withCragCredential } from '../../src/lib/transport/rust-kernel-client.mjs'

test('a CRAG v2 slot created with an API key stays selectable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-key-'))
  const secret = 'sk-ant-slot-key'
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.claude', 'credentials.json'),
    JSON.stringify({ anthropicApiKey: { apiKey: secret } }),
  )
  const health = withCragCredential(
    { homeDir: home },
    { ok: true, dataplane: 'crag', kernel_version: 'v2', runtime_variant: 'crag-v2', ready_slots: 4 },
  )
  assert.equal(health.credential.has_access, true)
  assert.equal(health.credential.has_refresh, false)
  assert.equal(health.credential.needs_refresh, false)
  assert.equal(JSON.stringify(health).includes(secret), false)
  const gate = evaluateCredentialEligibility({
    vm: { id: 'vm-01', claude: { has_access: true, has_api_key: true, mode: 'apikey' } },
    workerStatus: health,
  })
  assert.equal(gate.ok, true)
  fs.rmSync(home, { recursive: true, force: true })
})

test('cli-node health is not given a CRAG credential', () => {
  const health = withCragCredential({ homeDir: '/missing' }, { ok: true, dataplane: 'wrap', ready_slots: 1 })
  assert.equal(health.credential, undefined)
})
