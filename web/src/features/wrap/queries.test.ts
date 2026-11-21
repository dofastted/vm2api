import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError, api } from '@/lib/api'
import { installKernelTargets, updateCragTargets } from './queries'

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: vi.fn(),
}))

const apiMock = vi.mocked(api)
const targets = [
  { id: 'vm-03', kernel: 'crag' as const, expected_tag: 'v3.1.6' },
]
const endpoint = '/api/panel/kernels/install'

beforeEach(() => apiMock.mockReset())
afterEach(() => vi.useRealTimers())

it('polls the same background job through an upstream disconnect without resubmitting', async () => {
  vi.useFakeTimers()
  const report = {
    ok: false,
    total: 1,
    ok_count: 0,
    failed_count: 1,
    items: [
      {
        ...targets[0],
        ok: false,
        stopped: false,
        rolled_back: true,
        code: 'kernel_health_timeout',
      },
    ],
  }
  apiMock
    .mockResolvedValueOnce({ job_id: 'job-123' })
    .mockResolvedValueOnce({ state: 'running' })
    .mockRejectedValueOnce(new ApiError('Bad Gateway', 502))
    .mockResolvedValueOnce({ state: 'completed', report })
  const result = installKernelTargets(targets)
  await vi.advanceTimersByTimeAsync(2000)
  await expect(result).resolves.toEqual(report)
  const posts = apiMock.mock.calls.filter(
    ([, options]) => options?.method === 'POST'
  )
  expect(posts).toEqual([
    [
      endpoint,
      expect.objectContaining({
        body: JSON.stringify({ targets, background: true }),
      }),
    ],
  ])
  expect(apiMock.mock.calls.slice(1).map(([path]) => path)).toEqual(
    Array(3).fill(`${endpoint}?job_id=job-123`)
  )
})

it.each([new TypeError('connection lost'), new ApiError('Timeout', 408)])(
  'does not retry the install when the initial receipt is lost: %s',
  async (error) => {
    apiMock.mockRejectedValueOnce(error)
    await expect(installKernelTargets(targets)).rejects.toMatchObject({
      code: 'kernel_install_unconfirmed',
    })
    expect(apiMock).toHaveBeenCalledTimes(1)
  }
)

it.each([401, 403, 404])(
  'cannot confirm an accepted job when its status endpoint returns %i',
  async (status) => {
    apiMock
      .mockResolvedValueOnce({ job_id: 'job-123' })
      .mockRejectedValueOnce(new ApiError('Status unavailable', status))
    await expect(installKernelTargets(targets)).rejects.toMatchObject({
      code: 'kernel_install_unconfirmed',
    })
    expect(apiMock).toHaveBeenCalledTimes(2)
  }
)

it('does not accept a completed status without an installation report', async () => {
  apiMock
    .mockResolvedValueOnce({ job_id: 'job-123' })
    .mockResolvedValueOnce({ state: 'completed' })
  await expect(installKernelTargets(targets)).rejects.toMatchObject({
    code: 'kernel_install_unconfirmed',
  })
  expect(apiMock).toHaveBeenCalledTimes(2)
})

it('submits a CRAG update to its own endpoint but polls the shared install job', async () => {
  const pinned = [
    {
      id: 'vm-03',
      kernel: 'crag' as const,
      payload_tag: 'payload-2026.11.21-crag-3.1.12',
    },
  ]
  const report = {
    ok: true,
    total: 1,
    ok_count: 1,
    failed_count: 0,
    items: [{ ...pinned[0], ok: true, stopped: false, restarted: true }],
  }
  apiMock
    .mockResolvedValueOnce({ job_id: 'job-9' })
    .mockResolvedValueOnce({ state: 'completed', report })
  await expect(updateCragTargets(pinned)).resolves.toEqual(report)
  expect(apiMock.mock.calls[0]).toEqual([
    '/api/panel/kernels/crag-update',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ targets: pinned, background: true }),
    }),
  ])
  expect(apiMock.mock.calls[1][0]).toBe(`${endpoint}?job_id=job-9`)
})

it('does not retry a CRAG update whose receipt is lost', async () => {
  apiMock.mockRejectedValueOnce(new TypeError('connection lost'))
  await expect(updateCragTargets(targets)).rejects.toMatchObject({
    code: 'kernel_install_unconfirmed',
  })
  expect(apiMock).toHaveBeenCalledTimes(1)
})
