# 协议行为

对齐 `src/lib/protocol/*`、`src/lib/identity/crs-persona.mjs`、`src/server.mjs` 的 `handleProtocol`。日期 2026-08-26。

上游 hop 始终 `stream:true`。客户端 SSE 透传；非流或 `x-kin-delivery: verified` 则缓冲到 `message_stop` 再聚合。

## 官方 Claude Code 判定

`isOfficialClaudeCodeTraffic(headers, body)` 四闸：

| 条件 | 实现 |
|------|------|
| UA | `^claude-cli/\d+\.\d+\.\d+`（sub2api 同款前缀；vscode / cowork / desktop 都算） |
| `metadata.user_id` | 合法官方 user id |
| tools | 不能是 OpenAI `{type:function}` / `tool_choice.type=function`。`/v1/messages` 上这种 tools 会先转 Anthropic，但仍判非官方 |
| system | 含 `x-anthropic-billing-header:`、官方 `cc_entrypoint`（`cli` / `sdk-cli` / `vscode` / `cowork` / `desktop`，不含 `local-agent`）、或官方身份行（含 `You are Claude Code` / `Claude Agent SDK` 变体） |

四闸不全 → 非官方，走人设。虚拟机测试入站会先铺 4 块官方 system + 官方 UA，因此分类为 `claude_code_official`。

## 非官方人设

每次请求热读 `routing.compatibility`（改盘无需重启 Node）。仓库配置为：

| 键 | 值 | 含义 |
|----|----|------|
| `persona_preset` | `official_full` | 使用独立的完整官方模板；`official` 保留原有官方提示词 |
| `overlay_preset` | `off` | 不向首条 user 注入 overlay |
| `persona_park` | `false` | 与 `overlay_preset=off` 对齐 |
| `cache_ttl` | `1h` | 出站 cache_control 默认 1h；可改为 5m，或用 `x-kin-cache-ttl` 覆盖 |

**official 模板**保留 billing + Agent SDK identity + 可选 caller_agent / caller_system，并在 agent 块之后写槽位 `# Environment`（`{{env}}`，只含 `Timezone: <槽位时区>`，不挂 cache，不破 agent 块的 1h global 缓存）；不会自动追加完整 agent prompt。

**official_full 模板**在相同前缀后固定追加完整 `agent_official`，带 ephemeral 5m cache；调用方 system 作为末块追加。

**zero 模板**在 agent 槽之后写 `{{env}}` 块（`hide`、`drop_if_empty`、不挂 cache），只含槽位时区。自定义档空模板回落 official，同样带 `{{env}}`。live 已自定义的 zero 模板不会自动多出这一块，需在 system提示词页「恢复预设」。

**agent prompt 常驻约束**：默认不启用。`compatibility.agent_standing` 仍保留内置 distillation / 思维链 / NSFW 四行文本（显式空串 = 不加，上限 2000 字符），只有当前档的 `agent_standing_presets` 显式为 `true` 才经 `{{agent_standing}}` 写成 agent 块第一段：official / 0注入 在 `caller_agent` 之前，official_full 在 `agent_official` 之前（同一块）。关掉后 0注入 无调用方 agent 时回到零宽占位；已有显式开启的配置不被覆盖。

**按档开关**（`{official,official_full,zero,custom}: boolean`）：
- `agent_standing_presets`：是否写常驻约束，缺 map 或缺 key 视为关。控制台开关、预览与 Node 出站使用同一缺省语义。
- `agent_standing_hide_presets`：常驻约束是否从客户端 usage 中扣除，缺 map/key 视为开，独立于整档遮罩；未启用约束时不扣约束 token。cli-hop 0注入 同样生效。
- `persona_env_presets`：是否写 `{{env}}`，缺 map/key 视为开。官方完整的 `env_official` 不受此开关影响。
- `persona_hide_presets`：整档 usage 遮罩（billing / identity / agent / Environment 等 `hide:true` 块）。缺 key 时依次回落旧全局 `persona_hides`、该档模板的 `hide` 标记（默认 zero 开、其余关）。槽位单独指定人设时读该槽位档的开关；cli-hop 0注入 关掉后 CLI billing + Environment 计入 usage。

cli-hop 的 kin 分支只组装 `billing →（identity 布局的身份句）→ # Environment\n - Timezone: <kernel.json timezone> → Node/caller leftover`。它剥离重复 billing、身份句、`# Environment` 和 Kin/Crag 自产 persona，不再追加槽内 cwd、Platform、Notes 或默认 agent prompt。leftover 各块原文（包括首尾空白）按原顺序以双换行拼接；调用方真正的 `You are an agent for Claude Code...` 和 `Notes:` 不会被当作自产内容删除。常驻约束若启用，仍在 leftover 的 agent prompt 顶部。billing 的 `isSubagent: true`、`splitSysPromptPrefix` 断点与既有缓存 TTL 策略不因本修复改变。

调用方 `messages[].role=system` 和 tools / `tool_choice` 保留；`overlay_preset=off` 不挂 prompt-leak / identity / no-tools reminder。

四闸通过的官方 Claude Code 原生请求在 persona 入口直接返回：不 rewrite、不重复追加已有官方 system、不 park、不藏 usage。只有 UA 而没有官方 system 的请求不通过四闸，仍按第三方完整模板处理。

遗留 `persona_inject=rewrite|overwrite|append|none` 仍可用，但不是仓库配置默认值。`rewrite` 使用 KIN 短 agent + env；`overwrite` 使用完整 agent_prompt + continuation + Environment。system提示词页保存时三档写回 `official_prompt` / `official_full` / `zero`；自定义才保留旧 inject。

权威开关是 `routing.json` 的 `compatibility.persona_preset`（system提示词）与 `cache_ttl`（设置 → 协议）。`vms/<id>/run/kernel.json` 不是第二套面板：面板保存、槽位「跟随全局」、外部改写 `routing.json`，或虚拟机环境保存时区之后，才把解析结果投影进去（`persona_preset`、`system_layout`、`default_cache_ttl`、`timezone`）。`system_layout` 只有 `zero` 与 `identity`（`official` / `official_full` / `custom` 都是 `identity`）。字节没变不重写。kernel 热读该文件，不必重启槽。Codex 槽不写。手改 `kernel.json` 会在下一次投影时被盖掉。

面板预览表达 Node 给出的模板内容；cli-hop 最终线序以上述 CLI-owned 前缀为准，不把 Node 对象预览当成最终 wire 抓包。更新 CLI 二进制后需要替换槽内副本并重启相应 kernel/CLI；配置热读不能让旧进程自动加载新 ELF。删除旧环境文本后首次前缀会冷写，后续 cache_read 数值须实测，不能保证必然不低于旧值。0注入 + 常驻约束关闭 + 无调用方 agent 的真实模型可见输出须单独验收。

Go worker JSON 透传，不必因人设重建 worker。

### usage 遮罩

全部非官方协议（Messages / Chat / Completions / Responses）回包 usage 按「没有被网关改写的 system、没有注入 tools」显示：藏网关注入的 persona system 块与 server tools，保留用户 prompt 与用户自己的 tools，抹掉因 persona 产生的官方 cache。官方 CC 不遮罩。

## thinking 与 max_tokens

`max_tokens` **就是** thinking 预算（thinking + 可见输出共享）。调用方有值则不覆盖；缺失时 OAuth 默认 **128000**。绝对上限 128000。仅当超过模型 `max_tokens_cap` 时 `applyMaxTokensCap` 下调。

| 模型 | thinking |
|------|----------|
| Haiku / Claude 4.5 及更早 | 拒绝 `adaptive` → `enabled` + budget |
| Claude 5 / Fable 5 / Mythos / Opus 4.7+ | 保留 `thinking.enabled`；缺省时非官方可补 `adaptive` + `display: omitted` |
| 缺 `context_management` | 补 `clear_thinking_20251015`（需带对应 beta） |

非官方缺省还可补 `output_config.effort=high`，**不覆盖**已有 thinking / max_tokens。最新 main 在 unofficial 缺 `thinking.display` 时补 `omitted`。

虚拟机测试未传 `max_tokens` 时用模型策略 `max_tokens_default`，再不行用 64（健康探测 hello 同口径）。

## beta 与 1M

- 存盘的 `kin-cc-headers.json` **只**留 `anthropic-version` / `anthropic-beta`。UA、stainless、session、accept-language 只出槽位指纹 + 代码 pin。
- 出站 UA 锁 `claude-cli/2.1.284 (external, sdk-cli)`。Stainless 仍是 `js` / `Linux` / `x64` / `node` / `v26.3.0` / `0.112.1`，`retry-count=0`，`timeout=600`。
- 非官方裸模型 **不注入、不重放** `context-1m-2025-08-07`。入站末尾 `[1m]`（如 `claude-sonnet-5[1m]`）在矩阵允许时注入该 beta（官方/非官方都算）。
- 官方 CC：矩阵 `betas.pass_context_1m` 决定透传/剥离；未入库时回退 `defaults.context_1m_whitelist`（seed：`sonnet-5*`）。同一 `[1m]` 后缀在允许时也会注入。
- 出站 `model` 去掉 `[1m]` 后缀。
- 缺 `context-management` beta 时剥掉 body 同名字段。
- 缺 beta 时不带对应高级字段；短 beta 按 mimicry 集合补齐（官方路径）。

模型目录权威是面板 `model_policy`（`GET/PUT /api/panel/model-policy`）。`GET /v1/models` 与 `validateOfficialModel` 读这份集合，**禁止** hop 槽位 `/internal/v1/models`。

## web_search

五种人设方案只在末轮 user 提示词出现「搜索」/`search`/`web search` 时注入 `{type: web_search_20250305, name: web_search}`。调用方已声明则原样转发。`web_search=false` / `x-kin-web-search: false` / `tool_choice=none` 不补。官方 Claude Code 入站不注入。

Rikka / 客户端 `search_web`、`scrape_web` **不是** Anthropic 自带搜索：出站保持 `{name,description,input_schema}`，模型 `tool_use search_web` 由 App 执行。已有 `search_web` 时 `ensureClaudeWebSearch` 不再叠原生 `web_search`。

出站只有 `{type,name}` 存根（约 18 token），但 schema 在 Anthropic 侧，**实际计费约 2794 token**（vm-05 zero 基线实测：同形状请求带工具 2837、不带 43，两次复测一致）。因此客户端 usage 按 `SERVER_TOOL_INPUT_TOKENS` 里的真实 schema 成本扣，而不是按出站字节估算，否则第三方能从 `input_tokens` 看出网关注入了搜索工具。调用方自己声明的 `web_search` 不扣，照常可见。


## 清洗与整流

`sanitizeInboundBody` / `request-rectifier`：

- 非法 Anthropic `role` 按 Sub2API 清洗
- 非官方补 tool 对、短签名预过滤
- OpenAI `response_format` → `output_config`；`refusal` → `content_filter`
- 空 refusal 记 `content_filter_refusal`

## thinking 历史与签名

出站前 `stripInvalidThinkingBlocks` 丢两类历史 thinking 块，**顺序是先文本后签名**：

1. `thinking` 文本为空的（非官方被补 `display: omitted` 后 haiku 只回签名不回文本，这类块出站前就没了）
2. 签名短于 24 字符或是 dummy 的（`hasUsableThinkingSignature`，兜第三方截断的 SSE 签名）

HTTP hop 与 cli-hop（`prepareCliHopBody`）共用内容预过滤，但职责不同。cli-hop 的 Node 清除 caller `cache_control` 后写入最后消息及 `messages.length>=4` 时倒数第二 user 的断点，TTL 用入站会话已 pin 值。native Claude Code CLI 每个 job 热读 slot `kernel.json` 做 persona 布局，自产 system/tools 标记必须沿用同一请求 TTL，不得再从面板独立决策。Rust kernel 只认证、转发和流式传输，不再重打 last。Node 出站 JSON 不是最终 wire。HTTP hop 仍可由 Node 按自己的路由策略整流缓存。

长度够的签名原样转发，由 Anthropic 验。上游**严格验签名自身完整性**：乱码签名回 400 `Invalid \`signature\` in \`thinking\` block`。但签名**不与 thinking 文本绑定、也不与模型绑定** —— 真签名配改写过的文本、或 sonnet 的签名打到 opus / haiku，上游都 200（2026-08-28 实测，见 `测试结果/2026-08-28-thinking-signature/`）。

HTTP hop 那个 400 默认原样透传。`routing.failover.signature_repair=true`（设置页「探测 → 签名修复」）才走 `signature_repairable` 的 `repair-and-retry`（剥 thinking 历史 + 删 `body.thinking` 后重试一次），客户端只看到 200。**cli-hop / rust 槽始终走这一次同槽降级重试**（预过滤挡不住换票或长乱码签）；重试不得再补 `thinking.adaptive`。

## 健康探测缓存

`routing.health_probe`：

- **`enabled` 默认 `false`**：不开就没有定时探测、也没有缓存回放，第三方探活按普通推理落到真实槽位
- 开启后才做定时真实 Messages（默认 10min）。hello 通过 `personaMode=overwrite` 生成完整 agent_prompt + continuation + Environment，并携带官方 UA / metadata 经站点 `/v1/messages` 官方通道钉槽发送
- 匹配的第三方短请求（`hi`/`hello`/`ping`/`test`/`健康`，无 system/tools、小 `max_tokens`）在占并发前回放缓存的官方 Messages 体（真实 `id` / `content` / `usage`），不本地合成 `msg_health_*`
- `cache_ttl_sec` 默认 900；`cache_models` 空=拦全部入站模型
- 无有效缓存且 `fail_closed` 时 503
- 设置页「探测」可热改；`GET/POST /api/panel/health-probe`

## 身份出站

选槽之后：

- `device_id`：64 hex 原样出站（创建生成值或官方 `machineID`）。遗留 UUID 槽仍 sha256。官方初装成功后存储值被 `~/.claude.json` `machineID` 覆盖
- `session_id`：官方 CC 保留调用方原值；非官方用 CRS hash
- 无显式会话标识时的回退：sticky 键与出站 session 种子都取首条 user 消息的完整内容指纹（保持块类型与顺序、不截断；多模态块按内容参与）。后续消息不参与；客户端改写 / 裁剪首条消息时需带显式 `session_id` 保持连续
- `metadata.user_id`：官方 `userID` + 凭证 email（不读残留 `.claude/.claude.json`）
- guest locale / tz 进 fingerprint；`/etc/machine-id` 是 `guest_machine_id`（systemd 32 hex）；出站 hostname 是 `<distro>-<4hex>`

## 相关头

| 头 | 作用 |
|----|------|
| `x-kin-delivery: verified` | 缓冲到终态 |
| `x-kin-cache-ttl: 1h` | 出站 cache 升 1h |
| `x-kin-vm` | 仅 master：钉槽（虚拟机测试 loopback） |
| `x-session-id` 等 | sticky 键，见 `routing.sticky` |
| `x-kin-debug` / `x-kin-log` | 单请求日志模式覆盖 |
| `X-Request-ID` | 回写响应头 |

Go worker 用 trailer `X-Kin-Usage` / `X-Kin-Model` / `X-Kin-Stop-Reason` 回传合并 usage，与非流同一终态记账。
