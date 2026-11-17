import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  catalogForVm,
  indexVms,
  isCodexVm,
  isGptCatalogId,
  kindFromModel,
  platformLabel,
  compactEmail,
  clipLabel,
  slotAccountLabel,
  slotCredentialLabel,
  vmKindOf,
} from '@/lib/vm-kind'

describe('vmKindOf', () => {
  it('defaults unmarked slots to Claude', () => {
    expect(vmKindOf({ id: 'vm-01', inference_engine: 'rust' })).toBe('claude')
    expect(platformLabel({ id: 'vm-01' })).toBe('Claude')
  })

  it('reads explicit openai/codex', () => {
    const vm = { id: 'vm-codex-01', platform: 'openai', family: 'codex' }
    expect(isCodexVm(vm)).toBe(true)
    expect(platformLabel(vm)).toBe('GPT')
  })

  it('lets explicit anthropic win leftover Codex flags', () => {
    const vm: Vm = {
      id: 'vm-01',
      platform: 'anthropic',
      family: 'claude',
      codex_kernel: true,
    }
    expect(isCodexVm(vm)).toBe(false)
  })

  it('keeps legacy unmarked Codex flags', () => {
    expect(isCodexVm({ id: 'a', codex_kernel: true })).toBe(true)
    expect(
      isCodexVm({ id: 'b', inference_engine: 'codex' } as unknown as Vm)
    ).toBe(true)
    expect(isCodexVm({ id: 'c', runtime: { codex_kernel: '1' } })).toBe(true)
  })
})

describe('kindFromModel / slotAccountLabel', () => {
  it('classifies GPT models and openai protocol as Codex', () => {
    expect(kindFromModel('gpt-5.4')).toBe('codex')
    expect(kindFromModel('claude-sonnet-5', 'openai')).toBe('codex')
    expect(kindFromModel('claude-sonnet-5')).toBe('claude')
  })

  it('prefers email over slot id', () => {
    expect(
      slotAccountLabel({ id: 'vm-01', email: 'a@x.com' }, { vmId: 'vm-01' })
    ).toBe('a@x.com')
    expect(slotAccountLabel(undefined, { vmId: 'vm-09' })).toBe('vm-09')
    expect(indexVms([{ id: 'vm-01' }]).get('vm-01')?.id).toBe('vm-01')
  })

  it('shortens long local parts and keeps a short domain', () => {
    expect(compactEmail('a@x.com')).toBe('a@x.com')
    expect(compactEmail('someone.with.a.very.long.name@gmail.com', 22)).toBe(
      'someone.wit…@gmail.com'
    )
    expect(compactEmail('user@verylongcorporatedomain.example.com', 22)).toBe(
      'user@example.com'
    )
    expect(compactEmail('no-at-but-extremely-long-label-here', 12)).toBe(
      'no-at-but-e…'
    )
  })

  it('clips left-side names to 10 characters', () => {
    expect(clipLabel('vm-01')).toBe('vm-01')
    expect(clipLabel('account@example.com')).toBe('account@ex…')
    expect(clipLabel('十个字符刚好够用啊啊')).toBe('十个字符刚好够用啊啊')
    expect(clipLabel('十个字符刚好够用啊啊多')).toBe('十个字符刚好够用啊啊…')
  })
})

describe('slotCredentialLabel', () => {
  it('shows full emails on blades and local parts on compact units', () => {
    for (const platform of ['openai', 'anthropic']) {
      const vm = {
        id: 'vm-01',
        platform,
        email: 'user@example.com',
        has_token: true,
      }
      expect(slotCredentialLabel(vm)).toBe('user@example.com')
      expect(slotCredentialLabel(vm, true)).toBe('user')
    }
  })

  it('distinguishes imported accounts without email from empty slots at both sizes', () => {
    for (const compact of [false, true]) {
      expect(slotCredentialLabel({ has_token: true }, compact)).toBe(
        '已导入账号 · 邮箱未知'
      )
      expect(slotCredentialLabel({ has_refresh: true }, compact)).toBe(
        '已导入账号 · 邮箱未知'
      )
      expect(slotCredentialLabel({ has_token: false }, compact)).toBe('空槽')
      expect(
        slotCredentialLabel({ email: '  ', has_token: true }, compact)
      ).toBe('已导入账号 · 邮箱未知')
    }
  })
})

describe('catalogForVm', () => {
  const items = [
    { id: 'claude-sonnet-5', family: 'sonnet' },
    { id: 'gpt-5.4', family: 'codex' },
    { id: 'gpt-5.6' },
  ]

  it('keeps only GPT ids on Codex slots', () => {
    const vm = { id: 'vm-codex-01', platform: 'openai', family: 'codex' }
    expect(catalogForVm(items, vm).map((m) => m.id)).toEqual([
      'gpt-5.4',
      'gpt-5.6',
    ])
    expect(isGptCatalogId('gpt-5.4', 'codex')).toBe(true)
  })

  it('hides GPT ids on Claude slots', () => {
    const vm = { id: 'vm-01', platform: 'anthropic', family: 'claude' }
    expect(catalogForVm(items, vm).map((m) => m.id)).toEqual([
      'claude-sonnet-5',
    ])
  })
})
