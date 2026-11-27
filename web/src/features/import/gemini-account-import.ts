export const ACCOUNT_FILE_LIMIT = 2 * 1024 * 1024

const OAUTH_ACCESS_TOKEN_RE = /^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/
const OAUTH_REFRESH_TOKEN_RE = /^1\/\/[0-9A-Za-z._~+/-]{6,2048}$/
const BARE_REFRESH_TOKEN_RE = /1\/\/[0-9A-Za-z._~+/-]{6,2048}/g
const GEMINI_API_KEY_RE = /^[A-Za-z0-9_-]{20,256}$/
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/
const MAX_EXPIRY_SECONDS = 253402300800
const MILLISECOND_THRESHOLD = 1_000_000_000_000
const GEMINI_CPA_TYPES = new Set(['gemini', 'antigravity', 'gemini-cli'])
const GEMINI_PLATFORMS = new Set([
  'gemini',
  'antigravity',
  'gemini-cli',
  'google',
  'google-gemini',
  'google-oauth',
  'antigravity_enterprise',
  'antigravity-enterprise',
  'code-assist',
  'code_assist',
  'cloudcode',
])
const NON_GEMINI_PROVIDERS = new Set([
  'claude',
  'claude-code',
  'anthropic',
  'openai',
  'codex',
  'chatgpt',
  'kimi',
  'moonshot',
  'xai',
  'grok',
  'deepseek',
  'qwen',
  'mistral',
  'cohere',
  'cursor',
  'copilot',
  'perplexity',
  'openrouter',
  'zhipu',
  'minimax',
  'doubao',
  'azure',
  'bedrock',
  'iflow',
])
const ALLOWED_OAUTH_AUTH_METHODS = new Set([
  'consumer',
  'personal_consumer',
  'gcp',
  'business_licensed_enterprise',
])
const WIF_PROVIDER_RE = /^[A-Za-z0-9._:/-]{1,512}$/
const OAUTH_CLIENT_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/
const PROJECT_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/
const MAX_RECURSION_DEPTH = 16

export type GeminiImportFormat =
  'antigravity_rt' | 'antigravity_tools' | 'cpa' | 'sub2api'

export const GEMINI_IMPORT_FORMAT_LABELS: Record<GeminiImportFormat, string> = {
  antigravity_rt: 'Antigravity 账号 / Refresh Token',
  antigravity_tools: 'Antigravity Tools',
  cpa: 'CLIProxyAPI (CPA)',
  sub2api: 'sub2api',
}

export type GeminiOAuthImportPayload =
  | {
      refresh_token: string
      access_token?: string
      expiry_timestamp?: number
      auth_method?: string
      wif_provider?: string
      oauth_client_key?: string
      is_gcp_tos?: boolean
      project_id?: string
    }
  | {
      access_token: string
      expiry_timestamp: number
      auth_method?: string
      wif_provider?: string
      oauth_client_key?: string
      is_gcp_tos?: boolean
      project_id?: string
    }

export type ParsedGeminiAccount =
  | {
      kind: 'oauth'
      format: GeminiImportFormat
      oauth_account: GeminiOAuthImportPayload
      hasRefreshToken: boolean
      platform?: string
      email?: string
      project_id?: string
      oauth_client_key?: string
      is_gcp_tos?: boolean
      suggestedName?: string
      label: string
    }
  | {
      kind: 'api_key'
      format: GeminiImportFormat
      api_key: string
      platform?: string
      email?: string
      project_id?: string
      suggestedName?: string
      label: string
    }

export type ParsedGeminiImportResult = {
  format: GeminiImportFormat
  accounts: ParsedGeminiAccount[]
  skippedNonGemini: number
  skippedInvalid: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value: unknown, maxLength = 254): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLength) : undefined
}

function normalizedTag(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function validExpirySeconds(seconds: number): number | null {
  return Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    seconds < MAX_EXPIRY_SECONDS
    ? seconds
    : null
}

function toSecondsFromNumeric(num: number): number | null {
  if (
    typeof num !== 'number' ||
    !Number.isFinite(num) ||
    !Number.isSafeInteger(num) ||
    num <= 0
  ) {
    return null
  }
  const seconds = num >= MILLISECOND_THRESHOLD ? Math.floor(num / 1000) : num
  return validExpirySeconds(seconds)
}

export function parseGeminiExpirySeconds(value: unknown): number | null {
  if (typeof value === 'number') {
    return toSecondsFromNumeric(value)
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    return toSecondsFromNumeric(Number(trimmed))
  }
  if (ISO_DATETIME_RE.test(trimmed)) {
    const ms = Date.parse(trimmed)
    if (Number.isFinite(ms) && ms > 0) {
      return validExpirySeconds(Math.floor(ms / 1000))
    }
  }
  return null
}

function parseTimestampPlusExpiresIn(
  source: Record<string, unknown>
): number | null {
  const tsSeconds = parseGeminiExpirySeconds(source.timestamp)
  if (tsSeconds == null) return null
  const rawExpiresIn = source.expires_in
  const expiresIn =
    typeof rawExpiresIn === 'number'
      ? rawExpiresIn
      : typeof rawExpiresIn === 'string' &&
          /^\d+(?:\.\d+)?$/.test(rawExpiresIn.trim())
        ? Number(rawExpiresIn.trim())
        : Number.NaN
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null
  return validExpirySeconds(Math.floor(tsSeconds + expiresIn))
}

function extractExpirySeconds(
  primary: Record<string, unknown>,
  fallback?: Record<string, unknown>
): number | null {
  const sources = fallback ? [primary, fallback] : [primary]
  for (const src of sources) {
    for (const key of [
      'expiry_timestamp',
      'expires_at',
      'expiresAt',
      'expired',
      'expiry',
    ]) {
      const value = src[key]
      if (value !== undefined && value !== null && value !== '') {
        const parsed = parseGeminiExpirySeconds(value)
        if (parsed != null) return parsed
      }
    }
    const fromDuration = parseTimestampPlusExpiresIn(src)
    if (fromDuration != null) return fromDuration
  }
  return null
}

function extractAccessToken(
  primary: Record<string, unknown>,
  fallback?: Record<string, unknown>
): string | null {
  const sources = fallback ? [primary, fallback] : [primary]
  for (const src of sources) {
    for (const key of ['access_token', 'accessToken']) {
      if (typeof src[key] === 'string') {
        const token = src[key].trim()
        if (!token) continue
        return OAUTH_ACCESS_TOKEN_RE.test(token) ? token : null
      }
    }
  }
  return null
}

export function normalizeGeminiRefreshToken(raw: unknown): {
  token: string
  projectId?: string
} | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const pipeIndex = trimmed.indexOf('|')
  const candidate = (
    pipeIndex >= 0 ? trimmed.slice(0, pipeIndex) : trimmed
  ).trim()
  if (!OAUTH_REFRESH_TOKEN_RE.test(candidate)) return null
  const trailingProject =
    pipeIndex >= 0 ? cleanText(trimmed.slice(pipeIndex + 1), 128) : undefined
  return {
    token: candidate,
    ...(trailingProject ? { projectId: trailingProject } : {}),
  }
}

function extractRefreshToken(
  primary: Record<string, unknown>,
  fallback?: Record<string, unknown>
): { token: string; projectId?: string } | null {
  const sources = fallback ? [primary, fallback] : [primary]
  for (const src of sources) {
    for (const key of ['refresh_token', 'refreshToken']) {
      if (typeof src[key] === 'string') {
        const parsed = normalizeGeminiRefreshToken(src[key])
        if (parsed) return parsed
      }
    }
  }
  return null
}

type OptionalAuthMeta = {
  auth_method?: string
  wif_provider?: string
  oauth_client_key?: string
  is_gcp_tos?: boolean
  project_id?: string
}

type InheritedAccountContext = OptionalAuthMeta & {
  name?: string
  email?: string
}

function parseProjectIdValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return trimmed && PROJECT_ID_RE.test(trimmed) ? trimmed : undefined
  }
  if (isRecord(raw)) {
    return parseProjectIdValue(
      raw.id ?? raw.project_id ?? raw.projectId ?? raw.name
    )
  }
  return undefined
}

function extractOptionalAuthMeta(
  sources: Array<Record<string, unknown> | undefined>,
  fallbackProjectId?: string
): OptionalAuthMeta {
  let authMethod: string | undefined
  let wifProvider: string | undefined
  let oauthClientKey: string | undefined
  let isGcpTos: boolean | undefined
  let projectId: string | undefined
  for (const src of sources) {
    if (!src) continue
    if (!authMethod) {
      const candidate = normalizedTag(src.auth_method ?? src.authMethod)
      if (candidate && ALLOWED_OAUTH_AUTH_METHODS.has(candidate)) {
        authMethod = candidate
      }
    }
    if (!wifProvider) {
      const raw = src.wif_provider ?? src.wifProvider ?? src.saved_wif_provider
      if (typeof raw === 'string') {
        const trimmed = raw.trim()
        if (trimmed && WIF_PROVIDER_RE.test(trimmed)) {
          wifProvider = trimmed
        }
      }
    }
    if (!oauthClientKey) {
      const raw = src.oauth_client_key ?? src.oauthClientKey
      if (typeof raw === 'string') {
        const trimmed = raw.trim()
        if (trimmed && OAUTH_CLIENT_KEY_RE.test(trimmed)) {
          oauthClientKey = trimmed
        }
      }
    }
    if (isGcpTos === undefined) {
      const raw = src.is_gcp_tos !== undefined ? src.is_gcp_tos : src.isGcpTos
      if (typeof raw === 'boolean') {
        isGcpTos = raw
      }
    }
    if (!projectId) {
      projectId = parseProjectIdValue(
        src.project_id ?? src.projectId ?? src.cloudaicompanionProject
      )
    }
  }
  if (
    !projectId &&
    fallbackProjectId &&
    PROJECT_ID_RE.test(fallbackProjectId)
  ) {
    projectId = fallbackProjectId
  }
  return {
    ...(authMethod ? { auth_method: authMethod } : {}),
    ...(wifProvider ? { wif_provider: wifProvider } : {}),
    ...(oauthClientKey ? { oauth_client_key: oauthClientKey } : {}),
    ...(typeof isGcpTos === 'boolean' ? { is_gcp_tos: isGcpTos } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  }
}

function mergeInheritedContext(
  inherited: InheritedAccountContext | undefined,
  node: Record<string, unknown>
): InheritedAccountContext | undefined {
  const name = cleanText(node.name, 80) || cleanText(node.label, 80)
  const email =
    cleanText(node.email, 254) ||
    cleanText(node.email_address, 254) ||
    cleanText(node.id_token_email, 254)
  const meta = extractOptionalAuthMeta([node])
  if (!inherited && !name && !email && !Object.keys(meta).length) {
    return undefined
  }
  return {
    ...(inherited ?? {}),
    ...meta,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
  }
}

function extractApiKey(source: Record<string, unknown>): string | null {
  for (const key of ['api_key', 'apiKey']) {
    if (typeof source[key] === 'string') {
      const keyValue = source[key].trim()
      if (!keyValue) continue
      return GEMINI_API_KEY_RE.test(keyValue) ? keyValue : null
    }
  }
  return null
}

function buildOAuthPayload({
  refreshToken,
  accessToken,
  expiryTimestamp,
  meta,
}: {
  refreshToken: string | null
  accessToken: string | null
  expiryTimestamp: number | null
  meta: OptionalAuthMeta
}): GeminiOAuthImportPayload | null {
  if (refreshToken) {
    return {
      refresh_token: refreshToken,
      ...(accessToken && expiryTimestamp != null
        ? { access_token: accessToken, expiry_timestamp: expiryTimestamp }
        : {}),
      ...meta,
    }
  }
  if (accessToken && expiryTimestamp != null) {
    return {
      access_token: accessToken,
      expiry_timestamp: expiryTimestamp,
      ...meta,
    }
  }
  return null
}

function maskRefreshTokenLabel(token: string): string {
  return `${token.slice(0, 12)}…`
}

function buildAccountLabel({
  name,
  email,
  projectId,
  refreshToken,
  platform,
  kind,
  hasRefreshToken,
  index,
}: {
  name?: string
  email?: string
  projectId?: string
  refreshToken?: string
  platform?: string
  kind: 'oauth' | 'api_key'
  hasRefreshToken?: boolean
  index?: number
}): string {
  const primary =
    name ||
    email ||
    projectId ||
    (refreshToken ? maskRefreshTokenLabel(refreshToken) : undefined) ||
    `账号 #${(index ?? 0) + 1}`
  const details: string[] = []
  if (email && email !== primary) details.push(email)
  if (platform) details.push(platform)
  details.push(
    kind === 'api_key' ? 'API Key' : hasRefreshToken ? 'Refresh Token' : 'OAuth'
  )
  return `${primary}（${details.join(' · ')}）`
}

function parseSub2apiAccount(
  doc: Record<string, unknown>,
  index?: number,
  inherited?: InheritedAccountContext
): ParsedGeminiAccount | null {
  const creds = doc.credentials
  if (!isRecord(creds)) return null
  const extra = isRecord(doc.extra) ? doc.extra : undefined
  const platform = normalizedTag(doc.platform) || undefined
  const accountType = normalizedTag(doc.type)
  const name = cleanText(doc.name, 80) || inherited?.name
  const email =
    cleanText(creds.email, 254) ||
    cleanText(creds.email_address, 254) ||
    cleanText(doc.email, 254) ||
    cleanText(extra?.email_address, 254) ||
    cleanText(extra?.email, 254) ||
    inherited?.email
  const rt = extractRefreshToken(creds, doc)
  const meta = extractOptionalAuthMeta(
    [creds, doc, extra, inherited],
    rt?.projectId
  )
  const projectId =
    meta.project_id ||
    cleanText(creds.project_id, 128) ||
    cleanText(extra?.project_id, 128) ||
    rt?.projectId ||
    inherited?.project_id
  const suggestedName = cleanText(name || email || projectId, 80)

  const wantsApiKey = accountType === 'apikey' || accountType === 'api_key'
  const apiKey = extractApiKey(creds)
  if (
    wantsApiKey ||
    (!accountType && !rt && !extractAccessToken(creds) && apiKey)
  ) {
    if (!apiKey) return null
    return {
      kind: 'api_key',
      format: 'sub2api',
      api_key: apiKey,
      platform,
      email,
      project_id: projectId,
      suggestedName,
      label: buildAccountLabel({
        name,
        email,
        projectId,
        platform,
        kind: 'api_key',
        index,
      }),
    }
  }

  if (accountType && NON_GEMINI_PROVIDERS.has(accountType)) return null
  const accessToken = extractAccessToken(creds)
  const expiryTimestamp = extractExpirySeconds(creds)
  const payload = buildOAuthPayload({
    refreshToken: rt?.token ?? null,
    accessToken,
    expiryTimestamp,
    meta,
  })
  if (!payload) return null

  return {
    kind: 'oauth',
    format: 'sub2api',
    oauth_account: payload,
    hasRefreshToken: Boolean(rt?.token),
    platform,
    email,
    project_id: projectId,
    ...(meta.oauth_client_key
      ? { oauth_client_key: meta.oauth_client_key }
      : {}),
    ...(typeof meta.is_gcp_tos === 'boolean'
      ? { is_gcp_tos: meta.is_gcp_tos }
      : {}),
    suggestedName,
    label: buildAccountLabel({
      name,
      email,
      projectId,
      refreshToken: rt?.token,
      platform,
      kind: 'oauth',
      hasRefreshToken: Boolean(rt?.token),
      index,
    }),
  }
}

function tryParseSingleObject(
  doc: Record<string, unknown>,
  index?: number,
  inherited?: InheritedAccountContext
): ParsedGeminiAccount | null {
  // 1. sub2api single account object: `{ platform, type, credentials: { ... } }`
  if (isRecord(doc.credentials)) {
    const platform = normalizedTag(doc.platform)
    if (platform && !GEMINI_PLATFORMS.has(platform)) return null
    return parseSub2apiAccount(doc, index, inherited)
  }

  // Reject explicitly non-Gemini providers (e.g. CPA claude / codex / kimi / xai)
  const typeTag = normalizedTag(doc.type)
  if (typeTag && NON_GEMINI_PROVIDERS.has(typeTag)) {
    return null
  }
  const platformTag = normalizedTag(doc.platform)
  if (platformTag && !GEMINI_PLATFORMS.has(platformTag)) {
    return null
  }

  const name =
    cleanText(doc.name, 80) || cleanText(doc.label, 80) || inherited?.name
  const email =
    cleanText(doc.email, 254) ||
    cleanText(doc.email_address, 254) ||
    cleanText(doc.id_token_email, 254) ||
    inherited?.email
  const baseProjectId =
    parseProjectIdValue(
      doc.project_id ?? doc.projectId ?? doc.cloudaicompanionProject
    ) || inherited?.project_id

  // 2. Nested `token` shape: Antigravity Tools, official agy token, or CPA Gemini CLI
  if (isRecord(doc.token)) {
    const tokenObj = doc.token
    const rt = extractRefreshToken(tokenObj, doc)
    const accessToken = extractAccessToken(tokenObj, doc)
    const expiryTimestamp = extractExpirySeconds(tokenObj, doc)
    const meta = extractOptionalAuthMeta(
      [doc, tokenObj, inherited],
      rt?.projectId
    )
    const payload = buildOAuthPayload({
      refreshToken: rt?.token ?? null,
      accessToken,
      expiryTimestamp,
      meta,
    })
    if (!payload) return null
    const isCpa =
      GEMINI_CPA_TYPES.has(typeTag) ||
      (tokenObj.expiry_timestamp === undefined &&
        (typeof tokenObj.expiry === 'string' ||
          typeof tokenObj.token_uri === 'string'))
    const format: GeminiImportFormat = isCpa
      ? 'cpa'
      : accessToken
        ? 'antigravity_tools'
        : 'antigravity_rt'
    const platform =
      (GEMINI_CPA_TYPES.has(typeTag) ? typeTag : '') ||
      platformTag ||
      (isCpa ? 'gemini' : 'antigravity')
    const resolvedProject =
      meta.project_id ||
      baseProjectId ||
      parseProjectIdValue(tokenObj.project_id ?? tokenObj.projectId) ||
      rt?.projectId
    const resolvedEmail =
      email ||
      cleanText(tokenObj.email, 254) ||
      cleanText(tokenObj.email_address, 254)
    const suggestedName = cleanText(
      name || resolvedEmail || resolvedProject,
      80
    )
    return {
      kind: 'oauth',
      format,
      oauth_account: payload,
      hasRefreshToken: Boolean(rt?.token),
      platform,
      email: resolvedEmail,
      project_id: resolvedProject,
      ...(meta.oauth_client_key
        ? { oauth_client_key: meta.oauth_client_key }
        : {}),
      ...(typeof meta.is_gcp_tos === 'boolean'
        ? { is_gcp_tos: meta.is_gcp_tos }
        : {}),
      suggestedName,
      label: buildAccountLabel({
        name,
        email: resolvedEmail,
        projectId: resolvedProject,
        refreshToken: rt?.token,
        platform,
        kind: 'oauth',
        hasRefreshToken: Boolean(rt?.token),
        index,
      }),
    }
  }

  // 3. Flat shape: Antigravity Manager / Antigravity2API (`{ email, refresh_token }`),
  // schema_version 2 accounts (`{ email, refresh_token, oauth_client_key, is_gcp_tos, project_id }`),
  // opencode-antigravity-auth (`{ refreshToken }`), CPA Antigravity / Gemini top-level
  const rt = extractRefreshToken(doc)
  const accessToken = extractAccessToken(doc)
  const expiryTimestamp = extractExpirySeconds(doc)
  const meta = extractOptionalAuthMeta([doc, inherited], rt?.projectId)
  const payload = buildOAuthPayload({
    refreshToken: rt?.token ?? null,
    accessToken,
    expiryTimestamp,
    meta,
  })
  if (!payload) return null

  const platform =
    (GEMINI_CPA_TYPES.has(typeTag) ? typeTag : '') ||
    platformTag ||
    'antigravity'
  const isCpa = Boolean(
    GEMINI_CPA_TYPES.has(typeTag) ||
    doc.expired !== undefined ||
    doc.expires_in !== undefined ||
    doc.timestamp !== undefined ||
    doc.expiry !== undefined
  )
  const format: GeminiImportFormat = isCpa
    ? 'cpa'
    : rt && !accessToken
      ? 'antigravity_rt'
      : 'antigravity_tools'
  const resolvedProject = meta.project_id || baseProjectId || rt?.projectId
  const suggestedName = cleanText(name || email || resolvedProject, 80)
  return {
    kind: 'oauth',
    format,
    oauth_account: payload,
    hasRefreshToken: Boolean(rt?.token),
    platform,
    email,
    project_id: resolvedProject,
    ...(meta.oauth_client_key
      ? { oauth_client_key: meta.oauth_client_key }
      : {}),
    ...(typeof meta.is_gcp_tos === 'boolean'
      ? { is_gcp_tos: meta.is_gcp_tos }
      : {}),
    suggestedName,
    label: buildAccountLabel({
      name,
      email,
      projectId: resolvedProject,
      refreshToken: rt?.token,
      platform,
      kind: 'oauth',
      hasRefreshToken: Boolean(rt?.token),
      index,
    }),
  }
}

function accountDedupeKey(account: ParsedGeminiAccount): string {
  if (account.kind === 'api_key') {
    return `api_key:${account.api_key}`
  }
  if (
    'refresh_token' in account.oauth_account &&
    account.oauth_account.refresh_token
  ) {
    return `rt:${account.oauth_account.refresh_token}`
  }
  return `at:${account.oauth_account.access_token}:${account.oauth_account.expiry_timestamp}`
}

function looksLikeAccountNode(doc: Record<string, unknown>): boolean {
  return (
    isRecord(doc.credentials) ||
    isRecord(doc.token) ||
    'refresh_token' in doc ||
    'refreshToken' in doc ||
    'access_token' in doc ||
    'accessToken' in doc ||
    'api_key' in doc ||
    'apiKey' in doc
  )
}

function makeBareRefreshAccount(
  token: string,
  index: number
): Extract<ParsedGeminiAccount, { kind: 'oauth' }> {
  return {
    kind: 'oauth',
    format: 'antigravity_rt',
    oauth_account: { refresh_token: token },
    hasRefreshToken: true,
    platform: 'antigravity',
    label: buildAccountLabel({
      refreshToken: token,
      platform: 'antigravity',
      kind: 'oauth',
      hasRefreshToken: true,
      index,
    }),
  }
}

type CollectState = {
  accounts: ParsedGeminiAccount[]
  seen: Set<string>
  skippedNonGemini: number
  skippedInvalid: number
}

function appendUniqueAccount(
  state: CollectState,
  account: ParsedGeminiAccount
) {
  const key = accountDedupeKey(account)
  if (state.seen.has(key)) return
  state.seen.add(key)
  state.accounts.push(account)
}

function collectFromNode(
  node: unknown,
  state: CollectState,
  depth = 0,
  inherited?: InheritedAccountContext
): void {
  if (depth > MAX_RECURSION_DEPTH || node == null) return

  if (typeof node === 'string') {
    const parsed = normalizeGeminiRefreshToken(node)
    if (parsed) {
      const meta = extractOptionalAuthMeta([inherited], parsed.projectId)
      const base = makeBareRefreshAccount(parsed.token, state.accounts.length)
      const projectId =
        meta.project_id || parsed.projectId || inherited?.project_id
      const email = inherited?.email
      const suggestedName = cleanText(inherited?.name || email || projectId, 80)
      appendUniqueAccount(state, {
        ...base,
        oauth_account: {
          refresh_token: parsed.token,
          ...meta,
        },
        ...(email ? { email } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        ...(meta.oauth_client_key
          ? { oauth_client_key: meta.oauth_client_key }
          : {}),
        ...(typeof meta.is_gcp_tos === 'boolean'
          ? { is_gcp_tos: meta.is_gcp_tos }
          : {}),
        ...(suggestedName ? { suggestedName } : {}),
      })
    } else if (depth === 1) {
      state.skippedInvalid += 1
    }
    return
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      if (
        item == null ||
        (typeof item !== 'object' && typeof item !== 'string')
      ) {
        state.skippedInvalid += 1
        continue
      }
      collectFromNode(item, state, depth + 1, inherited)
    }
    return
  }

  if (!isRecord(node)) return

  const platformTag = normalizedTag(node.platform)
  if (platformTag && !GEMINI_PLATFORMS.has(platformTag)) {
    state.skippedNonGemini += 1
    return
  }

  const typeTag = normalizedTag(node.type)
  if (typeTag && NON_GEMINI_PROVIDERS.has(typeTag)) {
    if (looksLikeAccountNode(node)) {
      state.skippedNonGemini += 1
    }
    return
  }

  const parsed = tryParseSingleObject(node, state.accounts.length, inherited)
  if (parsed) {
    appendUniqueAccount(state, parsed)
    return
  }

  // Recurse into nested containers (`accounts`, `tokens`, `data.accounts`, arbitrary object maps/arrays),
  // preserving outer email/name/project_id/oauth_client_key/is_gcp_tos metadata.
  const nextInherited = mergeInheritedContext(inherited, node)
  let recursed = false
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object') {
      recursed = true
      collectFromNode(child, state, depth + 1, nextInherited)
    }
  }
  if (!recursed && looksLikeAccountNode(node)) {
    state.skippedInvalid += 1
  }
}

export function extractBareRefreshTokens(text: string): string[] {
  const matches = text.match(BARE_REFRESH_TOKEN_RE) ?? []
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const raw of matches) {
    const parsed = normalizeGeminiRefreshToken(raw)
    if (parsed && !seen.has(parsed.token)) {
      seen.add(parsed.token)
      tokens.push(parsed.token)
    }
  }
  return tokens
}

export function parseGeminiAccountImportData(
  data: unknown
): ParsedGeminiImportResult {
  if (typeof data === 'string') {
    const tokens = extractBareRefreshTokens(data)
    if (!tokens.length) {
      throw new Error(
        '未找到有效的 Gemini / Antigravity 账号凭据或 Refresh Token（1//...）。'
      )
    }
    return {
      format: 'antigravity_rt',
      accounts: tokens.map((token, idx) => makeBareRefreshAccount(token, idx)),
      skippedNonGemini: 0,
      skippedInvalid: 0,
    }
  }

  if (isRecord(data)) {
    // Explicit top-level single-account provider errors for clear user feedback
    const bundle =
      isRecord(data.data) &&
      (Array.isArray(data.data.accounts) || Array.isArray(data.data.tokens))
        ? data.data
        : data
    const hasBundleArray =
      Array.isArray(bundle.accounts) ||
      Array.isArray(bundle.tokens) ||
      Object.values(data).some((v) => Array.isArray(v))
    if (hasBundleArray) {
      const bundleType = normalizedTag(bundle.type)
      if (bundleType && NON_GEMINI_PROVIDERS.has(bundleType)) {
        throw new Error(`不支持的导出文件类型 "${bundleType}"。`)
      }
    } else {
      const platformTag = normalizedTag(data.platform)
      if (platformTag && !GEMINI_PLATFORMS.has(platformTag)) {
        throw new Error(
          `不支持导入平台为 "${platformTag}" 的账号，请选择 Gemini 或 Antigravity 账号。`
        )
      }
      const typeTag = normalizedTag(data.type)
      if (typeTag && NON_GEMINI_PROVIDERS.has(typeTag)) {
        throw new Error(
          `不支持导入类型为 "${typeTag}" 的账号文件，请选择 Gemini 或 Antigravity 账号。`
        )
      }
    }
  } else if (!Array.isArray(data)) {
    throw new Error(
      '文件格式无效，请选择 Antigravity、CLIProxyAPI（CPA）或 sub2api 导出的账号 JSON，或直接粘贴 Refresh Token（1//...）。'
    )
  }

  const state: CollectState = {
    accounts: [],
    seen: new Set(),
    skippedNonGemini: 0,
    skippedInvalid: 0,
  }
  collectFromNode(data, state, 0)

  if (!state.accounts.length) {
    if (state.skippedNonGemini > 0 && state.skippedInvalid === 0) {
      throw new Error('该导出文件中未包含 Gemini 或 Antigravity 账号。')
    }
    if (isRecord(data) && isRecord(data.credentials)) {
      throw new Error(
        'sub2api 账号 JSON 缺少有效的 Gemini / Antigravity 凭据（Refresh Token、访问令牌与过期时间，或 API Key）。'
      )
    }
    throw new Error(
      '未找到有效的 Gemini / Antigravity 账号凭据（需包含 Refresh Token 1//...、访问令牌与过期时间，或 API Key）。'
    )
  }

  return {
    format: state.accounts[0].format,
    accounts: state.accounts,
    skippedNonGemini: state.skippedNonGemini,
    skippedInvalid: state.skippedInvalid,
  }
}

export function parseGeminiAccountImportText(
  rawText: string
): ParsedGeminiImportResult {
  const trimmed = rawText.trim()
  if (!trimmed) {
    throw new Error('请选择账号 JSON 文件或粘贴 Refresh Token（1//...）。')
  }
  let parsed: unknown
  let jsonValid = false
  try {
    parsed = JSON.parse(trimmed)
    jsonValid = true
  } catch {
    jsonValid = false
  }
  if (jsonValid) {
    return parseGeminiAccountImportData(parsed)
  }
  // Fallback aligned with Antigravity2API: extract bare `1//...` refresh tokens from plain text
  const tokens = extractBareRefreshTokens(trimmed)
  if (tokens.length > 0) {
    return {
      format: 'antigravity_rt',
      accounts: tokens.map((token, idx) => makeBareRefreshAccount(token, idx)),
      skippedNonGemini: 0,
      skippedInvalid: 0,
    }
  }
  throw new Error(
    '文件内容不是有效的 JSON，也未找到有效的 Refresh Token（1//...）。'
  )
}

export async function readGeminiAccountImportFile(
  file: File | null
): Promise<ParsedGeminiImportResult> {
  if (!file || file.size > ACCOUNT_FILE_LIMIT) {
    throw new Error('请选择不超过 2 MiB 的账号 JSON 文件。')
  }
  return parseGeminiAccountImportText(await file.text())
}
