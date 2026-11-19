export function antigravityModelSyncRequest(vmId: string) {
  return {
    url: `/api/panel/vms/${encodeURIComponent(vmId)}/antigravity/models/sync`,
    body: {},
  }
}
