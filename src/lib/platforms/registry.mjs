/** Account platforms are independent of model vendors and inbound protocols. */
const platforms = [
  { id: 'anthropic', family: 'claude', kind: 'claude', label: 'Claude', aliases: ['claude'] },
  { id: 'openai', family: 'codex', kind: 'codex', label: 'GPT', aliases: ['codex', 'gpt', 'chatgpt'] },
  { id: 'antigravity', family: 'antigravity', kind: 'antigravity', label: 'Antigravity', aliases: [] },
]

export const PLATFORM_REGISTRY = Object.freeze(
  Object.fromEntries(
    platforms.map((platform) => [
      platform.id,
      Object.freeze({ ...platform, aliases: Object.freeze(platform.aliases) }),
    ]),
  ),
)
export const ACCOUNT_PLATFORMS = Object.freeze(Object.keys(PLATFORM_REGISTRY))

export function platformDescriptor(value) {
  const label = String(value || '')
    .trim()
    .toLowerCase()
  if (!label) return null
  return (
    Object.values(PLATFORM_REGISTRY).find((platform) => platform.id === label || platform.aliases.includes(label)) ||
    null
  )
}

export function normalizePlatformId(value) {
  return platformDescriptor(value)?.id || null
}
