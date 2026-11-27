import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { listSchedulerPools, POOLS_BACKEND_NOT_READY } from './api'

const calls: string[] = []
let next: () => unknown = () => ({ pools: [] })

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      calls.push(path)
      return next()
    }),
  }
})

describe('listSchedulerPools', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('reads only /api/panel/pools (single source of truth) and normalizes provider-aware prompt defaults', async () => {
    next = () => ({
      pools: [
        { id: 'p1', provider_scope: 'anthropic' },
        { id: 'p2', provider_scope: 'openai' },
        { id: 'p3', provider_scope: 'gemini' },
      ],
    })
    const pools = await listSchedulerPools()
    expect(pools.map((p) => p.provider_scope)).toEqual([
      'anthropic',
      'openai',
      'google',
    ])
    expect(pools.map((p) => p.system_prompt_mode)).toEqual([
      'inherit_global',
      'passthrough',
      'passthrough',
    ])
    expect(calls).toEqual(['/api/panel/pools'])
  })

  it('surfaces 404 as backend-not-ready instead of falling back to /vm-pools', async () => {
    next = () => {
      throw new ApiError('not found', 404)
    }
    await expect(listSchedulerPools()).rejects.toThrow(POOLS_BACKEND_NOT_READY)
    expect(calls).toEqual(['/api/panel/pools'])
  })
})
