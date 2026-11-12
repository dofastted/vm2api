import type { AuthScheme, OauthFlavor, Vm } from '@/types/panel-vm'
import { isCodexVm } from '@/lib/vm-kind'

export type CredType =
  'oauth' | 'setup-token' | 'official-setup-token' | 'apikey' | 'none'

const CRED_TYPE_LABEL: Record<CredType, string> = {
  oauth: 'OAuth',
  'setup-token': 'Setup Token',
  'official-setup-token': '官方 Setup Token',
  apikey: 'Console',
  none: '无凭证',
}

/**
 * 判定槽位的凭证类型。
 *
 * 权威字段是 `credential_mode` —— gateway 的三个 Vm 序列化函数只产出它。
 * `claude_mode` 在 gateway 侧仅有一处读取兜底、**零个写入点**，
 * 这里保留只为兼容可能存在的旧数据，新代码不应依赖它。
 *
 * 注意 gateway 有三套互不通用的词汇表：
 * - `flavor` 用下划线（`setup_token`）
 * - `credential_mode` 用连字符（`setup-token` / `official-setup-token`）
 * - `/vms/import` 的 `type` 又是第三套
 * 归一化时统一把下划线转连字符，但**不要**拿转换结果去当 flavor 用。
 */
export function credTypeFromMode(raw: unknown): CredType {
  const m = String(raw || '')
    .toLowerCase()
    .replace(/_/g, '-')
  if (!m) return 'none'
  if (
    m === 'official-setup-token' ||
    m === 'office-setup-token' ||
    m === 'claude-setup-token'
  ) {
    return 'official-setup-token'
  }
  if (m === 'setup-token') return 'setup-token'
  if (m === 'apikey' || m === 'api-key' || m === 'console') return 'apikey'
  return 'oauth'
}

export function credTypeOf(vm: Vm | undefined): CredType {
  if (!vm?.has_token) return 'none'
  return credTypeFromMode(vm.credential_mode || vm.claude_mode || '')
}

export function credTypeLabel(type: CredType): string {
  return CRED_TYPE_LABEL[type] || '无凭证'
}

/** 「类型」列的三类，按**实际调用上游的形式**归类，而不是按凭证怎么获得。 */
export type CredEndpoint = 'console' | 'oauth' | 'api' | 'none'

const CRED_ENDPOINT_LABEL: Record<CredEndpoint, string> = {
  console: 'Console',
  oauth: 'OAuth',
  api: 'API',
  none: '无凭证',
}

export function credEndpointLabel(endpoint: CredEndpoint): string {
  return CRED_ENDPOINT_LABEL[endpoint]
}

/**
 * Claude 槽刷新走 OAuth 接口，但实际推理都是 `Authorization: Bearer` 调 Console
 * （Setup Token 形式），所以 OAuth 与 Setup Token 都归 Console；只有 `x-api-key`
 * 方案才算 API。GPT 槽走 Codex OAuth，归 OAuth。
 *
 * 归类只看实际生效的认证方案（`authSchemeOf`），不看 `credential_mode`：
 * 后者记录的是凭证怎么导入的，同一个 OAuth 授权可以被「转为 Setup Token」，
 * 但调用形式并没有因此不同。
 */
export function credEndpointOf(vm: Vm | undefined): CredEndpoint {
  if (credTypeOf(vm) === 'none') return 'none'
  if (isCodexVm(vm)) return 'oauth'
  return authSchemeOf(vm) === 'x_api_key' ? 'api' : 'console'
}

/** 只有 Claude 完整 OAuth 槽才支持官方初装。GPT 槽走 Codex OAuth。 */
export function supportsOfficialCc(vm: Vm | undefined): boolean {
  if (isCodexVm(vm)) return false
  return credTypeOf(vm) === 'oauth'
}

/**
 * 能否刷新凭证。镜像 gateway `canRefreshCredential`：
 * Console API Key 和官方 Setup Token 永远不能刷新；转换后的 Setup Token 无 refresh 时也不能。
 * GPT 槽有 refresh_token 才能刷新。
 */
export function canRefreshCredential(vm: Vm | undefined): boolean {
  if (isCodexVm(vm)) return Boolean(vm?.has_refresh)
  const type = credTypeOf(vm)
  if (type === 'apikey' || type === 'official-setup-token') return false
  if (type === 'setup-token') return !!vm?.has_refresh
  return true
}

/** 导入面板里用户选择的凭证类型。与 `CredType` 不同，它没有 `none`。 */
export type ImportKind = 'oauth' | 'setup-token' | 'apikey'

/** GPT 槽只走 Codex OAuth / 账号文件；Claude 才有 Setup Token / Console。 */
export function importSurfaceFor(vm: Vm | undefined): 'claude' | 'codex' {
  return isCodexVm(vm) ? 'codex' : 'claude'
}

/** 导入方式。Setup Token 只有 Cookie / 授权链接；OAuth 另加官方 Claude Code。 */
export type ImportMethod = 'session' | 'link' | 'cc'

export const IMPORT_KINDS: { id: ImportKind; label: string }[] = [
  { id: 'setup-token', label: 'Setup Token' },
  { id: 'oauth', label: 'OAuth' },
  { id: 'apikey', label: 'Console' },
]

export function importMethodsFor(
  kind: ImportKind
): { id: ImportMethod; label: string }[] {
  if (kind === 'apikey') return []
  const methods: { id: ImportMethod; label: string }[] = [
    { id: 'cc', label: 'Claude Code 授权' },
    { id: 'link', label: '授权链接' },
    { id: 'session', label: 'Cookie' },
  ]
  if (kind === 'setup-token') return methods.filter((item) => item.id !== 'cc')
  return methods
}

export function defaultImportKind(): ImportKind {
  return 'setup-token'
}

export function defaultImportMethod(kind: ImportKind): ImportMethod {
  return kind === 'apikey' ? 'link' : 'session'
}

export function resolveImportMethod(
  kind: ImportKind,
  method: ImportMethod
): ImportMethod {
  const allowed = importMethodsFor(kind).map((item) => item.id)
  if (allowed.includes(method)) return method
  return defaultImportMethod(kind)
}

const AUTH_SCHEME_LABEL: Record<AuthScheme, string> = {
  x_api_key: 'x-api-key',
  authorization_bearer: 'Authorization: Bearer',
}

export function authSchemeLabel(scheme: AuthScheme): string {
  return AUTH_SCHEME_LABEL[scheme]
}

/** 归一化任意 `auth_scheme` 输入；无法识别时返回 null（交给调用方取默认值）。 */
export function normalizeAuthScheme(raw: unknown): AuthScheme | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  if (s === 'authorization_bearer' || s === 'bearer' || s === 'authorization')
    return 'authorization_bearer'
  if (s === 'x_api_key' || s === 'apikey' || s === 'api_key') return 'x_api_key'
  return null
}

/**
 * 凭证类型对应的默认认证方案，镜像 gateway `defaultAuthScheme`。
 * 只有 `apikey` 走 `x_api_key`，其余一律 Bearer。
 */
export function defaultAuthScheme(kind: ImportKind | CredType): AuthScheme {
  return kind === 'apikey' ? 'x_api_key' : 'authorization_bearer'
}

/**
 * 槽位当前**实际生效**的认证方案。
 *
 * `vm.auth_scheme` 为 null / 未识别时不代表没有方案，而是「跟随凭证类型默认」——
 * 本地推导与 gateway `resolveAuthScheme` 一致，无需再问后端。
 */
export function authSchemeOf(vm: Vm | undefined): AuthScheme {
  return (
    normalizeAuthScheme(vm?.auth_scheme) ?? defaultAuthScheme(credTypeOf(vm))
  )
}

/**
 * 由「凭证类型 + 导入方式」推出 `generate-auth-url` / `exchange-code` 的 `flavor`。
 *
 * ⚠️ 这是**唯一**允许产出 flavor 的地方。绝不能把 `setup-token-session` 响应里的
 * `flavor: 'claude_setup_token'` 原样回传 —— `generate-auth-url` 的
 * `normalizeOauthFlavor` 不认它，会静默降级成 CAI PKCE 流程且不报错。
 * （`exchange-code` 那边有额外的 OR 分支兜住，两端点行为不一致。）
 */
export function oauthFlavorFor(
  kind: ImportKind,
  method: ImportMethod
): OauthFlavor {
  if (kind === 'setup-token') return 'setup_token'
  return method === 'cc' ? 'claude_code' : 'cai'
}

/**
 * `POST /vms/import` 的 `type` —— **第三套词汇表**，与 flavor 无关。
 *
 * 后端只认 `apikey` / `console` / `inference` / `setup-token` / `setup_token`；
 * 传 `'cai'` / `'claude_code'` / `'oauth'` 不报错但也不起作用。
 * 想导 OAuth 就**不传** `type`，让 gateway 按内容自动推断。
 */
export function importTypeFor(kind: ImportKind): 'apikey' | 'setup-token' | '' {
  if (kind === 'apikey') return 'apikey'
  if (kind === 'setup-token') return 'setup-token'
  return ''
}
