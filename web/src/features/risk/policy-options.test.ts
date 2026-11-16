import { describe, expect, it } from 'vitest'
import { endpointOptions, modelOptions, poolOptions } from './policy-options'

describe('risk audit target options', () => {
  it('lists all groups by name but prevents choosing paused or empty pools', () => {
    expect(
      poolOptions([
        { id: 'pool_a', name: '普通组', enabled: true, vm_ids: ['vm-1'] },
        { id: 'pool_b', name: '降级组', enabled: true, vm_ids: ['vm-2'] },
        { id: 'pool_c', name: '暂停组', enabled: false, vm_ids: ['vm-3'] },
        { id: 'pool_d', name: '空组', enabled: true, vm_ids: [] },
      ]).map(({ label, disabled }) => [label, disabled])
    ).toEqual([
      ['普通组', false],
      ['降级组', false],
      ['暂停组', true],
      ['空组', true],
    ])
  })

  it('labels channels by protocol and excludes disabled channels from model targets', () => {
    const endpoints = [
      {
        id: 'ep-one',
        name: '备用',
        prefix: 'backup',
        kind: 'openai' as const,
        models: [
          { name: 'upstream-small', alias: 'small' },
          { name: 'upstream-shared', alias: 'GPT-SHARED' },
          { name: 'upstream-image', alias: 'image', image: true },
        ],
      },
      {
        id: 'ep-two',
        disabled: true,
        models: [{ name: 'test', alias: 'disabled-channel' }],
      },
    ]
    expect(endpointOptions(endpoints)).toMatchObject([
      { value: 'ep-one', label: '备用', detail: 'OpenAI' },
      { value: 'ep-two', disabled: true },
    ])
    const catalog = [
      { id: 'gpt-shared', display_name: 'Shared' },
      { id: 'disabled-model', enabled: false },
      { id: 'gpt-image-1', family: 'gpt-image' },
    ]
    const choices = modelOptions(catalog, endpoints)
    expect(choices.map(({ value }) => value)).toEqual([
      'gpt-shared',
      'small',
      'backup/small',
      'backup/GPT-SHARED',
    ])
    expect(choices[0].label).toBe('Shared')
  })
})
