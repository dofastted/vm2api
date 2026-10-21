/** Container identity is shared across nodes until a Docker daemon identity is verified. */
export function physicalContainerName(vmId) {
  return `kin-${String(vmId || '').replace(/^vm-/, '')}`
}

/** Exact inverse of physicalContainerName's single prefix removal. */
export function physicalVmAliases(vmId) {
  const suffix = String(vmId || '').replace(/^vm-/, '')
  return suffix.startsWith('vm-') ? [`vm-${suffix}`] : [...new Set([suffix, `vm-${suffix}`])]
}
