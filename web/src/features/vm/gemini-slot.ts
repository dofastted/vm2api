import type { Vm } from '@/types/panel-vm'
import type { GeminiEnvironment } from '@/features/import/gemini-environments'

export function geminiSlot(environment: GeminiEnvironment): Vm {
  const { auth_state: auth, account } = environment
  const authorized = auth === 'authorized'
  const reason =
    auth === 'reauth_required'
      ? '凭证失效'
      : !environment.runtime_ready
        ? '载荷未启用推理'
        : !environment.billing_ready
          ? '付费调用未开放'
          : null
  return {
    id: environment.id,
    name: environment.name,
    gemini: environment,
    email: account?.email || undefined,
    proxy_id: environment.proxy_id,
    proxy_configured: true,
    credential_mode: environment.auth_method === 'oauth' ? 'oauth' : 'apikey',
    has_token: authorized || (auth === 'disabled' && !!account),
    unschedulable_reason:
      auth === 'reauth_required' ? 'oauth_reauth_required' : undefined,
    schedule_state:
      auth === 'disabled'
        ? 'off'
        : auth === 'reauth_required' || (authorized && reason)
          ? 'unschedulable'
          : authorized
            ? 'on'
            : undefined,
    unschedulable_text: reason,
    availability:
      !authorized && auth !== 'reauth_required' && auth !== 'disabled'
        ? { key: 'none', usable: false }
        : undefined,
  }
}
