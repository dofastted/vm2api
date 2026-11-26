import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  api,
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

describe('没有 message 的失败响应', () => {
  beforeEach(() => {
    installBrowser()
    setSession('kin-panel-test-token')
  })

  afterEach(() => vi.unstubAllGlobals())

  function stubStatus(status: number, body = '{}', statusText?: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            status,
            ...(statusText === undefined ? {} : { statusText }),
          })
      )
    )
  }

  it('带出状态码，不再只说一句「请求失败」', async () => {
    // HTTP/2 下 `statusText` 恒为空串，状态码是唯一剩下的线索。
    stubStatus(502)
    await expect(api('/api/panel/vms/v1/oauth/exchange-code')).rejects.toThrow(
      '请求失败 (502)'
    )
  })

  it('网关返回 HTML 错误页时同样能看出状态码', async () => {
    // 反代 / WAF 拦截时响应体不是 JSON，`res.json()` 退化成 `{}`；状态码
    // 是此时唯一能把网关拦截和后端业务错误分开的依据。
    stubStatus(403, '<!DOCTYPE html><title>403 Forbidden</title>')
    await expect(api('/api/panel/vms/v1/oauth/exchange-code')).rejects.toThrow(
      '请求失败 (403)'
    )
  })

  it('保留 statusText 并补上状态码', async () => {
    stubStatus(504, '{}', 'Gateway Timeout')
    await expect(api('/api/panel/vms/v1/oauth/exchange-code')).rejects.toThrow(
      '请求失败 (504 Gateway Timeout)'
    )
  })

  it('2xx 的 ok:false envelope 报出那个 2xx', async () => {
    stubStatus(200, JSON.stringify({ ok: false }))
    await expect(api('/api/panel/vms/v1')).rejects.toThrow('请求失败 (200)')
  })

  it('后端给了 message 就不动它', async () => {
    stubStatus(
      400,
      JSON.stringify({
        ok: false,
        error: { code: 'proxy_required', message: '虚拟机未绑定 SOCKS5' },
      })
    )
    await expect(api('/api/panel/vms/v1/oauth/exchange-code')).rejects.toThrow(
      '虚拟机未绑定 SOCKS5'
    )
  })

  it('cragDeviceApi 走同一套兜底', async () => {
    stubStatus(502)
    await expect(cragDeviceApi('/orders')).rejects.toThrow('请求失败 (502)')
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
