import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearModelsCache,
  isCodexCatalogModel,
  listOfficialModels,
  seedModelCatalog,
  validateOfficialModel,
} from '../../src/lib/protocol/models.mjs'
import {
  CHATGPT_MODELS_URL,
  CODEX_MODELS_URL,
  CODEX_APP_VERSION,
  CODEX_CATALOG_DEFAULT_VERSION,
  CODEX_CATALOG_ORIGINATOR,
  CODEX_OAUTH_TOKEN_URL,
  fetchChatgptModelCatalog,
  normalizeCodexCatalogVersion,
  parseChatgptModelIds,
  parseCodexModelCatalog,
  refreshCodexAccessToken,
  resolveCodexCatalogVersion,
} from '../../src/lib/protocol/codex-models.mjs'

test('catalog treats gpt prefix as Codex family', () => {
  assert.equal(isCodexCatalogModel('gpt-5.4'), true)
  assert.equal(isCodexCatalogModel('gpt-5.6-sol'), true)
  assert.equal(isCodexCatalogModel('claude-sonnet-5'), false)
  assert.equal(isCodexCatalogModel('codex-mini'), false)
})

test('validateOfficialModel is Claude catalog and does not accept gpt', () => {
  clearModelsCache()
  assert.equal(validateOfficialModel('gpt-5.4').ok, false)
  assert.equal(validateOfficialModel('gpt-4o').ok, false)
  clearModelsCache()
})

test('listOfficialModels no longer mixes GPT ids', () => {
  clearModelsCache()
  seedModelCatalog()
  assert.equal(
    listOfficialModels().some((m) => m.id.startsWith('gpt')),
    false,
  )
  clearModelsCache()
})

test('parseCodexModelCatalog uses official slug/display_name and drops luna-wm', () => {
  const models = parseCodexModelCatalog({
    models: [
      { slug: 'gpt-5.6', display_name: 'GPT-5.6' },
      { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4 Mini' },
      { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol' },
      { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna' },
      { slug: 'gpt-5.6-luna-wm', display_name: 'Luna' },
      { slug: 'whisper-1' },
      { slug: 'claude-sonnet-5' },
    ],
  })
  assert.deepEqual(
    models.map((m) => m.id),
    ['gpt-5.6', 'gpt-5.4-mini', 'gpt-6-sol', 'gpt-6-luna'],
  )
  assert.equal(models[0].display_name, 'GPT-5.6')
  assert.deepEqual(parseChatgptModelIds({ models: [{ slug: 'gpt-5.6' }] }), ['gpt-5.6'])
})

test('fetchChatgptModelCatalog hits /codex/models and does not treat 401 as success', async () => {
  const calls = []
  const ok = await fetchChatgptModelCatalog({
    accessToken: 'tok',
    accountId: 'acct',
    catalogVersion: '0.158.0',
    proxyUrl: 'socks5://127.0.0.1:1080',
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { slug: 'gpt-5.6', display_name: 'GPT-5.6' },
            { slug: 'gpt-5.4', display_name: 'GPT-5.4' },
            { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol' },
            { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna' },
            { slug: 'gpt-5.6-luna-wm', display_name: 'Luna' },
          ],
        }),
      }
    },
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ids, ['gpt-5.6', 'gpt-5.4', 'gpt-6-sol', 'gpt-6-luna'])
  assert.equal(ok.models[0].display_name, 'GPT-5.6')
  assert.match(String(calls[0].url), /\/backend-api\/codex\/models/)
  assert.equal(calls[0].headers.authorization, 'Bearer tok')
  assert.equal(calls[0].headers.originator, CODEX_CATALOG_ORIGINATOR)
  assert.equal(calls[0].headers.version, '0.158.0')
  assert.equal(calls[0].headers['user-agent'], 'codex_cli_rs/0.158.0 (linux x86_64)')
  assert.match(String(calls[0].url), /client_version=0\.158\.0/)
  assert.equal(calls[0].headers['chatgpt-account-id'], 'acct')
  assert.equal(CODEX_MODELS_URL, CHATGPT_MODELS_URL)

  const denied = await fetchChatgptModelCatalog({
    accessToken: 'tok',
    catalogVersion: '0.158.0',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) }),
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.error, 'upstream_auth')
  assert.deepEqual(denied.ids, [])
})

test('codex catalog version accepts stable semver and rejects arbitrary values', () => {
  assert.equal(normalizeCodexCatalogVersion('v0.158.0'), '0.158.0')
  assert.equal(normalizeCodexCatalogVersion('0.158.0'), '0.158.0')
  assert.equal(normalizeCodexCatalogVersion('latest'), '')
  assert.equal(normalizeCodexCatalogVersion('0.158.0-linux-x64'), '')
})

test('resolveCodexCatalogVersion fetches and caches the official package version', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-version-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cachePath = path.join(dir, 'version.json')
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { status: 200, json: async () => ({ version: '0.158.0' }) }
  }
  const first = await resolveCodexCatalogVersion({ cachePath, fetchImpl })
  const second = await resolveCodexCatalogVersion({ cachePath, fetchImpl })
  assert.deepEqual(first, { ok: true, version: '0.158.0', source: 'registry' })
  assert.equal(second.version, '0.158.0')
  assert.equal(second.source, 'cache')
  assert.equal(calls, 1)
})

test('resolveCodexCatalogVersion honors the settings override without network access', async () => {
  const resolved = await resolveCodexCatalogVersion({
    configuredVersion: '0.155.0',
    fetchImpl: async () => {
      throw new Error('network should not be used')
    },
  })
  assert.deepEqual(resolved, { ok: true, version: '0.155.0', source: 'settings' })
})

test('resolveCodexCatalogVersion falls back to the default when registry is unavailable', async () => {
  const resolved = await resolveCodexCatalogVersion({
    cachePath: path.join(os.tmpdir(), `codex-catalog-missing-${Date.now()}.json`),
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  assert.deepEqual(resolved, { ok: true, version: CODEX_CATALOG_DEFAULT_VERSION, source: 'default' })
})

test('refreshCodexAccessToken posts form grant and keeps fallback refresh token', async () => {
  const calls = []
  const tok = await refreshCodexAccessToken({
    refreshToken: 'rt-old',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: String(init.body || ''), headers: init.headers })
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at-new', expires_in: 3600 }),
      }
    },
  })
  assert.equal(tok.ok, true)
  assert.equal(tok.access_token, 'at-new')
  assert.equal(tok.refresh_token, 'rt-old')
  assert.equal(calls[0].url, CODEX_OAUTH_TOKEN_URL)
  assert.match(calls[0].body, /grant_type=refresh_token/)
  assert.match(calls[0].body, /refresh_token=rt-old/)
})
