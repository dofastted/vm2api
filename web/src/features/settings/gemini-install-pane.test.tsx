import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { GeminiInstallPane } from './gemini-install-pane'
import {
  classifyMaintenanceSubmitError,
  GEMINI_INSTALL_COMMAND,
  GEMINI_LOCAL_PREPARE_COMMAND,
  maintenanceQueryOptions,
  type MaintenanceSnapshot,
  type MaintenanceStatus,
} from './gemini-maintenance'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: string }) => <a>{children}</a>,
}))

function baseSnapshot(
  overrides: Partial<MaintenanceSnapshot> = {}
): MaintenanceSnapshot {
  return {
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
    job: null,
    ...overrides,
  }
}

function renderStatus(status: MaintenanceStatus) {
  const client = new QueryClient()
  client.setQueryData(maintenanceQueryOptions.queryKey, status)
  client.setQueryData(['panel', 'gemini-environments'], {
    available: true,
    environments: [],
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <GeminiInstallPane />
      </QueryClientProvider>
    )
  } finally {
    client.clear()
  }
}

function renderWithPhase(phase: string) {
  return renderStatus(
    baseSnapshot({
      job: {
        id: 'job-1',
        action: 'repair',
        status: 'running',
        phase,
        error_code: null,
        started_at: '2026-11-22T09:00:00Z',
        finished_at: null,
      },
    })
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

test('maps check ids, check codes, and failed job error codes to Chinese with secondary code tags', () => {
  const html = renderStatus(
    baseSnapshot({
      checks: [
        {
          id: 'runtime_service',
          state: 'warning',
          code: 'gemini_maintenance_service_inactive',
        },
        {
          id: 'ipv4_forwarding',
          state: 'warning',
          code: 'gemini_maintenance_ipv4_forwarding_disabled',
        },
        {
          id: 'sandbox',
          state: 'fail',
          code: 'gemini_sandbox_apparmor_restricted',
        },
        {
          id: 'agy_patch',
          state: 'fail',
          code: 'gemini_maintenance_agy_patch_missing',
        },
      ],
      job: {
        id: 'job-2',
        action: 'repair',
        status: 'failed',
        phase: 'failed',
        error_code: 'gemini_maintenance_busy',
        started_at: '2026-11-22T09:00:00Z',
        finished_at: '2026-11-22T09:00:05Z',
      },
    })
  )
  expect(html).toContain('Gemini 运行服务')
  expect(html).toContain('Gemini 运行服务（vm2api-gemini.service）当前未运行')
  expect(html).toContain('gemini_maintenance_service_inactive')
  expect(html).toContain('IPv4 转发')
  expect(html).toContain('宿主机未开启 IPv4 转发')
  expect(html).toContain('非特权沙箱（bwrap / AppArmor）')
  expect(html).toContain('AppArmor 限制了非特权 user namespace')
  expect(html).toContain('gemini_sandbox_apparmor_restricted')
  expect(html).toContain('Antigravity CLI 资格补丁')
  expect(html).toContain('尚未应用资格补丁')
  expect(html).toContain('gemini_maintenance_agy_patch_missing')
  expect(html).toContain('宿主仍有进行中的 Gemini 授权、终端、推理或维护任务')
  expect(html).toContain('gemini_maintenance_busy')

  const unavailableHtml = renderStatus(
    baseSnapshot({
      checks: [
        {
          id: 'sandbox',
          state: 'fail',
          code: 'gemini_sandbox_unavailable',
        },
      ],
      job: {
        id: 'job-3',
        action: 'repair',
        status: 'failed',
        phase: 'failed',
        error_code: 'gemini_maintenance_apparmor_policy_conflict',
        started_at: '2026-11-22T09:00:00Z',
        finished_at: '2026-11-22T09:00:05Z',
      },
    })
  )
  expect(unavailableHtml).toContain('非特权沙箱（bwrap）不可用')
  expect(unavailableHtml).toContain('gemini_sandbox_unavailable')
  expect(unavailableHtml).toContain('/etc/apparmor.d/vm2api-gemini')
  expect(unavailableHtml).toContain(
    'gemini_maintenance_apparmor_policy_conflict'
  )
})

test('bootstrap notice offers both local prepare-gemini script and remote curl command', () => {
  const html = renderStatus({
    available: false,
    bootstrap_required: true,
    code: 'gemini_maintenance_unavailable',
  })
  expect(html).toContain(GEMINI_LOCAL_PREPARE_COMMAND)
  expect(html).toContain(GEMINI_INSTALL_COMMAND)
  expect(html).toContain('复制本地命令')
  expect(html).toContain('复制远程命令')
})

describe('classifyMaintenanceSubmitError', () => {
  test('treats deterministic 4xx/503 rejections as 任务未提交 with Chinese reason', () => {
    const busy = classifyMaintenanceSubmitError(
      new ApiError('gemini_maintenance_busy', 409, 'gemini_maintenance_busy')
    )
    expect(busy.kind).toBe('rejected')
    expect(busy.title).toMatch(/^任务未提交：/)
    expect(busy.title).toContain('进行中的 Gemini')
    expect(busy.code).toBe('gemini_maintenance_busy')

    const denied = classifyMaintenanceSubmitError(
      new ApiError(
        'gemini_maintenance_denied',
        503,
        'gemini_maintenance_denied'
      )
    )
    expect(denied.kind).toBe('rejected')
    expect(denied.title).toMatch(/^任务未提交：/)
    expect(denied.title).toContain('无权访问')
  })

  test('treats network drops and timeouts as 未能确认任务已提交', () => {
    const network = classifyMaintenanceSubmitError(
      new TypeError('Failed to fetch')
    )
    expect(network.kind).toBe('uncertain')
    expect(network.title).toBe('未能确认任务已提交')

    const timeout = classifyMaintenanceSubmitError(
      new ApiError(
        'gemini_maintenance_timeout',
        503,
        'gemini_maintenance_timeout'
      )
    )
    expect(timeout.kind).toBe('uncertain')
    expect(timeout.title).toBe('未能确认任务已提交')
    expect(timeout.detail).toContain('超时')
  })
})
