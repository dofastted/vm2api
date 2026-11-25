import type {
  ActiveUsageQueryResult,
  ActiveUsageRetainedWindow,
  Vm,
} from '@/types/panel-vm'

export const ACTIVE_USAGE_WINDOW_LABELS: Record<'5h' | '7d' | '7d_oi', string> =
  {
    '5h': '5H',
    '7d': '7D',
    '7d_oi': 'Fable',
  }

export function formatQuotaRatioPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知'
  const ratio = value > 1.5 ? value / 100 : value
  return `${(ratio * 100).toFixed(0)}%`
}

function summarizeRetainedWindows(
  windows: ActiveUsageRetainedWindow[]
): string {
  return windows
    .map(
      (item) =>
        `${ACTIVE_USAGE_WINDOW_LABELS[item.window] || item.window}（官方 ${formatQuotaRatioPct(item.official_utilization)} / 当前保留 ${formatQuotaRatioPct(item.retained_utilization)}）`
    )
    .join('、')
}

function describeRetentionReason(windows: ActiveUsageRetainedWindow[]): string {
  if (windows.some((item) => item.reason === 'inflight')) {
    return '当前有在途推理请求，保留保守响应头以防覆盖在途消耗'
  }
  if (windows.some((item) => item.reason === 'newer_headers')) {
    return '查询期间产生了更新的推理响应头，保留最新响应头读数'
  }
  if (windows.some((item) => item.reason === 'reset_boundary')) {
    return '查询早于最近一次重置边界，保留当前窗口状态'
  }
  if (windows.some((item) => item.reason === 'official_leftover_limit')) {
    return '官方侧仍为旧窗口满额残留，保留当前活跃响应头'
  }
  return '官方侧读数与活跃响应头冲突，保留当前保守读数'
}

export type ActiveUsageOutcomeView = {
  kind: 'reconciled' | 'settle_conflict' | 'retained'
  message: string
  canForceReconcile: boolean
  retainedWindows: ActiveUsageRetainedWindow[]
  settleRemainingSec: number
}

export function describeActiveUsageOutcome(
  data: ActiveUsageQueryResult | null | undefined,
  forced = false
): ActiveUsageOutcomeView {
  const retained = Array.isArray(data?.retained_windows)
    ? data.retained_windows
    : []
  if (!data || data.reconciled !== false || retained.length === 0) {
    return {
      kind: 'reconciled',
      message: forced ? '已按官方读数校准额度' : '已更新官方额度',
      canForceReconcile: false,
      retainedWindows: [],
      settleRemainingSec: 0,
    }
  }
  const summary = summarizeRetainedWindows(retained)
  const canForce =
    data.can_force_reconcile === true &&
    retained.every((item) => item.reason === 'settle_window')
  const settleRemainingSec = canForce
    ? Math.max(1, Math.ceil((Number(data.settle_remaining_ms) || 0) / 1000))
    : 0
  if (canForce) {
    return {
      kind: 'settle_conflict',
      message: `官方读数已记录，但 ${summary} 距上次推理不足 5 分钟（约剩 ${settleRemainingSec} 秒静置期），暂保留保守响应头；若确认已在外部重置可按官方校准`,
      canForceReconcile: true,
      retainedWindows: retained,
      settleRemainingSec,
    }
  }
  return {
    kind: 'retained',
    message: `官方读数已记录，但 ${summary} 未覆盖：${describeRetentionReason(retained)}`,
    canForceReconcile: false,
    retainedWindows: retained,
    settleRemainingSec: 0,
  }
}

export function conflictStillDivergent(
  vm: Vm,
  retainedWindows: ActiveUsageRetainedWindow[]
): boolean {
  if (!retainedWindows.length) return false
  const official = vm.quota_observations?.official
  if (!official) return true
  return retainedWindows.some((item) => {
    if (item.window === '5h') {
      return (
        official['5h']?.utilization == null ||
        vm.utilization_5h == null ||
        official['5h'].utilization !== vm.utilization_5h
      )
    }
    if (item.window === '7d') {
      return (
        official['7d']?.utilization == null ||
        vm.utilization_7d == null ||
        official['7d'].utilization !== vm.utilization_7d
      )
    }
    return (
      vm.utilization_7d_oi == null ||
      item.official_utilization == null ||
      vm.utilization_7d_oi !== item.official_utilization
    )
  })
}
