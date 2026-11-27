import { afterEach, describe, expect, it, vi } from 'vitest'
import { maintenanceQueryOptions } from './gemini-maintenance'

const apiMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: apiMock,
}))

type QueryFn = (context: { signal: AbortSignal }) => Promise<unknown>
const queryFn = maintenanceQueryOptions.queryFn as unknown as QueryFn

afterEach(() => {
  vi.useRealTimers()
  apiMock.mockReset()
})

describe('maintenanceQueryOptions', () => {
  it('returns the unavailable/bootstrap status as data', async () => {
    const status = {
      available: false,
      bootstrap_required: true,
      code: 'gemini_maintenance_unavailable',
    }
    apiMock.mockResolvedValue(status)
    await expect(
      queryFn({ signal: new AbortController().signal })
    ).resolves.toEqual(status)
  })

  it('fails with a timeout code instead of staying pending when the read stalls', async () => {
    vi.useFakeTimers()
    apiMock.mockImplementation(
      (_path: string, opts: RequestInit) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    const result = queryFn({ signal: new AbortController().signal })
    const assertion = expect(result).rejects.toMatchObject({
      code: 'gemini_maintenance_timeout',
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
  })

  it('propagates caller cancellation without rewriting it as a timeout', async () => {
    apiMock.mockImplementation(
      (_path: string, opts: RequestInit) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    const controller = new AbortController()
    const result = queryFn({ signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })
})
