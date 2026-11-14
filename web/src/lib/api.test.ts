import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, normalizePanelError, panelFetch } from './api'
import {
  hasSession,
  onPanelSessionExpired,
  sessionToken,
  setSession,
} from './session'

function installBrowser() {
  const values = new Map<string, string>()
  vi.stubGlobal('location', { hostname: 'console.example', protocol: 'https:' })
  vi.stubGlobal('document', { cookie: '' })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  })
  return values
}

describe('panel error envelope', () => {
  it('preserves structured error metadata', () => {
    const normalized = normalizePanelError(
      {
        error: {
          type: 'permission_error',
          code: 'forbidden',
          message: '没有权限',
          details: { capability: 'users' },
        },
        data: { refresh_class: 'fatal' },
      },
      403,
      'Forbidden'
    )

    expect(normalized).toEqual({
      message: '没有权限',
      status: 403,
      type: 'permission_error',
      code: 'forbidden',
      details: { capability: 'users' },
      data: { refresh_class: 'fatal' },
    })
  })

  it('keeps string error codes compatible with existing callers', () => {
    const error = new ApiError('冲突', 409, 'conflict')
    expect(error).toMatchObject({ status: 409, code: 'conflict' })
  })
})

describe('panelFetch 401', () => {
  beforeEach(() => {
    installBrowser()
    setSession('kin-panel-test-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears session and notifies on panel API 401', async () => {
    const expired = vi.fn()
    onPanelSessionExpired(expired)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 }))
    )
    const res = await panelFetch('/api/panel/me')
    expect(res.status).toBe(401)
    expect(hasSession()).toBe(false)
    expect(sessionToken()).toBe('')
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('does not expire session when panel login returns 401', async () => {
    const expired = vi.fn()
    onPanelSessionExpired(expired)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 }))
    )
    const res = await panelFetch('/api/panel/login', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(hasSession()).toBe(true)
    expect(expired).not.toHaveBeenCalled()
  })
})
