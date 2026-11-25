import { describe, expect, test } from 'vitest'
import {
  ACCOUNT_FILE_LIMIT,
  parseGeminiAccountImportData,
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

describe('parseGeminiAccountImportData', () => {
  test('parses Antigravity Tools single account JSON', () => {
    const result = parseGeminiAccountImportData({
      email: 'tools@example.test',
      token: {
        access_token: 'ya29.antigravity-tools',
        refresh_token: '1//ignored',
        expiry_timestamp: 4102444800,
      },
    })
    expect(result.format).toBe('antigravity_tools')
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      kind: 'oauth',
      format: 'antigravity_tools',
      email: 'tools@example.test',
      suggestedName: 'tools@example.test',
      oauth_account: {
        access_token: 'ya29.antigravity-tools',
        expiry_timestamp: 4102444800,
      },
    })
  })

  test('parses CLIProxyAPI (CPA) Antigravity auth JSON using expired or timestamp + expires_in', () => {
    const withExpired = parseGeminiAccountImportData({
      type: 'antigravity',
      access_token: 'ya29.cpa-ag-1',
      refresh_token: '1//cpa-refresh',
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
      platform: 'antigravity',
      email: 'cpa-ag@example.test',
      project_id: 'proj-ag-1',
      oauth_account: {
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
        refresh_token: '1//cpa-cli-refresh',
        expiry: '2030-01-01T00:00:00.123456789Z',
        token_uri: 'https://oauth2.googleapis.com/token',
      },
    })
    expect(result.format).toBe('cpa')
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      kind: 'oauth',
      format: 'cpa',
      platform: 'gemini',
      email: 'cpa-cli@example.test',
      project_id: 'gcp-proj-42',
      oauth_account: {
        access_token: 'ya29.cpa-gemini-cli',
        expiry_timestamp: 1893456000,
      },
    })
  })

  test('parses sub2api full export with mixed platforms, OAuth accounts, and Gemini API keys', () => {
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
            refresh_token: '1//sub-ag-rt',
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
    expect(result.accounts).toHaveLength(3)
    expect(result.accounts[0]).toMatchObject({
      kind: 'oauth',
      platform: 'antigravity',
      email: 'ag-sub@example.test',
      suggestedName: 'ag-sub',
      oauth_account: {
        access_token: 'ya29.sub-ag',
        expiry_timestamp: 1893456000,
      },
    })
    expect(result.accounts[1]).toMatchObject({
      kind: 'oauth',
      platform: 'gemini',
      email: 'gem-sub@example.test',
      suggestedName: 'gem-oauth',
      oauth_account: {
        access_token: 'ya29.sub-gem',
        expiry_timestamp: 1893456000,
      },
    })
    expect(result.accounts[2]).toMatchObject({
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
})
