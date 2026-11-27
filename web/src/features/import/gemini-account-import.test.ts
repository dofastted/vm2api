import { describe, expect, test } from 'vitest'
import {
  ACCOUNT_FILE_LIMIT,
  extractBareRefreshTokens,
  parseGeminiAccountImportData,
  parseGeminiAccountImportText,
  parseGeminiExpirySeconds,
  readGeminiAccountImportFile,
} from './gemini-account-import'

describe('parseGeminiExpirySeconds', () => {
  test('handles unix seconds, unix ms, numeric strings, and RFC3339 timestamps', () => {
    expect(parseGeminiExpirySeconds(4102444800)).toBe(4102444800)
    expect(parseGeminiExpirySeconds(1893456000123)).toBe(1893456000)
    expect(parseGeminiExpirySeconds('1893456000')).toBe(1893456000)
    expect(parseGeminiExpirySeconds('1893456000999')).toBe(1893456000)
    expect(parseGeminiExpirySeconds('2030-01-01T00:00:00Z')).toBe(1893456000)
    expect(parseGeminiExpirySeconds('2030-01-01T08:00:00.123456+08:00')).toBe(
      1893456000
    )
    expect(parseGeminiExpirySeconds(1.5)).toBeNull()
    expect(parseGeminiExpirySeconds('invalid')).toBeNull()
    expect(parseGeminiExpirySeconds(0)).toBeNull()
  })
})

describe('parseGeminiAccountImportData & parseGeminiAccountImportText', () => {
  test('parses Antigravity Manager / Antigravity2API minimal email + refresh_token array JSON', async () => {
    const sampleJson = JSON.stringify([
      {
        email: 'member@example.test',
        refresh_token: '1//06FixtureMinimalRefreshToken_abc-123',
      },
    ])
    const file = {
      size: sampleJson.length,
      text: async () => sampleJson,
    } as unknown as File
    const result = await readGeminiAccountImportFile(file)
    expect(result.format).toBe('antigravity_rt')
    expect(result.skippedInvalid).toBe(0)
    expect(result.skippedNonGemini).toBe(0)
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      kind: 'oauth',
      format: 'antigravity_rt',
      hasRefreshToken: true,
      email: 'member@example.test',
      suggestedName: 'member@example.test',
      oauth_account: {
        refresh_token: '1//06FixtureMinimalRefreshToken_abc-123',
      },
    })
  })

  test('extracts bare 1// refresh tokens from plain text and deduplicates', () => {
    const raw = `
      account A: 1//06FirstBareToken_abc-123
      duplicate: 1//06FirstBareToken_abc-123
      account B: 1//06SecondBareToken_xyz-789
    `
    expect(extractBareRefreshTokens(raw)).toEqual([
      '1//06FirstBareToken_abc-123',
      '1//06SecondBareToken_xyz-789',
    ])
    const result = parseGeminiAccountImportText(raw)
    expect(result.format).toBe('antigravity_rt')
    expect(result.accounts).toHaveLength(2)
    expect(result.accounts[0]).toMatchObject({
      kind: 'oauth',
      hasRefreshToken: true,
      oauth_account: { refresh_token: '1//06FirstBareToken_abc-123' },
    })
    expect(result.accounts[0].suggestedName).toBeUndefined()
    expect(result.accounts[1]).toMatchObject({
      kind: 'oauth',
      hasRefreshToken: true,
      oauth_account: { refresh_token: '1//06SecondBareToken_xyz-789' },
    })
  })

  test('supports nested arbitrary containers, camelCase refreshToken with |projectId, and deduplication', () => {
    const result = parseGeminiAccountImportData({
      version: 3,
      wrapper: {
        accounts: [
          {
            email: 'opencode@example.test',
            refreshToken: '1//06OpencodeRefreshToken_abc|proj-from-pipe',
          },
          {
            email: 'opencode-dup@example.test',
            refresh_token: '1//06OpencodeRefreshToken_abc',
          },
          {
            email: 'enterprise@example.test',
            refresh_token: '1//06EnterpriseRefreshToken_xyz',
            auth_method: 'business_licensed_enterprise',
            wif_provider:
              'projects/1/locations/global/workloadIdentityPools/p/providers/g',
          },
        ],
      },
    })
    expect(result.accounts).toHaveLength(2)
    expect(result.accounts[0]).toMatchObject({
      kind: 'oauth',
      hasRefreshToken: true,
      email: 'opencode@example.test',
      project_id: 'proj-from-pipe',
      oauth_account: {
        refresh_token: '1//06OpencodeRefreshToken_abc',
      },
    })
    expect(result.accounts[1]).toMatchObject({
      kind: 'oauth',
      hasRefreshToken: true,
      email: 'enterprise@example.test',
      oauth_account: {
        refresh_token: '1//06EnterpriseRefreshToken_xyz',
        auth_method: 'business_licensed_enterprise',
        wif_provider:
          'projects/1/locations/global/workloadIdentityPools/p/providers/g',
      },
    })
  })

  test('parses Antigravity Tools single account JSON with refresh_token and access_token', () => {
    const result = parseGeminiAccountImportData({
      email: 'tools@example.test',
      token: {
        access_token: 'ya29.antigravity-tools',
        refresh_token: '1//06tools-refresh',
        expiry_timestamp: 4102444800,
      },
    })
    expect(result.format).toBe('antigravity_tools')
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      kind: 'oauth',
      format: 'antigravity_tools',
      hasRefreshToken: true,
      email: 'tools@example.test',
      suggestedName: 'tools@example.test',
      oauth_account: {
        refresh_token: '1//06tools-refresh',
        access_token: 'ya29.antigravity-tools',
        expiry_timestamp: 4102444800,
      },
    })
  })

  test('parses CLIProxyAPI (CPA) Antigravity auth JSON using expired or timestamp + expires_in', () => {
    const withExpired = parseGeminiAccountImportData({
      type: 'antigravity',
      access_token: 'ya29.cpa-ag-1',
      refresh_token: '1//06cpa-refresh',
      expires_in: 3599,
      timestamp: 1893452400000,
      expired: '2030-01-01T00:00:00Z',
      email: 'cpa-ag@example.test',
      project_id: 'proj-ag-1',
    })
    expect(withExpired.format).toBe('cpa')
    expect(withExpired.accounts[0]).toMatchObject({
      kind: 'oauth',
      format: 'cpa',
      hasRefreshToken: true,
      platform: 'antigravity',
      email: 'cpa-ag@example.test',
      project_id: 'proj-ag-1',
      oauth_account: {
        refresh_token: '1//06cpa-refresh',
        access_token: 'ya29.cpa-ag-1',
        expiry_timestamp: 1893456000,
      },
    })

    const withTimestampFallback = parseGeminiAccountImportData({
      type: 'antigravity',
      access_token: 'ya29.cpa-ag-2',
      expires_in: 3600,
      timestamp: 1893452400000,
    })
    expect(withTimestampFallback.format).toBe('cpa')
    expect(withTimestampFallback.accounts[0]).toMatchObject({
      kind: 'oauth',
      hasRefreshToken: false,
      oauth_account: {
        access_token: 'ya29.cpa-ag-2',
        expiry_timestamp: 1893456000,
      },
    })
  })

  test('parses CLIProxyAPI (CPA) Gemini CLI auth JSON with nested token.expiry', () => {
    const result = parseGeminiAccountImportData({
      type: 'gemini',
      email: 'cpa-cli@example.test',
      project_id: 'gcp-proj-42',
      auto: true,
      checked: true,
      token: {
        access_token: 'ya29.cpa-gemini-cli',
        token_type: 'Bearer',
        refresh_token: '1//06cpa-cli-refresh',
        expiry: '2030-01-01T00:00:00.123456789Z',
        token_uri: 'https://oauth2.googleapis.com/token',
      },
    })
    expect(result.format).toBe('cpa')
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      kind: 'oauth',
      format: 'cpa',
      hasRefreshToken: true,
      platform: 'gemini',
      email: 'cpa-cli@example.test',
      project_id: 'gcp-proj-42',
      oauth_account: {
        refresh_token: '1//06cpa-cli-refresh',
        access_token: 'ya29.cpa-gemini-cli',
        expiry_timestamp: 1893456000,
      },
    })
  })

  test('parses sub2api full export with mixed platforms, OAuth accounts, RT-only OAuth, and Gemini API keys', () => {
    const result = parseGeminiAccountImportData({
      exported_at: '2026-11-25T08:00:00Z',
      proxies: [],
      accounts: [
        {
          name: 'claude-skip',
          platform: 'anthropic',
          type: 'oauth',
          credentials: {
            access_token: 'sk-ant-oat01-skip',
            expires_at: '1893456000',
          },
        },
        {
          name: 'ag-sub',
          platform: 'antigravity',
          type: 'oauth',
          credentials: {
            access_token: 'ya29.sub-ag',
            refresh_token: '1//06sub-ag-rt',
            expires_at: '1893456000',
            email: 'ag-sub@example.test',
            project_id: 'proj-sub-1',
          },
        },
        {
          name: 'gem-oauth',
          platform: 'gemini',
          type: 'oauth',
          credentials: {
            access_token: 'ya29.sub-gem',
            expires_at: '2030-01-01T00:00:00Z',
            project_id: 'proj-sub-2',
          },
          extra: {
            email_address: 'gem-sub@example.test',
          },
        },
        {
          name: 'ag-rt-only',
          platform: 'antigravity',
          type: 'oauth',
          credentials: {
            refresh_token: '1//06sub-rt-only',
          },
        },
        {
          name: 'gem-key',
          platform: 'gemini',
          type: 'apikey',
          credentials: {
            api_key: 'AIzaSyA12345678901234567890abcdef',
          },
        },
      ],
    })
    expect(result.format).toBe('sub2api')
    expect(result.skippedNonGemini).toBe(1)
    expect(result.skippedInvalid).toBe(0)
    expect(result.accounts).toHaveLength(4)
    expect(result.accounts[0]).toMatchObject({
      kind: 'oauth',
      hasRefreshToken: true,
      platform: 'antigravity',
      email: 'ag-sub@example.test',
      suggestedName: 'ag-sub',
      oauth_account: {
        refresh_token: '1//06sub-ag-rt',
        access_token: 'ya29.sub-ag',
        expiry_timestamp: 1893456000,
      },
    })
    expect(result.accounts[1]).toMatchObject({
      kind: 'oauth',
      hasRefreshToken: false,
      platform: 'gemini',
      email: 'gem-sub@example.test',
      suggestedName: 'gem-oauth',
      oauth_account: {
        access_token: 'ya29.sub-gem',
        expiry_timestamp: 1893456000,
      },
    })
    expect(result.accounts[2]).toMatchObject({
      kind: 'oauth',
      hasRefreshToken: true,
      platform: 'antigravity',
      suggestedName: 'ag-rt-only',
      oauth_account: {
        refresh_token: '1//06sub-rt-only',
      },
    })
    expect(result.accounts[3]).toMatchObject({
      kind: 'api_key',
      platform: 'gemini',
      suggestedName: 'gem-key',
      api_key: 'AIzaSyA12345678901234567890abcdef',
    })
  })

  test('parses sub2api single account JSON and API-enveloped export', () => {
    const single = parseGeminiAccountImportData({
      name: 'single-ag',
      platform: 'antigravity',
      type: 'oauth',
      credentials: {
        access_token: 'ya29.single-sub2api',
        expires_at: '1893456000',
      },
    })
    expect(single.format).toBe('sub2api')
    expect(single.accounts[0]).toMatchObject({
      kind: 'oauth',
      hasRefreshToken: false,
      oauth_account: {
        access_token: 'ya29.single-sub2api',
        expiry_timestamp: 1893456000,
      },
    })

    const enveloped = parseGeminiAccountImportData({
      code: 0,
      data: {
        type: 'sub2api-data',
        version: 1,
        accounts: [
          {
            name: 'wrapped-gem',
            platform: 'gemini',
            type: 'oauth',
            credentials: {
              access_token: 'ya29.wrapped-gem',
              expires_at: 1893456000,
            },
          },
        ],
      },
    })
    expect(enveloped.format).toBe('sub2api')
    expect(enveloped.accounts[0]).toMatchObject({
      kind: 'oauth',
      oauth_account: {
        access_token: 'ya29.wrapped-gem',
        expiry_timestamp: 1893456000,
      },
    })
  })

  test('rejects non-Gemini providers, missing credentials, and invalid files', async () => {
    expect(() =>
      parseGeminiAccountImportData({
        type: 'claude',
        access_token: 'sk-ant-oat01-xyz',
        expired: '2030-01-01T00:00:00Z',
      })
    ).toThrow(/不支持导入类型为 "claude"/)

    expect(() =>
      parseGeminiAccountImportData({
        platform: 'openai',
        type: 'oauth',
        credentials: { access_token: 'tok', expires_at: '1893456000' },
      })
    ).toThrow(/不支持导入平台为 "openai"/)

    expect(() =>
      parseGeminiAccountImportData({
        accounts: [
          {
            name: 'only-claude',
            platform: 'anthropic',
            type: 'oauth',
            credentials: { access_token: 'tok', expires_at: '1893456000' },
          },
        ],
      })
    ).toThrow(/未包含 Gemini 或 Antigravity 账号/)

    await expect(readGeminiAccountImportFile(null)).rejects.toThrow(/2 MiB/)
    const oversized = {
      size: ACCOUNT_FILE_LIMIT + 1,
      text: async () => '{}',
    } as unknown as File
    await expect(readGeminiAccountImportFile(oversized)).rejects.toThrow(
      /2 MiB/
    )
    const badJson = {
      size: 10,
      text: async () => '{bad',
    } as unknown as File
    await expect(readGeminiAccountImportFile(badJson)).rejects.toThrow(
      /有效的 JSON/
    )
  })

  test('parses schema_version 2 export, bare RT special chars, relaxed types, tokens bundle, and nested outer metadata', () => {
    // Redacted Format 2 fixture (antigravity-accounts-2026-11-28_04-34-13.json)
    const format2 = parseGeminiAccountImportData({
      schema_version: 2,
      accounts: [
        {
          email: 'redacted2@gmail.com',
          refresh_token: '1//06Q_Format2Fixture_xyz',
          oauth_client_key: 'antigravity_enterprise',
          is_gcp_tos: false,
          project_id: 'aicode-consumers',
        },
        {
          email: 'redacted3@gmail.com',
          refresh_token: '1//06R_Format2Second_abc',
          oauth_client_key: 'consumer',
          is_gcp_tos: true,
          project_id: 'aicode-pro',
        },
      ],
    })
    expect(format2.format).toBe('antigravity_rt')
    expect(format2.accounts).toHaveLength(2)
    expect(format2.accounts[0]).toMatchObject({
      kind: 'oauth',
      hasRefreshToken: true,
      email: 'redacted2@gmail.com',
      project_id: 'aicode-consumers',
      oauth_client_key: 'antigravity_enterprise',
      is_gcp_tos: false,
      suggestedName: 'redacted2@gmail.com',
      oauth_account: {
        refresh_token: '1//06Q_Format2Fixture_xyz',
        oauth_client_key: 'antigravity_enterprise',
        is_gcp_tos: false,
        project_id: 'aicode-consumers',
      },
    })
    expect(format2.accounts[1]).toMatchObject({
      kind: 'oauth',
      email: 'redacted3@gmail.com',
      oauth_account: {
        refresh_token: '1//06R_Format2Second_abc',
        oauth_client_key: 'consumer',
        is_gcp_tos: true,
        project_id: 'aicode-pro',
      },
    })

    // Bare refresh tokens with `.`, `~`, `+`, `/` must not be truncated
    const specialRt = '1//06Bare.Token~with+plus/slash_999'
    expect(extractBareRefreshTokens(`RT: ${specialRt}`)).toEqual([specialRt])
    const parsedBare = parseGeminiAccountImportText(`RT: ${specialRt}`)
    expect(parsedBare.accounts[0]).toMatchObject({
      kind: 'oauth',
      oauth_account: { refresh_token: specialRt },
    })

    // Generic `{ type: "antigravity-export", tokens: [...] }` + relaxed account `type`
    const relaxed = parseGeminiAccountImportData({
      type: 'antigravity-export',
      tokens: [
        {
          type: 'authorized_user',
          email: 'adc@gmail.com',
          refresh_token: '1//06Adc_111111',
        },
        {
          type: 'personal',
          email: 'p@gmail.com',
          refresh_token: '1//06Personal_222222',
        },
        {
          type: 'pro',
          email: 'pro@gmail.com',
          refresh_token: '1//06Pro_333333',
        },
        {
          type: 'google',
          email: 'g@gmail.com',
          refresh_token: '1//06Google_444444',
        },
        {
          type: 'antigravity_enterprise',
          email: 'e@gmail.com',
          refresh_token: '1//06Ent_555555',
        },
      ],
    })
    expect(relaxed.format).toBe('antigravity_rt')
    expect(relaxed.accounts).toHaveLength(5)

    // Outer email/name/project_id/oauth_client_key/is_gcp_tos preserved when descending into nested object
    const nested = parseGeminiAccountImportData({
      email: 'outer@gmail.com',
      name: 'Outer Env',
      project_id: 'outer-proj',
      oauth_client_key: 'antigravity_enterprise',
      is_gcp_tos: false,
      auth: {
        refresh_token: '1//06NestedToken_abc',
      },
    })
    expect(nested.accounts).toHaveLength(1)
    expect(nested.accounts[0]).toMatchObject({
      kind: 'oauth',
      email: 'outer@gmail.com',
      project_id: 'outer-proj',
      suggestedName: 'Outer Env',
      oauth_account: {
        refresh_token: '1//06NestedToken_abc',
        project_id: 'outer-proj',
        oauth_client_key: 'antigravity_enterprise',
        is_gcp_tos: false,
      },
    })
  })
})
