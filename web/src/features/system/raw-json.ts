import type { PersonaPreset } from '@/types/panel-routing'
import type { SystemPreviewBlock } from '@/lib/persona-template'

export type RenderedPreviewBlock = SystemPreviewBlock & {
  region: 'system' | 'messages · role=system' | 'messages · 首条 user'
}

/** 0注入模式禁用 JSON 原始内容加载与展示。 */
export function canShowRawJson(mode: string): boolean {
  return mode !== 'zero'
}

/** 根据当前模式计算最终展开态：切入 0注入或切换档位时立刻收起。 */
export function resolveRawJsonOpen(
  openForMode: string | null,
  currentMode: string
): boolean {
  return canShowRawJson(currentMode) && openForMode === currentMode
}

/** 仅在用户显式点击「加载 JSON 原始内容」时惰性构造出站 JSON 预览。 */
export function buildAnthropicRawJsonPayload(
  preset: PersonaPreset,
  rendered: readonly RenderedPreviewBlock[]
) {
  const system = rendered
    .filter((block) => block.region === 'system')
    .map((block) => ({
      id: block.id,
      type: 'text',
      text: block.text,
      ...(block.ttl || block.scope
        ? {
            cache_control: {
              type: 'ephemeral',
              ...(block.ttl ? { ttl: block.ttl } : {}),
              ...(block.scope ? { scope: block.scope } : {}),
            },
          }
        : {}),
    }))
  const environmentMessages = rendered
    .filter((block) => block.region === 'messages · role=system')
    .map((block) => ({
      id: block.id,
      role: 'system',
      type: 'text',
      text: block.text,
    }))
  const callerReminder = rendered
    .filter((block) => block.region === 'messages · 首条 user')
    .map((block) => ({
      id: block.id,
      placement: 'first_user_message',
      type: 'text',
      text: block.text,
    }))
  return {
    provider: 'anthropic',
    mode: preset,
    system,
    ...(environmentMessages.length
      ? { environment_messages: environmentMessages }
      : {}),
    ...(callerReminder.length ? { caller_reminder: callerReminder } : {}),
  }
}
