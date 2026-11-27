import type { ComponentProps, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeminiInventory } from '@/features/import/gemini-environments'
import {
  compareGeminiVersions,
  geminiReleaseVersionLabel,
  startMaintenance,
  type MaintenanceRequest,
  type MaintenanceSnapshot,
  type MaintenanceStatus,
} from '@/features/settings/gemini-maintenance'
import {
  CragGeminiKernelRow,
  type CragGeminiKernelRowProps,
} from './craggemini-row'

type ConfirmProps = ComponentProps<
  typeof import('@/components/confirm-dialog').ConfirmDialog
>
type ButtonProps = ComponentProps<
  typeof import('@/components/ui/button').Button
>

const state = vi.hoisted(() => ({
  maintenance: undefined as MaintenanceStatus | undefined,
  maintenancePending: false,
  maintenanceError: false,
  maintenanceErrorValue: null as unknown,
  maintenanceFetchStatus: 'idle' as 'idle' | 'fetching' | 'paused',
  refetch: vi.fn(),
  inventory: undefined as GeminiInventory | undefined,
  values: [] as unknown[],
  cursor: 0,
  buttons: [] as ButtonProps[],
  confirm: undefined as ConfirmProps | undefined,
  mutateCalls: [] as MaintenanceRequest[],
  invalidateQueries: vi.fn(),
  cancelQueries: vi.fn(),
  setQueryData: vi.fn(),
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++
    if (index >= state.values.length)
      state.values[index] = typeof initial === 'function' ? initial() : initial
    return [
      state.values[index],
      (next: unknown) => {
        state.values[index] =
          typeof next === 'function' ? next(state.values[index]) : next
      },
    ]
  },
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({
    invalidateQueries: state.invalidateQueries,
    cancelQueries: state.cancelQueries,
    setQueryData: state.setQueryData,
    isMutating: () => 0,
  }),
  useMutation: ({
    mutationFn,
  }: {
    mutationFn: (request: MaintenanceRequest) => Promise<MaintenanceSnapshot>
  }) => ({
    isPending: false,
    variables: undefined,
    mutate: (request: MaintenanceRequest) => {
      state.mutateCalls.push(request)
      void mutationFn(request)
    },
  }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey.includes('gemini-maintenance')) {
      return {
        data: state.maintenance,
        isPending: state.maintenancePending,
        isError: state.maintenanceError,
        error: state.maintenanceErrorValue,
        fetchStatus: state.maintenanceFetchStatus,
        isFetching: state.maintenanceFetchStatus === 'fetching',
        refetch: state.refetch,
      }
    }
    if (queryKey.includes('gemini-environments')) {
      return {
        data: state.inventory,
        isPending: false,
        isError: false,
      }
    }
    return { data: undefined, isPending: false, isError: false }
  },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: (props: ConfirmProps) => {
    state.confirm = props
    return props.open ? <div>{props.desc}</div> : null
  },
}))

vi.mock('@/components/ui/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/button')>()
  return {
    ...actual,
    Button: (props: ButtonProps) => {
      state.buttons.push(props)
      return <actual.Button {...props} />
    },
  }
})

vi.mock('@/features/settings/gemini-maintenance', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/features/settings/gemini-maintenance')
  >()),
  startMaintenance: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
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
      version: '0.4.4',
      cli_version: '1.5.9',
      activation_required: false,
      issue: null,
    },
    releases: [
      {
        id: 'payload-2026.11.24-gemini-0.4.6',
        version: '0.4.6',
        cli_version: '1.5.9',
        installed: false,
        compatible: true,
      },
    ],
    rollback: { available: false, version: null },
    checks: [],
    job: null,
    supports_remote_releases: true,
    ...overrides,
  }
}

function renderRow(overrides: Partial<CragGeminiKernelRowProps> = {}) {
  state.cursor = 0
  state.buttons.length = 0
  state.confirm = undefined
  const props: CragGeminiKernelRowProps = {
    canEdit: true,
    parentBusy: false,
    geminiPin: { tag: 'payload-2026.11.24-gemini-0.4.6', version: '0.4.6' },
    remoteVersions: [
      'payload-2026.11.24-gemini-0.4.6',
      'payload-2026.11.24-gemini-0.4.4',
    ],
    versionsFetching: false,
    versionsError: false,
    onOpenVersionMenu: vi.fn(),
    ...overrides,
  }
  return renderToStaticMarkup(<CragGeminiKernelRow {...props} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  state.maintenance = baseSnapshot()
  state.maintenancePending = false
  state.maintenanceError = false
  state.maintenanceErrorValue = null
  state.maintenanceFetchStatus = 'idle'
  state.inventory = {
    available: true,
    payload_state: 'installed',
    payload_mode: 'crag_subscription',
    crag_subscription: {
      configured: true,
      active: true,
      product: 'craggemini',
      host_id: 'host-1',
      sync_pending: false,
      version: 2,
      revision: 1,
      issued_at: 1700000000,
      expires_at: 1800000000,
      slot_limit: 10,
      used_slots: 4,
      available_slots: 6,
      reclaim_supported: true,
    },
    environments: [
      {
        id: 'env-1',
        name: 'g1',
        proxy_id: 'px-1',
        auth_state: 'authorized',
        runtime_ready: true,
        billing_ready: true,
        auth_method: 'oauth',
        kernel_version: '0.4.4',
        created_at: null,
        updated_at: null,
        models: [],
        account: null,
      },
    ],
  }
  state.values = []
  state.cursor = 0
  state.buttons = []
  state.confirm = undefined
  state.mutateCalls = []
  vi.mocked(startMaintenance).mockResolvedValue(baseSnapshot())
})

describe('CRAGGemini version helpers', () => {
  it('extracts version numbers rather than payload dates and orders rc versions properly', () => {
    expect(geminiReleaseVersionLabel('payload-2026.11.24-gemini-0.4.6')).toBe(
      '0.4.6'
    )
    expect(
      geminiReleaseVersionLabel('payload-2026.11.20-gemini-0.3.0-rc.2')
    ).toBe('0.3.0-rc.2')
    expect(compareGeminiVersions('0.3.0-rc.2', '0.3.0')).toBe(-1)
    expect(compareGeminiVersions('0.4.4', '0.4.6')).toBe(-1)
    expect(compareGeminiVersions('0.4.6', '0.4.6')).toBe(0)
    expect(compareGeminiVersions('0.4.6', '0.4.4')).toBe(1)
  })
})

describe('CragGeminiKernelRow', () => {
  it('installs CRAGGemini after explicit confirmation when not yet installed', () => {
    state.maintenance = baseSnapshot({
      service: { installed: false, active: false },
      payload: {
        state: 'not_configured',
        version: null,
        cli_version: null,
        activation_required: false,
        issue: 'gemini_payload_not_installed',
      },
    })
    const html = renderRow()
    expect(html).toContain('未安装')
    expect(html).toContain('锁定版本：0.4.6')
    const installButton = state.buttons.find(
      (btn) => btn['aria-label'] === '安装 CRAGGemini 内核'
    )
    expect(installButton?.disabled).toBe(false)
    installButton?.onClick?.({} as never)
    renderRow()
    expect(state.confirm?.open).toBe(true)
    expect(state.confirm?.title).toContain('安装 CRAGGemini 内核')
    expect(startMaintenance).not.toHaveBeenCalled()
    state.confirm?.handleConfirm?.()
    expect(startMaintenance).toHaveBeenCalledExactlyOnceWith({
      action: 'install',
      release_id: 'payload-2026.11.24-gemini-0.4.6',
    })
  })

  it('upgrades an installed CRAGGemini to the pinned release in one click after confirmation', () => {
    const html = renderRow()
    expect(html).toContain('当前：0.4.4 · CLI 1.5.9')
    expect(html).toContain('服务：运行中')
    expect(html).toContain('宿主订阅：已绑 4 / 10 席位')
    expect(html).toContain('升级到锁定版本 0.4.6')
    const upgradeButton = state.buttons.find(
      (btn) =>
        btn['aria-label'] ===
        '将 CRAGGemini 升级到锁定版本 payload-2026.11.24-gemini-0.4.6'
    )
    expect(upgradeButton?.disabled).toBe(false)
    upgradeButton?.onClick?.({} as never)
    renderRow()
    expect(state.confirm?.open).toBe(true)
    expect(state.confirm?.confirmText).toBe('升级并重启')
    state.confirm?.handleConfirm?.()
    expect(startMaintenance).toHaveBeenCalledExactlyOnceWith({
      action: 'update_native',
      release_id: 'payload-2026.11.24-gemini-0.4.6',
    })
  })

  it('reports already-current status instead of restarting when already on the pinned release', () => {
    state.maintenance = baseSnapshot({
      payload: {
        state: 'installed',
        version: '0.4.6',
        cli_version: '1.5.9',
        activation_required: false,
        issue: null,
      },
      releases: [
        {
          id: 'payload-2026.11.24-gemini-0.4.6',
          version: '0.4.6',
          cli_version: '1.5.9',
          installed: true,
          compatible: true,
        },
      ],
    })
    renderRow()
    const upgradeButton = state.buttons.find(
      (btn) =>
        btn['aria-label'] ===
        '将 CRAGGemini 升级到锁定版本 payload-2026.11.24-gemini-0.4.6'
    )
    upgradeButton?.onClick?.({} as never)
    renderRow()
    expect(state.confirm).toBeUndefined()
    expect(startMaintenance).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith(
      'CRAGGemini 已是锁定版本 0.4.6，无需升级'
    )
  })

  it('supports rolling back to the previous verified CRAGGemini release', () => {
    state.maintenance = baseSnapshot({
      rollback: { available: true, version: '0.4.3' },
    })
    const html = renderRow()
    expect(html).toContain('回滚 0.4.3')
    const rollbackButton = state.buttons.find(
      (btn) => btn['aria-label'] === '回滚 CRAGGemini 到上一版 0.4.3'
    )
    expect(rollbackButton?.disabled).toBe(false)
    rollbackButton?.onClick?.({} as never)
    renderRow()
    expect(state.confirm?.open).toBe(true)
    expect(state.confirm?.confirmText).toBe('确认回滚')
    state.confirm?.handleConfirm?.()
    expect(startMaintenance).toHaveBeenCalledExactlyOnceWith({
      action: 'rollback',
    })
  })

  it('explains host broker upgrade when an older maintenance broker pins an older release', () => {
    state.maintenance = baseSnapshot({
      supports_remote_releases: undefined,
      payload: {
        state: 'installed',
        version: '0.4.2',
        cli_version: '1.5.9',
        activation_required: false,
        issue: null,
      },
      releases: [
        {
          id: 'payload-2026.11.23-gemini-0.4.2',
          version: '0.4.2',
          cli_version: '1.5.9',
          installed: true,
          compatible: true,
        },
      ],
    })
    const html = renderRow()
    expect(html).toContain('控制面锁定版本为')
    expect(html).toContain('0.4.6')
    expect(html).toContain('prepare-gemini')
  })

  it('shows bootstrap command and disables install when host maintenance service is unavailable', () => {
    state.maintenance = {
      available: false,
      bootstrap_required: true,
      code: 'gemini_maintenance_unavailable',
    }
    const html = renderRow()
    expect(html).toContain('宿主维护未就绪，需先初始化')
    expect(html).not.toContain('正在读取宿主状态')
    expect(html).toContain('install-gemini.sh')
    const installButton = state.buttons.find(
      (btn) => btn['aria-label'] === '安装 CRAGGemini 内核'
    )
    expect(installButton?.disabled).toBe(true)
  })

  it('shows the localized reason when the maintenance service is unavailable without bootstrap', () => {
    state.maintenance = {
      available: false,
      bootstrap_required: false,
      code: 'gemini_maintenance_denied',
    }
    const html = renderRow()
    expect(html).toContain('控制面无权访问 Gemini 维护服务 socket')
    expect(html).not.toContain('正在读取宿主状态')
    expect(html).not.toContain('install-gemini.sh')
  })

  it('shows a loading indicator only while the status read is in flight', () => {
    state.maintenance = undefined
    state.maintenancePending = true
    state.maintenanceFetchStatus = 'fetching'
    expect(renderRow()).toContain('正在读取宿主状态')
  })

  it('does not spin forever when the first status read was cancelled', () => {
    state.maintenance = undefined
    state.maintenancePending = true
    state.maintenanceFetchStatus = 'idle'
    const html = renderRow()
    expect(html).not.toContain('正在读取宿主状态')
    expect(html).toContain('宿主状态尚未读取')
    const retry = state.buttons.find(
      (btn) => btn['aria-label'] === '重新读取 CRAGGemini 宿主状态'
    )
    expect(retry).toBeDefined()
    retry?.onClick?.({} as never)
    expect(state.refetch).toHaveBeenCalled()
  })

  it('surfaces a status read failure with its code and a retry action', async () => {
    const { ApiError } = await import('@/lib/api')
    state.maintenance = undefined
    state.maintenancePending = false
    state.maintenanceError = true
    state.maintenanceErrorValue = new ApiError(
      '读取宿主维护状态超时',
      0,
      'gemini_maintenance_timeout'
    )
    const html = renderRow()
    expect(html).toContain('无法读取 CRAGGemini 维护状态')
    expect(html).toContain('gemini_maintenance_timeout')
    expect(html).not.toContain('正在读取宿主状态')
    const retry = state.buttons.find(
      (btn) => btn['aria-label'] === '重新读取 CRAGGemini 宿主状态'
    )
    retry?.onClick?.({} as never)
    expect(state.refetch).toHaveBeenCalledTimes(1)
  })

  it('renders live Chinese phase while a maintenance job is running and translates failures', () => {
    state.maintenance = baseSnapshot({
      job: {
        id: 'job-run',
        action: 'update_native',
        status: 'running',
        phase: 'fetching',
        error_code: null,
        started_at: '2026-11-24T12:00:00Z',
        finished_at: null,
      },
    })
    const runningHtml = renderRow()
    expect(runningHtml).toContain('正在更新 CRAGGemini：下载签名载荷')
    const upgradeWhileRunning = state.buttons.find(
      (btn) =>
        btn['aria-label'] ===
        '将 CRAGGemini 升级到锁定版本 payload-2026.11.24-gemini-0.4.6'
    )
    expect(upgradeWhileRunning?.disabled).toBe(true)

    state.maintenance = baseSnapshot({
      job: {
        id: 'job-fail',
        action: 'update_native',
        status: 'failed',
        phase: 'failed',
        error_code: 'gemini_maintenance_busy',
        started_at: '2026-11-24T12:00:00Z',
        finished_at: '2026-11-24T12:00:05Z',
      },
    })
    const failedHtml = renderRow()
    expect(failedHtml).toContain(
      '宿主仍有进行中的 Gemini 授权、终端、推理或维护任务'
    )
  })

  it('restricts CRAGGemini host management for non-admin viewers', () => {
    const html = renderRow({ canEdit: false })
    expect(html).toContain('仅管理员可查看或管理 CRAGGemini 宿主内核')
    expect(html).not.toContain('兑换槽位')
    for (const btn of state.buttons) {
      expect(btn.disabled).toBe(true)
    }
  })
})
