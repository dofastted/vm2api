/**
 * Official Claude Code User-Agent prefix:
 *   `(?i)^claude-cli/\d+\.\d+\.\d+`
 *
 * VS Code (`claude-vscode`), Cowork (`local-agent`), Desktop, and Agent SDK
 * all keep the same product prefix. Entrypoint tokens after the version are
 * not a denylist — new IDE surfaces should pass without a code change.
 *
 * Body passthrough still needs the other official-traffic gates
 * (user_id / tools / official system). oh-my-pi is rejected by system shape.
 *
 * Outbound pin is `OFFICIAL_CLI_VERSION` in `vm-identity.mjs`.
 * This check accepts any `claude-cli` semver; it does not pin the version.
 */

export const CLAUDE_CLI_UA_RE = /^claude-cli\/\d+\.\d+\.\d+/i

export function isOfficialClaudeUa(ua = '') {
  return CLAUDE_CLI_UA_RE.test(String(ua || '').trim())
}

/** Leftover helper: family-looking UA that failed the official semver prefix. */
export function isUnofficialClaudeEntrypointUa(ua = '') {
  const s = String(ua || '')
  if (isOfficialClaudeUa(s)) return false
  return /claude-desktop|agent-sdk|claude-vscode|local-agent/i.test(s)
}
