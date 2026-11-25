import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeGeminiOAuthImport, parseGeminiExpirySeconds } from '../../src/lib/gemini/oauth-import.mjs'

test('parseGeminiExpirySeconds normalizes unix seconds, unix ms, numeric strings, and RFC3339', () => {
  assert.equal(parseGeminiExpirySeconds(4102444800), 4102444800)
  assert.equal(parseGeminiExpirySeconds(1764060000123), 1764060000)
  assert.equal(parseGeminiExpirySeconds('1764060000'), 1764060000)
  assert.equal(parseGeminiExpirySeconds('1764060000456'), 1764060000)
  assert.equal(parseGeminiExpirySeconds('2030-01-01T00:00:00Z'), 1893456000)
  assert.equal(parseGeminiExpirySeconds('2030-01-01T08:00:00.123456+08:00'), 1893456000)
  assert.equal(parseGeminiExpirySeconds(1.5), null)
  assert.equal(parseGeminiExpirySeconds(0), null)
  assert.equal(parseGeminiExpirySeconds(-10), null)
  assert.equal(parseGeminiExpirySeconds('not-a-date'), null)
  assert.equal(parseGeminiExpirySeconds(253402300800), null)
})

test('normalizeGeminiOAuthImport accepts normalized and Antigravity Tools formats', () => {
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      access_token: 'ya29.direct-token',
      expiry_timestamp: 4102444800,
      refresh_token: '1//never-forwarded',
    }),
    { access_token: 'ya29.direct-token', expiry_timestamp: 4102444800 },
  )

  assert.deepEqual(
    normalizeGeminiOAuthImport({
      email: 'ag@example.test',
      token: {
        access_token: 'ya29.ag-tools',
        refresh_token: '1//never-forwarded',
        expiry_timestamp: 4102444800,
      },
    }),
    { access_token: 'ya29.ag-tools', expiry_timestamp: 4102444800 },
  )
})

test('normalizeGeminiOAuthImport accepts CPA antigravity and CPA gemini CLI auth files', () => {
  // CPA Antigravity with RFC3339 `expired`
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      type: 'antigravity',
      access_token: 'ya29.cpa-ag-token',
      refresh_token: '1//cpa-refresh',
      expires_in: 3599,
      timestamp: 1893452400000,
      expired: '2030-01-01T00:00:00Z',
      email: 'cpa@example.test',
      project_id: 'proj-cpa',
    }),
    { access_token: 'ya29.cpa-ag-token', expiry_timestamp: 1893456000 },
  )

  // CPA Antigravity fallback to `timestamp` (ms) + `expires_in` (s)
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      type: 'antigravity',
      access_token: 'ya29.cpa-ag-fallback',
      refresh_token: '1//cpa-refresh',
      expires_in: 3600,
      timestamp: 1893452400000,
    }),
    { access_token: 'ya29.cpa-ag-fallback', expiry_timestamp: 1893456000 },
  )

  // CPA Gemini CLI nested `token` with Go oauth2.Token RFC3339Nano `expiry`
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      type: 'gemini',
      email: 'cli@example.test',
      project_id: 'proj-cli',
      auto: true,
      checked: true,
      token: {
        access_token: 'ya29.cpa-gemini-cli',
        token_type: 'Bearer',
        refresh_token: '1//cpa-gemini-refresh',
        expiry: '2030-01-01T00:00:00.987654321Z',
        token_uri: 'https://oauth2.googleapis.com/token',
      },
    }),
    { access_token: 'ya29.cpa-gemini-cli', expiry_timestamp: 1893456000 },
  )

  // CPA Gemini CLI top-level fallback
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      type: 'gemini',
      access_token: 'ya29.cpa-gemini-flat',
      expiry: '2030-01-01T00:00:00Z',
    }),
    { access_token: 'ya29.cpa-gemini-flat', expiry_timestamp: 1893456000 },
  )
})

test('normalizeGeminiOAuthImport accepts sub2api single account and unambiguous export bundles', () => {
  // sub2api single antigravity OAuth account (string unix seconds `expires_at`)
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      name: 'ag-prod',
      platform: 'antigravity',
      type: 'oauth',
      credentials: {
        access_token: 'ya29.sub2api-ag',
        refresh_token: '1//sub2api-refresh',
        expires_at: '1893456000',
        email: 'ag@example.test',
        project_id: 'proj-sub',
      },
    }),
    { access_token: 'ya29.sub2api-ag', expiry_timestamp: 1893456000 },
  )

  // sub2api full export without `type` (matches ExportData omitempty) with mixed platforms
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      exported_at: '2026-11-25T08:00:00Z',
      proxies: [],
      accounts: [
        {
          name: 'claude-1',
          platform: 'anthropic',
          type: 'oauth',
          credentials: { access_token: 'sk-ant-oat01-ignore', expires_at: '1893456000' },
        },
        {
          name: 'gemini-1',
          platform: 'gemini',
          type: 'oauth',
          credentials: {
            access_token: 'ya29.sub2api-gemini',
            refresh_token: '1//sub2api-gemini-refresh',
            expires_at: '2030-01-01T00:00:00Z',
            project_id: 'proj-g',
          },
        },
      ],
    }),
    { access_token: 'ya29.sub2api-gemini', expiry_timestamp: 1893456000 },
  )

  // sub2api export wrapped in API response `{ data: { accounts: [...] } }`
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      code: 0,
      data: {
        type: 'sub2api-data',
        version: 1,
        accounts: [
          {
            name: 'ag-wrapped',
            platform: 'antigravity',
            type: 'oauth',
            credentials: { access_token: 'ya29.wrapped', expires_at: 1893456000 },
          },
        ],
      },
    }),
    { access_token: 'ya29.wrapped', expiry_timestamp: 1893456000 },
  )
})

test('normalizeGeminiOAuthImport rejects non-Gemini providers, malformed tokens, and ambiguous bundles', () => {
  assert.equal(
    normalizeGeminiOAuthImport({
      type: 'claude',
      access_token: 'sk-ant-oat01-xxx',
      expired: '2030-01-01T00:00:00Z',
    }),
    null,
  )
  assert.equal(
    normalizeGeminiOAuthImport({
      platform: 'anthropic',
      type: 'oauth',
      credentials: { access_token: 'sk-ant-oat01-xxx', expires_at: '1893456000' },
    }),
    null,
  )
  assert.equal(
    normalizeGeminiOAuthImport({
      platform: 'gemini',
      type: 'apikey',
      credentials: { api_key: 'AIzaSyA12345678901234567890' },
    }),
    null,
  )
  assert.equal(
    normalizeGeminiOAuthImport({
      type: 'antigravity',
      access_token: 'bad\r\ntoken',
      expired: '2030-01-01T00:00:00Z',
    }),
    null,
  )
  // Multiple Gemini accounts in one bundle are ambiguous for direct single-account API import
  assert.equal(
    normalizeGeminiOAuthImport({
      accounts: [
        {
          name: 'ag-1',
          platform: 'antigravity',
          type: 'oauth',
          credentials: { access_token: 'ya29.one', expires_at: '1893456000' },
        },
        {
          name: 'gem-2',
          platform: 'gemini',
          type: 'oauth',
          credentials: { access_token: 'ya29.two', expires_at: '1893456000' },
        },
      ],
    }),
    null,
  )
})
