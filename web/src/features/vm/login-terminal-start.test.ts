import type { Vm } from '@/types/panel-vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { prepareLoginTerminal } from './login-terminal-start'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

const request = vi.mocked(api)
const slot: Vm = {
  id: 'vm-import',
  status: 'stopped',
  has_token: false,
  proxy: { id: 'px-selected', host: 'proxy.example', port: 1080 },
}

beforeEach(() => request.mockReset())

describe('official login from an empty import slot', () => {
  it('waits for the selected slot to start before allowing the terminal to open', async () => {
    let complete!: () => void
    request.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        })
    )
    const openTerminal = vi.fn()
    const pending = prepareLoginTerminal(slot).then(openTerminal)

    expect(request).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/vms/vm-import/start',
      { method: 'POST' }
    )
    await Promise.resolve()
    expect(openTerminal).not.toHaveBeenCalled()

    complete()
    await pending
    expect(openTerminal).toHaveBeenCalledOnce()
    expect(slot.proxy?.id).toBe('px-selected')
  })

  it('opens a running slot without restarting it, even before its first login', async () => {
    await prepareLoginTerminal({ ...slot, status: 'running', has_token: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('also starts an existing stopped slot with credentials', async () => {
    request.mockResolvedValueOnce({})
    await prepareLoginTerminal({ ...slot, has_token: true })
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not auto-allocate an exit when the user has not selected one', async () => {
    await expect(
      prepareLoginTerminal({ id: 'vm-empty', status: 'stopped' })
    ).rejects.toThrow('请先为槽位绑定出口')
    expect(request).not.toHaveBeenCalled()
  })

  it('honors an authoritative rejection even when stale proxy fields remain', async () => {
    await expect(
      prepareLoginTerminal({ ...slot, can_import_credential: false })
    ).rejects.toThrow('请先为槽位绑定出口')
    expect(request).not.toHaveBeenCalled()
  })

  it('accepts local egress and public records exposing only proxy_id', async () => {
    request.mockResolvedValue({})
    await prepareLoginTerminal({ ...slot, proxy: { host: 'local', port: 0 } })
    await prepareLoginTerminal({
      ...slot,
      proxy: undefined,
      proxy_id: 'px-selected',
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps the terminal closed on failure and allows a later retry', async () => {
    const failure = new Error('guest image unavailable')
    request.mockRejectedValueOnce(failure).mockResolvedValueOnce({})
    const openTerminal = vi.fn()

    await expect(prepareLoginTerminal(slot).then(openTerminal)).rejects.toBe(
      failure
    )
    expect(openTerminal).not.toHaveBeenCalled()

    await prepareLoginTerminal(slot).then(openTerminal)
    expect(openTerminal).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
  })
})
