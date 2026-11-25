export const ACCOUNT_FILE_LIMIT = 2 * 1024 * 1024

const OAUTH_ACCESS_TOKEN_RE = /^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/
const GEMINI_API_KEY_RE = /^[A-Za-z0-9_-]{20,256}$/
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/
const MAX_EXPIRY_SECONDS = 253402300800
const MILLISECOND_THRESHOLD = 1_000_000_000_000
const GEMINI_PROVIDERS = new Set(['gemini', 'antigravity', 'gemini-cli'])
const SUB2API_BUNDLE_TYPES = new Set(['sub2api-data', 'sub2api-bundle'])

export type GeminiImportFormat = 'antigravity_tools' | 'cpa' | 'sub2api'

export const GEMINI_IMPORT_FORMAT_LABELS: Record<GeminiImportFormat, string> = {
  antigravity_tools: 'Antigravity Tools',
  cpa: 'CLIProxyAPI (CPA)',
  sub2api: 'sub2api',
}

export type ParsedGeminiAccount =
  | {
      kind: 'oauth'
      format: GeminiImportFormat
      oauth_account: {
        access_token: string
        expiry_timestamp: number
      }
      platform?: string
      email?: string
      project_id?: string
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

function buildAccountLabel({
  name,
  email,
  projectId,
  platform,
  kind,
  index,
}: {
  name?: string
  email?: string
  projectId?: string
  platform?: string
  kind: 'oauth' | 'api_key'
  index?: number
}): string {
  const primary = name || email || projectId || `账号 #${(index ?? 0) + 1}`
  const details: string[] = []
  if (email && email !== primary) details.push(email)
  if (platform) details.push(platform)
  details.push(kind === 'api_key' ? 'API Key' : 'OAuth')
  return `${primary}（${details.join(' · ')}）`
}

function parseSub2apiAccount(
  doc: Record<string, unknown>,
  index?: number
): ParsedGeminiAccount | null {
  const creds = doc.credentials
  if (!isRecord(creds)) return null
  const extra = isRecord(doc.extra) ? doc.extra : undefined
  const platform = normalizedTag(doc.platform) || undefined
  const accountType = normalizedTag(doc.type)
  const name = cleanText(doc.name, 80)
  const email =
    cleanText(creds.email, 254) ||
    cleanText(creds.email_address, 254) ||
    cleanText(extra?.email_address, 254) ||
    cleanText(extra?.email, 254)
  const projectId =
    cleanText(creds.project_id, 128) || cleanText(extra?.project_id, 128)
  const suggestedName = cleanText(name || email || projectId, 80)

  const wantsApiKey = accountType === 'apikey' || accountType === 'api_key'
  const apiKey = extractApiKey(creds)
  if (wantsApiKey || (!accountType && !extractAccessToken(creds) && apiKey)) {
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

  if (accountType && accountType !== 'oauth') return null
  const accessToken = extractAccessToken(creds)
  const expiryTimestamp = extractExpirySeconds(creds)
  if (!accessToken || expiryTimestamp == null) return null

  return {
    kind: 'oauth',
    format: 'sub2api',
    oauth_account: {
      access_token: accessToken,
      expiry_timestamp: expiryTimestamp,
    },
    platform,
    email,
    project_id: projectId,
    suggestedName,
    label: buildAccountLabel({
      name,
      email,
      projectId,
      platform,
      kind: 'oauth',
      index,
    }),
  }
}

function parseSingleObject(
  doc: Record<string, unknown>,
  index?: number
): ParsedGeminiAccount {
  // 1. sub2api single account object: `{ platform, type, credentials: { ... } }`
  if (isRecord(doc.credentials)) {
    const platform = normalizedTag(doc.platform)
    if (platform && !GEMINI_PROVIDERS.has(platform)) {
      throw new Error(
        `不支持导入平台为 "${platform}" 的账号，请选择 Gemini 或 Antigravity 账号。`
      )
    }
    const parsed = parseSub2apiAccount(doc, index)
    if (!parsed) {
      throw new Error(
        'sub2api 账号 JSON 缺少有效的 Gemini / Antigravity 凭据（访问令牌与过期时间，或 API Key）。'
      )
    }
    return parsed
  }

  // Reject explicitly non-Gemini providers (e.g. CPA claude / codex / kimi / xai)
  const typeTag = normalizedTag(doc.type)
  if (typeTag && !GEMINI_PROVIDERS.has(typeTag)) {
    throw new Error(
      `不支持导入类型为 "${typeTag}" 的账号文件，请选择 Gemini 或 Antigravity 账号。`
    )
  }
  const platformTag = normalizedTag(doc.platform)
  if (platformTag && !GEMINI_PROVIDERS.has(platformTag)) {
    throw new Error(
      `不支持导入平台为 "${platformTag}" 的账号，请选择 Gemini 或 Antigravity 账号。`
    )
  }

  const name = cleanText(doc.name, 80) || cleanText(doc.label, 80)
  const email = cleanText(doc.email, 254)
  const projectId = cleanText(doc.project_id, 128)

  // 2. Nested `token` shape: Antigravity Tools (`token.expiry_timestamp`) or CPA Gemini CLI (`type: "gemini"`, `token.expiry`)
  if (isRecord(doc.token)) {
    const tokenObj = doc.token
    const accessToken = extractAccessToken(tokenObj, doc)
    const expiryTimestamp = extractExpirySeconds(tokenObj, doc)
    if (!accessToken || expiryTimestamp == null) {
      throw new Error(
        '账号 JSON 缺少有效的 access_token 或过期时间（expiry_timestamp / expiry）。'
      )
    }
    const isCpa =
      typeTag === 'gemini' ||
      typeTag === 'gemini-cli' ||
      typeTag === 'antigravity' ||
      (tokenObj.expiry_timestamp === undefined &&
        (typeof tokenObj.expiry === 'string' ||
          typeof tokenObj.token_uri === 'string'))
    const format: GeminiImportFormat = isCpa ? 'cpa' : 'antigravity_tools'
    const platform = typeTag || (isCpa ? 'gemini' : 'antigravity')
    const resolvedProject = projectId || cleanText(tokenObj.project_id, 128)
    const suggestedName = cleanText(name || email || resolvedProject, 80)
    return {
      kind: 'oauth',
      format,
      oauth_account: {
        access_token: accessToken,
        expiry_timestamp: expiryTimestamp,
      },
      platform,
      email,
      project_id: resolvedProject,
      suggestedName,
      label: buildAccountLabel({
        name,
        email,
        projectId: resolvedProject,
        platform,
        kind: 'oauth',
        index,
      }),
    }
  }

  // 3. Flat CPA Antigravity / Gemini top-level format
  const accessToken = extractAccessToken(doc)
  const expiryTimestamp = extractExpirySeconds(doc)
  if (accessToken && expiryTimestamp != null) {
    const platform = typeTag || platformTag || 'antigravity'
    const format: GeminiImportFormat =
      typeTag ||
      doc.expired !== undefined ||
      doc.expires_in !== undefined ||
      doc.timestamp !== undefined ||
      doc.expiry !== undefined
        ? 'cpa'
        : 'antigravity_tools'
    const suggestedName = cleanText(name || email || projectId, 80)
    return {
      kind: 'oauth',
      format,
      oauth_account: {
        access_token: accessToken,
        expiry_timestamp: expiryTimestamp,
      },
      platform,
      email,
      project_id: projectId,
      suggestedName,
      label: buildAccountLabel({
        name,
        email,
        projectId,
        platform,
        kind: 'oauth',
        index,
      }),
    }
  }

  throw new Error(
    '文件格式无效，请选择 Antigravity Tools、CLIProxyAPI（CPA）或 sub2api 导出的 Gemini / Antigravity 账号 JSON。'
  )
}

export function parseGeminiAccountImportData(
  data: unknown
): ParsedGeminiImportResult {
  // Top-level JSON array (e.g. multiple CPA or sub2api account objects)
  if (Array.isArray(data)) {
    const accounts: ParsedGeminiAccount[] = []
    let skippedNonGemini = 0
    let skippedInvalid = 0
    for (let idx = 0; idx < data.length; idx += 1) {
      const item = data[idx]
      if (!isRecord(item)) {
        skippedInvalid += 1
        continue
      }
      const tag = normalizedTag(item.platform) || normalizedTag(item.type)
      if (tag && !GEMINI_PROVIDERS.has(tag)) {
        skippedNonGemini += 1
        continue
      }
      try {
        accounts.push(parseSingleObject(item, idx))
      } catch {
        skippedInvalid += 1
      }
    }
    if (!accounts.length) {
      throw new Error(
        skippedNonGemini > 0 && skippedInvalid === 0
          ? '该 JSON 列表中未包含 Gemini 或 Antigravity 账号。'
          : '该 JSON 列表中未找到有效的 Gemini / Antigravity 账号凭据。'
      )
    }
    return {
      format: accounts[0].format,
      accounts,
      skippedNonGemini,
      skippedInvalid,
    }
  }

  if (!isRecord(data)) {
    throw new Error(
      '文件格式无效，请选择 Antigravity Tools、CLIProxyAPI（CPA）或 sub2api 导出的 Gemini / Antigravity 账号 JSON。'
    )
  }

  // sub2api export bundle: `{ type?, version?, exported_at?, proxies?, accounts: [...] }`
  // Also tolerate raw API envelope `{ code: 0, data: { accounts: [...] } }`
  const bundle =
    isRecord(data.data) && Array.isArray(data.data.accounts) ? data.data : data
  if (Array.isArray(bundle.accounts)) {
    const bundleType = normalizedTag(bundle.type)
    if (bundleType && !SUB2API_BUNDLE_TYPES.has(bundleType)) {
      throw new Error(`不支持的导出文件类型 "${bundleType}"。`)
    }
    const accounts: ParsedGeminiAccount[] = []
    let skippedNonGemini = 0
    let skippedInvalid = 0
    for (let idx = 0; idx < bundle.accounts.length; idx += 1) {
      const item = bundle.accounts[idx]
      if (!isRecord(item)) {
        skippedInvalid += 1
        continue
      }
      const platform = normalizedTag(item.platform)
      if (!GEMINI_PROVIDERS.has(platform)) {
        skippedNonGemini += 1
        continue
      }
      const parsed = parseSub2apiAccount(item, idx)
      if (parsed) {
        accounts.push(parsed)
      } else {
        skippedInvalid += 1
      }
    }
    if (!accounts.length) {
      if (skippedInvalid > 0) {
        throw new Error(
          '该 sub2api 导出文件中的 Gemini / Antigravity 账号缺少有效凭据（访问令牌与过期时间，或 API Key）。'
        )
      }
      throw new Error(
        '该 sub2api 导出文件中未包含 Gemini 或 Antigravity 账号。'
      )
    }
    return {
      format: 'sub2api',
      accounts,
      skippedNonGemini,
      skippedInvalid,
    }
  }

  const single = parseSingleObject(data)
  return {
    format: single.format,
    accounts: [single],
    skippedNonGemini: 0,
    skippedInvalid: 0,
  }
}

export async function readGeminiAccountImportFile(
  file: File | null
): Promise<ParsedGeminiImportResult> {
  if (!file || file.size > ACCOUNT_FILE_LIMIT) {
    throw new Error('请选择不超过 2 MiB 的账号 JSON 文件。')
  }
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    throw new Error('文件内容不是有效的 JSON。')
  }
  return parseGeminiAccountImportData(raw)
}
