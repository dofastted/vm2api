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
