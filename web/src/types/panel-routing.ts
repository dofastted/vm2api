import type { RuntimeType } from '@/types/panel-vm'

/** `routing.compatibility.persona_preset`。PUT 严格匹配，不做别名归一化。 */
export type PersonaPreset = 'official' | 'official_full' | 'zero' | 'custom'

/** `routing.compatibility.overlay_preset`。`off` 没有模板体。 */
export type OverlayPreset = 'off' | 'official' | 'minimal' | 'custom'

/**
 * persona / overlay 模板的一个 system 块。
 * `id` / `note` / `drop_if_empty` / `hide` 是 meta，渲染时被剥离；
 * 只有 `type` / `text` / `cache_control` 会到达 Anthropic。
 */
export type PersonaBlock = {
  id?: string
  note?: string
  /** persona 只能是 'text'（或缺省）；overlay 必须是 'wrapper' 或 'body'。 */
  type?: 'text' | 'wrapper' | 'body'
  text: string
  /** 任一块为 true → 对调用方遮罩这部分 usage。 */
  hide?: boolean
  /** 渲染后 text.trim() 为空则整块丢弃。 */
  drop_if_empty?: boolean
  cache_control?: { type?: string; ttl?: string; [key: string]: unknown }
  [key: string]: unknown
}
export type BackupItem = {
  id: string
  created_at?: string
  size?: number
  note?: string
  kind?: string
}
/** `GET/PUT /api/panel/distill`。协议入口蒸馏拦截规则。 */
export type DistillRules = {
  enabled: boolean
  skip_official: boolean
  skip_zero: boolean
  error: {
    status: number
    type: string
    code: string
    message: string
  }
  structure: {
    min_max_tokens: number
    require_no_tools: boolean
    require_single_turn: boolean
  }
  needles: string[]
  /** Extra regexes. Built-in distillation / CoT patterns live on the hard rules. */
  patterns: string[]
  fingerprints: string[]
}

/** `GET/PUT /api/panel/refusal-guards`。上游 AUP 指纹缓存，独立于蒸馏拦截。 */
export type RefusalGuardItem = {
  fingerprint: string
  model: string
  first_seen_at: string
  last_seen_at: string
  hit_count: number
  source_request_id: string | null
  error_message: string | null
  preview: string | null
}

export type RefusalDeviceBlock = {
  device_id: string
  first_seen_at: string
  last_seen_at: string
  hit_count: number
  source_request_id: string | null
  fingerprint: string | null
  reason: string | null
}

export type RefusalGuardConfig = {
  enabled: boolean
  similarity_enabled: boolean
  /** 80、85、90 或 95。 */
  similarity: number
  device_block_enabled: boolean
  count: number
  items: RefusalGuardItem[]
  device_count: number
  devices: RefusalDeviceBlock[]
}

export type PolicyQuestion = {
  id: string
  label: string
  summary: string
  instructions: string
  enabled: boolean
  builtin?: boolean
}

export type PolicyRule = {
  category: string
  source: string
  enabled: boolean
}
/** `GET/PUT /api/panel/jev-intercept`。决策模型与硬正则。密钥只回 api_key_set。 */
export type JevInterceptConfig = {
  enabled: boolean
  hard_regex_enabled: boolean
  provider: 'jev' | 'laya' | 'modernbert'
  providers?: {
    id: string
    label: string
    default_model: string
    default_base_url?: string
  }[]
  defaults?: {
    safety_instruction: string
    question_ids: string[]
    safety_threshold: number
    block_if_below: boolean
    fail_open: boolean
    dedup_sec: number
    max_state_chars: number
    expand_base64: boolean
    strip_reminders: boolean
    timeout_ms: number
  }
  base_url: string
  model: string
  timeout_ms: number
  api_key_set: boolean
  api_key_count: number
  safety_instruction: string
  question_ids: string[]
  question_bank?: PolicyQuestion[]
  builtin_questions?: PolicyQuestion[]
  safety_threshold: number
  block_if_below: boolean
  fail_open: boolean
  dedup_sec: number
  max_state_chars: number
  expand_base64: boolean
  strip_reminders: boolean
  categories: string[]
  builtin_patterns: string[]
  builtin_rules?: PolicyRule[]
  rules?: PolicyRule[]
  rules_customized?: boolean
  patterns: string[]
}

export type NotifyEvents = {
  pool_empty: boolean
  pool_low: boolean
  pool_recovered: boolean
  digest: boolean
  revoked: boolean
  invalid: boolean
  account_down: boolean
  account_up: boolean
}

export type NotifyTelegramConfig = {
  enabled: boolean
  /** GET 永远为空；保存后只通过 bot_token_set 表示已配置，禁止回显。 */
  bot_token: string
  bot_token_set?: boolean
  chat_id: string
}

/** `GET /routing -> notify` 与 `GET /notify -> config` 的脱敏通知配置。 */
export type NotifyConfig = {
  enabled: boolean
  interval_sec: number
  cooldown_sec: number
  digest_sec: number
  min_available: number
  run_on_start: boolean
  console_url: string
  events: NotifyEvents
  telegram: NotifyTelegramConfig
  email?: Record<string, unknown>
}

export type NotifyStatus = {
  config: NotifyConfig
  snapshot?: Record<string, unknown> | null
  last_events?: { type?: string; title?: string }[]
  last_error?: string | null
  last_run_at?: string | null
  channels?: { email?: boolean; telegram?: boolean; any?: boolean }
}

export type BackupsPayload = {
  items?: BackupItem[]
}

/** `routing.vm`：槽位默认形态与机器规格。创建时覆盖 memory/vcpus/disk_gb 后固化到槽。 */
export type VmRoutingSmbios = {
  manufacturer: string
  product: string
  version: string
  family: string
}

export type VmRoutingConfig = {
  default_runtime: RuntimeType
  memory: string
  vcpus: number
  disk_gb: number
  cpu_model: string
  smbios: VmRoutingSmbios
  mac_oui: string
  allow_tcg: boolean
}
