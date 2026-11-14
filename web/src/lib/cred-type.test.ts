import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  credEndpointOf,
  defaultImportKind,
  defaultImportMethod,
  IMPORT_KINDS,
  importMethodsFor,
  importSurfaceFor,
  importTypeFor,
  oauthFlavorFor,
  resolveImportMethod,
} from '@/lib/cred-type'

describe('credential import defaults', () => {
  it('shows OAuth first and defaults to native Claude Code', () => {
    expect(IMPORT_KINDS.map(({ id }) => id)).toEqual([
      'oauth',
      'setup-token',
      'apikey',
    ])
    expect(defaultImportKind()).toBe('oauth')
    expect(defaultImportMethod('oauth')).toBe('cc')
  })

  it('keeps Cookie as the Setup Token default', () => {
    expect(defaultImportMethod('setup-token')).toBe('session')
    expect(importTypeFor('setup-token')).toBe('setup-token')
    expect(oauthFlavorFor('setup-token', 'link')).toBe('setup_token')
  })

  it('offers Cookie and auth-link for setup-token, not Claude Code', () => {
    expect(importMethodsFor('setup-token').map((m) => m.id)).toEqual([
      'link',
      'session',
    ])
    expect(resolveImportMethod('setup-token', 'cc')).toBe('session')
    expect(resolveImportMethod('setup-token', 'link')).toBe('link')
  })

  it('keeps authorization link and Cookie as OAuth alternatives', () => {
    expect(importMethodsFor('oauth').map((m) => m.id)).toEqual([
      'cc',
      'link',
      'session',
    ])
    expect(importTypeFor('oauth')).toBe('')
    expect(oauthFlavorFor('oauth', 'cc')).toBe('claude_code')
  })

  it('routes OpenAI slots to Codex import, not Setup Token / Console', () => {
    expect(
      importSurfaceFor({
        id: 'vm-codex-01',
        platform: 'openai',
        family: 'codex',
      })
    ).toBe('codex')
    expect(
      importSurfaceFor({ id: 'vm-01', platform: 'anthropic', family: 'claude' })
    ).toBe('claude')
  })
})

describe('credEndpointOf', () => {
  const claude = (over: Partial<Vm>): Vm => ({
    id: 'vm',
    has_token: true,
    ...over,
  })

  // 刷新走 OAuth 接口，但推理都是 Authorization: Bearer 调 Console。
  it('files full OAuth and Setup Token slots under Console', () => {
    expect(credEndpointOf(claude({ credential_mode: 'oauth' }))).toBe('console')
    expect(
      credEndpointOf(
        claude({
          credential_mode: 'setup-token',
          auth_scheme: 'authorization_bearer',
        })
      )
    ).toBe('console')
    expect(
      credEndpointOf(
        claude({
          credential_mode: 'official-setup-token',
          auth_scheme: 'authorization_bearer',
        })
      )
    ).toBe('console')
  })

  it('files x-api-key slots under API, by default for Console keys', () => {
    expect(credEndpointOf(claude({ credential_mode: 'apikey' }))).toBe('api')
    expect(
      credEndpointOf(
        claude({ credential_mode: 'oauth', auth_scheme: 'x_api_key' })
      )
    ).toBe('api')
  })

  it('follows the effective scheme, not how the credential was imported', () => {
    expect(
      credEndpointOf(
        claude({
          credential_mode: 'apikey',
          auth_scheme: 'authorization_bearer',
        })
      )
    ).toBe('console')
  })

  it('keeps GPT slots on OAuth and empty slots unclassified', () => {
    expect(
      credEndpointOf(
        claude({
          platform: 'openai',
          family: 'codex',
          credential_mode: 'oauth',
        })
      )
    ).toBe('oauth')
    expect(credEndpointOf(claude({ has_token: false }))).toBe('none')
    expect(credEndpointOf(undefined)).toBe('none')
  })
})
