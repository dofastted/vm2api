import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeGeminiOAuthImport,
  normalizeGeminiOAuthImportList,
  normalizeGeminiRefreshToken,
  parseGeminiExpirySeconds,
} from '../../src/lib/gemini/oauth-import.mjs'

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

test('normalizeGeminiRefreshToken trims, strips trailing project suffix, and rejects malformed values', () => {
  assert.equal(
    normalizeGeminiRefreshToken('  1//06FixtureRefreshToken_abc-123|proj-123  '),
    '1//06FixtureRefreshToken_abc-123',
  )
  assert.equal(normalizeGeminiRefreshToken('ya29.not-a-refresh-token'), null)
  assert.equal(normalizeGeminiRefreshToken('1//short'), null)
  assert.equal(normalizeGeminiRefreshToken('1//bad\r\ntoken'), null)
})

test('normalizeGeminiOAuthImport accepts bare refresh token and Antigravity RT export arrays', () => {
  // Bare refresh token string
  assert.deepEqual(normalizeGeminiOAuthImport('1//06BareFixtureToken_abc-123'), {
    refresh_token: '1//06BareFixtureToken_abc-123',
  })

  // Antigravity Manager / Antigravity2API minimal `[{ email, refresh_token }]` array
  assert.deepEqual(
    normalizeGeminiOAuthImport([
      {
        email: 'user@example.test',
        refresh_token: '1//06ArrayFixtureToken_abc-123',
      },
    ]),
    { refresh_token: '1//06ArrayFixtureToken_abc-123' },
  )

  // Duplicate entries with the same refresh token deduplicate to one unambiguous credential
  assert.deepEqual(
    normalizeGeminiOAuthImport([
      { email: 'dup@example.test', refresh_token: '1//06DuplicateToken_abc-123' },
      { email: 'dup@example.test', refreshToken: '1//06DuplicateToken_abc-123|proj-dup' },
    ]),
    { refresh_token: '1//06DuplicateToken_abc-123' },
  )

  // Enterprise auth metadata (auth_method + wif_provider) is whitelisted; extra fields stripped
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      email: 'corp@example.test',
      refresh_token: '1//06EnterpriseToken_abc-123',
      auth_method: 'business_licensed_enterprise',
      wif_provider: 'projects/123/locations/global/workloadIdentityPools/p/providers/g',
      proxy: 'socks5h://ignored',
      device: { installation_id: 'ignored' },
    }),
    {
      refresh_token: '1//06EnterpriseToken_abc-123',
      auth_method: 'business_licensed_enterprise',
      wif_provider: 'projects/123/locations/global/workloadIdentityPools/p/providers/g',
    },
  )
})

test('normalizeGeminiOAuthImport accepts normalized access-only and Antigravity Tools formats', () => {
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      access_token: 'ya29.direct-token',
      expiry_timestamp: 4102444800,
    }),
    { access_token: 'ya29.direct-token', expiry_timestamp: 4102444800 },
  )

  assert.deepEqual(
    normalizeGeminiOAuthImport({
      email: 'ag@example.test',
      token: {
        access_token: 'ya29.ag-tools',
        refresh_token: '1//06AgToolsRefresh_abc',
        expiry_timestamp: 4102444800,
      },
    }),
    {
      refresh_token: '1//06AgToolsRefresh_abc',
      access_token: 'ya29.ag-tools',
      expiry_timestamp: 4102444800,
    },
  )
})

test('normalizeGeminiOAuthImport accepts CPA antigravity and CPA gemini CLI auth files', () => {
  // CPA Antigravity with RFC3339 `expired` and refresh_token
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      type: 'antigravity',
      access_token: 'ya29.cpa-ag-token',
      refresh_token: '1//06cpa-refresh-token',
      expires_in: 3599,
      timestamp: 1893452400000,
      expired: '2030-01-01T00:00:00Z',
      email: 'cpa@example.test',
      project_id: 'proj-cpa',
    }),
    {
      refresh_token: '1//06cpa-refresh-token',
      access_token: 'ya29.cpa-ag-token',
      expiry_timestamp: 1893456000,
      project_id: 'proj-cpa',
    },
  )

  // CPA Antigravity without refresh_token falls back to `timestamp` (ms) + `expires_in` (s)
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      type: 'antigravity',
      access_token: 'ya29.cpa-ag-fallback',
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
        refresh_token: '1//06cpa-gemini-refresh',
        expiry: '2030-01-01T00:00:00.987654321Z',
        token_uri: 'https://oauth2.googleapis.com/token',
      },
    }),
    {
      refresh_token: '1//06cpa-gemini-refresh',
      access_token: 'ya29.cpa-gemini-cli',
      expiry_timestamp: 1893456000,
      project_id: 'proj-cli',
    },
  )

  // CPA Gemini CLI top-level access-only fallback
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
  // sub2api single antigravity OAuth account (string unix seconds `expires_at` + refresh_token)
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      name: 'ag-prod',
      platform: 'antigravity',
      type: 'oauth',
      credentials: {
        access_token: 'ya29.sub2api-ag',
        refresh_token: '1//06sub2api-refresh',
        expires_at: '1893456000',
        email: 'ag@example.test',
        project_id: 'proj-sub',
      },
    }),
    {
      refresh_token: '1//06sub2api-refresh',
      access_token: 'ya29.sub2api-ag',
      expiry_timestamp: 1893456000,
      project_id: 'proj-sub',
    },
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
            refresh_token: '1//06sub2api-gemini-refresh',
            expires_at: '2030-01-01T00:00:00Z',
            project_id: 'proj-g',
          },
        },
      ],
    }),
    {
      refresh_token: '1//06sub2api-gemini-refresh',
      access_token: 'ya29.sub2api-gemini',
      expiry_timestamp: 1893456000,
      project_id: 'proj-g',
    },
  )

  // sub2api export wrapped in API response `{ data: { accounts: [...] } }` (access-only)
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
  assert.equal(
    normalizeGeminiOAuthImport({
      refresh_token: '1//bad\r\nrefresh',
    }),
    null,
  )
  // Multiple distinct accounts in one bundle or array return cleanly (list + index selection) instead of null
  const multiBundle = {
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
  }
  assert.deepEqual(normalizeGeminiOAuthImportList(multiBundle), [
    { access_token: 'ya29.one', expiry_timestamp: 1893456000 },
    { access_token: 'ya29.two', expiry_timestamp: 1893456000 },
  ])
  assert.deepEqual(normalizeGeminiOAuthImport(multiBundle), {
    access_token: 'ya29.one',
    expiry_timestamp: 1893456000,
  })
  assert.deepEqual(normalizeGeminiOAuthImport(multiBundle, { accountIndex: 1 }), {
    access_token: 'ya29.two',
    expiry_timestamp: 1893456000,
  })
  assert.equal(normalizeGeminiOAuthImport(multiBundle, { accountIndex: 2 }), null)

  const multiArray = [
    { email: 'a@example.test', refresh_token: '1//06FirstToken_111111' },
    { email: 'b@example.test', refresh_token: '1//06SecondToken_222222' },
  ]
  assert.deepEqual(normalizeGeminiOAuthImportList(multiArray), [
    { refresh_token: '1//06FirstToken_111111' },
    { refresh_token: '1//06SecondToken_222222' },
  ])
  assert.deepEqual(normalizeGeminiOAuthImport(multiArray), {
    refresh_token: '1//06FirstToken_111111',
  })
  assert.deepEqual(normalizeGeminiOAuthImport(multiArray, { accountIndex: 1 }), {
    refresh_token: '1//06SecondToken_222222',
  })
})

test('normalizeGeminiOAuthImport supports schema_version 2 export, relaxed types, nested metadata, and extended bare RT chars', () => {
  // Format 1 redacted fixture (antigravity_accounts_2026-11-27.json)
  const format1 = [
    {
      email: 'redacted1@gmail.com',
      refresh_token: '1//06M_RedactedFormat1_abc-123',
    },
  ]
  assert.deepEqual(normalizeGeminiOAuthImport(format1), {
    refresh_token: '1//06M_RedactedFormat1_abc-123',
  })

  // Format 2 redacted fixture (antigravity-accounts-2026-11-28_04-34-13.json)
  const format2 = {
    schema_version: 2,
    accounts: [
      {
        email: 'redacted2@gmail.com',
        refresh_token: '1//06Q_RedactedFormat2_xyz-789',
        oauth_client_key: 'antigravity_enterprise',
        is_gcp_tos: false,
        project_id: 'aicode-consumers',
      },
    ],
  }
  assert.deepEqual(normalizeGeminiOAuthImport(format2), {
    refresh_token: '1//06Q_RedactedFormat2_xyz-789',
    oauth_client_key: 'antigravity_enterprise',
    is_gcp_tos: false,
    project_id: 'aicode-consumers',
  })

  // Bare RT text containing `.`, `~`, `+`, `/` must not be truncated
  const specialRt = '1//06Special.Token~with+plus/slash_123-end'
  assert.deepEqual(normalizeGeminiOAuthImport(`paste:\n${specialRt}\n`), {
    refresh_token: specialRt,
  })
  assert.deepEqual(normalizeGeminiOAuthImportList(`${specialRt}\n1//06Second.RT~a+b/c`), [
    { refresh_token: specialRt },
    { refresh_token: '1//06Second.RT~a+b/c' },
  ])

  // Relaxed bundle & account `type` values (`authorized_user`, `personal`, `pro`, `google`, `antigravity_enterprise`, `{ tokens: [...] }`)
  assert.deepEqual(
    normalizeGeminiOAuthImportList({
      type: 'antigravity-export',
      tokens: [
        { type: 'authorized_user', refresh_token: '1//06AdcToken_111111' },
        { type: 'personal', refresh_token: '1//06PersonalToken_222222' },
        { type: 'pro', refresh_token: '1//06ProToken_333333' },
        { type: 'google', refresh_token: '1//06GoogleToken_444444' },
        {
          type: 'antigravity_enterprise',
          refresh_token: '1//06EntToken_555555',
          is_gcp_tos: true,
        },
        { type: 'claude', refresh_token: '1//06ShouldIgnoreClaude' },
      ],
    }),
    [
      { refresh_token: '1//06AdcToken_111111' },
      { refresh_token: '1//06PersonalToken_222222' },
      { refresh_token: '1//06ProToken_333333' },
      { refresh_token: '1//06GoogleToken_444444' },
      { refresh_token: '1//06EntToken_555555', is_gcp_tos: true },
    ],
  )

  // Outer metadata preserved when descending into nested auth object
  assert.deepEqual(
    normalizeGeminiOAuthImport({
      email: 'outer@gmail.com',
      project_id: 'outer-project',
      oauth_client_key: 'antigravity_enterprise',
      is_gcp_tos: false,
      auth: {
        refresh_token: '1//06NestedAuthObj_abc',
      },
    }),
    {
      refresh_token: '1//06NestedAuthObj_abc',
      project_id: 'outer-project',
      oauth_client_key: 'antigravity_enterprise',
      is_gcp_tos: false,
    },
  )
})
