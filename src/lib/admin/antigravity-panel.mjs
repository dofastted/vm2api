import { normalizeAntigravityRouting, ANTIGRAVITY_CAPABILITIES } from '../protocol/antigravity-route.mjs'

export function antigravityStatusView({ routing, runtime = {} } = {}) {
  const config = normalizeAntigravityRouting(routing?.antigravity)
  return {
    enabled: config.enabled,
    ready: config.enabled && runtime.ready === true,
    authenticated: typeof runtime.authenticated === 'boolean' ? runtime.authenticated : null,
    models: config.models.filter((entry) => entry.enabled),
    capabilities: ANTIGRAVITY_CAPABILITIES,
    runtime: {
      ...runtime,
      supported: runtime.supported ?? !['antigravity_runtime_unsupported', 'platform_mismatch'].includes(runtime.code),
    },
    error: runtime.code || null,
    message: !config.enabled ? '实验文本会话尚未启用' : runtime.message || runtime.error || null,
  }
}
