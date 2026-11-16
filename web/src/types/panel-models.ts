export type ModelCatalogItem = {
  id: string
  display_name?: string
  owned_by?: string
  family?: string
  enabled?: boolean
}

export type ModelsPayload = {
  data?: ModelCatalogItem[]
  items?: ModelCatalogItem[]
}
