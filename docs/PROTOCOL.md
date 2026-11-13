# 协议行为

对齐 `src/lib/protocol/*`、`src/lib/identity/crs-persona.mjs`、`src/server.mjs` 的 `handleProtocol`。日期 2026-08-26。

进槽前的封控拦截不在本文，见 [RISK.md](RISK.md)。

上游 hop 始终 `stream:true`。客户端 SSE 透传；非流或 `x-kin-delivery: verified` 则缓冲到 `message_stop` 再聚合。

## CRAG native V2 部署边界

`dataplane: "crag"` 一律采用 native V2 与官方 Claude；省略版本和已存的 `legacy` 也走 v2，不再安装 `cc-node` 或 `share/crag/kin-kernel`。`KIN_CRAG_V2_ROOT` 指向解压后的签名加密发布目录，必须包含 `encrypted: true` native manifest、完整 SHA-256 成员、架构匹配的 `crag-v2` 启动器、签名 `crag-v2.payload.enc`、发布公钥与官方 Claude；不接受旧 Node、明文 native V2 或未 bundled 的独立部署变体。

物化后的 `.kin/kin-kernel` 直接 exec `.kin/crag-v2/crag-v2`，Claude 位于 `.kin/crag-v2/claude-code-2.1.321/claude`；不复制 Node 或注入旧 CLI 版本。替换产物后沿用现有显式 idle-restart 流程；写 `kernel.json` 本身不新增自动重启。判断 idle 必须计入 active、waiting-tool、queued 和实际 PID，不能把 runnable ceiling 与物理容量之差当作运行任务数。

所有 CRAG 选择与正常 hop 都要求该 VM 的离线注册码；V2 原生网关再次校验签名、设备绑定和当前 UTC 到期时间。缺失/无效/错误 VM/未生效/已到期均为终态 403，不当作 OAuth 刷新、模型策略、账号冷却或 Go 回退。cli-node/wrap 不要求 CRAG 注册码。

槽详情「推理内核」提供机器码复制、注册码激活/替换，以及签名内的期限、生效时间和到期时间；无授权点击 CRAG 会进入激活，不提前改 VM 配置或停内核。期限只能由供应方签发为 1个月/半年/1年（UTC 自然月 1/6/12，月底收敛），客户不能直接改过期时间。错误替换码不破坏现有有效授权，续期只换授权，不隐式切换内核。

设备私钥/注册码保存在与现有 worker run 映射一致的 Linux 私有目录；保留运行数据与 machine-id 的普通容器重建保留授权，复制到不同 VM/设备无效。不要把 `license_dir` 放在 WSL DrvFS。启动器只在 sealed memfd 解密业务程序，不写明文；客户包不含供应方私钥/产品 AES key。离线授权不支持远程吊销，不能可靠阻止 root 回拨时间或复制全部设备材料。


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
| `cache_ttl` | `1h` | 平台新增 marker 的缺省 TTL；`x-kin-cache-ttl` 参与首次会话选择。调用方合法 `1h`、`5m`、`1h → 5m` 及省略 TTL 均保留，不按菜单值统一改写 |

**official / official_full 模板**统一采用 2.1.303 OAuth 抓包中的 harness + guidance；顶层 `system` 只装提示词与调用方 `caller_system`。Environment 放入 `messages[].role=system`，不打缓存点，不混入顶层提示词。身份和 billing 入口跟随 `cc_entrypoint`。所有档位均使用 2.1.303，不再提供单独的 `official_303` 选项；旧值读写时归一为 `official_full`，旧开关和模板迁移到完整版，已有明确的完整版配置优先。

**official_full 环境扩展**额外提供抓包中的工具 / agent / MCP / skills 长说明（`{{env_instructions_303}}`），默认不加载，可开启、改写或整块移除。抓包样本仅为文字，不会创建对应工具能力，启用前须按实际客户端修改。个人目录、实时日期与剩余 token 不固化到该长说明。模型附加句也写入环境区域。时区和语言通过 `{{env_timezone}}` / `{{env_locale}}` 独立按需加载，默认关闭。

**zero 模板**仅保留 billing，不自动追加环境。自定义档空模板回落 official；已保存的自定义模板不被默认模板覆盖。模板块可用元数据 `role: "system"` 指定环境区域，未指定时进入顶层 `system`；该元数据不会出站。

**agent prompt 常驻约束**：默认不启用。`compatibility.agent_standing` 仍保留内置 distillation / 思维链 / NSFW 四行文本（显式空串 = 不加，上限 2000 字符），只有当前档的 `agent_standing_presets` 显式为 `true` 才经 `{{agent_standing}}` 写成 agent 块第一段：official / 0注入 在 `caller_agent` 之前，official_full 在 `agent_official` 之前（同一块）。关掉后 0注入 无调用方 agent 时回到零宽占位；已有显式开启的配置不被覆盖。

**按档开关**（`{official,official_full,zero,custom}: boolean`）：
- `agent_standing_presets`：是否写常驻约束，缺 map 或缺 key 视为关。控制台开关、预览与 Node 出站使用同一缺省语义。
- `agent_standing_hide_presets`：常驻约束是否从客户端 usage 中扣除，缺 map/key 视为开，独立于整档遮罩；未启用约束时不扣约束 token。cli-hop 0注入 同样生效。
- `persona_env_presets`：是否写生成的 `{{env}}` / `{{env_timezone_only}}` / `{{env_official}}` 及槽位 `{{timezone}}`，缺 map/key 视为开。关闭时删除生成的整个环境块（含官方完整档 continuation 环境块），不留下带 cache 的零宽环境占位；调用方或自定义模板字面写入的 Environment / 时区保留，不用槽位时区覆盖。控制台预览与最终出站一致，各档独立。
- `persona_env_instructions_presets`：完整版长环境说明，缺 map/key 视为关。
- `persona_timezone_presets` / `persona_locale_presets`：独立加载槽位时区 / locale，缺 map/key 视为关。`persona_env_presets=false` 同时停用所有生成的环境消息，包括模型附加句；调用方已有 `role=system` 原文保留。
- `persona_hide_presets`：整档 usage 遮罩（billing / identity / agent / Environment 等 `hide:true` 块）。缺 key 时依次回落旧全局 `persona_hides`、该档模板的 `hide` 标记（默认 zero 开、其余关）。槽位单独指定人设时读该槽位档的开关；cli-hop 0注入 关掉后 CLI billing + Environment 计入 usage。

native cli-hop 优先完整保留 Node 已组装、带 billing 的 wire system，不在后面重加槽内 Environment。Node 关闭当前档 Environment 时，CLI 预处理保留调用方环境原文，HTTP 出站也跳过槽位时区刷新；没有调用方环境就不发送 Environment 块。启用时沿用原有槽位环境规则。调用方真正的 `You are an agent for Claude Code...` 和 `Notes:` 不会被当作自产内容删除。无 Node billed wire system 的独立 CLI fallback 仍沿用自己的布局，不在本次修改范围；槽位必须使用支持 wire-system 保留的 CLI 产物，旧 ELF 不会因修改控制面配置而自动更新。

调用方 `messages[].role=system` 和 tools / `tool_choice` 保留；`overlay_preset=off` 不挂 prompt-leak / identity / no-tools reminder。

四闸通过的官方 Claude Code 原生请求在 persona 入口直接返回：不 rewrite、不重复追加已有官方 system、不 park、不藏 usage。只有 UA 而没有官方 system 的请求不通过四闸，仍按第三方完整模板处理。

遗留 `persona_inject=rewrite|overwrite|append|none` 仍可用，但不是仓库配置默认值。`rewrite` 使用 KIN 短 agent + env；`overwrite` 使用完整 agent_prompt + continuation + Environment。system提示词页保存时三档写回 `official_prompt` / `official_full` / `zero`；自定义才保留旧 inject。

权威开关是 `routing.json` 的 `compatibility.persona_preset`（system提示词）与 `cache_ttl`（设置 → 协议 → 提示词缓存 → 默认缓存写入 TTL，可选 `5m` / `1h`，缺省 `1h`，点击「保存」生效）。该值仅是默认值，不覆盖请求头、请求显式 TTL、已有会话锁定值或 system 模板显式 TTL；官方透传的调用方 marker 及缺失 TTL 保持原样。`vms/<id>/run/kernel.json` 不是第二套面板：面板保存、槽位「跟随全局」、外部改写 `routing.json`，或虚拟机环境保存时区之后，才把解析结果投影进去（`persona_preset`、`system_layout`、`default_cache_ttl`、`timezone`）。`system_layout` 只有 `zero` 与 `identity`（`official` / `official_full` / `custom` 都是 `identity`）。字节没变不重写。kernel 热读该文件，不必重启槽。Codex 槽不写。手改 `kernel.json` 会在下一次投影时被盖掉。

### CRAG v2 print

CRAG v2 槽的 worker 传输是 **print**，不是 TUI。官方二进制是 `claude-code-2.1.321`。`kernel.json` 的 `persona_preset` 和 `CLAUDE_CODE_SYSTEM_LAYOUT` 不被这个 worker 读取，也不能靠 `--bare` 做 0注入：`--bare` 会把 OAuth 槽切成只认 API key。是否走 print 只看这台 VM 实际启用的内核：运行中的 health `runtime_variant=crag-v2` 优先，其次是槽位自己写明的 `dataplane` / `crag_kernel_version`，再其次是该槽 `run/kernel.json`。全局 `routing.inference` 不能把 wrap、cc 或未写内核的槽送上 print。legacy CRAG 仍走 cli-node。

system提示词页有两套。cli-node 仍用上面的模板。CRAG 一套只认 `compatibility.crag_persona_preset`：

| 值 | 清洗 |
|----|------|
| `official_full`（缺省） | 不把官方四块 system 再贴进去。调用方剩余文本走 `crag_prompt.mode=append`（裸 `system` 在 v2 里也是 append）。≤ 64 KiB 才是 `--append-system-prompt`；更长由 helper 写进用户消息，不是 system 缓存块。没有尾巴就不发 system 旗标。 |
| `zero` | 必须 `crag_prompt.mode=replace`。超过 64 KiB 直接 400，不假装替换成功。没有调用方文本时发不出 replace。`--system-prompt` 是否换掉 identity/harness/guidance，2.1.303 没复抓，未证实。 |

槽位显式 `zero` 覆盖成 replace。`official` / `official_full` / `official_303` 在这条 print 上都收成 append 尾巴；只要 identity 没有旗标，自定义模板不贴进去。print 不传 `--tools ""` 和 `--no-chrome`，内置工具和 Chrome 保持官方默认。thinking、temperature、betas、system 上的 `cache_control` 协议层可以收到，helper 不转发。今天进官方 CLI 的是 `--model`、64 KiB append/replace 文本、preload 的 `max_tokens` / `effort` / 已有 cache marker 的 ttl，以及调用方工具变成 MCP。

官方 Claude Code 的 `agent_summary` 旁路只按当前完整摘要指令识别，沿用独立执行会话、席位与父会话粘性隔离。CRAG 的工具续接按工具 ID 认领，换 session ID 不会隔离继承的 `tool_result`：print 入核前，仅将已识别摘要的末条 user 消息中的工具结果展开为只读标签和原始内容块，保留正文、图片、错误标记、缓存断点及尾随 system 提示。历史工具调用/结果对与正常主请求保持原样；不靠匹配工具输出里的 `tool_result replayed` 文本触发清洗，不吞真实重放错误、不重发已消费结果。


面板预览表达 Node 给出的模板内容；cli-hop 最终线序以上述 CLI-owned 前缀为准，不把 Node 对象预览当成最终 wire 抓包。更新 CLI 二进制后需要替换槽内副本并重启相应 kernel/CLI；配置热读不能让旧进程自动加载新 ELF。删除旧环境文本后首次前缀会冷写，后续 cache_read 数值须实测，不能保证必然不低于旧值。0注入 + 常驻约束关闭 + 无调用方 agent 的真实模型可见输出须单独验收。

Go worker JSON 透传，不必因人设重建 worker。

### usage 遮罩

全部非官方协议（Messages / Chat / Completions / Responses）回包 usage 按「没有被网关改写的 system、没有注入 tools」显示：藏网关注入的 persona system 块与 server tools，保留用户 prompt 与用户自己的 tools，抹掉因 persona 产生的官方 cache。官方 CC 不遮罩。

## DSH 工具结果裁剪与缓存

`routing.compatibility.preserve_pruned_tool_results: true` 可为槽位推理开启 DSH 工具结果裁剪保护；缺省关闭，API 直连端点不启用。它不会修改客户端配置或路由粘性。

DSH 在压缩压力下会把旧工具结果改为前4096码点、固定middle-pruned标记和后1024码点。开启后，网关在同一认证密钥、严格的DSH `session-UUID`、模型和完整历史前缀内，仅恢复精确等于该裁剪结果的旧文本。必须有此前完整verified且未重试的请求作为原文基线；仅收到keepalive、取消、失败或不完整流不会提交原文。真正的历史编辑、删消息、工具参数变化及摘要替换不还原。

原文只在进程内保存：TTL 1小时、总量16MiB、最多128会话、每会话2MiB、单工具文本256KiB，待确认快照也计入总预算。凭据和会话仅用于进程HMAC隔离，日志只记录 `hop_meta.tool_result_prune` 的恢复数量和原因，不增加正文日志。并发同会话、快照缺失、超预算或无法确认上下文空间时，整组保持调用方较短的原请求；不做部分还原。重启后从自然成功请求重新建立基线。

恢复在persona重渲染、额度风险估算和传输前完成。上下文检查使用上一次真实输入/输出、追加消息的UTF-8字节上界、输出预留和16K余量；新增图片、文档或其它无法可靠估价的内容时不恢复。该保护不能让真实摘要或新摘要后的上下文免于冷写，也不能保证上游缓存永不淘汰。

## thinking 与 max_tokens

`max_tokens` **就是** thinking 预算（thinking + 可见输出共享）。前置协议清洗时缺失值用该模型目录的 `max_tokens_default`，目录没有时用 4096。调用方有值且低于 `compatibility.min_max_tokens` 时默认抬到该值，模式「不改」则不抬；超过模型 `max_tokens_cap` 时下调。CRAG print 绕过普通出站准备，因此协议清洗阶段也必须应用模型上限。

| 模型 | thinking |
|------|----------|
| Haiku / Claude 4.5 及更早 | 拒绝 `adaptive` → `enabled` + budget |
| Claude 5 / Fable 5 / Mythos / Opus 4.7+ | 保留 `thinking.enabled`；缺省时非官方可补 `adaptive` + `display: omitted` |
| 缺 `context_management` | 补 `clear_thinking_20251015`（需带对应 beta） |

非官方缺省还可补 `output_config.effort=high`，**不覆盖**已有 thinking / max_tokens。最新 main 在 unofficial 缺 `thinking.display` 时补 `omitted`。

虚拟机测试未传 `max_tokens` 时用模型策略 `max_tokens_default`，再不行用 64（健康探测 hello 同口径）。

连接测试及真实健康探针显式选择 thinking：允许关闭的模型发送 `{"type":"disabled"}`，要求 adaptive 的模型仍发送 adaptive。普通入站只有 Haiku 4.5 的小预算单次探针（原始 `max_tokens` 为 1–64 的整数、单条最多 64 字符的纯文本 user、无 system/tools/显式 thinking，且非官方透传）补 disabled；输出下限与模型 cap 沿用现有配置，不扩大预算、不改普通会话或调用方显式思考选择。

显式携带既有 `x-kin-health-real` 标记的真实健康请求，在同样的 Haiku 4.5、1–64 token、单 user、无 system/tools/显式 thinking 条件下补 disabled，不以诊断标记的正文长度排除；没有此标记的普通长正文保持原行为。

CRAG 需配套原生 helper 将显式 disabled 送到官方 Claude 的最终 fetch 边界；旧签名内核可能忽略该字段。修改 Node 或只热写配置不等于已更新运行中的 CRAG；新内核需要按现有签名交付与排空安装流程生效，不能用全局 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 覆盖所有模型来替代。


## beta 与 1M

- 存盘的 `kin-cc-headers.json` **只**留 `anthropic-version` / `anthropic-beta`。UA、stainless、session、accept-language 只出槽位指纹 + 代码 pin。
- Node 协议清洗和 worker envelope 的 UA 入口统一读取 `routing.compatibility.cc_entrypoint`（缺省 `cli`，可显式选择 `sdk-cli`），覆盖槽位身份中的旧入口，不采用调用方 UA；版本号仍取槽位身份 / 代码 pin。Setup Token / API Key 的 inference-only UA 不变。原生 cli-node 的最终 UA 由 CLI 读取 `kernel.json.cc_entrypoint` 生成，不把 envelope 当作最终抓包。Stainless 是 `js` / `Linux` / `x64` / `node` / `v26.3.0` / `0.128.0`，`retry-count=0`；CLI 把配置的毫秒 timeout 转为秒写入头（缺省 `600`）。CCH 是 billing body 参数，不属于 UA。
- cli-node SDK 请求显式带 `Accept: application/json, text/event-stream`、`Accept-Encoding: gzip, br`。`Content-Length` 在 CCH 密封和最终序列化之后按 UTF-8 字节数设置；不是响应长度，不能拿它填写 SSE 响应。该补齐构建尚未进 payload，不能据代码或 envelope 推断运行中的 CLI 已发送这些头。
- 新 CLI 在最终 `fetch` 调用前，经任务隔离的内部事件回传请求头。debug 日志的 `outbound_headers_source=cli_final` 时，`outbound_headers` 才是此处采集的实际值；凭证及未列入公开清单的自定义头值在离开 CLI 前脱敏。此值不含底层 HTTP 实现后加的 Host / HTTP/2 伪头，不是 TLS 抓包。内部事件不下发调用方、不计作首 token 或启动上游 idle 计时；重试记录最后一次采集结果。
- Node → worker 的头另存 `worker_envelope_headers`。旧 CLI 无回传或该次尝试尚未发送时，最终头为 null、source 为 `unavailable`，不回退成 envelope。旧日志缺少 source，保留原值但不标为最终值。`outbound_body` 仍是 worker envelope 的请求体，未改为 CLI 最终序列化字节；需同时升级 Node / web / cli-node，kernel 已有的通道无需修改。
- 非官方裸模型 **不注入、不重放** `context-1m-2025-08-07`。入站末尾 `[1m]`（如 `claude-sonnet-5[1m]`）在矩阵允许时注入该 beta（官方/非官方都算）。
- 官方 CC：矩阵 `betas.pass_context_1m` 决定透传/剥离；未入库时回退 `defaults.context_1m_whitelist`（seed：`sonnet-5*`）。同一 `[1m]` 后缀在允许时也会注入。
- 出站 `model` 去掉 `[1m]` 后缀。
- 缺 `context-management` beta 时剥掉 body 同名字段。
- 缺 beta 时不带对应高级字段；短 beta 按 mimicry 集合补齐（官方路径）。

模型目录权威是面板 `model_policy`（`GET/PUT /api/panel/model-policy`）。`GET /v1/models` 与 `validateOfficialModel` 读这份集合，**禁止** hop 槽位 `/internal/v1/models`。`GET /v1/models` 只列出该 key 的 `group_type` 能调度的模型：`openai` 只列 GPT，`anthropic` 只列 Claude，`all` 与 master 两者都列。固定策略模型 `auto` 不属于 worker 抓到的 Claude 目录：`policy_only` 与 `worker_intersect_policy` 在它启用时列出；`worker_only` 即使 worker 列表没有它，也会追加已启用的 `auto`。策略里停用后，三种模式都不列出。请求里的 `model: "auto"` 原样通过校验和出站，不改写成具体 Claude 模型。

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

## 搜索历史重放

旧 `server_tool_use` / `web_search_tool_result` / 加密 `search_result` 被当前上游拒绝时，`search_repairable` 仍只在该请求内做一次纯文本修复重试；这不是 `slot_busy`，每个执行 lease 都在 hop 的 `finally` 释放，不清除原会话 pin。

若同一 VM / 账号 / 模型 / 凭据代际的修复跳确认成功，`FailoverRunner` 在进程内记录该入站会话的精确搜索历史和工具契约指纹。后续回合仅追加普通消息、指纹不变时，首跳直接复用既有修复，不再重复发送已知失败的历史。首次遇到、内容改变、新增搜索、不同会话或执行上下文均原样尝试；修复失败不记录。已知修复后来仍被拒绝时，返回真实错误并丢弃记录，不重发同一份展开体。

记录只保留指纹，不保存历史正文；最多 512 项，空闲 1 小时失效，与 Anthropic cache TTL 无关。Node 重启后重新学习，因此首个携带旧历史的请求仍可能经历一次 400 → 修复 → 200。无需数据库迁移，不修改生产 persona、凭据、容器或 kernel/CLI。

## thinking 历史与签名

出站前 `stripInvalidThinkingBlocks` 保留可回放的历史思维块：

1. `thinking` 即使文本为空，只要有完整签名也保留；这是 `display: omitted` 的正常响应形态。
2. Opus / Sonnet / Haiku 5.5 按 sub2api：非空且非 dummy 的签名都算有效，不看长度；`redacted_thinking` 有 `data` 就留，没有 `data` 时再看签名。历史里只要有一块无效，整段 thinking / `redacted_thinking` 都拆掉，只留正文；拆完没有内容的轮删掉。全部有效时不拆。
3. 更早的型号仍逐块过滤：签名短于 24、空签名、dummy 签名删掉，合法签名块留下。`redacted_thinking` 不看 `data`，只在签名达到 24 字符时留。
4. 保留路径（cli-hop 首跳，以及默认 HTTP hop）不走上面的拆链，只在 `stripInvalidThinkingBlocks` 的这一支里处理：`redacted_thinking` 不看 `data` 和签名，原样留。`thinking` 只有签名可用（非空、不少于 24、非 dummy）才留，空正文也留；缺失、空、短于 24、dummy 的删掉，不再补 `signature: ""`。不走保留路径时，`redacted_thinking` 仍按上面第 2、3 条删。当前没有按账号归属过滤签名的步骤。

HTTP hop 与 cli-hop（`prepareCliHopBody`）共用内容预过滤，但缓存职责不同。cli-hop 首跳保留签名可用的 thinking 指纹，没有可用签名的删掉；签名修复重试才清除其余块。官方家族开启 `official_cc_passthrough` 时，Node 保留 system/tools/messages 的 caller marker、显式 TTL、缺失 TTL 和位置，不添点、不裁剪；超过四点、thinking marker、非法 TTL 或 5m（含缺失）后出现 1h，在调度前返回 `400 invalid_cache_control`。

关闭透传或非官方请求仍按所选人设组装。保留的 caller marker 不再统一改写 TTL：显式 `1h` 保留 `1h`，显式 `5m` 保留 `5m`，合法的 `1h → 5m` 各自保留；省略 TTL 的已有 marker 保持省略，语义为隐式 `5m`。HTTP hop 的 `preserve_client=true` 也保留已有 message marker；无 message marker 时，才按配置补最后消息及 `messages.length>=4` 时倒数第二 user 的点。

平台新增的缺省 marker 使用入站会话 pin 值（菜单选 `5m` 且请求没有另选时，新增点使用 `5m`），不覆盖 caller 或模板显式 TTL。按 `tools → system → messages → 顶层自动缓存` 检查顺序；Node 整流只把非法 TTL 修正为本次缺省值，并把 `5m`（含省略 TTL）之后非法出现的 `1h` 降为 `5m`，此前合法 marker 不动。模板自产点仍遵守剩余预算；非法模板返回 request-scoped 400，零上游执行，不换号、不冷却。

识别为官方 Claude Code 家族但未开 `official_cc_passthrough` 时，请求与第三方一样先剥离成标准 Anthropic 结构，再按槽位档重写 system；识别本身不再保留入站 system。人设组装保留下来的 caller marker 适用上述 TTL 规则，不再把缺失 TTL 当作菜单选择后补齐。只有协议页打开透传，官方家族才跳过剥离与重写，按前文 `official_cc_passthrough` 的规则处理。入站请求头不能跳过剥离。

native CLI 对已有缓存 marker 的 wire system 直接保留块边界、显式 TTL 和省略 TTL，wire tools / messages 同样保留。仅对 CLI 自有 marker 补 TTL，优先请求显式 TTL（混合时 5m）→ slot `kernel.json.default_cache_ttl` → 1h，并按保留内容占用后的剩余预算裁剪。Rust kernel 不增删 marker、不重打 last、不自动降级 TTL。HTTP hop 与 native envelope 的日志/计费保留上游真实 5m/1h 分桶；仅缺少分桶的用量或 message_delta 超过既有分桶的增量使用缺省 TTL 归类。Node 对象不等于最终 wire，源码验证也不等于已发布或部署新 CLI 二进制。

长度够的签名原样转发，由 Anthropic 验。5.5 的非 dummy 签名在非保留路径原样转发，不按 24 字符预过滤；保留路径仍要求不少于 24。签名是 opaque 加密内容，当前模型 / 账户 / 会话前缀不匹配时可能被丢弃或返回 400 `Invalid \`signature\` in \`thinking\` block`。网关不伪造真实签名，也不给缺签名的块补空字段。切换账号时不改写已有签名；`cli-node` 仍按现有登录 / fallback 逻辑清理签名块。

`routing.failover.signature_repair=true`（设置页「探测 → 签名修复」）才走 `signature_repairable` 的 `repair-and-retry`（剥 thinking 历史 + 删 `body.thinking` 后重试一次），客户端只看到 200。关闭时包括 cli-hop 在内都原样透传 400；`cli-node` 自身行为不受该面板开关改变。

`routing.compatibility.thinking_display` 默认 `summarized`（设置 → 协议 → thinking 显示；缺省即开，显式 `passthrough` 关闭）。只改已经打开的 thinking（`adaptive` / `enabled`）：`omitted`、`updates`，以及 Opus 4.7+、5 系列、Haiku 5.5、Fable、Mythos 上没写 display 的请求，出站改成 `summarized`。其它值、`disabled`、没开 thinking 不动。改写在 beta 计算之前，所以被改掉的 `updates` 不再带 `thinking-display-updates-2026-08-18`。`passthrough` 时 `updates` 仍只在出站 beta 声明该 token 时保留，否则降成 `omitted`。分类器请求不经过这条出站改写。

## Codex 模型与运行环境

Codex 目录客户端 `auto` 跟随官方 npm 发布；网络不可用且没有缓存时使用已核实的 `0.167.1`。推理 UA 单独配置，新安装的默认画像同步到该版本，不覆盖已部署机自定义 UA。内核保留所选画像的 originator/version，忽略下游伪造的身份与设备证明头。

GPT 模型以账号返回的 `/backend-api/codex/models` 为准，6.2 等新增 ID 不在网关改名，也不按型号猜测能力、可用性或价格。同步发现的新 ID 沿用默认关闭，管理员启用后才调度。静态回退目录补齐官方参考目录中的 `gpt-6-astra`、`gpt-6.1-sol`、`gpt-6.1-terra` 与 `gpt-5.6-sol/terra/luna`。Responses、Chat 和 Completions 的 `ultra` 推理档位原样保留；Completions 也保留显式 `reasoning` / `reasoning_effort`。槽位测试、定时计划和日志支持该档位，具体模型是否接受由上游判断。

`codex.analytics.enabled` 仍默认关闭。启用后的 `codex_thread_initialized` 使用当前槽内采集的系统、系统版本和架构，不读取内核所在控制面宿主。先执行槽位 `collect-identity`；数据不完整时不发送，不伪造环境或 CLI 工具事件。字段、队列和隐私边界见 [面板 API · OpenAI 传输与隐私](PANEL_API.md#openai-传输与隐私)。

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
| `x-kin-cache-ttl: 1h` | Node 重写模式的首次会话 TTL 选择；不覆盖 native 透传 caller / 模板显式 TTL |
| `x-kin-vm` | 仅 master：钉槽（虚拟机测试 loopback） |
| `x-session-id` 等 | sticky 键，见 `routing.sticky` |
| `x-kin-debug` / `x-kin-log` | 单请求日志模式覆盖 |
| `X-Request-ID` | 回写响应头 |

Go worker 用 trailer `X-Kin-Usage` / `X-Kin-Model` / `X-Kin-Stop-Reason` 回传合并 usage，与非流同一终态记账。
