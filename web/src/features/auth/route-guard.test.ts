import { QueryClient } from '@tanstack/react-query'
import { isRedirect } from '@tanstack/react-router'
import type { MeResponse } from '@/types/panel-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { LS_TOKEN } from '@/lib/session'
import { guardPanelRoute } from './route-guard'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const TENANT: MeResponse = {
  user: 'tenant',
  role: 'user',
  views: ['vm', 'proxies', 'keys', 'billing', 'logs', 'statistics'],
}
const SUPER: MeResponse = {
  user: 'ops',
  role: 'super',
  views: ['overview', 'cluster', 'logs', 'statistics', 'vm'],
}

let storage: Map<string, string>

beforeEach(() => {
  storage = new Map([[LS_TOKEN, 'panel-token']])
  vi.stubGlobal('location', { hostname: 'console.example' })
  vi.stubGlobal('document', { cookie: '' })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  toastError.mockReset()
})

function client(me?: MeResponse) {
  const queryClient = new QueryClient()
  if (me) queryClient.setQueryData(['panel', 'me'], me)
  return queryClient
}

function guard(queryClient: QueryClient, href: string, preload = false) {
  const pathname = href.split('?')[0]
  return guardPanelRoute({ queryClient, location: { pathname, href }, preload })
}

async function redirectOf(pending: Promise<unknown>) {
  const thrown = await pending.then(
    () => null,
    (error: unknown) => error
  )
  expect(isRedirect(thrown)).toBe(true)
  return (thrown as { options: Record<string, unknown> }).options
}

function meResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('panel route guard', () => {
  it('lets a role into its pages and their sub-routes', async () => {
    const queryClient = client(TENANT)
    await expect(guard(queryClient, '/vm')).resolves.toEqual(TENANT)
    await expect(guard(queryClient, '/vm/vm-01?tab=usage')).resolves.toEqual(
      TENANT
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it('sends a blocked page to the role home with one warning', async () => {
    const options = await redirectOf(guard(client(TENANT), '/users'))
    expect(options).toMatchObject({ to: '/vm', replace: true })
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('无权访问该页面', {
      id: 'panel-route-forbidden',
    })
  })

  it('blocks sub-routes of a blocked parent', async () => {
    const options = await redirectOf(guard(client(SUPER), '/settings/about'))
    expect(options).toMatchObject({ to: '/overview' })
  })

  it('stays quiet while preloading a link', async () => {
    const options = await redirectOf(guard(client(TENANT), '/wrap', true))
    expect(options).toMatchObject({ to: '/vm' })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('moves roles without 总览 from the console entry without a warning', async () => {
    const options = await redirectOf(guard(client(TENANT), '/overview'))
    expect(options).toMatchObject({ to: '/vm' })
    expect(toastError).not.toHaveBeenCalled()
    await expect(guard(client(SUPER), '/overview')).resolves.toEqual(SUPER)
  })

  it('holds the page until /api/panel/me answers, then reuses it', async () => {
    let answer: (response: Response) => void = () => undefined
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = client()
    let settled = false
    const pending = guard(queryClient, '/keys').finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    answer(meResponse(200, TENANT))
    await expect(pending).resolves.toEqual(TENANT)
    await expect(guard(queryClient, '/proxies')).resolves.toEqual(TENANT)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0])).toContain('/api/panel/me')
  })

  it('sends an expired session to sign-in and back afterwards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => meResponse(401, { error: { message: 'expired' } }))
    )
    const options = await redirectOf(guard(client(), '/keys?page=2'))
    expect(options).toMatchObject({
      to: '/login',
      search: { redirect: '/keys?page=2' },
    })
    expect(storage.has(LS_TOKEN)).toBe(false)
  })

  it('does not open the page when /api/panel/me fails otherwise', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => meResponse(502, { error: { message: 'down' } }))
    )
    const thrown = await guard(client(), '/keys').then(
      () => null,
      (error: unknown) => error
    )
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(502)
    expect(storage.has(LS_TOKEN)).toBe(true)
  })
})
