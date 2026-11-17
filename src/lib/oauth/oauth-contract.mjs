/**
 * Shared public OAuth protocol constants. Secret exchange code stays in the
 * local-only auth service bundle (`src/lib/oauth/auth.js`, git-ignored as
 * "not part of the published tree").
 *
 * This module stays a leaf to avoid the vm-identity cycle (oauth-contract →
 * vm-identity → oauth-credentials → oauth-identity → oauth-contract), so the CLI
 * User-Agent is NOT built here: callers take `officialClaudeCliUa` from
 * `identity/vm-identity.mjs`, which owns `OFFICIAL_CLI_VERSION`. A hand-synced
 * literal here had drifted to 2.1.303.
 */
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'
export const CLAUDE_WEB = 'https://claude.ai'
export const CAI_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
export const PLATFORM = 'https://platform.claude.com'
export const ANTHROPIC_API = 'https://api.anthropic.com'
export const TOKEN_URL = `${PLATFORM}/v1/oauth/token`
export const BOOTSTRAP_URL = `${ANTHROPIC_API}/api/claude_cli/bootstrap?entrypoint=claude-code&model=claude-opus-5-5`
export const FULL_OAUTH_SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
export const BROWSER_AUTHORIZE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
export const BETA_OAUTH = 'oauth-2025-04-20'

export const OFFICIAL_CLI_HEADERS = Object.freeze({
  'x-app': 'cli',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v26.12.1',
  'x-stainless-package-version': '0.128.0',
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '600',
})
