export function controlPlaneMode(env = process.env) {
  const mode = env.VM2API_CONTROL_PLANE_MODE || 'standalone'
  if (mode !== 'standalone' && mode !== 'kubernetes') {
    throw new Error('VM2API_CONTROL_PLANE_MODE must be standalone or kubernetes')
  }
  return mode
}

export function isKubernetesMode(env = process.env) {
  return controlPlaneMode(env) === 'kubernetes'
}

export function shutdownTimeoutMs(env = process.env) {
  const value = Number(env.VM2API_SHUTDOWN_TIMEOUT_MS ?? 60_000)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('VM2API_SHUTDOWN_TIMEOUT_MS must be a positive integer')
  }
  return value
}
