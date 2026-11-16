import fs from 'node:fs'
import path from 'node:path'
import { inspectContainer } from '../vm/vm-runtime.mjs'
import { execCapture, inspectContainerOrNull } from '../cluster/docker-remote.mjs'
import { LOCAL_CRAG_CLAUDE, REMOTE_CRAG_CLAUDE } from '../vm/slot-engine.mjs'
import { slotExecCmd, slotExecContainer } from '../vm/slot-exec.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { flattenOauthIdentity } from './oauth-identity.mjs'
import { installedCragV2Root, materializeCragV2, verifyCragV2Tree } from '../vm/wrap-cli-runtime.mjs'

export const AUTH_LOGIN_SOURCE = 'claude-auth-login'
export const AUTH_LOGIN_FLAVOR = 'claude_code'

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Login and operations select the same native CLI, never a PATH alias. */
export function resolveAuthLoginClaude(vm) {
  return slotHost(vm).bakedKernel ? REMOTE_CRAG_CLAUDE : LOCAL_CRAG_CLAUDE
}

/** Stage a complete package without selecting CRAG as the slot's inference engine. */
function stageBundledAuthClaude(projectRoot, vm) {
  if (slotHost(vm).bakedKernel) return
  const installed = installedCragV2Root(projectRoot, vm)
  if (installed && fs.existsSync(path.join(installed, 'manifest.json'))) {
    const verified = verifyCragV2Tree(installed, { allowPreviousClaude: true })
    if (!verified.ok) throw fail(verified.code, verified.error)
    return
  }
  // Older login sessions copied only Claude into this directory. Complete that
  // tree even when the executable exists, so license reads can verify it.
  const staged = materializeCragV2(projectRoot, vm, { select: false })
  if (!staged.ok) throw fail(staged.code, staged.error)
}

export async function assertAuthLoginReady(projectRoot, vm, { inspect = inspectContainer, cliExists = null } = {}) {
  const host = slotHost(vm)
  const container = slotExecContainer(vm)
  let running
  if (host.bakedKernel) {
    const info = await inspectContainerOrNull(host.dockerApi(), container)
    running = info?.State?.Running === true && info.State.Restarting !== true
  } else {
    running = inspect(container)?.running
  }
  if (!running) throw fail('container_not_ready', '虚拟机尚未运行，请先启动再打开终端')

  const bin = resolveAuthLoginClaude(vm)
  stageBundledAuthClaude(projectRoot, vm)
  const { Cmd, User } = slotExecCmd(vm, ['sh', '-c', 'test -f "$1" && test -x "$1"', 'auth-cli', bin], {
    user: host.execUser(vm),
  })
  const present = cliExists
    ? await cliExists(bin, vm)
    : (await execCapture(host.dockerApi(), container, Cmd, { user: User })).exitCode === 0
  if (!present) throw fail('claude_cli_missing', 'CRAG 包内原生 Claude Code 不存在或不可执行，请先同步客户端')
  return bin
}

export function nativeLoginLaunch(bin, configDir) {
  return {
    // A private config directory prevents failed or cancelled login from overwriting the active grant.
    cmd: [
      '/bin/sh',
      '-c',
      'umask 077; mkdir -- "$CLAUDE_CONFIG_DIR" || exit; ' +
        'timeout --foreground -k 5s 30m "$1" auth login && : > "$CLAUDE_CONFIG_DIR/complete"',
      'auth-login',
      bin,
    ],
    env: [
      `CLAUDE_CONFIG_DIR=${configDir}`,
      'KIN_AUTH_LOGIN=1',
      'BROWSER=true',
      'CLAUDE_CODE_USE_BEDROCK=0',
      'CLAUDE_CODE_USE_VERTEX=0',
      'CLAUDE_CODE_USE_FOUNDRY=0',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0',
      'ANTHROPIC_BASE_URL=',
      'ANTHROPIC_API_KEY=',
      'ANTHROPIC_AUTH_TOKEN=',
      'CLAUDE_CODE_OAUTH_TOKEN=',
      'CLAUDE_CODE_OAUTH_REFRESH_TOKEN=',
    ],
  }
}

export async function readNativeLoginOauth(run, configDir) {
  const result = await run([
    '/bin/sh',
    '-c',
    'read_json() { [ -f "$1" ] && dd if="$1" iflag=nofollow,nonblock bs=65537 count=1 status=none; }; ' +
      '[ ! -L "$1" ] && [ -f "$1/complete" ] && read_json "$1/.credentials.json" || exit 1; ' +
      'printf "\\n\\036\\n"; if [ -f "$1/.claude.json" ]; then read_json "$1/.claude.json"; fi',
    'native-oauth-result',
    configDir,
  ])
  let doc
  let profile
  if (result.exitCode === 0) {
    const [credential, settings] = result.stdout.split('\x1e')
    try {
      doc = JSON.parse(credential)
      profile = settings?.trim() ? JSON.parse(settings)?.oauthAccount : null
    } catch {
      throw fail('auth_login_incomplete', '无法读取原生 Claude Code 写入的授权凭证')
    }
  }
  return officialLoginCredentialToOauth(doc, profile)
}

/** Full OAuth written by official login, not an inference-only setup token. */
export function officialLoginCredentialToOauth(doc, profile) {
  const oauth = doc?.claudeAiOauth ?? doc ?? {}
  const access = String(oauth.accessToken || oauth.access_token || '').trim()
  const refresh = String(oauth.refreshToken || oauth.refresh_token || '').trim()
  if (!access || !refresh) throw fail('auth_login_incomplete', '官方登录未写入完整 OAuth 凭证')
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes
    : String(oauth.scope || '')
        .trim()
        .split(/\s+/)
  if (!scopes.includes('user:profile') || !scopes.includes('user:inference')) {
    throw fail('auth_login_scope', '官方登录没有拿到完整 OAuth 权限')
  }
  const expiresAt = Number(oauth.expiresAt || oauth.expires_at || 0)
  const expiryMs = expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
    throw fail('auth_login_expired', '官方登录未写入有效期内的 OAuth 凭证')
  }
  const identity = flattenOauthIdentity({
    ...oauth,
    email: profile?.emailAddress || oauth.email || oauth.emailAddress || oauth.email_address,
    account_uuid: profile?.accountUuid || oauth.accountUuid || oauth.account_uuid,
    org_uuid: profile?.organizationUuid || oauth.orgUuid || oauth.org_uuid,
    subscription_type: oauth.subscriptionType || oauth.subscription_type,
    rate_limit_tier: oauth.rateLimitTier || oauth.rate_limit_tier,
  })
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_at: Math.floor(expiryMs / 1000),
    scope: scopes.join(' '),
    ...identity,
    type: 'oauth',
    mode: 'oauth',
    source: AUTH_LOGIN_SOURCE,
    flavor: AUTH_LOGIN_FLAVOR,
  }
}
