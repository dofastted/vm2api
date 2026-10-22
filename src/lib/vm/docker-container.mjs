/** Shared helpers for docker slot containers on the control plane / node host. */

export function isMissingContainerMessage(message) {
  return /no such container/i.test(String(message || ''))
}

/** Local `docker inspect` / Engine 404: container id or name is gone. */
export function isDockerInspectNotFound({ stderr = '', stdout = '' } = {}) {
  const hay = `${stderr}\n${stdout}`
  return /no such container|no such object/i.test(hay)
}

export function telemetryContainerSkip(container, detail) {
  return {
    ok: true,
    skipped: true,
    action: 'skipped',
    reason: 'container_unavailable',
    container: String(container || ''),
    ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
  }
}

export function logTelemetryContainerSkip(scope, vmId, container, detail) {
  const suffix = detail ? `: ${detail}` : ''
  console.warn(`[${scope}] Go slot service refresh skipped ${vmId}: no container ${container} on this host${suffix}`)
}
