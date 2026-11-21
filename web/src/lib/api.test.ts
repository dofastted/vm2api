import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  cragDeviceApi,
  loginRequest,
  loginTotpRequest,
  normalizePanelError,
  panelFetch,
} from './api'
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

describe('two-step sign-in', () => {
  beforeEach(() => {
    installBrowser()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubJson(status: number, body: unknown) {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('returns a session when the account has no second factor', async () => {
    stubJson(200, { ok: true, token: 'kin-panel-abc', user: 'admin' })
    const result = await loginRequest({
      username: 'admin',
      password: 'pw',
      base: '',
    })
    expect(result).toEqual({
      kind: 'session',
      token: 'kin-panel-abc',
      user: 'admin',
    })
  })

  it('returns the challenge instead of throwing on a 401 totp_required', async () => {
    stubJson(401, {
      ok: false,
      totp_required: true,
      challenge: 'payload.signature',
      expires_in: 300,
      error: { code: 'totp_required', message: '请输入两步验证码' },
    })
    const result = await loginRequest({
      username: 'admin',
      password: 'pw',
      base: '',
    })
    expect(result).toEqual({
      kind: 'totp',
      challenge: 'payload.signature',
      expiresIn: 300,
    })
  })

  it('can submit the code together with the password', async () => {
    const fetchMock = stubJson(200, { ok: true, token: 'kin-panel-xyz' })
    await loginRequest({
      username: 'admin',
      password: 'pw',
      code: '123456',
      base: '',
    })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ username: 'admin', password: 'pw', code: '123456' })
  })

  it('omits the code field when none is given', async () => {
    const fetchMock = stubJson(200, { ok: true, token: 'kin-panel-xyz' })
    await loginRequest({ username: 'admin', password: 'pw', base: '' })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ username: 'admin', password: 'pw' })
  })

  it('surfaces a wrong password as an ApiError', async () => {
    stubJson(401, {
      ok: false,
      error: { message: '用户名或密码错误', type: 'auth' },
    })
    await expect(
      loginRequest({ username: 'admin', password: 'bad', base: '' })
    ).rejects.toThrow('用户名或密码错误')
  })

  it('exchanges the challenge and a code for a session', async () => {
    const fetchMock = stubJson(200, {
      ok: true,
      token: 'kin-panel-second',
      user: 'admin',
    })
    const result = await loginTotpRequest({
      challenge: 'payload.signature',
      code: '123456',
      username: 'admin',
      base: '',
    })
    expect(result).toEqual({
      kind: 'session',
      token: 'kin-panel-second',
      user: 'admin',
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/panel/login/totp')
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ challenge: 'payload.signature', code: '123456' })
  })

  it('keeps the error code so the page can fall back to the password step', async () => {
    stubJson(401, {
      ok: false,
      error: {
        code: 'totp_challenge_expired',
        message: '验证超时，请重新登录',
      },
    })
    await expect(
      loginTotpRequest({ challenge: 'stale', code: '123456', base: '' })
    ).rejects.toMatchObject({ code: 'totp_challenge_expired', status: 401 })
  })

  it('does not mistake a missing token for a challenge', async () => {
    // `totp_required` without a challenge is a malformed reply, not a second step.
    stubJson(401, { ok: false, totp_required: true })
    await expect(
      loginRequest({ username: 'admin', password: 'pw', base: '' })
    ).rejects.toBeInstanceOf(ApiError)
  })
})

describe('CRAG device checkout', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the serving host without requiring or sending panel credentials', async () => {
    const values = installBrowser()
    values.set('kin_api_base', 'https://other-console.example')
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, data: { orders: [] } })
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(hasSession()).toBe(false)
    await expect(cragDeviceApi('/orders')).resolves.toEqual({ orders: [] })
    setSession('kin-panel-test-token')
    await cragDeviceApi('/orders')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(call).toEqual([
        '/api/panel/crag-shop/device/orders',
        {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
        },
      ])
    }
  })
})
