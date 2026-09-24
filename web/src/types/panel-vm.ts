/**
 * 出站认证头方案。gateway 规范化后只有这两个值。
 *
 * 未显式设置时 `Vm.auth_scheme` 为 `null`，表示「跟随 credential_mode 默认」
 * （`apikey` → `x_api_key`，其余 → `authorization_bearer`），不是异常态。
 */
export type AuthScheme = 'x_api_key' | 'authorization_bearer'

/**
 * `POST /vms/:id/oauth/generate-auth-url` 的 `flavor`（**下划线**风格）。
 *
 * 与 `credential_mode`（连字符）和 `/vms/import` 的 `type` 是三套互不通用的词汇表，
 * 不可互相赋值。
 */
export type OauthFlavor = 'cai' | 'claude_code' | 'setup_token'

/** 代理出口节点的地理位置。`checked_at` 有值而 `ip` 为空即检测失败，见 `error`。 */
export type ProxyGeo = {
  ip?: string | null
  country?: string | null
  country_code?: string | null
  region?: string | null
  city?: string | null
  isp?: string | null
  /** IANA 时区，绑定后槽位默认跟随它。 */
  timezone?: string | null
  checked_at?: string | null
  error?: string | null
}

export type VmProxySnap = {
  id?: string
  host?: string
  port?: number | string
  status?: string
  enabled?: boolean
  latency_ms?: number
  last_error?: string
  last_probe_at?: string
  /** 是否配了账密。账密本身永不出现在列表响应里，见 api-contract.md。 */
  has_auth?: boolean
  consecutive_failures?: number
  bound_vm_ids?: string[]
  bound_vm_id?: string
  bound_count?: number
  bind_limit?: number
  created_at?: string
  kind?: 'local' | 'socks5' | string
  scheme?: string
  /** 出口地理位置；从未检测过为 null。 */
  geo?: ProxyGeo | null
}

export type InferenceEngine = 'auto' | 'go' | 'rust'

export type VmKernelHealth = {
  reachable?: boolean
  process_up?: boolean
  status?: string | number | null
  version?: string | null
  worker_version?: string | null
  engine?: string | null
  provider?: string | null
  ready_slots?: number | null
  cli_pid?: number | null
  error_code?: string | null
  proxy_ok?: boolean | null
  accounts?: number | null
  vm_id?: string | null
}
export type VmKernelSnapshot = {
  credential_owner?: string | null
  credential_state?: string | null
  proxy_state?: string | null
  telemetry?: {
    enabled?: boolean | null
    running?: boolean | null
    process?: string | null
    read_only?: boolean
  } | null
  process_topology?: {
    rust_pid1?: boolean
    go_worker_pid1?: boolean
    go_telemetry?: boolean
  } | null
  configured_engine?: 'go' | 'rust' | null
  resolved_engine?: 'go' | 'rust' | null
  active_engine?: 'go' | 'rust' | null
  go_health?: VmKernelHealth | null
  rust_health?: VmKernelHealth | null
  codex_health?: VmKernelHealth | null
}

export type VmCircuit = {
  account_id?: string
  state: 'closed' | 'open' | 'half_open'
  failures: number
  threshold: number
  /** 毫秒时间戳；仅 open 时有值 */
  open_until: number | null
  open_ms: number
}

export type Vm = {
  id: string
  name?: string
  owner_user_id?: string | null
  origin?: string | null
  email?: string
  status?: string
  has_token?: boolean
  has_refresh?: boolean
  cred_status?: string | { text?: string; key?: string; tone?: string }
  /**
   * 凭证类型的权威字段（连字符风格：`oauth` / `setup-token` / `apikey` / `console`）。
   * gateway 的三个 Vm 序列化函数只产出这一个。
   */
  credential_mode?: string
  /** 仅为兼容旧数据保留 —— gateway 侧只有一处读取兜底，零写入点。新代码勿依赖。 */
  claude_mode?: string
  /** 可经 `PATCH /vms/:id` 热改；重置为默认要发空串 `''`，发 `null` 会 400。 */
  auth_scheme?: string
  availability?: {
    /**
     * 后端 `availability.mjs` 实际产出 7 种：
     * `none` / `bad` / `off` / `quota` / `sessions` / `cool` / `ok`。
     * 此前只声明了 5 种（含后端根本不返回的 `warn`/`caution`），
     * 导致 `off` 被误归类、「关闭调用」筛选恒为空。
     * 注意 `off` 的 `usable` 为 false，判断顺序上必须先于 `!usable`。
     */
    key: 'ok' | 'none' | 'bad' | 'off' | 'quota' | 'sessions' | 'cool'
    usable: boolean
    text?: string
    reason?: string
  }
  proxy_configured?: boolean
  can_import_credential?: boolean
  proxy?: VmProxySnap
  proxy_id?: string
  schedulable?: boolean
  schedule_manual?: boolean
  /** Operator switch vs quota/cooldown park. */
  schedule_state?: 'on' | 'restricted' | 'off'
  restriction_reason?: string | null
  restriction_until?: number | null
  /** Claude 单元熔断（Codex 为 null）。连续 5xx 达阈值后打开，到期只放 1 个探测。 */
  circuit?: VmCircuit | null
  cooldown_until?: number
  cooldown_reason?: string
  utilization_5h?: number
  utilization_7d?: number
  utilization_7d_oi?: number
  utilization_7d_sonnet?: number
  status_5h?: string
  status_7d?: string
  reset_5h?: string
  reset_7d?: string
  reset_7d_oi?: string
  reset_7d_sonnet?: string
  codex_usage?: {
    windows?: Array<{
      id?: string
      used_percent?: number
      reset_at?: string | null
    }>
    quota?: {
      utilization_5h?: number
      utilization_7d?: number
    }
  } | null
  reset_credits?: {
    available_count?: number
    credits?: Array<{ expires_at?: string }>
    fetched_at?: string
  } | null
  near_limit?: boolean
  fable?: Record<string, unknown>
  weekly_split?: Record<string, unknown>
  account_tier?: string
  /** Official /usage listed a Fable model. Overrides leftover Pro stamps. */
  usage_has_fable?: boolean
  /** anthropic | openai。缺省按 Claude 槽展示。 */
  platform?: string | null
  /** claude | codex */
  family?: string | null
  codex_kernel?: boolean
  inference_engine?: 'go' | 'rust' | null
  resolved_inference_engine?: 'go' | 'rust' | null
  persona_preset?: string | null
  resolved_persona_preset?: string | null
  dataplane?: 'wrap' | 'crag' | null
  resolved_dataplane?: 'wrap' | 'crag' | null
  kernel?: string
  region?: string
  /** 槽位环境时区（容器 `TZ` + persona `# Environment`）。 */
  timezone?: string | null
  /** `manual` = 手动钉住，绑定代理不会覆盖；`proxy_geo` = 跟随代理出口。 */
  timezone_source?: 'auto' | 'manual' | 'proxy_geo' | string
  zone?: string
  active?: boolean
  max_concurrency?: number
  max_rpm?: number
  /** Claude CLI native 执行位热准入上限；内核固定预开 20。 */
  session_slots?: number | null
  session_slots_override?: boolean
  /** 当前有效调度等级；自动模式范围 1～7，手动模式范围 1～10。 */
  schedule_level?: number
  /** 调度等级来源；缺失时按自动模式展示。 */
  schedule_level_mode?: 'auto' | 'manual'
  rpm?: number
  /** 同等级 WRR 权重，不是调度等级。 */
  weight?: number
  inflight?: number
  allowed_models?: string[] | null
  requests?: number
  tokens_in?: number
  tokens_out?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
  cache_hit_rate?: number | null
  today_cost?: number
  today_requests?: number
  today_tokens?: number
  today_input_tokens?: number
  today_output_tokens?: number
  today_cache_read_tokens?: number
  today_cache_creation_tokens?: number
  total_cost?: number
  expires_at?: string
  refreshed_at?: string
  oauth_source?: string
  account_uuid?: string
  org_uuid?: string
  access_preview?: string
  refresh_preview?: string
  last_probe?: {
    at?: string
    ok?: boolean
    error?: string
    source?: string
    transport?: boolean
    rate_limited?: boolean
  }
  last_probe_check?: {
    at?: string
    ok?: boolean
    source?: string
    via?: string
    error?: string | null
    data_at?: string | null
  } | null
  probe_source?: string
  /** 最近一次刷票失败的原因。与 `last_probe.error` 是两条独立的失效来源。 */
  refresh_error?: string
  extra_usage?: unknown
  runtime?: Record<string, unknown>
  fingerprint?: Record<string, unknown>
  worker_credential?: Record<string, unknown>
  seed_policy?: Record<string, unknown>
  fable_cooldown_until?: number
  fable_cooldown_reason?: string
  fable_inflight?: number
  /** 每账号 Fable 并发上限，取自 `routing.concurrency.fable_max_per_account`（VM 级回落值）。 */
  fable_max?: number
  schedule_disabled_reason?: string
  container?: string
  official_cc?: OfficialCcStatus
  /** 会话上限快照对象；旧字段 `session_active`/`session_max` 是它的扁平化镜像。 */
  sessions?: { active?: number; max?: number }
  session_active?: number
  session_max?: number
  status_7d_oi?: string
  window_5h_cost?: number
  window_5h_requests?: number
  window_5h_tokens?: number
  window_7d_cost?: number
  window_7d_requests?: number
  window_7d_success?: number
  window_7d_errors?: number
  window_7d_tokens?: number
  [key: string]: unknown
}

export type VmDetailPayload = {
  vm?: Vm
  kernel?: VmKernelSnapshot | null
  proxy?: VmProxySnap | null
  account?: Record<string, unknown> | null
  billing?: Record<string, unknown> | null
  [key: string]: unknown
}

/** `GET/PUT /api/panel/vms/:id/seed-settings` 剥壳后的 payload。不展示 `cli_home`。 */
export type VmSeedSettings = {
  vm_id?: string
  seed_policy?: Record<string, unknown>
  telemetry_enabled?: boolean
  telemetry_disabled?: boolean
  kill_keys?: string[]
  required_env?: Record<string, string>
  note?: string
  settings_json?: Record<string, unknown> | null
  kin_seed?: Record<string, unknown> | null
  [key: string]: unknown
}

/**
 * `GET /api/panel/vms/:id/oauth/setup-token-session`
 *
 * 永远 200，用 `active` 区分有无会话 —— **没有 404 分支**，
 * 连 vm 是否存在都不校验。`active: false` 不是错误，只是「当前没有进行中的会话」。
 */
export type SetupTokenSession = {
  active?: boolean
  vm_id?: string
  session_id?: string
  auth_url?: string
  /** 毫秒 epoch，TTL 30 分钟。同一响应里没有秒级字段，不要 `* 1000`。 */
  expires_at?: number
  /**
   * 恒为 `'claude_setup_token'`。
   * ⚠️ **不可原样回传给 `generate-auth-url`** —— 那边的 `normalizeOauthFlavor`
   * 不认这个值，会静默降级成 CAI PKCE 流程且不报错。回传要用 `'setup_token'`。
   */
  flavor?: string
  source?: string
  /** `code_fed` / `token_ready` / `error` + PTY 侧的中间态，后端不做枚举校验。 */
  status?: string
  /** 非 null 但 `active` 仍为 true 是合法状态：会话活着但上次喂码失败，可重试。 */
  error?: string | null
  /** 硬编码字面量 `true`，不携带信息 —— 不要拿它做分支判断。 */
  retryable?: boolean
}

export type OfficialCcStatus = {
  status?: string
  step?: string
  hello_ok?: boolean
  usage_ok?: boolean
  account_tier?: string
  /** `profile` = 官方 /api/oauth/profile；`usage` = /usage 推断兜底。 */
  account_tier_source?: string
  /** 槽内 GET /v1/models 返回的模型 id。 */
  available_models?: string[]
  exit_code?: number | null
  resident?: boolean
  resident_ok?: boolean
  resident_pid?: number | null
  bridge_port?: number | null
  error?: string | null
  force?: boolean
  stats_ok?: boolean
  telemetry_enabled?: boolean
  telemetry_official?: boolean
  [key: string]: unknown
}

export type QuotaTierKey = 'default' | 'pro' | 'max'

export type QuotaTierPolicy = {
  max_concurrency?: number
  max_rpm?: number
  limit_5h?: number
  limit_7d?: number
  max_sessions?: number
  session_idle_min?: number
  warn_ratio?: number
  [key: string]: unknown
}

export type VmCredentialResponse = {
  vm_id?: string
  has_token?: boolean
  source?: string | null
  export?: Record<string, unknown>
}

export type OfficialCcBootstrapPayload = {
  vm_id?: string
  status?: OfficialCcStatus
}

export type TestModelsPayload = {
  items?: { id: string; label?: string; family?: string }[]
  models?: { id: string; label?: string; family?: string }[]
  platform?: 'openai' | 'anthropic' | 'all'
  protocol?: 'openai.responses' | 'anthropic.messages' | null
  inbound_path?: '/v1/responses' | '/v1/messages' | null
  source?: string
}
