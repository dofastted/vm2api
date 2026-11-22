import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  billingRowSlot,
  isLeftoverUsageAccount,
  isLeftoverUsageRow,
  usageAccountForVm,
  vmTotalCost,
} from '@/lib/vm-usage'
import { vmCostLedger } from './vm-usage'

describe('billingRowSlot', () => {
  const byId = new Map<string, Vm>([
    ['vm-02', { id: 'vm-02', account_uuid: 'new', email: 'new@example.com' }],
    ['vm-05', { id: 'vm-05' }],
  ])

  it('gives a reused slot id only to its bound account', () => {
    expect(
      billingRowSlot({ account_id: 'new', vm_id: 'vm-02' }, byId)?.id
    ).toBe('vm-02')
    expect(
      billingRowSlot({ account_id: 'old', vm_id: 'vm-02' }, byId)
    ).toBeUndefined()
  })

  it('keeps the slot when its bound account is unknown', () => {
    expect(
      billingRowSlot({ account_id: 'any', vm_id: 'vm-05' }, byId)?.id
    ).toBe('vm-05')
  })

  it('has no slot for deleted slots or rows without one', () => {
    expect(
      billingRowSlot({ account_id: 'x', vm_id: 'vm-09' }, byId)
    ).toBeUndefined()
    expect(billingRowSlot({ account_id: 'x' }, byId)).toBeUndefined()
  })
})

describe('GPT vm-id usage rows are live when the slot has no uuid', () => {
  const vm = {
    id: 'vm-codex-01',
    email: 'lemeryvorhees@gmail.com',
    platform: 'openai',
  } as Vm
  const row = {
    account_id: 'vm-codex-01',
    vm_id: 'vm-codex-01',
    total_cost: 139.87,
    today_cost: 24.86,
    window_5h_cost: 0.43,
    window_7d_cost: 139.87,
  }

  it('does not treat a GPT vm-id row as leftover', () => {
    expect(isLeftoverUsageRow(row, vm)).toBe(false)
    expect(isLeftoverUsageAccount(row)).toBe(false)
  })

  it('joins the row so the VM page can show spend', () => {
    expect(usageAccountForVm(vm, [row])?.total_cost).toBe(139.87)
    expect(vmTotalCost(vm, [row])).toBe(139.87)
  })

  it('uses the current account lifetime even when the slot history is higher', () => {
    expect(
      vmTotalCost({ ...vm, lifetime_usage: { cost: 0, tokens: 0 } }, [row])
    ).toBe(0)
    expect(
      vmTotalCost({ ...vm, lifetime_usage: { cost: 300, tokens: 500 } }, [row])
    ).toBe(300)
  })

  it('still drops a reused Claude slot leftover', () => {
    const claude = { id: 'vm-02', account_uuid: 'new-uuid' } as Vm
    const leftover = {
      account_id: 'vm-02',
      vm_id: 'vm-02',
      total_cost: 0,
      today_cost: 0,
    }
    expect(isLeftoverUsageRow(leftover, claude)).toBe(true)
    expect(usageAccountForVm(claude, [leftover])).toBeNull()
  })
})

describe('vm cost ledger labels', () => {
  it('names an archived account total and a retained-log fallback separately', () => {
    const archived = vmCostLedger({
      id: 'vm-1',
      total_cost: 4,
      total_tokens: 9,
      lifetime_usage: { cost: 12, tokens: 30 },
    } as never)
    expect(archived[2]).toMatchObject({
      label: '账号总计',
      note: '账号总计',
      cost: 12,
      tokens: 30,
    })

    const retained = vmCostLedger(
      { id: 'vm-2', total_cost: 7, total_tokens: 11 } as never,
      [{ account_id: 'vm-2', vm_id: 'vm-2', total_cost: 19, total_tokens: 41 }]
    )
    expect(retained[2]).toMatchObject({
      label: '日志合计',
      note: '保留日志合计',
      cost: 19,
      tokens: 41,
    })
    // 可见标签本身必须能区分两种口径：`note` 走 `title`，触屏无悬停、
    // 这两处又是不可聚焦的 `<td>`/`<span>`，不能让它承载唯一的区分。
    expect(retained[2].label).not.toBe(archived[2].label)
  })
})
