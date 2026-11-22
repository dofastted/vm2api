import type { Vm } from '@/types/panel-vm'
import { geminiHostBlocker } from '@/lib/gemini-account-status'
import {
  geminiPayloadIssue,
  type GeminiEnvironment,
  type GeminiInventory,
} from '@/features/import/gemini-environments'

export function geminiSlot(
  environment: GeminiEnvironment,
  inventory?: GeminiInventory
): Vm {
  const { auth_state: auth, account } = environment
  return {
    id: environment.id,
    name: environment.name,
    gemini: environment,
    email: account?.email || undefined,
    proxy_id: environment.proxy_id,
    proxy_configured: true,
    credential_mode: environment.auth_method === 'oauth' ? 'oauth' : 'apikey',
    has_token: auth === 'authorized' || (auth === 'disabled' && !!account),
    // The host prerequisite is display context, not an inferred scheduler state.
    unschedulable_text: geminiHostBlocker(
      environment,
      inventory,
      geminiPayloadIssue(inventory)
    ),
  }
}
