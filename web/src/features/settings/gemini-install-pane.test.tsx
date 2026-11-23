import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { GeminiInstallPane } from './gemini-install-pane'
import {
  maintenanceQueryOptions,
  type MaintenanceSnapshot,
} from './gemini-maintenance'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: string }) => <a>{children}</a>,
}))

function renderWithPhase(phase: string) {
  const client = new QueryClient()
  const snapshot: MaintenanceSnapshot = {
    available: true,
    install_dir: '/opt/vm2api',
    service: { installed: true, active: true },
    payload: {
      state: 'installed',
      version: '0.3.0-rc.3',
      cli_version: '1.5.9',
      activation_required: false,
      issue: null,
    },
    releases: [],
    rollback: { available: false, version: null },
    checks: [],
    job: {
      id: 'job-1',
      action: 'repair',
      status: 'running',
      phase,
      error_code: null,
      started_at: '2026-11-22T09:00:00Z',
      finished_at: null,
    },
  }
  client.setQueryData(maintenanceQueryOptions.queryKey, snapshot)
  client.setQueryData(['panel', 'gemini-environments'], {
    available: true,
    environments: [],
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GeminiInstallPane />
    </QueryClientProvider>
  )
}

test('renders Chinese phase labels for applying and starting maintenance phases', () => {
  const applying = renderWithPhase('applying')
  expect(applying).toContain('应用变更')
  expect(applying).not.toContain('>applying<')

  const starting = renderWithPhase('starting')
  expect(starting).toContain('启动 Gemini 服务')
  expect(starting).not.toContain('>starting<')
})
