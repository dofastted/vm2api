import { createElement } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { proxyOwnHealthOf } from '@/features/vm/proxy-health'
import { ProxyChip } from './proxy-chip'
import { proxyStatusLabel } from './proxy-sort'
import {
  PROXY_LATENCY_WARN_MS,
  proxyFieldClass,
  proxyLatencyTone,
  proxySurfaceClass,
  proxyStatusTone,
  vmProxyTone,
} from './proxy-tone'

describe('proxyLatencyTone', () => {
  it('marks available proxies green', () => {
    expect(
      proxyLatencyTone({ status: 'ok', enabled: true, latency_ms: 80 })
    ).toBe('ok')
    expect(proxyFieldClass('ok')).toBe('text-ok-3')
  })

  it('marks latency above 300ms yellow even when status is ok', () => {
    expect(
      proxyLatencyTone({
        status: 'ok',
        enabled: true,
        latency_ms: PROXY_LATENCY_WARN_MS + 1,
      })
    ).toBe('caution')
    expect(proxyFieldClass('caution')).toBe('text-caution-3')
  })

  it('marks dead or failed proxies red', () => {
    expect(proxyLatencyTone({ status: 'dead', latency_ms: 40 })).toBe('danger')
    expect(proxyLatencyTone({ status: 'fail', enabled: true })).toBe('danger')
    expect(proxyLatencyTone({ enabled: false, status: 'ok' })).toBe('danger')
    expect(proxyFieldClass('danger')).toBe('text-red-3')
  })
})

describe('vmProxyTone', () => {
  it('treats a live ticket without SOCKS5 as fail-closed red', () => {
    expect(vmProxyTone({ has_token: true })).toBe('danger')
    expect(proxySurfaceClass('danger')).toBe('bg-red-1 text-red-5')
  })

  it('keeps empty slots without a proxy as none', () => {
    expect(vmProxyTone({ has_token: false })).toBe('none')
  })

  it('shows a disconnected node as unavailable, without reusing its last healthy observation', () => {
    const proxy: VmProxySnap = {
      id: 'px-local',
      kind: 'local',
      view_id: 'px-local@node-a',
      node_id: 'node-a',
      enabled: true,
      status: 'fail',
      blocked_reason: 'node_unavailable',
      latency_ms: 25,
      bound_vm_ids: ['vm-a'],
    }
    const vm = {
      id: 'vm-a',
      node_id: 'node-a',
      proxy_id: 'px-local',
      proxy,
    } as Vm
    expect(proxyStatusLabel(proxy)).toBe('节点未连接')
    expect(proxyStatusTone(proxy)).toMatchObject({
      text: '节点未连接',
      cls: 'warn',
    })
    expect(proxyOwnHealthOf(proxy)).toMatchObject({
      score: 0,
      tone: { text: '节点未连接', cls: 'warn' },
    })
    expect(vmProxyTone(vm)).toBe('caution')
    const chip = renderToStaticMarkup(
      createElement(ProxyChip, { vm, compact: true })
    )
    expect(chip).toContain('节点未连接')
    expect(chip).toContain('已有绑定保留')
    expect(chip).not.toContain('IPv6 已关闭')
    expect(chip).not.toContain('已禁用')
    expect(chip).not.toContain('25ms')
  })
})
