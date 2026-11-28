# 风险审计

适用于 Messages、Chat Completions、Completions 和 Responses 的文本推理。面板入口是「风险审计」。`count_tokens` 入口（受 `routing.compatibility.count_tokens` 控制，默认关时返回 404）开启后也复用同一套前置关卡。

- **前置**：配置蒸馏、硬正则、拒答缓存、封禁和禁用工具。账号范围在这里设置，同时作用于适用的前置规则和 Jev。
- **Jev**：配置决策模型、评分和降级放行，查看模型调用用量。
- **状态**：默认打开，查看今日计数、拦截流水、封禁记录、上游 HTTP 400 与放行统计。

## 请求怎么处理

1. 读取入站身份，先检查设备／会话封禁、指定工具和拒答缓存。系统提示词改写默认开启，可在「前置 → 拒答与封禁」关闭；开启时命中返回不可自动重试的 400，不调用 Jev 或推理上游。
2. 在启用范围内执行蒸馏和硬正则规则。它们仍使用已经配置的开关、例外和规则；蒸馏维持可配置错误，普通硬正则返回 `policy_blocked`。Jev 不参与这些硬规则。普通硬正则的关键词命中只拒绝本次请求，不封设备、不封会话（与改写规则同一理由：正常文档会引用 `keygen` 这类子命令名，真实越狱仍会被上游拒绝并进入拒答缓存）；NSFW 类别证据确凿，维持强制封禁。
3. Jev 只收到用户会话和可解析的内联文件文本，包括纯文本和 UTF-8 base64 文本。不发 system／developer、助手历史、工具声明、调用、返回、环境或二进制文件；不按 URL 或文件 ID 拉取。最近的用户输入在截断窗口内优先保留。审核服务不可用时沿用失败放行开关；关闭时返回 503，不计违规。
4. 上游明确出现 Usage Policy、内容拒答或已配置的策略短语时，写入拒答缓存，供下次前置拦截。带附件的请求仅做精确匹配，指纹包含附件，避免把不同文件的同一句问法一起拦下。明确标记会话时封会话，不把当时可能无害的正文加入全局指纹库。普通 `api_error`、400 参数错误、认证和限流不计入设备违规，也不污染全局拒答指纹。
5. **上游 HTTP 400 / 500 三档分类与 10 分钟会话封锁**：请求在完成 failover / 网关侧修复重试后，若仍以真实上游 400、跨多槽位 5xx 毒请求（422 `poison_abort`）或终态 5xx 结束，统一经 `classifyUpstreamErrorForSessionBlock` 执行三档清洗分类（受「封锁拒答会话」开关控制，默认开，不受拒答缓存总开关与设备封禁开关影响，绝不降级已有永久会话封禁）：
   - **第 1 档 · 立即封锁 10 分钟（1 次即封，`upstream_error_action=session_10m`）**：重复同会话不可能自愈或已跨槽位证实有毒的错误，包括 `policy_refusal`（降级/未开永久封禁时的上游内容或使用政策拒答；明确违规仍维持永久封禁+设备记过）、`third_party_client`（第三方客户端 Extra Usage 拒绝）、`state_reference_invalid`（失效的 `previous_response_id`/Item/Conversation/Thread 引用）以及 `poison_abort`（Rust 调度器证实跨多健康槽位连续触发 5xx 的毒请求，写入 `upstream_500:poison_abort`）。
   - **第 2 档 · 容忍自愈 1 次，5 分钟内连续 2 次封 10 分钟（第 1 次记 `strike_1_of_2` 放行，任意 HTTP 200 成功立即清零；连续第 2 次写入 `session_10m`）**：客户端修正参数、压缩上下文或修复历史后可同会话恢复、但死循环客户端会持续打上游的错误，包括 `context_too_long`（`prompt is too long` / 上下文超限，允许 `/compact` 后同会话重发一次）、`param_range_invalid`（`max_tokens` / `max_output_tokens` / 采样参数超限或不支持）、`beta_or_header_invalid`（非法 `anthropic-beta` 请求头）、`tool_pair_broken`（`tool_use`/`tool_result` 或 `functionCall`/`functionResponse` 配对损坏）、`thinking_history_broken`（Thinking/Reasoning 签名或块损坏）、`search_or_cache_invalid`（搜索加密块或 `cache_control` 非法）、`media_invalid`（图片/PDF/文档超限或损坏）、`message_structure_invalid`（角色顺序错乱或空消息）、`tool_schema_invalid`（工具 Schema/参数校验失败）、`unknown`（经排除项清洗后的其他 400）以及 `internal_server_error`（耗尽 failover 换号后最终仍返回真实上游 HTTP 500，写入 `upstream_500:internal_server_error`）。
   - **第 3 档 · 清洗排除，绝不封锁会话（`upstream_error_action=skipped`）**：非会话责任的账号、渠道、网关与上游基础设施故障，包括 400 排除项 `account_disabled`、`auth_credential`、`billing_credit`、`model_unavailable`、`gateway_local`、`auto_mode_classifier`，以及 5xx 排除项 `upstream_502_bad_gateway`（502 断流/截断/代理故障）、`upstream_503_unavailable`（503/`slot_busy`/`scheduler_unavailable`）、`upstream_504_timeout`（504/408 超时）、`upstream_529_overloaded`（529 过载）、`worker_local_5xx`（本地 Worker 进程退出或连接中断）。
   - 封锁期内同一租户下的同会话（含子 agent）在前置关卡直接返回不可重试 400（带 `x-should-retry: false`）并递增 `hit_count`，不伤及同设备其他会话；10 分钟后自动解封。

改写规则只认对模型下的「作废系统提示词」指令：忽略／无视／绕过／覆盖（你的、之前的、上面的…）系统提示词，ignore / disregard / override / bypass your (previous) system prompt，以及「把你的系统提示词改成…」、rewrite your system prompt with …。文档和 skill 里讨论 system message、「修改系统提示词的配置」这类陈述句不算。命中只拒绝本次请求，不封设备、不封会话。合法的 `system` 块、模型身份句和「不要改写系统提示词」本身不会命中改写规则。若后面另有独立的「改写系统提示词」指令，且该开关开启，整条请求仍会被拦；客户端提供的 `<system-reminder>` 包装不是信任凭据。只想验普通推理时，发送 `pong` 用户消息，不附带改写指令。

账号范围和 API 渠道审核开关继续控制蒸馏／类别正则／Jev 的覆盖。持久封禁、拒答缓存和禁用工具不因账号范围或渠道切换而跳过。系统提示词改写只受自己的开关控制。配置适用的降级目标后，同平台的审核提前到选槽前，不再等待具体账号；未配置时保留按账号审核。

## 设备与会话

- `metadata.user_id` 支持 JSON 字符串、对象和旧版组合串。`device_id` 和 `machine_id`（兼容 `meachine_id`）属于同一种设备标识；违规时同时提供的首次关联至同一条记录，之后只携带其中一个也共用次数。不自动合并已经独立累计的两条记录。`session_id` / `session` 是入站会话，不取网关重建的出站值。
- 新封禁按认证用户隔离；没有用户 ID 的托管密钥按密钥记录隔离，平台请求用平台域。同一用户的两把密钥不会分出两套计数。没有设备或会话字段的第三方请求照常过适用规则，不用 IP、UA 或密钥假造设备，也不写设备／会话封禁。
- 默认第 1 次封设备 10 分钟，第 2 次封 24 小时，第 3 次永久。违规会话从首次命中起持续封锁，直到管理员解除。拦下重试不增加违规次数。定时封禁到期后保留次数；历史永久封禁不自动解封。
- 「前置 → 拒答与封禁」可选择常用时长和工具，必要时自定义。阶梯时长递增，最终为永久；同一策略可添加多个精确工具名。高级短语只补充明确拒答，不将 `API Error`、`400 错误`、`session` 等通用词直接当成违规证据。

## 放行与指标

先按 Jev 的 `noul` 阈值判拒绝，保留既有单项非 NSFW 近失带。通过后，以最不安全的有效分数到阈值的非负距离作为安全分差；默认高分安全时是 `max(0, min(noul) - threshold)`，反向评分时相应反转。

| 决策 | 默认安全分差 | 目标 |
|------|---------------|------|
| 模型降级 | ≤ 0.05 | 指定同平台模型，仍受密钥和槽位模型限制 |
| 路线降级 | ≤ 0.15 | OAuth 限于指定账号池与原授权的交集；API 限于指定同平台渠道 |
| 常规放行 | 其余 | 保留原模型和调度 |

阈值可配置，先检查模型降级，再检查路线降级。选择器从现有账号池、API 渠道和模型目录读取：每种目标独立选择一项，无需手填 ID。空目标跳过对应降级；选中但目标不可用时返回 503，不回退原路线。无有效分数、未审核或失败放行不触发降级。

## 查证据

- 封禁列表显示原因、次数、到期状态、触发会话和原请求入口。详情始终遵守原日志保留策略：有 debug 采样才有原始头／体，没有则展示已有摘要。
- 「上游 HTTP 400」独立于入站拦截，并显示原上游错误、入站设备／机器与会话。新字段不猜测历史 HTTP 状态；一次请求经过重试仍只显示一条记录。
- 「状态 → 降级放行」按实际发起上游请求的降级目标计数，不把未能调度的判决当作已出站。
- Claude Code `2.1.321` 的 `outbound-summary.json` 可核对模型、工具、系统块结构与缓存标记，但没有系统块全文或入站身份。不要用摘要判定某句话来自官方，或将其当成网关最终出站请求。
