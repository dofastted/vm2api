import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { GeminiEnvironment } from './gemini-environments'
import { GeminiTestPanel } from './gemini-test-panel'

const environment: GeminiEnvironment = {
  id: 'fixture-environment',
  name: 'Fixture',
  proxy_id: 'fixture-proxy',
  auth_method: 'oauth',
  auth_state: 'authorized',
  proxy_ready: true,
  runtime_ready: false,
  billing_ready: false,
  kernel_version: '0.3.0-rc.3',
  created_at: null,
  updated_at: null,
  models_discovered: true,
  models: ['fixture-model'],
  account: null,
}

function modelPullDisabled(override: Partial<GeminiEnvironment>) {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GeminiTestPanel environment={{ ...environment, ...override }} />
    </QueryClientProvider>
  )
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
  const pull = buttons.find(
    (match) => match[2].replace(/<[^>]*>/g, '').trim() === '拉取模型'
  )
  if (!pull) throw new Error('Model discovery control is absent')
  return /(?:^|\s)disabled(?:[=\s]|$)/.test(pull[1])
}

test('imported OAuth credentials cannot enable CLI model discovery despite an authorized marker and cached models', () => {
  expect(modelPullDisabled({ oauth_imported: true })).toBe(true)
})

test('official OAuth and API-key discovery do not depend on hardcoded runtime or billing readiness flags', () => {
  expect(modelPullDisabled({ oauth_imported: false })).toBe(false)
  expect(modelPullDisabled({ auth_method: 'api_key' })).toBe(false)
})

test('discovery remains blocked by explicit authorization or proxy failures', () => {
  expect(modelPullDisabled({ auth_state: 'reauth_required' })).toBe(true)
  expect(modelPullDisabled({ proxy_ready: false })).toBe(true)
})

test('unbound CRAGGemini seat warns before OAuth test chat without blocking model discovery', () => {
  const unbound: GeminiEnvironment = {
    ...environment,
    crag_license: {
      product: 'craggemini',
      status: 'unlicensed',
      valid: false,
      seat_required: true,
      code: 'license_required',
    },
  }
  expect(modelPullDisabled({ crag_license: unbound.crag_license })).toBe(false)
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GeminiTestPanel environment={unbound} />
    </QueryClientProvider>
  )
  expect(html).toContain('请先在「账号」绑定 CRAGGemini 订阅席位')
})

test('defaults test prompt to hello and prefers Gemini 4 neon model when available', () => {
  const withNeon: GeminiEnvironment = {
    ...environment,
    models: ['gemini-3-flash', 'gemini-4-neon-high', 'gemini-3.8-flash-high'],
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GeminiTestPanel environment={withNeon} />
    </QueryClientProvider>
  )
  expect(html).toContain('>hello</textarea>')
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
  const start = buttons.find(
    (match) => match[2].replace(/<[^>]*>/g, '').trim() === '开始测试'
  )
  expect(start).toBeDefined()
  expect(/(?:^|\s)disabled(?:[=\s]|$)/.test(start![1])).toBe(false)
})

test('shows Google verification guidance and safe link when account requires browser validation', () => {
  const verifyUrl =
    'https://accounts.google.com/v3/signin/continue?plt=fixture&sarp=1'
  const needsVerify: GeminiEnvironment = {
    ...environment,
    account: {
      state: 'ok',
      checked_at: '2026-11-24T00:00:00Z',
      email: 'verify@example.test',
      project_id: 'proj-1',
      region: null,
      plan: 'Google AI Ultra',
      expires_at: null,
      eligibility: 'verification_required',
      validation_url: verifyUrl,
      quotas: [],
      credits: [],
    },
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GeminiTestPanel environment={needsVerify} />
    </QueryClientProvider>
  )
  expect(html).toContain('VALIDATION_REQUIRED')
  expect(html).toContain('打开 Google 验证页')
  expect(html).toContain('https://accounts.google.com/v3/signin/continue')
})

test('renders cleanly with mixed Gemini and Anthropic (ag- prefixed) discovered models', () => {
  const mixed: GeminiEnvironment = {
    ...environment,
    models: ['claude-sonnet-4-6-high', 'gemini-4-neon', 'gpt-oss-120b-medium'],
    account: {
      state: 'ok',
      checked_at: '2026-11-24T00:00:00Z',
      email: 'mixed@example.test',
      project_id: 'proj-1',
      region: null,
      plan: 'Google AI Pro',
      expires_at: null,
      model_catalog: [
        { id: 'claude-sonnet-4-6-high', provider: 'anthropic', quota_group: '3p' },
        { id: 'gemini-4-neon', provider: 'google', quota_group: 'gemini' },
        { id: 'gpt-oss-120b-medium', provider: 'openai', quota_group: '3p' },
      ],
      quotas: [],
      credits: [],
    },
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GeminiTestPanel environment={mixed} />
    </QueryClientProvider>
  )
  expect(html).toContain('>hello</textarea>')
})
