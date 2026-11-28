import {
  queryOptions,
  useIsMutating,
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { api, isApiError } from '@/lib/api'
import type { GeminiEnvironment, GeminiInventory } from './gemini-environments'

export const GEMINI_ROOT = '/api/panel/gemini'
export const GEMINI_INVENTORY_KEY = ['panel', 'gemini-environments'] as const
const mutationFilter = { mutationKey: ['panel', 'gemini-operation'] }

export function geminiResource(id: string) {
  return `${GEMINI_ROOT}/environments/${encodeURIComponent(id)}`
}

export type GeminiProxy = {
  id: string
  label?: string | null
  host?: string | null
  port?: number | string | null
  latency_ms?: number | null
  geo?: {
    ip?: string | null
    country?: string | null
    country_code?: string | null
  } | null
  enabled: boolean
  kind: string
  address_family?: number | null
  status: string
  owner_user_id?: string | null
  blocked_reason?: string | null
}

export const geminiProxyOptions = queryOptions({
  queryKey: ['panel', 'gemini-egress-options'],
  queryFn: ({ signal }) =>
    api<{ proxies: GeminiProxy[] }>('/api/panel/proxies', { signal }),
})

const GEMINI_PROXY_KINDS = new Set(['socks5', 'socks5h', 'http'])

export function isGeminiProxy(
  proxy: GeminiProxy,
  options?: { ownerUserId?: string | null; allowFail?: boolean }
) {
  const kind = String(proxy.kind || '')
    .trim()
    .toLowerCase()
  const targetOwner = options?.ownerUserId?.trim() || null
  const proxyOwner = proxy.owner_user_id?.trim() || null
  // Mirror `src/lib/gemini/routes.mjs` (`proxyFor`):
  // - Platform Gemini environments (`targetOwner == null`) may only use platform proxies.
  // - Tenant-owned Gemini environments may use platform proxies OR their own tenant proxies.
  const ownerAllowed = targetOwner
    ? !proxyOwner || proxyOwner === targetOwner
    : !proxyOwner
  return (
    proxy.enabled &&
    GEMINI_PROXY_KINDS.has(kind) &&
    proxy.address_family !== 6 &&
    ownerAllowed &&
    !proxy.blocked_reason &&
    proxy.status !== 'dead' &&
    (options?.allowFail ? true : proxy.status !== 'fail')
  )
}

/** Public proxy address (`host:port`) without ever reading credentials. */
export function geminiProxyAddress(
  proxy: Pick<GeminiProxy, 'host' | 'port'> | null | undefined
): string | null {
  const rawHost = String(proxy?.host || '').trim()
  if (!rawHost) return null
  const host =
    rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost
  const port = proxy?.port
  return port != null && String(port).trim() !== '' ? `${host}:${port}` : host
}

/**
 * Human-readable proxy option label for Gemini selectors & summary cards.
 * Shows label (if set), `host:port`, distinct probed exit IP, region, latency,
 * and proxy ID so unlabeled `px-*` entries remain immediately identifiable.
 */
export function geminiProxyOptionLabel(proxy: GeminiProxy): string {
  const parts: string[] = []
  const id = String(proxy.id || '').trim()
  const label = String(proxy.label || '').trim()
  const rawHost = String(proxy.host || '').trim()
  const address = geminiProxyAddress(proxy)
  const exitIp = String(proxy.geo?.ip || '').trim()
  const region = String(
    proxy.geo?.country_code || proxy.geo?.country || ''
  ).trim()
  const latency =
    proxy.latency_ms != null && Number.isFinite(Number(proxy.latency_ms))
      ? `${Math.round(Number(proxy.latency_ms))}ms`
      : ''

  if (label && label !== id) parts.push(label)
  if (address && address !== label) parts.push(address)
  if (exitIp && exitIp !== rawHost && exitIp !== address && exitIp !== label) {
    parts.push(`出口 ${exitIp}`)
  }
  if (region) parts.push(region)
  if (latency) parts.push(latency)
  if (id && !parts.includes(id)) parts.push(id)
  return parts.join(' · ') || id
}

export function useGeminiBusy() {
  return useIsMutating(mutationFilter) > 0
}

export function useGeminiMutation<T, V>(
  options: UseMutationOptions<T, Error, V>
) {
  const client = useQueryClient()
  const mutation = useMutation({
    ...options,
    ...mutationFilter,
    networkMode: 'always',
    retry: false,
  })
  return {
    ...mutation,
    mutate: (variables: V) => {
      // The mutation cache marks pending synchronously, including before a UI rerender.
      if (!client.isMutating(mutationFilter)) mutation.mutate(variables)
    },
  }
}

export async function syncGeminiEnvironment(
  client: QueryClient,
  environment: GeminiEnvironment
) {
  await client.cancelQueries({ queryKey: GEMINI_INVENTORY_KEY })
  client.setQueryData<GeminiInventory>(
    GEMINI_INVENTORY_KEY,
    (inventory) =>
      inventory && {
        ...inventory,
        environments: inventory.environments.map((item) =>
          item.id === environment.id ? environment : item
        ),
      }
  )
  await client.invalidateQueries({ queryKey: GEMINI_INVENTORY_KEY })
}

export type GeminiError = { code?: string; message: string }

export function geminiError(error: unknown, fallback: string): GeminiError {
  return isApiError(error)
    ? { code: error.code, message: error.message || fallback }
    : { message: fallback }
}
