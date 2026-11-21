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

type GeminiProxy = {
  id: string
  label?: string
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

export function isGeminiProxy(proxy: GeminiProxy) {
  return (
    proxy.enabled &&
    proxy.kind === 'socks5' &&
    proxy.address_family === 4 &&
    !proxy.owner_user_id &&
    !proxy.blocked_reason &&
    proxy.status !== 'dead' &&
    proxy.status !== 'fail'
  )
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
