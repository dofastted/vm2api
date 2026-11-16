import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import type { VmPool } from '@/types/panel-keys'
import type { ModelCatalogItem } from '@/types/panel-models'

export type PolicyOption = {
  value: string
  label: string
  detail?: string
  disabled?: boolean
}

export function poolOptions(pools: VmPool[]): PolicyOption[] {
  return pools.map((pool) => ({
    value: pool.id,
    label: pool.name || pool.id,
    detail: !pool.enabled ? '已停用' : `${pool.vm_ids.length} 个槽位`,
    disabled: !pool.enabled || !pool.vm_ids.length,
  }))
}

function endpointProtocol(endpoint: ApiEndpoint) {
  return (endpoint.protocol ??
    (endpoint.kind === 'openai' ? 'openai' : 'anthropic')) === 'openai'
    ? 'OpenAI'
    : 'Anthropic'
}

export function endpointOptions(endpoints: ApiEndpoint[]): PolicyOption[] {
  return endpoints.map((endpoint) => ({
    value: endpoint.id,
    label: endpoint.name || endpoint.id,
    detail: endpoint.disabled ? '已停用' : endpointProtocol(endpoint),
    disabled: endpoint.disabled,
  }))
}

export function modelOptions(
  catalog: ModelCatalogItem[],
  endpoints: ApiEndpoint[]
): PolicyOption[] {
  const options = new Map<string, PolicyOption>()
  const add = (option: PolicyOption) => {
    const key = option.value.toLowerCase()
    if (!key || options.has(key)) return
    options.set(key, option)
  }
  for (const model of catalog) {
    if (model.enabled === false || model.family === 'gpt-image') continue
    add({
      value: model.id,
      label: model.display_name || model.id,
      detail: model.owned_by,
    })
  }
  for (const endpoint of endpoints) {
    if (endpoint.disabled) continue
    const detail = `${endpoint.name || endpoint.id} · ${endpointProtocol(endpoint)}`
    for (const model of endpoint.models ?? []) {
      const alias = (model.alias || model.name).trim()
      if (!alias || model.image) continue
      add({ value: alias, label: alias, detail })
      if (endpoint.prefix?.trim()) {
        const qualified = `${endpoint.prefix.trim()}/${alias}`
        add({ value: qualified, label: qualified, detail })
      }
    }
  }
  return [...options.values()]
}
