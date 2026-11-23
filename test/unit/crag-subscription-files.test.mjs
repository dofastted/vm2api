import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishedMatches } from '../../src/lib/cluster/crag-subscription-files.mjs'

const files = { device: '{"id":"d"}', permit: 'PERMIT', hostId: 'a'.repeat(64), entitlement: 'ENT' }
// Runs the generated script with the local shell, standing in for the node.
const localRun = async (_client, script) => execFileSync('sh', ['-c', script], { encoding: 'utf8' })

function slot(contents = files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-subfiles-'))
  const hostDir = path.join(root, 'subscription-host')
  const licenseDir = path.join(root, 'subscription-license')
  fs.mkdirSync(hostDir)
  fs.mkdirSync(licenseDir)
  fs.writeFileSync(path.join(licenseDir, 'device.json'), `${contents.device}\n`)
  fs.writeFileSync(path.join(licenseDir, 'registration.code'), `${contents.permit}\n`)
  fs.writeFileSync(path.join(hostDir, 'host_id'), `${contents.hostId}\n`)
  fs.writeFileSync(path.join(hostDir, 'entitlement.code'), `${contents.entitlement}\n`)
  return { root, hostDir, licenseDir }
}

test('a node already holding the same subscription files needs no republish', async () => {
  const s = slot()
  try {
    assert.equal(await publishedMatches(null, s.hostDir, s.licenseDir, files, { run: localRun }), true)
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true })
  }
})

test('changed, missing or mid-sync files are republished', async () => {
  const s = slot({ ...files, permit: 'OLD' })
  try {
    assert.equal(await publishedMatches(null, s.hostDir, s.licenseDir, files, { run: localRun }), false)
    fs.writeFileSync(path.join(s.licenseDir, 'registration.code'), `${files.permit}\n`)
    fs.writeFileSync(path.join(s.hostDir, 'sync-pending'), 'pending\n')
    assert.equal(await publishedMatches(null, s.hostDir, s.licenseDir, files, { run: localRun }), false)
    fs.rmSync(path.join(s.hostDir, 'sync-pending'))
    fs.rmSync(path.join(s.hostDir, 'entitlement.code'))
    assert.equal(await publishedMatches(null, s.hostDir, s.licenseDir, files, { run: localRun }), false)
    const failing = async () => {
      throw new Error('link down')
    }
    assert.equal(await publishedMatches(null, s.hostDir, s.licenseDir, files, { run: failing }), false)
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true })
  }
})
