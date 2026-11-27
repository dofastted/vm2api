import { createMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CRAG_GEMINI_PRODUCT } from '../../src/lib/gemini/payload.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import {
  GEMINI_HOST_RESOURCE_MESSAGES,
  GEMINI_SANDBOX_MESSAGES,
  createGeminiCragSubscription,
} from '../../src/lib/gemini/subscription.mjs'

const GEMINI_ENV_ID = 'gemini-aaaaaaaaaaaaaaaaaaaaaaaa'
const PROXY_ID = 'proxy-aaaaaaaaaaaaaaaaaaaa'
const proxyUrl = 'socks5://127.0.0.1:1080'

function makeAuthority() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519')
  const publicBytes = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  return {
    publicKey,
    publicBytes,
    issuerId: crypto.createHash('sha256').update(publicBytes).digest('hex'),
    payloadKeyId: 'a'.repeat(64),
    softwareVersion: '0.4.13',
  }
}

function sandboxEnv(code) {
  return {
    id: GEMINI_ENV_ID,
    proxy_id: PROXY_ID,
    auth_method: 'oauth',
    auth_state: 'authorized',
    models_discovered: true,
    models: ['gemini-2.5-flash'],
    crag_license: { valid: false, code },
  }
}

function installedList(environments) {
  return {
    payload_state: 'installed',
    payload_mode: 'crag_subscription',
    environments,
  }
}

function proxyPool() {
  return {
    snapshot: () => ({ proxies: [{ id: PROXY_ID, enabled: true, status: 'ok', owner_user_id: null }] }),
    getProxyByIdWithAuth: (id) => (id === PROXY_ID ? { url: proxyUrl } : null),
  }
}

function makeSubscription(root) {
  const authority = makeAuthority()
  return createGeminiCragSubscription({
    projectRoot: root,
    dataDir: path.join(root, 'data'),
    resolveAuthority: () => ({
      product: CRAG_GEMINI_PRODUCT,
      publicKey: authority.publicKey,
      publicKeyBytes: authority.publicBytes,
      issuerId: authority.issuerId,
      payloadKeyId: authority.payloadKeyId,
      softwareVersion: authority.softwareVersion,
    }),
    callHost: async () => ({}),
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'not_found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    origin: 'http://127.0.0.1:18790',
  })
}

test('checkAdmission passes host resource crag_license codes through as HTTP 503', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-host-resource-adm-'))
  const subscription = makeSubscription(root)
  const denied = subscription.checkAdmission(
    { auth_method: 'oauth', crag_license: { valid: false, code: 'gemini_host_resource_exhausted' } },
    { payloadMode: 'crag_subscription' },
  )
  assert.equal(denied.ok, false)
  assert.equal(denied.status, 503)
  assert.equal(denied.code, 'gemini_host_resource_exhausted')
  assert.equal(denied.message, GEMINI_HOST_RESOURCE_MESSAGES.gemini_host_resource_exhausted)
  assert.notEqual(denied.code, 'license_required')
})

test('checkAdmission passes sandbox crag_license codes through as HTTP 503', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-sandbox-adm-'))
  const subscription = makeSubscription(root)
  for (const code of ['gemini_sandbox_unavailable', 'gemini_sandbox_apparmor_restricted']) {
    const denied = subscription.checkAdmission(
      { auth_method: 'oauth', crag_license: { valid: false, code } },
      { payloadMode: 'crag_subscription' },
    )
    assert.equal(denied.ok, false)
    assert.equal(denied.status, 503)
    assert.equal(denied.code, code)
    assert.equal(denied.message, GEMINI_SANDBOX_MESSAGES[code])
  }
})

test('scheduler rejects stream with sandbox denial via checkAdmission (503, not license_required)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-sandbox-stream-'))
  const subscription = makeSubscription(root)
  const scheduler = createGeminiScheduler({
    schedulerRuntime: createMockSchedulerRuntime(),
    cragSubscription: subscription,
    callHost: async (op) => {
      if (op === 'list') return installedList([sandboxEnv('gemini_sandbox_unavailable')])
      throw new Error(`unexpected host op ${op}`)
    },
    proxyPool,
  })
  await assert.rejects(
    () =>
      scheduler.stream({
        model: 'gemini-2.5-flash',
        geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      }),
    (err) =>
      err.status === 503 &&
      err.code === 'gemini_sandbox_unavailable' &&
      err.message === GEMINI_SANDBOX_MESSAGES.gemini_sandbox_unavailable,
  )
})

test('scheduler catalog surfaces host resource denial via checkAdmission (503, not license_required)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-host-resource-catalog-'))
  const subscription = makeSubscription(root)
  const scheduler = createGeminiScheduler({
    cragSubscription: subscription,
    callHost: async (op) => {
      if (op === 'list') return installedList([sandboxEnv('gemini_host_resource_exhausted')])
      throw new Error(`unexpected host op ${op}`)
    },
    proxyPool,
  })
  const catalog = await scheduler.catalog()
  assert.equal(catalog.unlicensedAccounts.length, 1)
  assert.equal(catalog.unlicensedAccounts[0].denial.status, 503)
  assert.equal(catalog.unlicensedAccounts[0].denial.code, 'gemini_host_resource_exhausted')
  assert.equal(
    catalog.unlicensedAccounts[0].denial.message,
    GEMINI_HOST_RESOURCE_MESSAGES.gemini_host_resource_exhausted,
  )
})

test('scheduler fallback checkEnvironmentLicense honors sandbox codes without cragSubscription', async () => {
  const scheduler = createGeminiScheduler({
    callHost: async (op) => {
      if (op === 'list') return installedList([sandboxEnv('gemini_sandbox_apparmor_restricted')])
      throw new Error(`unexpected host op ${op}`)
    },
    proxyPool,
  })
  const catalog = await scheduler.catalog()
  assert.equal(catalog.unlicensedAccounts.length, 1)
  assert.equal(catalog.unlicensedAccounts[0].denial.status, 503)
  assert.equal(catalog.unlicensedAccounts[0].denial.code, 'gemini_sandbox_apparmor_restricted')
})
