# 协议行为

对齐 `src/lib/protocol/*`、`src/lib/identity/crs-persona.mjs`、`src/server.mjs` 的 `handleProtocol`。日期 2026-08-26。

进槽前的封控拦截不在本文，见 [RISK.md](RISK.md)。

上游 hop 始终 `stream:true`。客户端 SSE 透传；非流或 `x-kin-delivery: verified` 则缓冲到 `message_stop` 再聚合。

## 官方 Claude Code 判定

`isOfficialClaudeCodeTraffic(headers, body)` 四闸：

| 条件 | 实现 |
|------|------|
| UA | `^claude-cli/\d+\.\d+\.\d+`（sub2api 同款前缀；vscode / cowork / desktop 都算） |
| `metadata.user_id` | 合法官方 user id |
| tools | 不能是 OpenAI `{type:function}` / `tool_choice.type=function`。`/v1/messages` 上这种 tools 会先转 Anthropic，但仍判非官方 |
| system | 含 `x-anthropic-billing-header:`、官方 `cc_entrypoint`（`cli` / `sdk-cli` / `vscode` / `cowork` / `desktop`）、或官方身份行（含 `You are Claude Code` / `Claude Agent SDK` 变体）。`local-agent` 仅在 UA 含对应入口和 Agent SDK、平台为 `desktop_app` 且客户端版本有效时继续原有官方校验；OMP 专属特征仍优先排除 |

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

权威开关是 `routing.json` 的 `compatibility.persona_preset`（system提示词）与 `cache_ttl`（面板不再提供修改入口，直接改 `routing.json`；缺省 `1h`）。`vms/<id>/run/kernel.json` 不是第二套面板：面板保存、槽位「跟随全局」、外部改写 `routing.json`，或虚拟机环境保存时区之后，才把解析结果投影进去（`persona_preset`、`system_layout`、`default_cache_ttl`、`timezone`）。`system_layout` 只有 `zero` 与 `identity`（`official` / `official_full` / `custom` 都是 `identity`）。字节没变不重写。kernel 热读该文件，不必重启槽。Codex 槽不写。手改 `kernel.json` 会在下一次投影时被盖掉。

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
- 出站 UA 锁 `claude-cli/2.1.293 (external, sdk-cli)`。Stainless 仍是 `js` / `Linux` / `x64` / `node` / `v26.3.0` / `0.112.1`，`retry-count=0`，`timeout=600`。
- 非官方裸模型 **不注入、不重放** `context-1m-2025-08-07`。入站末尾 `[1m]`（如 `claude-sonnet-5[1m]`）在矩阵允许时注入该 beta（官方/非官方都算）。
- 官方 CC：矩阵 `betas.pass_context_1m` 决定透传/剥离；未入库时回退 `defaults.context_1m_whitelist`（seed：`sonnet-5*`）。同一 `[1m]` 后缀在允许时也会注入。
- 出站 `model` 去掉 `[1m]` 后缀。
- 缺 `context-management` beta 时剥掉 body 同名字段。
- 缺 beta 时不带对应高级字段；短 beta 按 mimicry 集合补齐（官方路径）。

模型目录权威是面板 `model_policy`（`GET/PUT /api/panel/model-policy`）。`GET /v1/models` 与 `validateOfficialModel` 读这份集合，**禁止** hop 槽位 `/internal/v1/models`。`GET /v1/models` 只列出该 key 的 `group_type` 能调度的模型：`openai` 只列 GPT，`anthropic` 只列 Claude，`all` 与 master 两者都列。

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

出站前 `stripInvalidThinkingBlocks` 保留可回放的历史思维块：

1. `thinking` 即使文本为空，只要有完整签名也保留；这是 `display: omitted` 的正常响应形态。
2. Opus / Sonnet / Haiku 5.5 按 sub2api：非空且非 dummy 的签名都算有效，不看长度；`redacted_thinking` 有 `data` 就留，没有 `data` 时再看签名。历史里只要有一块无效，整段 thinking / `redacted_thinking` 都拆掉，只留正文；拆完没有内容的轮删掉。全部有效时不拆。
3. 更早的型号仍逐块过滤：签名短于 24、空签名、dummy 签名删掉，合法签名块留下。`redacted_thinking` 不看 `data`，只在签名达到 24 字符时留。
4. 保留路径（cli-hop 首跳，以及默认 HTTP hop）不走上面的拆链。缺少 `signature` 字段的 `thinking` 补空字段，已有字段不改写。

HTTP hop 与 cli-hop（`prepareCliHopBody`）共用内容预过滤，但职责不同。cli-hop 的首个出站 hop 保留已有 thinking 指纹块，并为缺字段的 thinking 补 `signature: ""`；只有签名修复重试的 `repaired` hop 才清除这些块。Node 清除 caller `cache_control` 后写入最后消息及 `messages.length>=4` 时倒数第二 user 的断点，TTL 用入站会话已 pin 值。native Claude Code CLI 每个 job 热读 slot `kernel.json` 做 persona 布局，自产 system/tools 标记必须沿用同一请求 TTL，不得再从面板独立决策。Rust kernel 只认证、转发和流式传输，不再重打 last。Node 出站 JSON 不是最终 wire。HTTP hop 仍可由 Node 按自己的路由策略整流缓存。

长度够的签名原样转发，由 Anthropic 验。5.5 的非 dummy 签名也原样转发，不按 24 字符预过滤。签名是 opaque 加密内容，当前模型 / 账户 / 会话前缀不匹配时可能被丢弃或返回 400 `Invalid \`signature\` in \`thinking\` block`。网关不伪造真实签名，只在面板 / cli-hop 保留路径补齐缺失字段。切换账号时不改写已有签名；`cli-node` 仍按现有登录 / fallback 逻辑清理签名块。

`routing.failover.signature_repair=true`（设置页「探测 → 签名修复」）才走 `signature_repairable` 的 `repair-and-retry`（剥 thinking 历史 + 删 `body.thinking` 后重试一次），客户端只看到 200。关闭时包括 cli-hop 在内都原样透传 400；`cli-node` 自身行为不受该面板开关改变。

## 健康探测缓存

`routing.health_probe`：

- **`enabled` 默认 `false`**：不开就没有定时探测、也没有缓存回放，第三方探活按普通推理落到真实槽位
- **`probe_all_slots` 默认 `false`**：关闭时定时探测在首个成功槽后停止（early-stop）；开启后每个间隔对所有可调度槽各探一次（`concurrency` 上限、工作时段、冷却、凭证排除仍生效），列表顺序中首个成功仍写入缓存
- 开启后才做定时真实 Messages（默认 10min）。hello 通过 `personaMode=overwrite` 生成完整 agent_prompt + continuation + Environment，并携带官方 UA / metadata 经站点 `/v1/messages` 官方通道钉槽发送
- 匹配的第三方短请求（`hi`/`hello`/`ping`/`test`/`健康`，无 system/tools、小 `max_tokens`）在占并发前回放缓存的官方 Messages 体（真实 `id` / `content` / `usage`），不本地合成 `msg_health_*`
- `cache_ttl_sec` 默认 900；`cache_models` 空=拦全部入站模型
- 无有效缓存且 `fail_closed` 时 503
- 设置页「探测」可热改；`GET/POST /api/panel/health-probe`

## 身份出站

选槽之后：

- `device_id`：64 hex 原样出站（创建生成值或官方 `machineID`）。遗留 UUID 槽仍 sha256。官方初装成功后存储值被 `~/.claude.json` `machineID` 覆盖
- `session_id`：官方 CC 保留调用方原值；非官方用 CRS hash
- `metadata.user_id`：官方 `userID` + 凭证 email（不读残留 `.claude/.claude.json`）
- guest locale / tz 进 fingerprint；`/etc/machine-id` 是 `guest_machine_id`（systemd 32 hex）。新槽主机名与 machine-id 来自私有 `kin-computer`，不再限定 `<distro>-<4hex>`；已有容器启动时保留原身份。本机新建容器发布计算机身份挂载，远端槽位仍使用原有身份传输路径。

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
