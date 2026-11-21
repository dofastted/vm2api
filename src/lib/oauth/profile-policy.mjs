/**
 * 两条 OAuth 路径的**决策点**：普通登录与 setup token 只在 scope 和有效期上不同。
 *
 * 这份策略必须入库，否则 CI 无法验证它：`bin/kin-oauth-auth` 是 payload pin 的
 * release asset，helper 源码（`src/lib/oauth/auth.js`、`local-src/oauth-auth/`）
 * 都在 .gitignore 里。把决策放进这个模块后，单测可以直接覆盖它，e2e 仍然只负责
 * 「发布出去的二进制是否实现了这套策略」——事务性契约由 capabilities 声明，
 * 避免「改了行为但二进制还没发」时 CI 必然变红的结构性死锁。
 */
import { FULL_OAUTH_SCOPE } from './oauth-contract.mjs'

/** 二进制在 `operation: "capabilities"` 里回报这些能力名。 */
export const OAUTH_CAPABILITIES = Object.freeze([
  // 浏览器段交给 kin-worker oauth session-code（Chrome TLS 指纹）。
  'session-code-bridge',
  // setup-token profile 走 README 的换票流程：同 scope、同短效票，不再伪造一年期。
  'setup-token-short-lived',
  // KIN_OAUTH_PROXY_FALLBACK=local：出口被拒时用本地出口重试浏览器段。
  'proxy-fallback-local',
])

export const OAUTH_PROFILES = Object.freeze({
  oauth: Object.freeze({ scope: FULL_OAUTH_SCOPE, expiresIn: null, locked: false }),
  // setup-token 就是 README 的换票流程：与普通登录同 scope、同样不发 expires_in，
  // 换回来的是短效票（带上游给的 refresh）。长效票不在这里铸造——需要时由本地
  // 用短效票换（`claude setup-token` / to-setup-token 运行模式），面板不伪造。
  'setup-token': Object.freeze({ scope: FULL_OAUTH_SCOPE, expiresIn: null, locked: true }),
})

/** 未知 profile 一律按普通登录处理，和 `normalizeProfile` 的口径一致。 */
export function profilePolicy(profile) {
  return OAUTH_PROFILES[profile === 'setup-token' ? 'setup-token' : 'oauth']
}

/**
 * 调用方可以**收窄**普通登录的 scope；mint 的 scope 由 profile 独占，
 * 调用方传什么都不改变它。
 */
export function scopeForProfile(profile, requested) {
  const policy = profilePolicy(profile)
  if (policy.locked) return policy.scope
  return String(requested || '').trim() || policy.scope
}

/** `undefined` 表示请求里不发送该字段（普通登录的现状）。 */
export function expiresInForProfile(profile) {
  const expiresIn = profilePolicy(profile).expiresIn
  return Number(expiresIn) > 0 ? Number(expiresIn) : undefined
}
