import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VmKernelSwitchJob } from '@/lib/api'
import { getVmKernelSwitch, patchVm, startVmKernelSwitch } from '@/lib/api'
import {
  DEFAULT_RESOLVED_ENGINE,
  INFERENCE_ENGINE_OPTIONS,
  inferenceEnginePatchValue,
  isFallbackToGo,
  normalizeGlobalClaudeEngine,
  normalizeInferenceEngine,
} from './engine-contract'
import { vmKernelSwitchQueryOptions } from './queries'

vi.mock('@/lib/session', () => ({
  apiBase: () => '',
  clearSession: vi.fn(),
  hasSession: () => true,
  sessionToken: () => '',
}))

describe('VM inference engine contract', () => {
  it('exposes only auto and rust choices', () => {
    expect(INFERENCE_ENGINE_OPTIONS.map((option) => option.value)).toEqual([
      'auto',
      'rust',
    ])
  })

  it.each([
    ['auto', ''],
    ['rust', 'rust'],
    ['go', 'rust'],
  ] as const)('maps %s to the Gateway PATCH value %s', (engine, expected) => {
    expect(inferenceEnginePatchValue(engine)).toBe(expected)
  })

  it('falls back safely for unknown response values', () => {
    expect(normalizeInferenceEngine('unexpected', 'auto')).toBe('auto')
    expect(normalizeInferenceEngine(null, 'rust')).toBe('rust')
    expect(normalizeInferenceEngine('go', 'auto')).toBe('rust')
  })

  it('treats omitted or empty global engine as rust', () => {
    expect(normalizeGlobalClaudeEngine(undefined)).toBe('rust')
    expect(normalizeGlobalClaudeEngine('')).toBe('rust')
    expect(normalizeGlobalClaudeEngine('rust')).toBe('rust')
    expect(normalizeGlobalClaudeEngine('go')).toBe('rust')
  })

  it('never enables fallback_to_go', () => {
    expect(isFallbackToGo(undefined)).toBe(false)
    expect(isFallbackToGo(false)).toBe(false)
    expect(isFallbackToGo(true)).toBe(false)
  })

  it('uses rust when resolved engine is omitted', () => {
    expect(DEFAULT_RESOLVED_ENGINE).toBe('rust')
    expect(normalizeInferenceEngine(null, DEFAULT_RESOLVED_ENGINE)).toBe('rust')
    expect(normalizeInferenceEngine(undefined, DEFAULT_RESOLVED_ENGINE)).toBe(
      'rust'
    )
  })

  it('encodes the VM id and sends only the per-VM PATCH body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await patchVm('vm/with spaces', { inference_engine: '' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/panel/vms/vm%2Fwith%20spaces',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ inference_engine: '' }),
      })
    )
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('/routing')
    fetchMock.mockRestore()
  })

  it('preserves Gateway error messages for failed engine switches', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'ENGINE_UNHEALTHY',
            message: 'Rust health check failed',
          },
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )

    await expect(
      patchVm('vm-1', { inference_engine: 'rust' })
    ).rejects.toMatchObject({
      message: 'Rust health check failed',
      status: 503,
      code: 'ENGINE_UNHEALTHY',
    })
    fetchMock.mockRestore()
  })
})

function switchJob(
  overrides: Partial<VmKernelSwitchJob> = {}
): VmKernelSwitchJob {
  return {
    id: 'job-01',
    vm_id: 'vm/with spaces',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    status: 'running',
    started_at: '2026-11-15T00:00:00Z',
    finished_at: null,
    error: null,
    ...overrides,
  }
}

function switchResponse(data: VmKernelSwitchJob | null, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('remote VM kernel switch contract', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    { dataplane: 'crag', crag_kernel_version: 'v2' },
    { dataplane: 'wrap', crag_kernel_version: '' },
  ] as const)(
    'submits only the explicit per-slot target %j and retains the 202 running status',
    async (body) => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(switchResponse(switchJob(body), 202))
      const accepted = await startVmKernelSwitch('vm/with spaces', body)
      expect(accepted.status).toBe('running')
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        '/api/panel/vms/vm%2Fwith%20spaces/kernel-switch',
        expect.objectContaining({ method: 'POST', body: JSON.stringify(body) })
      )
    }
  )

  it.each(['succeeded', 'failed'] as const)(
    'keeps polling while running and stops on %s without submitting another POST',
    async (status) => {
      const completed = switchJob({
        status,
        finished_at: '2026-11-15T00:02:00Z',
        error:
          status === 'failed'
            ? { code: 'runtime_start_failed', message: '内核未就绪' }
            : null,
      })
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(switchResponse(switchJob(), 202))
        .mockResolvedValueOnce(switchResponse(switchJob()))
        .mockResolvedValueOnce(switchResponse(completed))
      const client = new QueryClient()
      const options = vmKernelSwitchQueryOptions('vm/with spaces')
      const observer = new QueryObserver(client, options)
      try {
        client.setQueryData(
          options.queryKey,
          await startVmKernelSwitch('vm/with spaces', {
            dataplane: 'crag',
            crag_kernel_version: 'v2',
          })
        )
        await client.fetchQuery(options)
        const query = observer.getCurrentQuery()
        if (typeof options.refetchInterval !== 'function') {
          throw new Error('Kernel switch polling query was not created')
        }
        expect(options.refetchInterval(query)).toBe(2000)
        await client.fetchQuery(options)
        expect(options.refetchInterval(query)).toBe(false)
        expect(query.state.data?.status).toBe(status)
        expect(query.state.data?.error?.message).toBe(
          status === 'failed' ? '内核未就绪' : undefined
        )
        expect(
          fetchMock.mock.calls.map(([, init]) => init?.method || 'GET')
        ).toEqual(['POST', 'GET', 'GET'])
      } finally {
        client.clear()
      }
    }
  )

  it('treats an initial null as idle but a lost running task as interrupted and stops polling', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(switchResponse(null))
      .mockResolvedValueOnce(switchResponse(switchJob()))
      .mockResolvedValueOnce(switchResponse(null))
      .mockResolvedValueOnce(switchResponse(null))
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 3 } },
    })
    const options = vmKernelSwitchQueryOptions('vm/with spaces')
    const observer = new QueryObserver(client, options)
    try {
      await expect(client.fetchQuery(options)).resolves.toBeNull()
      await client.fetchQuery(options)
      await expect(client.fetchQuery(options)).rejects.toMatchObject({
        code: 'kernel_switch_interrupted',
        message: expect.stringContaining('操作可能已中断'),
      })
      const query = observer.getCurrentQuery()
      if (typeof options.refetchInterval !== 'function') {
        throw new Error('Kernel switch polling query was not created')
      }
      expect(query.state.status).toBe('error')
      expect(options.refetchInterval(query)).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(
        fetchMock.mock.calls.every(
          ([, init]) => !init?.method || init.method === 'GET'
        )
      ).toBe(true)
      // The explicit UI state check acknowledges the interrupted task before GET.
      client.setQueryData(options.queryKey, null)
      await expect(client.fetchQuery(options)).resolves.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      client.clear()
    }
  })

  it('stops on a disconnected GET instead of retrying indefinitely or reissuing POST', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(switchResponse(switchJob()))
      .mockRejectedValueOnce(new Error('连接断开'))
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 3 } },
    })
    const options = vmKernelSwitchQueryOptions('vm/with spaces')
    const observer = new QueryObserver(client, options)
    try {
      await client.fetchQuery(options)
      await expect(client.fetchQuery(options)).rejects.toThrow('连接断开')
      const query = observer.getCurrentQuery()
      if (typeof options.refetchInterval !== 'function') {
        throw new Error('Kernel switch polling query was not created')
      }
      expect(options.refetchInterval(query)).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(
        fetchMock.mock.calls.every(
          ([, init]) => !init?.method || init.method === 'GET'
        )
      ).toBe(true)
    } finally {
      client.clear()
    }
  })

  it('propagates concurrent-switch conflicts instead of retrying the POST', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'kernel_switch_in_progress',
            message: '已有内核切换任务进行中',
          },
        }),
        { status: 409 }
      )
    )
    await expect(
      startVmKernelSwitch('vm-01', { dataplane: 'wrap' })
    ).rejects.toMatchObject({
      status: 409,
      code: 'kernel_switch_in_progress',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses GET and forwards cancellation when inspecting an existing job', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(switchResponse(switchJob()))
    const controller = new AbortController()
    await getVmKernelSwitch('vm/with spaces', controller.signal)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/vms/vm%2Fwith%20spaces/kernel-switch',
      expect.objectContaining({ signal: controller.signal })
    )
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined()
  })
})
