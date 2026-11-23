import type { Vm, VmCodexCredits } from '@/types/panel-vm'
import { expiresAtToMs } from '@/lib/fable-status'
import { fmtAgo } from '@/lib/format'

/** Matches backend `CODEX_CREDITS_TTL_MS` in `src/lib/protocol/codex-usage.mjs`. */
export const CODEX_CREDITS_TTL_MS = 10 * 60_000

export type OpenaiQuotaPayload = {
  quota?: {
    utilization_5h?: number | null
    utilization_7d?: number | null
  } | null
  credits?: VmCodexCredits | null
  reset_credits?: {
    available_count?: number
    credits?: Array<{ expires_at?: string }>
    fetched_at?: string
  } | null
  fetched_at?: string | null
  warning?: string
}

export type CodexCreditsStatusKey =
  'spendable' | 'stale' | 'empty' | 'rate_limited' | 'unknown'

export type CodexCreditsView = {
  balanceText: string
  statusKey: CodexCreditsStatusKey
  statusText: string
  fetchedAtMs: number | null
  agoText: string
}

/**
 * Format credit balance string/number with thousands separators while preserving
 * arbitrary decimal precision (never round long decimals through IEEE-754 float).
 */
export function formatCodexCreditBalance(
  balance: string | number | null | undefined
): string | null {
  if (balance == null) return null
  if (typeof balance === 'number') {
    if (!Number.isFinite(balance)) return null
    return addThousandsCommas(String(balance))
  }
  const raw = String(balance).trim()
  if (!raw) return null
  return addThousandsCommas(raw)
}

function addThousandsCommas(raw: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw)
  if (!match) return raw
  const sign = match[1] === '-' ? '-' : ''
  const normalizedInt = match[2].replace(/^0+(?=\d)/, '')
  const groupedInt = normalizedInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = match[3]
  return frac != null ? `${sign}${groupedInt}.${frac}` : `${sign}${groupedInt}`
}

function isUpstreamRateLimited(vm: Vm, now: number): boolean {
  const reason = String(
    vm.restriction_reason || vm.cooldown_reason || vm.availability?.reason || ''
  ).trim()
  if (
    !/^(rate_limited|account_quota_exhausted|[a-z]+_rate_limited)$/i.test(
      reason
    )
  ) {
    return false
  }
  const until = Number(vm.restriction_until || vm.cooldown_until || 0)
  if (until > 0 && until <= now) return false
  return true
}

export function describeCodexCredits(
  vm: Vm,
  now: number = Date.now()
): CodexCreditsView {
  const credits = vm.codex_credits ?? null
  const formattedBalance = formatCodexCreditBalance(credits?.balance)
  const priorSpendable =
    credits?.unlimited === true || credits?.has_credits === true
  const fetchedAtMs = expiresAtToMs(credits?.fetched_at)
  const agoText =
    fetchedAtMs != null ? fmtAgo(new Date(fetchedAtMs).toISOString(), now) : ''

  const balanceText =
    credits == null
      ? '未查询'
      : credits.unlimited === true
        ? '无限'
        : formattedBalance != null
          ? `${formattedBalance} 积分`
          : priorSpendable
            ? '有可用积分'
            : '0 积分'

  if (isUpstreamRateLimited(vm, now)) {
    return {
      balanceText,
      statusKey: 'rate_limited',
      statusText: '上游限流',
      fetchedAtMs,
      agoText,
    }
  }

  if (!credits) {
    return {
      balanceText: '未查询',
      statusKey: 'unknown',
      statusText: '未查询',
      fetchedAtMs: null,
      agoText: '',
    }
  }

  const isFresh =
    fetchedAtMs != null && now - fetchedAtMs <= CODEX_CREDITS_TTL_MS

  if (priorSpendable && isFresh) {
    return {
      balanceText,
      statusKey: 'spendable',
      statusText: '可用于续跑',
      fetchedAtMs,
      agoText,
    }
  }

  if (priorSpendable) {
    return {
      balanceText,
      statusKey: 'stale',
      statusText: '余额待刷新',
      fetchedAtMs,
      agoText,
    }
  }

  return {
    balanceText,
    statusKey: 'empty',
    statusText: '无可用积分',
    fetchedAtMs,
    agoText,
  }
}

export function formatOpenaiQuotaRefreshToast(
  data: OpenaiQuotaPayload | null | undefined
): string {
  if (!data) return '已刷新额度和积分'
  const parts: string[] = []

  const u5 = data.quota?.utilization_5h
  const u7 = data.quota?.utilization_7d
  const quotaBits: string[] = []
  if (u5 != null && Number.isFinite(Number(u5))) {
    quotaBits.push(`5h ${Math.round(Number(u5) * 100)}%`)
  }
  if (u7 != null && Number.isFinite(Number(u7))) {
    quotaBits.push(`7d ${Math.round(Number(u7) * 100)}%`)
  }
  parts.push(
    quotaBits.length
      ? `已刷新额度（${quotaBits.join(' / ')}）`
      : '已刷新额度和积分'
  )

  if (data.credits) {
    const formatted = formatCodexCreditBalance(data.credits.balance)
    if (data.credits.unlimited === true) {
      parts.push('Codex 积分 无限')
    } else if (data.credits.has_credits === true) {
      parts.push(
        formatted != null ? `Codex 积分 ${formatted} 积分` : 'Codex 积分可用'
      )
    } else {
      parts.push(
        formatted != null && formatted !== '0'
          ? `Codex 积分 ${formatted} 积分（无可用积分）`
          : '无可用积分'
      )
    }
  }

  const voucherRaw = data.reset_credits?.available_count
  if (voucherRaw != null && Number.isFinite(Number(voucherRaw))) {
    parts.push(`重置券 ${Math.max(0, Math.trunc(Number(voucherRaw)))} 张`)
  }

  return parts.join(' · ')
}
