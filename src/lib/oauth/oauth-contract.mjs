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
/** Setup-token mint (README: local-src/oauth-auth) reads identity as the VS Code entrypoint. */
export const SETUP_TOKEN_BOOTSTRAP_URL = `${ANTHROPIC_API}/api/claude_cli/bootstrap?entrypoint=claude-vscode&model=claude-opus-5`
/** Account settings PATCH target; `{"grove_enabled": true}` is the Grove agreement. */
export const ACCOUNT_SETTINGS_URL = `${ANTHROPIC_API}/api/oauth/account/settings`
export const FULL_OAUTH_SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
export const BROWSER_AUTHORIZE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
/** setup-token profile exchanges its code as the browser, not as the CLI (README step 2). */
export const BROWSER_TOKEN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8037.100 Safari/537.36'
/** sub2api exchanges its code as axios; the cookie stages still carry a Chrome fingerprint. */
export const TOKEN_UA_AXIOS = 'axios/1.13.6'
export const BETA_OAUTH = 'oauth-2025-04-20'
/** Per-request ceiling for every exchange hop; one slow hop must not time out the flow. */
export const OAUTH_REQUEST_TIMEOUT_MS = 60_000
/** claude.ai app origin + referer the cookie stages are opened from (sub2api style). */
export const CLAUDE_AI_ORIGIN = 'https://claude.ai'
export const CLAUDE_AI_REFERER = 'https://claude.ai/new'
/** The setup-token mint authorizes from the CAI page, so it keeps that origin. */
export const CAI_ORIGIN = 'https://claude.com'
/**
 * HTTP-level Chrome fingerprint. TLS/HTTP2 fingerprint impersonation needs a
 * libcurl/utls client, which the Node helper does not carry, so the header set
 * is the impersonation this process can actually perform.
 */
export const CHROME_HEADERS = Object.freeze({
  'sec-ch-ua': '"Chromium";v="146", "Not_A Brand";v="24", "Google Chrome";v="146"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
})

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
