import { describe, expect, it } from 'vitest'
import {
  bindOutcome,
  deleteConfirmText,
  disableConfirmText,
  editOutcome,
  probeAllOutcome,
} from './proxy-results'

describe('proxy action outcomes', () => {
  it('warns when the slot reload after binding failed', () => {
    const out = bindOutcome('vm-1 已绑定', { ok: false, error: 'boot timeout' })
    expect(out.level).toBe('warning')
    expect(out.text).toContain('boot timeout')
    expect(out.text).toContain('停止调度')
    expect(bindOutcome('vm-1 已绑定', null).level).toBe('success')
    expect(bindOutcome('vm-1 已绑定', { ok: true }).level).toBe('success')
  })

  it('reports a failed egress restart after editing a proxy', () => {
    const out = editOutcome({
      workers: [],
      egress: { ok: false, error: 'egress_restart_failed' },
    })
    expect(out.level).toBe('warning')
    expect(out.text).toContain('出口转发重启失败')
    expect(editOutcome({ workers: [], egress: null }).level).toBe('success')
  })

  it('reports automatic updates to bound slots', () => {
    expect(editOutcome({ workers: [{ vm_id: 'vm-1', ok: true }] })).toEqual({
      level: 'success',
      text: '已保存，已自动更新 1 台槽位配置',
    })
  })

  it('lists failed slot reloads after editing a proxy', () => {
    const out = editOutcome({
      workers: [
        { vm_id: 'vm-1', ok: false },
        { vm_id: 'vm-2', ok: true },
      ],
    })
    expect(out.text).toContain('1 台槽位重载失败：vm-1')
  })

  it('does not call an in-progress probe finished', () => {
    const busy = probeAllOutcome({ ok: false, error: 'probe_in_progress' })
    expect(busy.level).toBe('info')
    expect(busy.text).not.toContain('完成')
    const done = probeAllOutcome({
      ok: true,
      total: 2,
      results: [{ ok: true }, { ok: false }],
    })
    expect(done).toEqual({ level: 'success', text: '代理探测完成 1/2' })
  })

  it('spells out that bound slots stop scheduling', () => {
    expect(disableConfirmText(3)).toContain('3 台槽位会全部停止调度')
    expect(deleteConfirmText(2)).toContain('2 台槽位会解绑并停止调度')
  })
})
