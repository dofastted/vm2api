import type { Vm, VmProxySnap } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'

export type ProxyHealth = {
  score: number
  tone: StatusTone
  reasons: string[]
}

/**
 * 单槽 SOCKS5 健康分。延迟和连续失败是运营下一步要不要换绑的依据；
 * 有票无代理是 fail-closed，直接 0 分。
 */
export function proxyHealthOf(vm: Vm, proxy: VmProxySnap): ProxyHealth {
  if (vm.has_token && !proxy.host && !vm.proxy_id) {
    return {
      score: 0,
      tone: {
        key: 'bad',
        text: '缺 SOCKS5',
        cls: 'bad',
        label: '有凭证但未绑代理 · fail closed',
      },
      reasons: ['有凭证但未绑代理，出站会直接拒绝'],
    }
  }
  if (!proxy.host && !vm.proxy_id) {
    return {
      score: 0,
      tone: {
        key: 'none',
        text: '未绑定',
        cls: 'none',
        label: '还没有 SOCKS5',
      },
      reasons: ['池里分配一条，或从空闲列表绑定'],
    }
  }

  return proxyOwnHealthOf(proxy)
}

/**
 * 代理自身的健康分，不掺 VM 绑定关系。一条代理可能绑 0~N 台 VM，
 * 没有单一 vm 可传给 `proxyHealthOf`。
 */
export function proxyOwnHealthOf(proxy: VmProxySnap): ProxyHealth {
  if (proxy.blocked_reason === 'node_unavailable') {
    return {
      score: 0,
      tone: {
        key: 'warn',
        text: '节点未连接',
        cls: 'warn',
        label: '已有绑定保留，节点连接恢复后才能绑定新槽位或探测',
      },
      reasons: ['节点未连接，暂时无法探测出口，已有绑定保留'],
    }
  }
  if (proxy.blocked_reason === 'ipv6_disabled') {
    return {
      score: 0,
      tone: {
        key: 'off',
        text: 'IPv6 已关闭',
        cls: 'off',
        label: '设置 → SOCKS5 开启 IPv6 代理出口后才能使用',
      },
      reasons: ['IPv6 代理出口已关闭，保留绑定和探测历史，不计作代理故障'],
    }
  }
  const status = String(proxy.status || '').toLowerCase()
  if (status === 'dead' || status === 'down' || status === 'error') {
    return {
      score: 0,
      tone: {
        key: 'bad',
        text: '失效',
        cls: 'bad',
        label: proxy.last_error || '最近探测失败',
      },
      reasons: [proxy.last_error || '状态为失效，需要换绑或重探'],
    }
  }

  const fails = Number(proxy.consecutive_failures || 0)
  const lat = proxy.latency_ms
  let score = 100
  const reasons: string[] = []

  if (fails >= 3) {
    score -= 45
    reasons.push(`连续失败 ${fails}`)
  } else if (fails > 0) {
    score -= 18
    reasons.push(`失败 ${fails} 次`)
  }

  if (lat == null) {
    score -= 12
    reasons.push('尚未探测延迟')
  } else if (lat >= 1000) {
    score -= 40
    reasons.push(`${lat}ms`)
  } else if (lat >= 500) {
    score -= 22
    reasons.push(`${lat}ms`)
  } else if (lat >= 200) {
    score -= 8
    reasons.push(`${lat}ms`)
  } else {
    reasons.push(`${lat}ms`)
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const cls =
    score >= 80 ? 'ok' : score >= 55 ? 'caution' : score >= 30 ? 'warn' : 'bad'
  const text =
    cls === 'ok'
      ? '健康'
      : cls === 'caution'
        ? '偏慢'
        : cls === 'warn'
          ? '不稳'
          : '异常'
  return {
    score,
    tone: {
      key: cls,
      text,
      cls,
      label: reasons.join(' · '),
    },
    reasons,
  }
}
