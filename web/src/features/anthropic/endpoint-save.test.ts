import { describe, expect, it } from 'vitest'
import {
  DEFAULT_URL,
  API_DEFAULTS,
  DIRECT,
  draftFromStored,
  endpointSaveRequest,
} from './endpoint-save'

const stored = draftFromStored({
  id: 'ep_1',
  base_url: 'https://relay.example.com',
  auth_scheme: 'authorization_bearer',
  api_key_entries: [{ id: 'ek_1', proxy_id: 'px_9' }],
})

describe('anthropic console endpoint save', () => {
  it('loads the stored proxy instead of falling back to direct', () => {
    expect(stored.proxyId).toBe('px_9')
    expect(stored.keyId).toBe('ek_1')
    expect(stored.authScheme).toBe('authorization_bearer')
    expect(stored.riskReviewEnabled).toBe(false)
  })

  it('saving an unchanged stored row never sends name, models or proxy', () => {
    const req = endpointSaveRequest({ ...stored, apiKey: ' sk-new ' }, 'm1')
    expect(req.method).toBe('PATCH')
    expect(req.path).toBe('/api/panel/api-endpoints/ep_1')
    expect(req.body).toEqual({ key_id: 'ek_1', api_key: 'sk-new' })
  })

  it('sends only the fields the user changed', () => {
    const req = endpointSaveRequest(
      { ...stored, proxyId: DIRECT, baseUrl: DEFAULT_URL },
      'm1'
    )
    expect(req.body).toEqual({
      key_id: 'ek_1',
      proxy_id: '',
      kind: 'claude',
      base_url: DEFAULT_URL,
    })
    expect(req.body).not.toHaveProperty('models')
    expect(req.body).not.toHaveProperty('name')
  })

  it('creates a new endpoint with its first key and model', () => {
    const req = endpointSaveRequest(
      {
        id: 'tmp',
        baseUrl: DEFAULT_URL,
        authScheme: 'x_api_key',
        apiKey: 'sk-1234',
        proxyId: 'px_1',
      },
      'claude-sonnet-4-5'
    )
    expect(req.method).toBe('POST')
    expect(req.body).toMatchObject({
      kind: 'claude',
      risk_review_enabled: false,
      proxy_id: 'px_1',
      api_key_entries: [{ api_key: 'sk-1234' }],
      models: [{ name: 'claude-sonnet-4-5', alias: 'claude-sonnet-4-5' }],
    })
  })

  it('provides Anthropic and OpenAI defaults with their own authentication', () => {
    expect(API_DEFAULTS.anthropic).toEqual({
      baseUrl: DEFAULT_URL,
      authScheme: 'x_api_key',
    })
    expect(API_DEFAULTS.openai).toEqual({
      baseUrl: 'https://api.openai.com',
      authScheme: 'authorization_bearer',
    })
  })

  it('keeps OpenAI protocol on reload and saves all fetched models for API-key routing', () => {
    const row = draftFromStored({
      id: 'ep_openai',
      protocol: 'openai',
      base_url: 'https://relay.example',
      api_key_entries: [{ id: 'ek' }],
    })
    expect(row.protocol).toBe('openai')
    expect(row.authScheme).toBe('authorization_bearer')
    const request = endpointSaveRequest(
      {
        ...row,
        storedId: undefined,
        apiKey: 'sk-openai',
        fetchedModels: ['gpt-a', 'gpt-b'],
      },
      ''
    )
    expect(request.body).toMatchObject({
      kind: 'custom',
      protocol: 'openai',
      models: [
        { name: 'gpt-a', alias: 'gpt-a' },
        { name: 'gpt-b', alias: 'gpt-b' },
      ],
    })
  })

  it('requests a server-side merge without overwriting aliases or inventing a default model', () => {
    const req = endpointSaveRequest(
      {
        ...stored,
        fetchedModels: ['m1', 'm2'],
      },
      ''
    )
    expect(req.body).not.toHaveProperty('models')
    expect(req.body.fetched_models).toEqual([
      { name: 'm1', alias: 'm1' },
      { name: 'm2', alias: 'm2' },
    ])
    expect(() =>
      endpointSaveRequest({ ...stored, storedId: undefined }, '')
    ).toThrow('模型')
  })

  it('saves risk opt-in on creation and sends only changed stored toggles', () => {
    const row = draftFromStored({ id: 'review', risk_review_enabled: true })
    expect(row.riskReviewEnabled).toBe(true)
    expect(endpointSaveRequest(row, 'm').body).not.toHaveProperty(
      'risk_review_enabled'
    )
    expect(
      endpointSaveRequest({ ...row, riskReviewEnabled: false }, 'm').body
    ).toMatchObject({ risk_review_enabled: false })
    expect(
      endpointSaveRequest({ ...stored, riskReviewEnabled: true }, 'm').body
    ).toMatchObject({ risk_review_enabled: true })
    expect(
      endpointSaveRequest({ ...row, storedId: undefined }, 'm').body
    ).toMatchObject({ risk_review_enabled: true })
  })

  it('does not enroll OpenAI endpoints in the Anthropic risk toggle', () => {
    const row = draftFromStored({
      id: 'oai',
      protocol: 'openai',
      risk_review_enabled: true,
    })
    expect(
      endpointSaveRequest({ ...row, riskReviewEnabled: false }, 'm').body
    ).not.toHaveProperty('risk_review_enabled')
    expect(
      endpointSaveRequest({ ...row, storedId: undefined }, 'm').body
    ).not.toHaveProperty('risk_review_enabled')
  })
})
