export type ModelCatalogItem = {
  id: string
  platform?: string
  family?: string
  vendor?: string
  upstream_model?: string
  display_name?: string
  owned_by?: string
  enabled?: boolean
  reasoning_levels?: string[]
  default_reasoning_level?: string | null
}

export type ModelsPayload = {
  data?: ModelCatalogItem[]
  items?: ModelCatalogItem[]
}
