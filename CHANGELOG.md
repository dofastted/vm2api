# Changelog

## 未发布

## 1.3.199 — 2026-10-19

- 修复集群槽位凭据 pull 时 bytes 相同仍回填 VM 元数据；已运行容器不重建；节点凭证不被旧副本覆盖；原手动禁用 / 撤销 / 冷却保留。（#589）
- 测试：CRS 出站拒绝 `cc_gateway` 与 `x-claude-code-wiggly-dove` 回归锁。（#590）

已部署机升级：仅需更新 Node 控制面并重启；对受影响集群槽开机一次即可回填元数据；不必重建槽；不要更换 kernel/CLI；无迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.198 — 2026-10-19

- 一键更新和 `wrap-cli/sync` 同时更新集群槽：控制面拿到新的 kernel、cli-node、cc-node 与 Go `kin-worker` 遥测后，按节点和内核重建内容哈希镜像，再换容器。更新时可选保留原数据或重建新特征；不传时保留。Codex 槽不参与。本地槽仍只换挂载文件并重启进程。crag 数据面的集群槽仍拒绝。槽位页「重装 kernel」对集群槽走同一条路径。（#583）
- 槽位重建增加两种方式：保留原数据（凭证、指纹、主机名、machine-id、统计）或重建新特征（清家目录并重新生成计算机身份）。列表、详情和重装 kernel 都要先选。（#583）
- 同一出口的 kin-egress 启动串行化；等待端口释放不再阻塞事件循环（续 #562）。（#578）
- slot-guest-bin 任意 link 失败都退回复制，并暂存符号链接的真实文件（续 #569/#572）。（#579）
- sealClaudeCodeCch 只密封 system 计费头，不改写提示词中的同名字面量，也不因提示词字面量报错。（#580）
- 去掉已保存内置模板上旧默认自带的 `scope: global`（续 #536）。（#581）
- 面板日志导出与备份下载补 CORS，预检允许 Idempotency-Key（续 #529）。（#582）

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。集群需一键更新或 `wrap-cli/sync`（keep）刷新镜像并为 **running** 槽换容器；无迁移，不必单独重建槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。（traits 重建可能启动已停机的本地槽；集群 `restart:false` 时 kernel_changed 为硬编码，详见 Release notes。）

## 1.3.197 — 2026-10-19

- 修面板 billingStats：大 usage 库慢聚合时缓存 TTL 改为聚合完成后起算，避免刚写入即过期；复用 costByAccount 汇总全局 total/today 减少全表扫描（#576）

已部署机升级：仅需更新 Node 控制面并重启；不必重建槽；不要更换 kernel/CLI；无迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.196 — 2026-10-19

- 面板 billingStats 10s 进程内缓存（按账号窗口签名）+ backfillMissingCosts 60s 限频，缓解大 usage_logs 库控制台卡顿（#574）

已部署机升级：仅需更新 Node 控制面并重启；不必重建槽；不要更换 kernel/CLI；无迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.195 — 2026-10-19

- 修复控制面跨挂载时 slot-guest-bin 复制分支用 size+mtime 误判「已最新」：同大小新二进制改为 size+sha256 比较，复制只保留权限位、不再回写 mtime。（#572，续 #569）

已部署机升级：仅需更新 Node 控制面并重启；不必重建槽；不要更换 kernel / CLI；无迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.194 — 2026-10-19

- 修复 #514 的槽位 bin 目录：移到 `data/run/slot-guest-bin/`（原 `run/` 不在控制面 compose 挂载内，只存在于控制面容器里，宿主侧是空目录，槽内挂进来是空的）；条目改为硬链接（跨挂载时复制）并以 rename 原子替换，不再是指向宿主绝对路径的符号链接（槽内只挂载该目录，符号链接悬空导致 `kin-worker`/`kin-kernel` not found）；控制面启动时刷新目录；不传 kernel 的槽不再删除共享目录里的 `kin-kernel`；`containerHasKernelMount` 识别目录挂载。（#569）

已部署机升级：更新 Node 控制面并重启；**仍挂旧路径 `run/slot-guest-bin/` 或旧单文件挂载的槽须重建一次**；已对新路径硬链接的槽重启控制面刷新即可；不要更换 kernel / CLI；无迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.193 — 2026-10-18

- 修复客户端取消推理后仍在同一 VM 上重建出站 Session 的问题：取消只终止当前任务并释放请求占用，保留出站 Session 与席位绑定；跨 50 / 100 次请求不会按次数换代。换 VM、凭据失效和空响应恢复规则不变。此项仅需更新 Node 控制面并重启，不需要更换 kernel / CLI 或重建槽位。（#568）

已部署机升级：仅需更新 Node 控制面并重启；不要更换 kernel / CLI，不必重建槽位，无迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.192 — 2026-10-18

- 管理→连接支持编辑已接入节点名称与 SSH 配置：先测后存、有槽禁改用户、忙碌拒绝切换，凭证不回传。（#559/#560）
- kin-egress UDP DNS 接收缓冲扩至 65535 字节；上游解析失败时与 TCP 一致向客户端返回带原 ID 的 SERVFAIL，避免 UDP 请求空等超时。（#531）
- 设置 → 协议新增统一 CCH 开关（`compatibility.cch_enabled`，默认开）：开启则缺失也补并在最终请求体计算真实五位摘要；关闭仍固定写入 `cch=00000;`（5 个 0），不重新密封。不按试用 / 订阅状态分流，密封不改提示词中的同名字面量；固定 billing 参数策略和 296 / 293 两套标准 UA 不变。
- 设置 → 协议集中提供原生 sticky 槽空闲超时（`inference.session_idle_ttl_seconds`，默认 600 秒，范围 1–86400 秒），账号池不再重复显示：kernel 热读，基于最后任务完成时间回收，活动任务不回收；不复用账号绑定 TTL，不因保存设置重启 kernel / CLI。
- 修复内置 `official_full` / `official` 模板自动生成 `cache_control.scope=global` 导致上游参数级 400；Node、预览与旧模板 agent 回填一致移除自产 scope，保留调用方 / 自定义显式字段，不增加重试或换号。（#536）
- Claude kernel / CLI 依赖固定到不可变快照 `payload-2026.10.18-cch-sticky`；Codex kernel 与其余原生产物保持不变。
- 重载 kin-egress 时先 SIGTERM 并等待旧进程退出（超时 SIGKILL）且监听端口释放后再启动新进程；spawn 失败返回明确错误。（#530）
- 跨源管理台/API（`credentials: include`）在配置的受信 Origin 上回显 `Access-Control-Allow-Origin` 并启用 `Access-Control-Allow-Credentials`；未列入 `PANEL_CORS_ORIGINS` / `PUBLIC_BASE_URL` 的 Origin 仍为 `*`，不带 credentials。预检与 JSON/SSE 统一允许 `PATCH` 与完整 header 列表。（#529）
- KVM / Docker 槽位改为挂载宿主 `run/slot-guest-bin/`（仅含 `kin-worker`、`kin-kernel`，不暴露整个 `bin/` 里其它 helper），避免单文件 bind mount 在升级替换二进制后容器内仍粘旧 inode；**已用旧单文件挂载创建的容器须重建一次** 才能切换到 staging 目录挂载。（#514）

已部署机升级：更新 Node 控制面、web/dist 与配套 Claude kernel / CLI ELF（`payload-2026.10.18-cch-sticky`）；本机槽按正常流程排空后同步并重启；镜像内置 payload 的集群槽须新镜像并单独授权重建。#562 重载 egress 行为随 Node 重启生效。跨源管理台/API 若需带凭证，请配置 `PANEL_CORS_ORIGINS` / `PUBLIC_BASE_URL`（#529）。**仍用旧单文件 bind mount 创建的槽位容器须重建一次** 才能切换到 `run/slot-guest-bin/` staging 目录挂载（#514）；重建后升级 worker/kernel 不必再重建。#536 默认模板修复本身只需更新 Node / 前端。Go 服务标准 UA 不变，无新依赖或数据库迁移；保留 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.191 — 2026-10-18

- `deploy/install.sh` 的 schedule hold/resume 内联 Python 兼容 3.8–3.11，避免旧宿主升级时 SyntaxError。（#535）
- access 已过期且刷新失败的凭证退出调度池；GPT 上游失败施加进程内短期账号冷却（401/403 5 分钟、429 1 分钟、408/5xx/传输 30 秒），与换号上限协同。（#537）
- 修复未配置 PUBLIC_BASE_URL / PUBLIC_HOST 且 HOST=0.0.0.0 时 /health、/v1/meta 返回不可访问的 base_url；监听地址不再作为对外 URL 回退。（#534/#543）
- GPT/Codex 默认同账号重试 3 次、最多换号 3 次（401/403/429 直接换号；总尝试仍为 12；首条 SSE 发出后不再重试）。已有 `routing.json` 里写过 `failover` 字段的部署，仅重启不会自动变成上述新默认，须在面板「重试与切号」修改或手动合并配置。（#538）
- 修复 API 后端非流式路径在上游 SSE 仅有 `message_start`、或仅有 `stop_reason` 而无 `message_stop` 时仍返回 200 的问题；须见到 `message_stop`（或 SSE `error` 终态）才视为 verified，否则 `incomplete_response`（502）。（#528/#550）
- 修复新建 KVM 槽位因 kin-computer 空 UUID 被写成 `qemu -uuid -` 而崩溃：控制面校验指纹 UUID、坏档案重生成，并在启动前强制回填合法 RFC4122 UUID。（#513/#541）
- 默认控制面镜像在 helpers 阶段编译并落地 `kin-api-kernel`，入口脚本同步刷新该二进制；缺失或无法就绪时在启动阶段失败，避免 API Endpoint 请求才报 `api_kernel_transport`。（#527/#549）
- 修复删除租户后已分配 VM 残留 `owner_user_id`、无法回到公共号池参与额度切号的问题：删除时收回管理员分配的 VM，启动时补修已删除用户的旧记录；租户自建 VM 保持隔离，调度开关、额度冷却与凭证不变。升级只需更新 Node 控制面并重启，无数据库迁移或槽位重建。（#557）
- 面板会话在 `verifyPanelSession` 成功时滑动续期：剩余有效期不足一半（7 天 TTL）时写回 `exp` 并持久化；控制台请求 `/api/panel/*` 若返回 401 则清本地登录态、跳转登录页并提示「登录已过期」。（#516/#553）
- Anthropic 控制台「全部测试」按后端返回的行号绑定结果，空密钥行不再把其它行的测试结果错位显示。（#532/#554）

已部署机升级：更新 Node 控制面与 web/dist 后重启；升级脚本请同步 `deploy/install.sh`（#535，支持 Python 3.8–3.11 的 schedule hold/resume）。使用默认控制面镜像的部署须重建或更新镜像，使 helpers 阶段编译的 `kin-api-kernel` 落地且入口脚本刷新该二进制（#527/#549）；缺失或无法就绪时控制面会在启动阶段失败，而非等到 API Endpoint 请求才报 `api_kernel_transport`。Codex/GPT：默认同账号重试 3 次、最多换号 3 次（#538）；已在 `routing.json` 中写过 `failover` 字段的部署仅重启不会自动套用新默认，须在面板「重试与切号」修改或手动合并配置。另 #537：access 已过期且刷新失败的凭证不再参与调度，GPT 上游失败会施加进程内短期账号冷却（401/403 5 分钟、429 1 分钟、408/5xx/传输 30 秒），与上述换号策略一并生效。无数据库迁移；不必 wrap-cli/sync；不必重建槽位。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.190 — 2026-10-18

- 增加 Responses WebSocket 入口及全局/GPT 两级推理 WS 开关；关闭 WS 不关闭 HTTP/SSE，也不影响终端/集群连接。每轮复用原鉴权、范围、调度、日志与计费链路；连接内续接回放完整历史，未知 ID 明确要求全量重放，不伪造原生上游连接复用。
- 设置新增独立 OpenAI 页面，调度与槽位导航均指向它；集中 GPT 协议/客户端准入、配额/并发/RPM/会话容量、目录版本和上游传输/UA，移除原页重复 GPT 控件。
- Codex kernel 增加每请求传输与画像选项，修复取消后上游仍等待的问题。安装 UUID/client_metadata 和独立运行环境 Analytics 各自可选、默认关闭；Analytics 使用官方 `codex_thread_initialized` 结构并标明 vm2api 来源，沿用槽位出口，不上传提示词、文件、主机名或 MAC。字段与边界见 [PANEL_API.md](docs/PANEL_API.md#openai-传输与隐私)。

已部署机升级：更新 Node 控制面、web/dist 与 Codex kernel ELF。已有宿主 Codex kernel 须排空在途请求后随 Node 一次重启加载新二进制，不必重建 GPT 容器。Anthropic kernel / CLI 不变，不必 wrap-cli/sync。既有 `routing.json`、`vms/`、`data/`、`.env` 不覆盖；安装元数据与 Analytics 默认关闭。nginx 的 `/v1/responses`（或 `/responses`）必须保留 Upgrade 并直连 Node。无新依赖或数据库迁移。

## 1.3.189 — 2026-10-18

- VM 详情页按角色收起无权限的查询与按钮，租户与 super 不再反复弹「当前权限无法执行此操作」；切换槽位重置页面状态（代理选择、测试结果、时区、凭证输入）；账号页与概览「今日」改用当日计数；开机 kernel 未就绪时给出警告，关机提示会关闭调度；确认框回车不再重复提交；各按钮单独显示进行中；内存提升弹窗重置目标档位。（#521）
- 面板其它页面：Anthropic 控制台保存已有地址只提交变更字段，不再覆盖模型、名称与代理；代理池、顶栏与计费页按角色隐藏无权限操作，租户计费不再把 GPT 费用算进 Claude；全槽更新与数据面切换部分失败时显示逐槽明细；风控与模型页不再冲掉未保存草稿，「恢复默认」需确认；日志导出遵循当前筛选；系统提示词页只回写 compatibility；Key 额度用完显示「额度用完」；禁用代理前确认；若干失败误报为成功的提示改为如实报告；健康缓存间隔输入不再逐键钳制。
- 修复集群节点上的槽被 kernel 看门狗每隔几分钟重启：节点槽改经本地中转探测 kernel（超时 3 秒，跨洋往返约 110ms 时 800ms 会误判）；中转未就绪时只在容器确实缺失、停止或重启中才拉起；节点槽启动后写回中转 socket 路径。
- 定时测试「同步到全部槽」改为整块复制：启用开关、频率、时刻/分钟、星期、时区、模型、Prompt、token/effort；Claude 与 Codex 互为另一类的槽只同步开关与时间，保留各自模型与 Prompt；请求先整体校验，不会写一半。定时测试表单每 30 秒刷新，外部修改在未编辑时自动载入，编辑中给出提示而不再静默覆盖；切换槽位重新载入。

已部署机升级：更新 Node 控制面与 web/dist 后重启；无迁移、不必 wrap-cli/sync，不必重建槽位 / 无新 kernel payload。不要覆盖 `routing.json`、`vms/`、`data/` 或 `.env`。

## 1.3.188 — 2026-10-18

- 修复同一会话反复回放已被上游拒绝的搜索历史时，每轮都先 400 再修复成功的问题：仅在同 VM / 账号 / 模型 / 凭据代际确认修复成功后，进程内有界记录精确历史指纹，后续相同历史首跳复用原修复；新搜索内容或执行上下文不预先改写，不改变占位释放、出站 session、缓存 TTL 或签名修复开关。
- 设置 → 协议新增「默认缓存写入 TTL」，可选 5 分钟（`5m`）或 1 小时（`1h`）；复用已有配置保存与槽位热投影，不改变断点布局、透传边界、显式 TTL 或会话 pin 规则。
- system 提示词关闭「Environment」时，统一停止生成环境 / 时区宏，直接省略环境块；官方完整档也可关闭。保留调用方提供的 Environment 与时区，避免 native 预处理误删或 HTTP 槽位选择后覆盖；预览、保存和最终线序按档一致。
- 对齐 Claude Code `2.1.296` 的面板出站身份与 CLI 运行时版本投影，避免新 CLI 被旧 `CLAUDE_CODE_VERSION` 降回 `2.1.293`。
- native 官方透传同时保留 system/tools/messages 的 caller cache marker、显式 TTL 与缺失 TTL；超四点、thinking marker、非法 TTL / 顺序在调度前报 `400 invalid_cache_control`，不静默修复。
- native 重写模式只补齐、裁剪自产 marker，保留模板显式 TTL；非法模板零上游执行，不换号、不冷却。日志和计费保留上游真实 5m/1h usage 分桶。
- CLI 保留带 billing 的官方 / 子代理 wire system，不再要求 SDK identity 才能透传；原生工具预算只保护调用方前缀，保留其显式 TTL 和缺失 TTL。
- GPT 槽在 TTL（10 分钟）内有可用 credits（`has_credits || unlimited`）时仅豁免窗口 cap；显式 park 仍优先；上游 429 清除 credits 并 park。（#508）
- 修复 KVM 交互终端：交互/非 detach 不再包 `timeout 8`（仅保留 SSH ConnectTimeout）；`-e` 按次独立转义，保留值内换行（含 `KIN_PANEL_RC`）。（#509）
- Claude Desktop local-agent（UA 含 local-agent 与 agent-sdk、平台 desktop_app、合法 anthropic-client-version）不再仅凭 cc_entrypoint=local-agent 判成 OMP，避免 claude_code_only 误 403；OMP 专属与 body-only relay 仍保守。（#511）

已部署机升级：搜索历史修复本身只需更新 Node 控制面并重启，不需要同步或重启槽位。要启用本版 2.1.296 的完整 native 缓存契约，还需安装相应 kernel / CLI payload；本机槽定向同步，镜像内置 payload 的集群槽需要新镜像和单独授权重建。已安装 kernel `98357559…` / CLI `244ef884…` 的槽无需重复更新。不要覆盖 `routing.json`、`vms/`、`data/` 或 `.env`。

## 1.3.187 — 2026-10-17

- 更新 Claude kernel：保留未知消息块，以及已知类型中的扩展字段（如 thinking 绑定、引用和工具调用来源），不再在传给 CLI 时静默丢弃；扩展 tool_result 仍参与 continuation ID 校验和大小限制。
- Anthropic 流式 `event: error` 经 `mapUpstreamError` 重映射，Usage Policy 与 non-stream 一致为 `policy_blocked` / `refusal_guard`。（#503、#505）
- 修复网关流路径忽略 `KIN_STREAM_IDLE_TIMEOUT`：与面板 `failover.stream_idle_timeout_ms`、`kernel.json` 同步走同一级联（面板 → cfg.limits → 环境变量 → 默认 180 秒）。（#485、#506）

已部署机升级：更新 Node 控制面及 kernel payload；本机 Anthropic 槽在排空在途请求后同步并重启 kernel。集群节点使用镜像内置 kernel，须构建新槽位镜像并通过重载重建对应容器。已安装相同 kernel 哈希的槽无需重复替换。本次无新依赖或数据库迁移，不修改 Codex kernel；不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.186 — 2026-10-17

- `kin-computer` 改为 Ubuntu 22.04 / GLIBC 2.35 基线。Ubuntu 22.04、Debian 12 与 Ubuntu 24.04 均可创建 Docker / KVM 身份；已有槽位身份不重算。

已部署机升级：更新控制面镜像，或更新 Node 控制面并执行 `npm run fetch:payload`。不必 `wrap-cli/sync`，不必重建槽位容器。已有计算机身份不变；不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.185 — 2026-10-17

- 一键升级先只读检查槽内 kernel。字节没变且没有待重启标记时，不停调度、不重启。有变化时暂停当前可调度槽，等在途请求结束，再复制并重启变化的槽；crag 与 wrap 都按字节变化重启。
- 排空超时会恢复这次暂停，不留下整池停调度。重启失败的槽保留待重启标记，下次升级继续重启，健康启动后清除。手动关闭的槽不动。

已部署机升级：执行 `deploy/install.sh upgrade`。kernel 没变化时只重启 Node。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.184 — 2026-10-17

- kernel 保留 `redacted_thinking` 的签名；原来没有 `data` 时不再回写成 `null`。交付仍是未压缩动态 ELF。槽内用 bundled `ld-linux` 加载，整包 UPX 会被拒绝。更换后需要 `wrap-cli/sync`。

已部署机升级：更新 `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin`，执行 `wrap-cli/sync`（`restart: true`）。不必重建槽位容器。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.183 — 2026-10-17

- Opus / Sonnet / Haiku 5.5 的出站过滤对齐 sub2api：历史里出现一块无效 thinking，整段 thinking 与 `redacted_thinking` 都拆掉，只留正文；拆完没有内容的轮删掉。没有 `type` 但带 `thinking` 字段的块也算无效。`redacted_thinking` 有 `data` 就留，否则看签名；非空且非 dummy 的签名不再按 24 字符丢弃。全部有效时不拆。cli-hop 首跳和默认 HTTP 保留路径不变。更早型号仍逐块过滤，`redacted_thinking` 只在签名达到 24 字符时留。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，不必重建槽位容器。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.182 — 2026-10-17

- 代理地理可选 `KIN_PROXY_GEO_V6_LOOKUP_MODE=control-plane`：IPv6 探针仍经代理取真实出口，元数据查询走控制面默认路由；修正默认 IPv6 指定地址 URL（`/json/{ip}`）；仅显式开启且默认主查询传输失败时回退，并校验服务商返回 IP 与已验证 IPv6 一致（含缩写/展开）；默认 `proxy` 两阶段仍经代理。启用方式见 `docs/PANEL_API.md`。（#492、#307）
- 远程 Claude Docker 槽改用镜像烘焙 kernel 入口（`/opt/kin/kin-kernel`，`REMOTE_KERNEL_ENTRY`），不改 GPT 与本机/KVM 命令；新建或重建容器后生效。（#489、#496）
- 修复 Codex 返回配额耗尽（如 `usage_limit_reached`）且无利用率响应头时仍展示过期低用量：作废该槽未达上限窗口的过期利用率缓存，面板显示为未测量（`—`），保留新鲜测量与已封顶窗口；通用限流与成功无头响应行为不变。（#474、#487）
- `docker/kin-kvm/fetch-cloud.py` 在调用 `qemu-img` 前校验源路径为常规文件且非符号链接，收紧路径处理（CWE-78 防御加深）。（#471）
- 用量探测可选 `usage_probe.reset_delay_sec` / `reset_jitter_sec`（各 0–3600，默认 0）：在已知 Extra 5h reset 后，将已到期的周期探测推迟到 `reset + delay + 按账号稳定偏移`；不改官方退避、手动/事件探测与 Messages 健康监视；快照暴露待探测的 `next_probe_at`。（#488、#497）
- 内核看门狗在容器级恢复/重建前先对槽位所在 Docker 主机做有界观测（运行/缺失/已停/Restarting/暂停/unknown）；HTTP/权限/传输失败或观测超时视为 unknown，不消耗重启预算、不盲重启；确认 missing/stopped/restarting 且槽位仍为运行意图时才 revival/recreate，运行中容器仍走既有 kernel 重启；远程 Restarting 崩溃循环纳入看门狗重建；单槽异常与 tick 级 promise 拒绝互不影响。（#491）
- Docker 槽创建可选 `machine.docker_cpus`（`0` 或省略不限；`0.01`–`16` 为 CPU 时间上限）：写入槽位记录并在容器创建/重建时生效（本地 `--cpus`、集群 `NanoCpus`），KVM 与非法值拒绝；不提供在线 PATCH 或把 `vcpus` 隐式映射为 Docker 上限；损坏落盘值在 reload/恢复/重建前拒绝。（#490）
- 修复通知监控在冷却/无事件轮询时误清 `last_error`：仅在实际投递成功时清除，保留上次投递失败；解析 `dispatchNotify` 的 `ok: false` 与部分通道失败，同批次任一失败优先于成功事件。（#483）

已部署机升级：更新 Node 控制面；涉及代理地理 / 用量探测配置见 PANEL_API 与 routing。远程 Claude 烘焙 kernel 入口须新建或重建容器后生效。无新依赖，不必 wrap-cli/sync。不要覆盖 routing.json、vms/、data/、.env。

## 1.3.181 — 2026-10-17

- 采集客户机 CPU、内存、磁盘、MAC、DMI、Shell 与工具链，写入槽位特征并展示于运维页；终端启动打印实时系统特征。
- 采集后同步 worker.json 遥测配置至本机或节点，sidecar 热加载，无需重启；官方初装自动开启遥测默认关闭。

- 代理出口地理查询经 SOCKS5 时由代理端解析目标域名（查询路径内将 `socks5://` 规范为 `socks5h:`），避免依赖控制面本地 DNS；IPv4 与 IPv6 两阶段探测一致，不修改已保存代理 URI，HTTP(S) 代理与本地直连行为不变。（#482）
- 修复 KVM / Docker 槽容器处于 `Restarting` 崩溃循环时被当成运行中：`inspectContainer()` 读取 `State.Restarting`，崩溃循环的容器视为未运行，启动和重载改为重建，不再 `already-running` 短路或对重启中的容器 `docker exec`。新建槽位容器前先 `docker pull` 浮动 tag（`kin-kvm-*` / `kin-os-*`），拉取失败才用本地镜像，旧 runner 镜像可随重建更新；`docker/kin-*/build.mjs --pull` / `--pull-only` 也会刷新已存在的镜像。`kin-kvm-entry` 降权前对容器内 `/dev/kvm` 节点执行 `chmod g+rw`，兼容宿主 `0600` 权限。（#484）

已部署机升级：更新 Node 控制面、Go worker 与 web/dist；新建槽位默认关闭遥测，已有显式开关保留。无需 wrap-cli/sync 或重建槽位容器；遥测 sidecar 下次启动使用新 worker。首次从 1.3.179 升级须先安装 croner@10.0.1。不要覆盖 routing.json、vms/、data/、.env。
## 1.3.180 — 2026-10-17

- 测试链接按槽位定时真实对话（延续 #467 / REQ-0466）：面板结构化调度（每小时/每天/每周 + IANA 时区，无 Cron 文本框），SettingsRepo 持久化，到点 `runVmTestChat`；全局默认模板与「同步调度时间到全部/所选槽」（仅覆盖调度字段）。依赖 `croner@10.0.1`。（#466）
- 已有 Docker 槽可通过面板 `PATCH /api/panel/vms/:id`（`machine.memory`）或槽位详情「内存 → 提升」在线上调容器内存：先 `docker update --memory … --memory-swap …`，读回 `HostConfig.Memory` 一致后才写入 `machine.memory` / `runtime.memory`；失败不写配置。不支持降配或 KVM。（#441）
- 面板新增 admin 专用 Anthropic 控制台（`POST /api/panel/anthropic/messages`，与 VM 测试分离；经控制面转发上游，浏览器不直连）；推理路由收紧：仅 managed 且 category 为 `api` 的协议密钥走已配置的 API 上游，master key 与 `x-kin-backend=api` 不再强制 API 后端（改走 OAuth/VM）。（#478）
- 修复槽位开机成功后仍保留旧 PID、启动时间或停止标记：保存普通槽与 Codex 启动返回的运行信息，并保留等待就绪期间已写入的运行字段，避免在线升内存后 `runtime.memory` 被旧启动快照覆盖；凭证调度规则不变。（#479）
- 修复检查更新失败时被误判为「已是最新」：发布查询失败返回 `check_status: 'failed'`，`latest` / `latest_tag` / `update_available` 为 `null`；关于页显示失败标记并禁用自动升级，自动升级在发现失败时返回 502 `release_check_failed`（显式指定版本仍可用）。外部调用方需区分 `null` 与 `false`。（#480）

已部署机升级：更新 Node 控制面与 `web/dist`，安装新依赖 `croner@10.0.1`（`npm ci`），重启一次 Node。无迁移，不必 `wrap-cli/sync`。注意 #478 推理路由收紧：master key 与 `x-kin-backend=api` 不再强制 API 后端，只有 managed 且 category 为 `api` 的协议密钥走 API 上游；面板 API 变化见 `docs/PANEL_API.md`。#480 后 `/api/panel` 版本检查字段可能为 `null`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.179 — 2026-10-16

- 修复 Claude Code cli-hop 最终出站丢失 thinking 指纹：首个 hop 保留已有签名块，缺少 `signature` 字段时补 `signature: ""`，只有 repaired 重试清理 thinking 历史；`cli-node` 既有登录 / fallback 清理逻辑不变。cli-hop 不再自动开启 signature_repair，须 `routing.failover.signature_repair=true` 才同槽重试，否则签名 400 透传。（#475）
- 新增实际 kernel ELF → cli-node ELF → 本地 upstream capture 回归，覆盖已有签名、缺失字段、空 thinking 与 `redacted_thinking` 的最终 wire。
- 集群节点可以创建 GPT 槽。节点容器只保留身份和出口（`sleep infinity`，标签 `kin.vm.role=codex`），Codex kernel 仍在控制面监听 `vms/<id>/run/codex-kernel.sock`。节点选「本机出口」时 kernel 走该节点的转发，不再从控制面直连。旧的节点 GPT 容器（PID 1 仍是 kin-kernel）在下次启动或重载时重建。KVM 不使用该标签，新建后再次启动不会被重建。crag 数据面、官方 CC 初装、wrap 修复和推理引擎切换仍只在本机。（#473）
- 移除公开树中的闭源探针脚本 `scripts/verify-local-rust-slot.sh`（无运行时变化）。（#472）

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。旧节点 Docker GPT 槽下次启动或重载会按新规格重建。cli-hop / 面板首 hop 保留 thinking 指纹；签名 400 默认透传（须开启「探测→签名修复」才同槽重试）。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.178 — 2026-10-16

- 补齐 `kin-computer` 二进制交付：加入校验固定的 payload、Release 附件及控制面镜像，入口自动安装到 `bin/kin-computer`，默认不再依赖私有 `local-src/`。源码仍不公开，`KIN_COMPUTER_BIN` 可覆盖路径。二进制按 Debian 12 基线构建，避免新版 glibc 导致启动失败；不改已有槽位身份。

已部署机升级：更新控制面镜像，或更新 Node 控制面并执行 `npm run fetch:payload` 安装 `bin/kin-computer`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，不必重建槽位容器。已有计算机身份不变；不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.177 — 2026-10-16

- 调试日志容量按 `OCTET_LENGTH` 字节统计，避免多字节正文误算与同步清理读入全文。（#462）
- 修复 Claude 配额闸线弹窗在短视口下无法滚到底部（明确高度 + grid 三行布局）。（#465）

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次；无迁移、无新依赖，不必 `wrap-cli/sync`；不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.176 — 2026-10-15

- 修复 Codex 槽在 Node 重启后内核按需未拉起时误报故障：仅当 socket 无监听且本进程无跟踪子进程时诊断为警告 `codex_kernel_idle`（ENOENT/ECONNREFUSED）；超时、HTTP 错误、权限错误及已跟踪子进程不响应仍为 error `codex_kernel_down`。（#459）
- 蒸馏检测器只扫描最新用户正文并跳过工具回传；移除误伤学术知识蒸馏讨论的内置硬规则，保留套取思维链等收割规则。（#453、#456）
- 新槽位由私有 `kin-computer` 生成主机名和 machine-id；新建本机容器发布对应身份，已有容器启动时不改写主机名。控制面需单独安装该二进制并可用 `KIN_COMPUTER_BIN` 指定路径；公开镜像不包含它，缺失时建槽返回 `computer_service_missing`。集群槽镜像已存在时跳过传输；缺少云端基础系统时才拉取，母机只上传程序层。（#452）
- 修复 Claude 流式请求在 session/席位排队过久被 Cloudflare 524：延迟后下发 SSE ping 保活（短失败仍可 HTTP 429/529），已提交流用 Anthropic error 事件收尾；同会话串行增加超时上限，避免卡住占队。（#458）

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖、无 `web/dist` 变更，不必 `wrap-cli/sync`，不必重建槽位容器。新建槽需本机已安装 `kin-computer`（可用 `KIN_COMPUTER_BIN`）；不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.175 — 2026-10-15

- 新增槽位「恢复服务」：VM 列表行「更多操作」与模型测试失败结果里都能打开。弹窗先只读诊断（槽位状态、凭证、节点 SSH 链路与集群中继、出口代理与本机出口桥 kin-egress、容器、推理内核、自动恢复、调度），逐项给出状态、错误码和原因；「恢复服务」执行关机→开机，开机与 `POST /start` 同一路径，期间内核看门狗不插手，结束后清除内核故障标记与重启计数，并重新诊断。接口 `GET /api/panel/vms/:id/diagnose`、`POST /api/panel/vms/:id/recover`（同槽并发 409 `recover_in_progress`），租户可对自己的槽调用。
- 模型测试失败时突出错误码与 HTTP 状态，toast 带错误码；5xx 时自动诊断并显示第一个失败项，例如「容器反复崩溃重启：退出码 1，已重启 9 次」。诊断区分容器不存在 / 已退出 / 崩溃循环。管理员额外看到 Docker 错误原文、内核放弃原因和最后几行容器日志（常见令牌、密钥、代理账号已尽量遮盖）；租户只看到错误码、退出码、重启次数等结构化信息，不含原始日志、路径和主机。
- 自动恢复补缺：看门狗遇到容器已删除或已退出（`container_unavailable`）时走完整开机，仍占同一重启预算；每个 tick 检查本机 kin-egress 出口桥与集群节点的 docker 桥 / 槽位中继，挂了就拉起（每个出口或槽位 60 秒内最多一次）；控制面启动后对记录为运行中、容器不存在或未运行的槽位补开机一次（看门狗关闭时不做）。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，不必重建槽位容器。Node 启动后会对记录为运行中、但容器不存在或未运行的槽位各补开机一次（`kernel_watchdog.enabled=false` 时不做）；运行中的容器不受影响。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.174 — 2026-10-15

- 修复同一入站 session / device 的连续请求排队时，出站 Session ID 在同一 VM 上跳变：使用出队后、预绑定前的粘性快照，后续轮次复用前一轮已建立的出站会话，日志与 Node 出站请求保持一致。
- 同账号换 VM 时，新出站 session 会正确持久化；换机后只重建一次，后续轮次继续复用。保留取消、空响应和临时借位的既有规则。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，不必重建或重启槽位容器。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.173 — 2026-10-15

- Sonnet 5、Haiku 4.5 以及其他不支持对话中途 `role=system` 的型号，会把每一轮的 `<total_tokens>` 提醒抬进缓存断点后面的 system 尾块。尾块每轮变长，`cache_read` 停在工具和官方前缀（这次约 80.5K），后面的对话每轮整段重写。现在整段只留一条预算提醒，官方前缀里的那条不动。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.172 — 2026-10-15

- 面板恢复 admin 虚拟机「分配给租户 / 收回」：虚拟机列表与机架「更多操作」、详情卡与完整详情页运维 Tab 调用 `PATCH /api/panel/vms/:id/owner`；列表与详情展示租户属主读数。1.3.167–1.3.168 列表/网格改版后前端未再接线，群友反馈找不到分配按钮。
- 通知新增「企业微信群机器人」通道：`notify.wecom` 支持 `enabled` / `webhook` / `mention_all`，Webhook 可填完整地址或只填 key。账号池事件、定时汇报、内核故障告警与邮件、Telegram 共用同一套事件规则。Webhook 按密钥对待，面板与 GET 接口不回显，留空保存不覆盖已有值；设置 → 通知 新增对应卡片与「发送测试」。
- 健康探测可选「全号轮询」：`routing.health_probe.probe_all_slots` 默认关闭，行为与原先一致（首个可用槽成功后停止）。开启后每个间隔对所有可调度槽各探一次，受 `concurrency`、工作时段、冷却与凭证排除约束；列表顺序中首个成功仍写入健康缓存。设置页「探测 → 健康缓存」可开关；`interval_sec` 仍支持 3600 等值。（#399）

已部署机升级：更新 Node 控制面与 `web/dist`（镜像构建会重新编前端），重启一次 Node。无数据库迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。全号轮询与企业微信都默认关闭；企业微信要在设置里填写 webhook 后才发送。

## 1.3.171 — 2026-10-15

- 本地 429（例如 `fable_requires_max`，`exhausted: false` 且没有上游额度头）不再把 5h 标成 rejected。带 rejected 额度头或调用方明确 `exhausted: true` 的真实上游 429 仍拒绝。（#439）
- 流式请求在首字之前就装填保活心跳。等待超过心跳间隔会先写出 200 和 ping，并就此提交，避免 Cloudflare 120s 524；间隔内失败仍可换槽。（#429）
- 未向下游提交的 Codex 上游 503 `server_error` 会排除当前槽并换下一个，已提交或写过响应的不换。（#435）
- 设置 → 账号池 → 重试与切号增加「请求体上限」（8–128 MiB，常用 32 / 64 / 128）。它同时限制网关入站和槽内 kernel / Codex kernel 的 `max_request_bytes`。未设置时 kernel 仍是 32 MiB。保存后 Claude kernel 在空闲时重启。Codex kernel 只在该槽没有其他在途请求时重启，并等旧进程退出后再拉起，避免健康检查复用还在退出的进程。（#436）

已部署机升级：更新 Node 控制面与 `web/dist`（镜像构建会重新编前端），重启一次 Node。无数据库迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。请求体上限的默认仍是 32 MiB，要放到 64 需在设置里保存；保存后各槽 kernel 在没有请求时才会按新上限重启。

## 1.3.170 — 2026-10-15

- 本地代理拆成每台 VPS 一条：控制面 `px-local`，每个集群节点 `px-local-<节点 id>`，接入节点时自动建立。绑定额度、测通、测地理都按各自机器算，不再「所有节点共用」，节点行的探测看该节点的 SSH 链路，地理经节点本机出网查询。槽位只能绑它所在机器的本地代理，传通用的 `px-local` 会自动落到槽位自己机器的那一行，绑到别的机器返回 `local_proxy_node_mismatch`。升级后首次启动会把挂在 `px-local` 上的节点槽迁到各自节点的行，docker 网络不变，运行中的槽不用重建。（#329，#428）
- 虚拟机列表的出口芯片点击即测这个槽的真实出口 IP 与地理（`POST /api/panel/vms/:id/exit-probe`，仅 admin）。本地代理槽测它所在 VPS 那条本地代理，结果同步到代理池页；未绑定或被策略封禁的槽不可点。（#428）
- 新增管理员接口 `POST /api/panel/vms/:id/credential/clear`：清空槽位凭证与账号字段并关闭调度（`no_credential`），保留槽位本身及其代理、时区、指纹等配置。（#438）
- 修复 GPT 槽邮箱显示：导入按「显式邮箱 → ID Token → Access Token」补全身份，账号 ID 不再被当成邮箱，重新导入不再继承旧账号凭证，有凭证但邮箱未知的槽显示「已导入账号 · 邮箱未知」而不是空槽。（#432）
- 修复 Claude 省略 thinking 时首字时间（TTFT）记得过晚、导致输出速度虚高：带 `estimated_tokens` 的 thinking 增量即计为首次输出。（#431）

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无数据库迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。接了集群节点且用本地代理的部署，首次启动会把节点槽迁到各节点自己的本地代理行，并改写 `vms/<id>.json` 里的 `proxy.id`（日志 `[local-egress] vm: px-local -> px-local-<节点>`）；要回滚到旧版本，先备份 `vms/` 和 `data/`。

## 1.3.169 — 2026-10-14

- 修正 #411 改坏的 0 注入契约测试。空的常驻约束仍保留零宽 agent 槽；用量遮罩继续盖住计费头、该槽和 Environment，不盖调用方剩余 system。没有运行时行为变化。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.168 — 2026-10-14

- 计费改为三层价格：手动覆盖 > models.dev > 内置官方快照。models.dev 每 24 小时同步，缺的模型和档位（Mythos、gpt-6、Claude fast、OpenAI flex / priority、长上下文、1h 写入）由内置快照补。修正 Sonnet 5.5 缓存读 $0.10、Fable 5.1 / Mythos 5.1 缓存读 $0.25；去掉 Sonnet 4 / 4.5 超 200k 的加价。Anthropic web search 按 $10 / 1000 次计入费用。缓存写没有 5m / 1h 拆分且未声明 1h 时按 5m 计。
- token 口径统一：`usage_logs.input_tokens` 一律不含缓存，OpenAI / Codex 在写入时扣掉缓存读写。「总 Token」= 输入 + 输出 + 缓存读 + 缓存写，每类只算一次；GPT 不再重复算缓存。虚拟机窗口、`total_tokens`、`today_tokens` 现在都含缓存。`/billing` 的 `tokens_in` 改为输入 + 缓存。
- 托管 key 扣额度与写入日志用同一份计价结果，每个请求只计价一次。
- 模型页拆成「模型」「计费」两个 Tab。计费 Tab 显示每个模型的有效价、来源和与内置价的差异，可编辑覆盖、手动同步 models.dev、按时间段「按当前价重算」（只改官方价 `total_cost`，不动 `actual_cost` 和 key 已扣额度），并列出未定价模型。
- 模型目录自动同步：启动 5 秒后和每 6 小时经 OAuth 槽拉 Claude `/v1/models` 和 ChatGPT Codex 目录。新模型只在 `worker_only` 下直接对外，其他情况先加入并关闭。
- 虚拟机列表拆清三列职责：「今日 / 7D 请求」只显示次数；「用量窗口」只显示额度占比和重置时间；「成本」统一显示 5H / 7D / 总计的官方费用与含缓存 token。网格、展开详情及「查看统计」共用同一份窗口与成本组件，移除列表和弹窗里的估算总量／剩余金额、顶部全池剩余估算及重复累计指标；完整详情页与 API 的估算能力保留。
- 网格卡片底栏将逐格 session slot 改为按设置上限显示的席位容量条（已用 / 上限，保留宽限和排队提示），修复 20 席位挤出调度开关与菜单的问题；限额操作移到用量区，中／大卡片按实际宽度叠放或并排，金额与 token 完整对齐。
- 新接口 `GET /api/panel/pricing`、`PUT /api/panel/pricing/overrides`、`POST /api/panel/pricing/sync`、`POST /api/panel/pricing/reprice`；`/vms`、`/vms/:id`、`/usage` 新增 `estimate_5h` / `estimate_7d` / `estimate_fable` / `window_fable_cost`。见 `docs/PANEL_API.md`。
- API 后端空 system 也会套已配置的官方提示词。`rewrite` 的计费头放在 cache 断点之后。
- 拒答守卫改为不可重试的 400 `policy_blocked`（`code` 仍是 `refusal_guard`），不再返回 503，避免 Claude Code 误提示登录。
- 远程节点的 egress 容器改用配置文件属主的 uid:gid 运行；崩溃循环或旧规格会重建。
- `POST /api/panel/vms/pool-policy` 批量改权重、调度等级和并发上限。单槽 `PATCH` 也可以改 Codex `weight`。
- 修复 GPT OAuth 授权成功后虚拟机面板仍显示「未绑定账号」：换票后从 `id_token` / `access_token` 解析邮箱与 ChatGPT 账号 id。（#409）
- 默认环境变量管理员写入用户列表，可在面板改密码。引导是否完成看数据库密码，不再只看 `.env`。

已部署机升级：**升级前先备份数据库**。迁移 037 会就地把历史 OpenAI / Codex 行的 `input_tokens` 改成不含缓存（判据与原缓存命中率完全一致，命中率分母不变），无法自动撤销，回滚只能恢复备份。已经跑过 037 的机器不会再改这些行。更新 Node 控制面与 `web/dist`，重启一次 Node。无新依赖，不必 `wrap-cli/sync`。控制面需能访问 `https://models.dev`，访问不了时按内置快照计价。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.167 — 2026-10-14

- 官方档在调用方没有 system 时也出站四段：计费头、身份句、官方 prompt、Environment。顺序跟 cli-node 一致，计费头在 prompt 前面。调用方自己的 system 仍放在第 5 段。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.166 — 2026-10-14

- 计费头改放到最后一个 `cache_control` 之后。`cch` 仍按整份 body 变化，但不再打进 1h 前缀，`cache_read` 可以越过工具尾断点。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.165 — 2026-10-14

- 虚拟机页的网格视图改成机架地图：按服务器分机架，机架内按状态分区（在池 / 受限 / 关闭调用 / 未使用 / 无效凭证）分段。机架头显示本机状态构成、席位占用和 5h / 7d 费用与 token 合计，只统计当前筛选下可见的槽位。
- 每台槽位按「费用 / token」两行显示 5h、7d、Fable（仅 Max）和累计四列，竖柱带 70% 刻线和重置倒计时，并显示近 7d 占累计的比例。无效凭证、空槽、额度未探测的槽位直接给出重新授权、绑定凭证或刷新探测。
- 卡片分小 / 中 / 大三档，默认打开网格·大；视图和尺寸会记住。顶部状态分区条同时用于网格和列表的筛选，吊销并入无效凭证。排序新增 7d 费用和累计费用。
- `GET /api/panel/vms` 与用量账号行新增 `total_tokens`（累计输入 + 输出，不含缓存），和 `total_cost` 同源。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.164 — 2026-10-14

- 官方提示词把调用方的官方长提示词放回 agent 槽，并在该块打 1h 断点。不再只留身份句。
- 计费头的 `cc_prompt_index` / `cc_turn_index` 固定在首轮，避免每轮改写 system 前缀、把缓存打穿到工具断点。
- `role=system` 留在消息列表。第 5 段只放顶层 system，对话前缀可以随轮次增长。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。已保存的官方档模板即使没有 `{{caller_agent}}`，出站仍会把官方长提示词插回 agent 槽。

## 1.3.163 — 2026-10-14

- 官方请求也套用协议里设置的 system 档，包括 custom。分类器请求仍不改。
- 协议页「入站准入」新增「官方 Claude Code 家族透传」，默认关。打开后，直连和被识别为中转的官方家族保留入站 system（billing、身份句、system 上的 cache_control），不套当前提示词档。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。开关默认关，升级后官方家族会套用当前 system 档；要恢复透传，在协议页打开该开关。

## 1.3.162 — 2026-10-14

- 风险审计的蒸馏关不再写死收割包装、赛题正则和思考预算下限。这些值只来自面板保存的 `distill-rules.json`：`hard_needles` 是收割包装（官方客户端和 0 注入也拦），删掉即停，不会补回；结构收割的 `max_tokens` 和思考预算都用 `structure.min_max_tokens`；`contest_pattern` 留空则不做赛题结构判断。返回文案也只用该文件里的 `error.message`。出厂 `patterns` 为空，知识蒸馏 / 提取思维链仍由硬正则的 distill 类别拦截，避免两份名单。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。旧的 `distill-rules.json` 若没有 `hard_needles`，加载时把仍写在 `needles` 里的出厂收割句归到收割包装；已经从 `needles` 删掉的不会补回。整份替换该文件则会用仓库里的新出厂配置。

## 1.3.161 — 2026-10-14

加强和优化时区。加强针对 omp、pi 的单独优化。

## 1.3.160 — 2026-10-13

- 系统提示词按五段注入。官方完整是标准：billing、identity、agent、env，调用方 system 在可选第 5 段。官方提示词和 0 注入用同一槽位；第 3 段只放常驻约束，空则去掉。顶层 system 和消息里的 `role=system` 都进第 5 段，不再抬成中途 `role=system`。
- cli-hop 先剥掉入站 billing、identity 和 `# Environment`，再按槽位档覆写。cli-node 只有在出站已经带 billing 和 identity 时才原样放行，否则仍由 CLI 补回计费头和身份句。
- OMP / oh-my-pi 仍是非官方流量：正文进第 5 段，自带的 billing 和 `local-agent` 前缀不转发。旧的 `rewrite` 模式仍把中途 `role=system` 留在消息列表里。

已部署机升级：更新 Node 控制面，并把 `share/wrap-cli/cli-node` 同步进 Anthropic 槽（`wrap-cli/sync`，`restart: true`）。Codex 槽不用这枚 CLI。重启一次 Node。无迁移、无新依赖。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.159 — 2026-10-13

- 风险审计的账号范围改为按「平台 · 套餐」筛选（Claude Max/Pro 跟虚拟机列表同一套判断，GPT 按套餐）。不再按凭证形式。范围条在页面顶部，可收起。只选 GPT 套餐时 Claude 照旧全进关卡；选了 Claude 套餐或指定账号后，没命中的 Claude 才放行。GPT 在设了范围后只检查命中的套餐。没设范围时行为与 1.3.158 相同。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。没设账号范围的关卡，行为与 1.3.158 一致。

## 1.3.158 — 2026-10-13

- 伪造健康探测头（`x-health-real` 一类）不能再绕过密钥配额。内部已认证的健康探测仍不计配额。
- 风险关卡可按已有槽位字段收窄：凭证形式、`plan_type`、槽位 id / 邮箱 / 名称。三个名单取并集，全空时所有账号照旧进关卡。不新增账号属性。Claude 不受这个范围影响。
- 新增单槽「工作时段」（`policy.active_hours`：开工 / 收工、可选星期与钉住时区，开工晚于收工为跨夜班次）。窗口外该槽不参与调度：Claude 在模型与额度门禁之后判，Codex 直接跳过；整池都在休息时两侧都 503 `pool_unavailable` 并带 `Retry-After`（最近开窗时间）；Codex 续接 `previous_response_id` 时绑定槽在休息返回 409 `response_not_portable`。健康探测不挑休息中的槽，pin 诊断不受影响。时区取窗口自带值 → 槽位时区 → UTC，夏令时切换日按实际时刻判定。面板「调度」编辑器可设置，列表显示「休息时段」（受限），新增 `active_hours_timezone` / `active_hours_active` 字段；导出包、写回与重建保留窗口，无窗口导出为 `null`。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。没设工作时段的槽、没设账号范围的关卡，行为与升级前一致。

## 1.3.157 — 2026-10-13

- 增加 Fable 多轮 system 前缀的回归测试，防止历史 system 提醒被抬进顶层 system、冲掉缓存前缀。不改运行时行为。

已部署机不必为这一版升级。没有协议、配额或出口变化，无迁移，不必 `wrap-cli/sync`。

## 1.3.156 — 2026-10-13

- kin-egress 的 DNS-over-TCP 在同一连接上连续回答查询。解析失败回 SERVFAIL 后继续读下一笔，不再在首个应答后关闭连接。解析期间不占用客户端的 10 秒读写超时。
- 面板会话 `panel-sessions.json` 改为同目录临时文件原子替换，权限 `0600`。已经过宽的文件在加载时收紧。写入或加载失败会记一条日志，不再静默丢掉。
- 决策模型不可用且关闭失败放行时，只拦截当前请求，不再把客户端 device 永久封禁。503 拒答缓存在原句后说明是设备封禁、精确一致还是相似正文。

已部署机升级：更新 Node 控制面镜像（内含本次 `kin-egress`）并重启一次 Node。已经在跑的出口要换成这次发布的 `kin-egress`，DNS TCP 复用才会生效。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.155 — 2026-10-13

- 虚拟机详情 → 代理 tab 的出口下拉改为可输入筛选：输入名称、地址、国家、城市、时区或 ISP，只列匹配的可用节点，选中后点「绑定」。
- 「代理」页的搜索框改为筛选可用节点：有关键词时只显示可绑（未禁用、非 dead、无 IPv6 拦截）且有空位的代理，已满或失效的不参与匹配；清空关键词恢复全部列表。
- 「代理」页重排，找节点更快：席位图改成整页宽的横条放在顶部，健康图例仍可点击筛选；下方新增地区栏（本地出口、各国家，城市多于一个时可再细分），每档显示当前筛选下的条数和可绑空位，点一下就筛到该地区。地区栏在超宽屏（≥1536px）是表格左侧的竖栏，更窄时是表格上方的一排，笔记本宽度下表格不被挤成卡片。列表在宽屏下对齐成表格（节点、地区、状态、延迟、席位、已绑槽位、操作），点表头排序、再点翻转。「添加代理」「池设置」收进页头按钮打开的右侧抽屉，「全部测通 / 全部测地理」移到页头。窄屏时表格退回卡片排布。
- 代理列表每条压成一行（约 40px，1366 宽一屏约 13 条）：名称后跟地址，地区只显示国家 · 城市，席位改成「n/上限」+ 小格，已绑槽位行内最多显示 2 台、其余折成「+N」，行尾只留测通和「更多」菜单。点名称展开详情：完整地址、出口地理与 ISP、最近错误、全部已绑槽位与绑定、测地理 / 复制 / 编辑 / 启停 / 删除。顶部席位图变矮，待接代理收成一行。
- 顶部席位图改为按地区成簇的点阵：一个点一个绑定位，实心为已绑（按代理健康着色），空心为可绑空位，淡点为失效 / 禁用代理上用不了的位；一条代理一列，上限高的（如本地代理）折成相邻几列而不是拉高整图。每簇标出地区名和空位数，点地区名即筛到该地区，悬停 / 点列仍与表格行联动。地区栏可收起：竖栏收成只显示地区代码和空位数的窄条（60px），横排收成只剩当前选中的一档；收起状态记在浏览器里，不清除筛选。

已部署机升级：更新 `web/dist` 与 `VERSION`，重启一次 Node 让面板显示新版本号。Node 控制面代码、二进制、kernel / CLI payload 与 1.3.154 相同，无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.154 — 2026-10-13

- 欢迎页首配增加用法选择。个人自用关闭 5h/7d 闸，三档闸线拉到 100%，执行并发拉到 256，RPM 保持不限；蒸馏、硬正则、拒答缓存关掉，决策模型维持关闭且阈值降到 0。中转站把这些项写回出厂值：闸开着，default/Pro 并发 2、Max 并发 4，闸线 85%/80%（Max 95%），蒸馏、硬正则和拒答缓存开着。两种模式都不改提示词、探测、健康缓存和其余开关。`PUT /api/panel/onboarding` 增加 `{ action: "profile", mode: "personal" | "relay" }`，选择记在该用户的引导状态里，完成或跳过引导后仍保留。
- 欢迎页补了各主要页面的一句话说明。配额、风险审计、密钥、虚拟机用量、内核重装多一句：配额闸在设置「配额」；风险审计是出站前的四道关；密钥用 `sk-vm-`，不要把主控密钥写进环境变量；5h/7d 用量在虚拟机列表；内核重装不改凭证、代理和容器。
- system 提示词在没有 `persona_preset`、也没有 `persona_inject` 时默认完整官方提示词（`official_full`）。已写明的档位和旧的 `persona_inject` 不变。仓库里的 `routing.json` 本来就是这一档。
- 自动额度探测和健康缓存改为默认关闭。预热拦截、`max_tokens` 下限和其余探测项不变。已在 live `routing.json` 里写成开的开关保持开。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 live `routing.json`、`vms/`、`data/`、`.env`。要让已部署的探测和健康缓存跟着新默认关掉，在设置 → 探测里关，或删掉 `usage_probe.enabled` / `health_probe.enabled` 后重启。

## 1.3.153 — 2026-10-13

- 设置 → 协议 重排为两块：「入站准入」（Claude / GPT 两侧客户端放行，「识别中转来的官方 Claude Code」也移到这里）与「GPT 链路」（总开关在标题栏）。「仅允许 Claude Code 家族请求」原来是页面最底下第六张卡片，容易漏看，现在放在第一块入站准入里，并列出放行条件。
- 协议页不再提供 Claude 链路的修改：去掉数据面、缓存 TTL、缓存断点。数据面在「内核」页切换；`cache_ttl`、`cache_breakpoints` 只能直接改 `routing.json`，保存协议页时原值保留。
- 去掉「用量」页：侧栏不再显示，`#/usage` 路由删除，`super` 角色的可见页不再含 `usage`。账号 5h / 7d 限额看「虚拟机」列表的用量窗口；总览的「警告 / 限制」提示改为跳到虚拟机页。`GET /api/panel/usage` 仍保留，总览、集群和虚拟机列表在用。
- 「仅允许 Claude Code 家族请求」改严：只认 UA 已不够，直连须同时带 Claude Code 的整组请求头（`x-app: cli`、`anthropic-beta` 含 `claude-code-20250219`、Stainless SDK 头、`x-claude-code-session-id`），Messages 还要官方 system + user_id、会话头与 user_id 会话一致、计费块版本与 UA 一致。count_tokens 只验请求头。CLI 自身的 quota 探测只放行固定原样（`max_tokens: 1`、无 system/tools、单条 user 文本 `quota`、会话头与 user_id 一致）；其他 `max_tokens: 1` 的请求按普通请求判，因为输出下限会把它抬成真实补全。健康探测形状（含 sub2api 账号测试）一律 403，不再由探测缓存回答。中转流量跟随「识别中转来的官方 Claude Code」。面板测试对话和内部健康探测（master key 钉槽）不受影响。
- 蒸馏默认规则不再把 `Respond in the following format: <think>` 当模板。NewAPI 等中转用 `Go-http-client` 转发时带这句正常系统提示，`skip_official` 对不上，之前整段 403 `不允许蒸馏`。已保存的规则加载时也会丢掉这句，和裸 `<think>` 一样。收割针、指纹和「提取思维链」这类规则不变。
- 「识别中转来的官方 Claude Code」加强：系统里有官方计费块（`x-anthropic-billing-header` 和 `cc_entrypoint`，且不是 oh-my-pi）就按官方处理，不再同时要求 `user_id`。NewAPI 用 `Go-http-client` 转发时留着计费块、丢掉 metadata，之前不算官方，蒸馏和其他官方绕过都没走。没有计费块的中转仍要客户端 beta、官方 system 和合法 user_id。`local-agent` 仍不算官方。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。开着该开关、又依赖第三方健康检查或只带 UA 的客户端的部署，升级后这些请求会变成 403。

## 1.3.152 — 2026-10-12

- 用量聚合按每行 prompt 分母计算缓存命中率：Claude 为 input + 读 + 写，Codex / OpenAI 的 input 已含缓存；混用提供商按 token 加权，账号窗口二次汇总保留该分母。首页和用量页复用已算出的 `billing.total`。数据库页 `PromptCacheMetricsPanel` 仍用 input+read+creation 自行重算，不在本次范围内。（#363）
- 内核流 `streamGoWorker`（Claude / Codex 共用）的 TTFT 从首次生成内容起算：文本、推理、已生成的工具名（无参工具可能没有参数 delta）计时；`message_start` / `response.created` / 空完成等元数据不计。日志 `first_token_ms` 用 `firstTokenAt - 入口 t0`，取消和失败保留已观测时间。API 传输路径仍按首条 `data:` 行计时，未改。（#363）
- 槽位 JSON 读缓存保留调度热路径：只缓存文件文本，按 mtime/size/inode 签名命中，每次单独解析，调用者改返回对象不影响下次读取。`getVm` 只把缺文件（ENOENT）当成不存在；坏 JSON、目录和其它读错误继续抛出。`listVms` / `readCodexAccounts` 仍在各自边界跳过坏文件。删除槽位、重建擦除 home、备份恢复会立刻丢掉对应记录和 Codex 凭证缓存；缓存有固定 LRU 上限。`KIN_VM_READ_CACHE_MS=0` 关闭缓存，该变量只是开关不是 TTL。（#384）
- 临界区大额冷请求只按缓存未命中的输入判断，不再把 `max_tokens` 算进未缓存量。Claude Code 的 Opus 把输出上限固定成 128000，之前账号一进临界区，短提示词的新会话会被直接拦下，热会话结算一笔后也全部本地 429，直到下一次官方用量探测。现在短的新会话和已确认热前缀的小请求继续放行；真正的大额冷写入（默认 ≥10 万未命中输入）以及滞后读数下的下一笔大额未命中仍拒绝。8 万左右、低于阈值的冷提示词不再因为输出上限被抬过线；要拦这种写入，调低 `routing.quota.large_cold_uncached_tokens`，不要把输出上限加回去。（#385）
- GPT/Codex 槽不再因 Claude 凭证为空被停成 `no_credential`。新增 `vmHasSchedulableCredential(vm, projectRoot)`：Claude 槽沿用 Claude 凭证判断，GPT 槽读 `codex-credentials.json`（无项目根时回退槽位记录）。槽位启动、代理绑定/重绑/编辑/包更新后的恢复调度、代理重新启用三处改用它；之前预热或重绑会把整池 GPT 槽停掉，请求全部 `503 no_codex_vm`。已被停掉的槽需手动重新启用一次或再走一次上述路径。（#386）

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，kernel / CLI payload 不变，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.151 — 2026-10-12

- 修复消息级 effort 切换：支持该 beta 的模型保留空 `system` 控制轮及其原位置、历史控制和多次切换，不再删除或提升到顶层；顶层 `output_config.effort` 保持入站值。出站携带 `mid-conversation-output-config-2026-07-01`，kernel 序列化保留消息级控制字段。不支持该能力的模型维持原来的末尾提升处理。（#383）
- 本地实际 Node → 新 kernel ELF → 现有 CLI → SSE fixture 验证了新 user 前/后、历史控制和多次切换的出站消息、顶层 effort 与 beta；不等同于真实上游缓存命中验证。

部署该修复需更新 Node 与 kernel payload，并执行 `wrap-cli/sync`；CLI 本身无需重编。没有数据库迁移或新依赖。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.150 — 2026-10-12

- 遥测对齐 Claude Code 2.1.293。`device_id` 使用官方 64 位 user id，发送前去掉 `node_version`、`is_running_with_bun` 和 `betas`，补上 shell 等官方环境字段。
- 新建槽从手写 SMBIOS 品牌库随机抽一条机器画像，写入 `vm.machine.smbios` 后固定使用。已有厂商、型号和系列的槽不重抽。库里是 Dell、联想、惠普、华硕、宏碁、Framework、微星、技嘉的台式机和笔记本。Docker 槽只保存这份身份；KVM 启动读取槽位记录，不再回退全局 OptiPlex 7090。

已部署机升级：更新 Node 控制面与 `kin-worker`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。已有槽的 SMBIOS 不会被这次升级改写。

## 1.3.149 — 2026-10-12

- 控制台入口（`/cc`、`/console`）改为公开欢迎页 `#/welcome`：介绍、能力、三步快速开始和 Claude Code / Codex / curl 接入片段，版式参照 new-api 新版首页，配色只作用于欢迎页和登录页，控制台主题不变。登录改为独立页面 `#/login`，右上角「登录」进入；`/cc#/login`、`/console/#/login` 旧地址照常可用，未登录打开受保护页面会带 `redirect` 到登录页，登录后回原页面。
- 登录后欢迎页显示首配清单：修改默认密码、出口代理、槽位账号、可调度槽位、`sk-vm-` 密钥、首个成功请求，完成态全部来自网关真实数据，按角色裁剪（租户只算自己的槽和密钥）。首次登录且未完成时落在欢迎页；「跳过引导」或「完成引导」后登录直接进总览，用户菜单「欢迎与引导」可重新打开。
- 新增 `GET/PUT /api/panel/onboarding`：返回各步完成态、`needs_welcome` 和 `base_url`（仅 `PUBLIC_BASE_URL` 设置时），`PUT { action: complete | dismiss | reset }` 按用户写 SQLite `settings.onboarding_state`。admin / super / user 都可调用。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.148 — 2026-10-12

- 硬正则和决策模型的用户文本不再包含工具回传。omp 把 issue、命令输出放在 user 轮的 `tool_result`（以及 `*_tool_result`、`function_call_output`）里，正文引用 `ignore all previous instructions` 会被 jailbreak 规则拦截。用户自己写下的同一句仍然拦截；system 提示词硬正则本来就不扫，决策模型仍看 system。拒答相似度仍把工具回传算进文档。
- pi 插在消息序列里的空 `system` 控制轮（`content` 为空，只带 `output_config.effort` 或 `clear_at`）重新丢掉，不再原样转发出站。v1.3.138（#328）留下这些空轮之后，长会话里每轮一枚空 system，上游无法处理。末尾那条（后面没有 user/assistant）的 effort 仍提升到顶层 `output_config.effort`，当前轮不会退回旧的 `high`；夹在历史轮里的空控制只删除，不覆盖当前顶层 effort。带正文的对话中途 `role=system` 不变。（#374）
- 硬正则规则列表存成空数组（`rules: []`）时回落内置规则，与 `rules: null` 一致；之前内置规则被整体换成空集，`hard_regex_enabled` 仍显示开启，请求日志记 `by: unchecked`。要关掉这一层用 `hard_regex_enabled`。（#370，#371，@jxb412）
- 导入的槽位 OAuth 凭证在文档顶层和 `claudeAiOauth` 里都写 `kinGeneration`，与 Go 刷新器一致；文件仍是 `0444`，槽内 Claude 不能改写共享 refresh token 而丢掉代数。（#373）
- 换票结束于 Claude Code bootstrap（`entrypoint=claude-code&model=claude-opus-5-5`），不再 PATCH 账号 Grove / Help improve Claude。bootstrap 去掉 vscode 字段。`kin-oauth-auth` 随 payload `payload-2026.10.12` 更新。
- `server-side-fallback-*` 与 fallback credit beta 只在请求体显式带 `fallbacks` / `fallback_credit_token` 时附加。
- `GET /v1/models` 只列出该 key 的 `group_type` 能调度的模型：`openai` 只列 GPT，`anthropic` 只列 Claude，`all` 两者都列。（#364，@xjblszyy）
- 虚拟机列表开关调度成功后不再回跳到旧状态、等 5 秒轮询才纠正。（#367，@OneB1ank）
- KVM 槽位降权启动 QEMU 时保留 `/dev/kvm` 的设备组，`/dev/kvm` 属组与槽位主组不同时不再 `Permission denied` 循环重启；TCG 和 UID 0 路径不变。修复在 `kin-kvm-*` runner 镜像里，镜像已重新发布。（#365，#366，@OneB1ank）
- 槽内 `cli-node` 对齐 Claude Code 2.1.293 的请求组装与 CLI 兼容性（随 payload `payload-2026.10.12` 更新）。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖。`cli-node` 与 1.3.147 不同，槽位要 `wrap-cli/sync` 才用上新 CLI；KVM 槽位要拉取新的 `kin-kvm-*` 镜像并重建一次。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.147 — 2026-10-12

- GPT / Codex（OpenAI 平台模型）请求默认不过拦截关卡，日志记 `intercept.by = platform`（风控页「OpenAI 平台未接入」）。风控 → 硬正则新增「OpenAI 平台」开关（`jev_intercept.openai_platform_enabled`，默认关）；开启后与 Claude 走同一套硬正则、拒答缓存与决策模型，蒸馏规则仍不扫 OpenAI 平台。之前 Responses 形态的 `input` 取不到用户文本（#368），GPT 请求事实上从未被检查；修好取文本后若直接生效，Codex 放在 user 轮次的 AGENTS.md 会被硬正则误拦并封设备，所以改为显式开启。非布尔值 PUT 400。
- Responses / Codex 形态的 `input`（`message → content → input_text`）与 `instructions` 现在进入硬正则、决策模型和蒸馏的取文本（#369，@jxb412）。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.146 — 2026-10-11

- GPT 槽的容器不再循环重启。GPT 槽的 Codex 内核跑在宿主机上，但容器的主进程一直是 Claude 的 `kin-kernel`：它没有 Claude 凭证，等不到 20 个 CLI 槽就在约 4 分钟后退出，`--restart unless-stopped` 再拉起，线上两个 GPT 槽已各重启 1376 次（每次都起一遍 cli-node）。现在 GPT 槽容器的主进程是 `sleep infinity`，带 `kin.vm.role=codex` 标签；没有 `kernel.sock` 也算存活，重载不会再把它删掉重建。没有这个标签的旧 GPT 容器在下一次重载 / 启动时重建一次。Claude 槽不受影响。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。已有的 GPT 槽要各重载一次（面板「重载」或 `POST /api/panel/vms/<id>/reload`），容器会重建一次、容器 ID 改变；宿主机上的 Codex 内核和凭证不受影响。

## 1.3.145 — 2026-10-11

- 5h/7d 闸改成三段，调度和控制台用同一套判断：闸线下 `critical_band`（默认 5%）到闸线上 `gate_overshoot`（新，默认 5%，0–10%，设置 → 配额可改）为「临近闸线」；达到闸线 + 超出量才算闸上、让出席位换 VM。之前临近闸线时同一会话的第二个并发会被拒，预调度随即释放席位、把会话挪到别的 VM（余量还在却切 VM）；现在第二个并发在原 VM 排队，一次只跑一个，不换 VM。新会话优先开到正常 VM，没有时才开在临近闸线的 VM 上，用量过了闸线就不再开新席位。大额冷请求保护（#350）不变，作用范围随临近闸线区一起延伸到超出量。
- 控制台不再把临近闸线的账号显示成「可用」：新状态「5h/7d 临近闸线」（`availability.key = drain`，橙色，仍算在池）。状态优先级改为额度上限 / 门禁 → 503 熔断 → 调度关 → 临近闸线 → 席位满；之前熔断会盖住额度限制。席位满单独显示，不计入「受限」。
- 实时性：席位流加上每台 VM 的在飞请求数，每个请求开始、结束都推一帧；新增 `event: proxy`，SOCKS5 探测结果和代理状态变化即时推到 VM 列表、总览和详情页（详情页之前不接实时流）。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`；部署机 `routing.json` 没有 `gate_overshoot` 时按默认 0.05 生效，即升级后账号可越过原闸线最多 5 个百分点才切走；要到闸线即切，在设置 → 配额把超出量设为 0。

## 1.3.144 — 2026-10-11

- 决策模型 key 从 8 把放到 999 把。一行可以写成 `https://host/v1/systemone <key>`，和裸 key 放在同一池里轮换，所以 typesafe 和别的 systemone 可以一起用。
- `401` / `429` / `529` 退役这把 key，之后的请求不再调度它。再次保存密钥列表会把还在列表里的 key 重新启用。网络错误和其它 HTTP 状态只跳过这一跳的同一主机，不退役 key。模型故障放行的 keyword 写成 `网络异常` 或 `上游 <status>`。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移。不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.143 — 2026-10-11

- 首次部署不再种下一个删不掉的 `vm-01`。之前入口会写成活跃槽，而删除接口拒绝删除活跃槽；只有这一个槽时无法先切换，所以首个槽删不掉。重启还会把文件种回来。现在空环境可以直接启动。只剩一个活跃槽时可以删除，并清掉活跃指针；还有其他槽时仍要先切换活跃再删。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。已有的 `vm-01` 不会被删掉；它若是唯一槽位，升级后可以直接删除。

## 1.3.142 — 2026-10-11

- 日志列表默认隐藏「认证」类时，不再把无槽位的 403 策略拒绝一起藏掉：`claude_code_only`、`key_group_mismatch`、`vm_pool_unavailable`、`distill_blocked` 等已有明确分类的错误码照常显示。之前只按「无槽位 401/403」判定，这些拦截在默认视图里看不到，要勾「显示静音」才出现。入站来源统计口径不变。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.141 — 2026-10-11

- 「仅允许 Claude Code 家族请求」开启时，拦截提前到健康探测之前。此前像健康探测的第三方短请求（如 `hi`）会被探测缓存答出 200，或在探测 fail-closed 时得到 503 `health_unavailable`，而不是 403 `claude_code_only`。官方 Claude Code 的探测请求不受影响。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.140 — 2026-10-11

- 设置 → 协议新增「仅允许 Claude Code 家族请求」（`routing.compatibility.claude_code_only`，默认关）。开启后，Claude 模型的请求只放行官方 Claude Code：识别与人设/拦截路径共用 `isOfficialClaudeCodeTraffic`，「识别中转来的官方 Claude Code」开启时也放行被中转的官方流量；官方 `claude-cli` UA 的 `max_tokens=1` 探测与 `count_tokens` 同 sub2api 放行。其余（第三方客户端、`/v1/chat/completions` 等 OpenAI 格式入口调 Claude）在选号前返回 403 `claude_code_only`，`count_tokens` 同样拦截。GPT 模型与 Codex 搜索不受影响。该错误归「请求格式」，不计 SLA 失败；非布尔值 PUT 400。
- 仓库只保留源码：`web/dist`、`bin/kin-*`、`share/wrap-cli` 的 ELF / glibc、`share/crag` 不再进 git，并已从全部历史中清除（所有 tag 的提交号随之改变）。控制台与 `kin-worker` / `kin-egress` 在镜像构建与 CI 中由源码编译；闭源 kernel、`kin-oauth-auth`、`cli-node`、`cc-node`、crag kernel 与 glibc shim 放在独立的 payload Release，由 `deploy/payload.json` 按 sha256 钉住，`npm run fetch:payload` 下载并校验。镜像额外带上 crag kernel，入口写进 `share/crag`。版本 Release 附件名不变。
- amd64 源码安装（`install.sh --from-source` / 目录有 `.git`）此前只按 `docker-compose.yml` 拉 ghcr 镜像，并没有构建本机 checkout。现在安装 / 升级会在 `.env` 写 `COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml`（已有值不覆盖），按 checkout 构建；面板一键更新不再重复叠加同一个构建文件。

已部署机升级：镜像安装照常（一键脚本或面板更新），无迁移。源码安装（`--from-source` / 目录有 `.git`）这一次用新版 `curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade`：新脚本 `git fetch --force --tags` 接受重写后的 tag，旧面板的一键更新会因 tag 冲突失败。源码构建需要能访问 GitHub Release 下载 payload。重启一次 Node，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.139 — 2026-10-11

- 租户日志按属主隔离：`GET /api/panel/request-logs/stats` 的错误集合、入站鉴权失败（含客户端 IP）与粘性命中只统计租户自己的请求，租户侧不再返回全站 `totals` / `config`。日志属主改为写入时快照槽位当时的属主（`usage_logs.vm_owner_user_id`），平台槽分配给租户后，分配前的历史日志不再对新属主可见。升级前的历史日志不回填，租户只能按自己的用户 / 密钥看到；此前租户在自己槽上用面板 test-chat 产生的旧日志将不可见（#353，@XiangZheng2283）。

已部署机升级：更新 Node 控制面，重启一次 Node。启动时执行迁移 `036_usage_logs_vm_owner.sql`（加列 + 索引，大表建索引期间短暂阻塞写入）。不必 `wrap-cli/sync`，二进制不变。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.138 — 2026-10-11

- 修复继承全局 rust 引擎（槽配置未写 `inference_engine`）的槽不进内核看门狗的问题：CLI 重启预算用尽后按 60s/300s/900s 重启容器，用尽后标 fault 并通知，不再一直 `healthy:false`（#343）。
- 已停止 / 已失效的槽位不再每 15 秒被 cli-node 守护进程 `docker exec` 一次，日志里不再刷 `[cli-node-guard] vm-xx No such container`。
- 修复运行中槽位改绑另一条 SOCKS5 后仍挂在旧 `kin-eg-*` 网络、透明出口 IP 不变的问题：重载时若容器网络与当前绑定出口不一致则重建容器（cli-home / run / 磁盘 / machine-id 挂载保留），不再仅 `docker restart`。同一条代理改上游时也会重启 `kin-egress`，避免面板显示新出口、流量仍走旧出口（#325）。
- pi 在消息序列里插入的空 `system` 控制项（`output_config.effort`，例如当前轮 `max`）不再被空内容清理丢掉，也不会和相邻 system 轮次合并。当前轮有效 effort 记入日志；不支持对话中途 `role=system` 的模型把最后一条消息级 effort 提升到顶层 `output_config.effort`。出站补 `mid-conversation-output-config-2026-07-01`（#328）。
- 工具参数流式下发 `failover.eager_tool_streaming` 改为默认开启：未配置时给自定义工具加 `eager_input_streaming`，避免 Claude Code 经中转写大文件时静默触发 180 秒空闲超时。显式 `false` 仍关闭。已部署且 `routing.json` 里写了 `eager_tool_streaming: false` 的机器保持关闭，请到面板「重试与切号」打开（#339）。
- 请求日志列表把 HTTP 200 但 `final_state=incomplete` 的条目从绿色成功改成橙色未完成样式，悬停显示 `error_code`，避免把已提交却未写完的流当成成功（#339）。
- 绑定 SOCKS5 / 本机出口后槽位 `proxy_cli_enabled` 不再被后续写入打回 `false`。OAuth 提交、创建后启动、重置、包导入和重绑都会把该标志与已绑定出口一起保存；调度不再把已绑出口的槽当成 `no_eligible_accounts`。启动时会修好已被这个 bug 写成 `false` 的现有槽位（#332）。
- 5h/7d 闸线临近时（默认闸线下 5 个百分点）会按本请求规模准入：小请求或已确认缓存热请求仍可走；预估大额冷缓存（默认 10 万未命中 token，含 `max_tokens`）不再打到只剩约 1 个百分点余量的账号，先改选其他有余量账号，全池都在临界区则本地 429 `quota_guard_request_too_large`，不打上游。已达闸线仍拦截普通请求。粘性/占席请求同样过闸。临界区内成功结算后，读数未刷新前下一笔大请求也会被挡住；失败或取消释放预留。闸是尽力保护，不把美元换成官方百分比，也不截短上下文。设置「配额」可改临界带宽与阈值，默认开启（#342）。
- 集群节点上的本地代理在管理台显示为「节点名local代理」（例如 `东京-01local代理`），控制面槽为「当前VPS local代理」。代理池仍共用一条 `px-local` 与绑定额度，绑定计数标明「所有节点共用」；节点分组写「出口为该节点本机」，控制面探测不再当成节点出口。租户只看到「local代理」，不暴露节点名或其他租户槽位。本次不改配额语义（#329）。
- 面板一键更新会识别当前 Compose 项目，用独立助手重建并 `--force-recreate` 控制面，轮询健康、启动时版本和此前健康槽位的内核鉴权后再报告成功；不再只改磁盘 `VERSION` 就显示「已是最新」。无法识别实际服务时返回 `409` 并给出宿主机命令。升级到本版本这一次仍由旧版助手执行，新流程从下一次更新起生效；验收失败不会自动回滚，会保留失败状态与助手日志（#331）。
- 控制面调用内核同时发送 `X-Kin-Internal-Token` 和 `x-internal-token`，兼容 1.3.120 前后的槽内核、源码内核和 api-kernel（#331）。
- Codex Responses Lite（`gpt-6-astra` + `reasoning.context=all_turns`）累计加密推理历史超过 128 KiB 时，上游会在出字前返回结构化 `server_error`；网关原先只读 `error.status`，把外层 `status: 500` 落成 502。同一槽保留最新连续推理历史（上限 120 KiB）再试一次，并把上游 500 如实报成 500（#334，基于 @OneB1ank 的 #335）。`KIN_CODEX_REASONING_HISTORY_FALLBACK=0` 可关闭该恢复。
- 租户（`user`）在自己的槽位上点「查询额度」「使用重置券」「Claude 限额查询 / 重置」，以及对自己的密钥「清零」「轮换」不再返回 403。之前前端按钮已对租户开放，但权限白名单漏了这些接口；归属校验不变，访问他人的槽位或密钥仍返回 404（#351）。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。启动时自动把「已绑定出口但 `proxy_cli_enabled=false`」的槽位修好。不要覆盖 `routing.json`：若其中明确写了 `eager_tool_streaming: false`，升级后仍关闭，需在面板「重试与切号」打开；新配置项 `routing.quota.guard_large_cold` / `critical_band` / `large_cold_uncached_tokens` 缺省即生效。无迁移、无新依赖，不必 `wrap-cli/sync`，二进制不变。不要覆盖 `vms/`、`data/`、`.env`。

## 1.3.137 — 2026-10-11

- 首次安装后按脚本打开 `http://<ip>:8787/cc#/login` 不再 404。`/cc` 与 `/cc/` 和控制台 `index.html` 一样下发，且 `no-store`。Host 是未加括号的 IPv6 或非 ASCII 名字时不再在进路由前 500，路径照常路由；路径里的非法 `%` 不再冒泡成 500。

已部署机升级：更新 Node 控制面并重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，二进制不变。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.136 — 2026-10-10

- 槽位可创建为 KVM 虚拟机（与 Docker 子容器并存）。新增 `routing.vm`（默认形态、内存、vCPU、磁盘、CPU 型号、SMBIOS、MAC 前缀、`allow_tcg`）；创建时可覆盖内存 / vCPU / 磁盘并固化到 `vm.machine`。槽内存改为读 `vm.machine.memory` → `routing.vm.memory`（默认 `512m`），移除 `KIN_VM_MEMORY`。`GET /api/panel/cluster/local` 返回 `kvm: { ok, accel, error }`；节点 preflight 在 `runtime_type=kvm` 时含 `kvm` 检查。租户创建表单读 `GET /api/panel/vms/create-options`（与 `POST /vms/create` 同 ACL），因为 user 不能读 cluster/local 与 routing。
- KVM 槽 runner 镜像 `ghcr.io/dofastted/kin-kvm-{ubuntu,debian,arch,fedora}`，`os-catalog` 每项有 `kvm.image` / `kvm.cloud_image`。Release 由 `.github/workflows/guest-images.yml` 构建，离线构建上下文 `docker/kin-kvm/`，本机构建 `node docker/kin-kvm/build.mjs`。
- 控制台「导入」重做为一条上线流程：槽位（新建或选已有空槽）→ 出口 → 账号 → 上线，右栏随步骤显示进度与这台槽的规格；新建时按平台、形态、系统、规格顺序选择，KVM 不可用时选项禁用并写明原因。区域与语言单独成「环境」区：区域只写入槽位标签，语言写入槽位与指纹（`en_US` / `zh_CN` / `ja_JP` / `C`，非法值 400 `invalid_locale`）。创建不再单独指定并发与权重，跟随设置里的全局默认（并发创建后可在槽位详情钉住）。
- 新增「规格」页（资源组，仅管理员）：默认形态、内存、vCPU、磁盘、CPU 型号、SMBIOS、MAC 前缀与 TCG 开关，右栏显示本机 KVM 状态与客户机将读到的硬件。各组默认收成一行当前值，点开再改。设置里的「虚拟机」分页移除。槽位页的快捷创建与导入流程共用同一套表单；创建时的「规格」同样默认收起。内存可选 `256m` / `512m` / `1g` / `2g` / `4g` / `8g` / `16g`；低于 1G 时表单提示 OOM 风险。
- 修复槽位列表与总览接口缺少 `runtime_type` / `machine`，KVM 槽在列表中被标成容器。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。原先用 `KIN_VM_MEMORY` 的部署，先在 `routing.json` 写 `vm.memory`（可选 256m / 512m / 1g / 2g / 4g / 8g / 16g），否则新槽回落 `512m`。不要覆盖 `vms/`、`data/`、`.env`。

## 1.3.135 — 2026-10-09

- 对话中途 `role=system` 的模型白名单按官方文档补齐：Fable 5 / 5.1、Mythos 5 / 5.1、Opus 4.8 的这类轮次按原位发出，不再拼进顶层 `system`。之前这些模型的 `system` 每轮变长，提示缓存从 `system` 处断开，后面整段对话每轮重写 1h 缓存。文档列明 Sonnet 5 不支持，它的这类轮次改为挪进顶层 `system`（#324）。

已部署机升级：更新 Node 控制面，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，二进制不变。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.134 — 2026-10-09

- 命名账号池（`/api/panel/vm-pools`）：多把密钥绑定同一池，成员只在池上维护。调度、故障转移、排队和粘性会话都限制在当前成员内；池停用、为空或不存在返回 403 `vm_pool_unavailable`，不回落全局。未绑定的密钥仍按原来的 `group_type` / `allowed_vms`。迁移 `034_vm_pools.sql`（#320）。
- 代理可开「域名转发」（`domain_forward`）。kin-egress 只在本助手刚答过、且该 IP 只对应一个主机名时，把透明 TCP 的 SOCKS CONNECT 写成主机名；故意的 IP 字面量保持原样，多个主机名共享同一地址则拒绝猜测。默认关闭。IPv6 代理地址和这条开关是两件事。迁移 `035_proxy_domain_forward.sql`。打开开关时只重启该出口的 kin-egress，不重载槽位 worker（#322）。

已部署机升级：更新 Node 控制面、`web/dist` 和 `bin/kin-egress`，重启一次 Node。启动时执行迁移 `034_vm_pools.sql`、`035_proxy_domain_forward.sql`。不必 `wrap-cli/sync`，不要动槽容器。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.133 — 2026-10-09

- 遥测只读 `seed_policy.telemetry_disabled === false`。`disable_nonessential_traffic` 与 `do_not_track` 由这一位派生，不再单独作为开关或判定依据。虚拟机页「遥测」开关在默认开时为开；详情状态同一位，进程是否在跑另计。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，二进制不变。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。已有槽的磁盘种子要等下一次播种才把派生旗标写成同一极性。

## 1.3.132 — 2026-10-09

- 控制台左上角 GitHub 右侧增加「文档」，指向入门站 https://vm2api.fkcodex.com/zh/。
- README 与 `docs/RISK.md` 写明封控拦截顺序：蒸馏 → 硬正则 → 拒答缓存 → 决策模型 → 放行出站，并记下 1.3.122 以来调用方能碰到的变化（本地代理、模型页、密钥范围、流空闲）。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，二进制不变。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.131 — 2026-10-09

- 本地代理语义扩展为「当前VPS的本地代理」：槽位走所在 VPS 自身出口。集群节点上的槽位绑本地代理时，除槽内流量外，控制面代发的请求（OAuth 换票 / 刷新、测试对话、地理 → 时区）也经该节点 SSH 链路从节点出网；节点未连接时这些请求直接失败，不回落控制面直连。节点槽时区跟随节点出口地理（#318）。
- 创建槽位可指定出口（`proxy_id`），部署到集群节点时可直接选本地代理；越权 / 不存在返回 404，失效 / 绑满返回 409（#318）。
- 控制台：本地代理在导入、槽位详情、代理页、创建弹窗中固定排第一，标注 `local:<VPS IP>`（节点 = 节点地址，本机 = 本地代理出口 IP）；「本地出口」文案统一为「本地代理」（#318）。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，二进制不变。节点 sshd 需允许 TCP 转发（`AllowTcpForwarding`，默认开启）。

## 1.3.130 — 2026-10-09

- 修复风险审计统计：正常请求的 `error_code` / `final_state` 为空时，拦截判定在 SQL 里得到 NULL，既不算拦截也不算放行，面板「放行出站」只剩个位数、「今日入站」远小于实际。判定改为对空值安全；新增 `total`（今日全部推理入站 + 其它路径上的关卡拦截），各关占比与放行率统一以它为分母（#316）。
- 关卡判定（哪一关、命中词、规则）此前没有写进 `usage_logs.intercept`，放行原因全是「未记录」、拒答缓存命中显示为错误文案。现在每条请求都记录判定；升级前的旧日志仍归为「未经关卡」（#316）。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，二进制不变。

## 1.3.129 — 2026-10-09

- 面板「协议」页改为「风险审计」（`/risk`）：顶部按拦截顺序列出蒸馏 → 硬正则 → 拒答缓存 → 决策模型 → 放行出站五道关与今日计数；每关可看今日命中（按词/规则归并）、拦截流水（点开即请求详情，判断误伤）和本关设置。「放行出站」单列模型故障放行与上游拒答，用于发现漏拦。原「入口」端点复制与模型 id 列表移到「模型」页顶部。旧 `/protocol` 链接不再可用（#314）。
- 模型页改成卡片式模型矩阵，单个模型点击弹窗配置参数、上下文窗口、别名覆写、官方 beta 和计费说明。Anthropic / OpenAI 平台切换保留，Haiku 5.5 提供 100K 实用模型入口。
- `claude-haiku-5-5` 默认上下文、默认 `max_tokens` 和输出上限从 128K/1M 收敛到 100K；旧 1M/128K 默认设置会自动迁移到 100K，管理员自定义值不被重置（#312）。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，二进制不变。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.128 — 2026-10-09

- SOCKS5 出口地理检测新增 IPv6，与 IPv4 `geo` 并列写入 `geo_v6`（`proxies.geo_v6_*`）；启动时自动执行迁移 `033_proxy_geo_v6.sql`（#309，Fixes #307）。
- 修复 Claude 完整 OAuth 授权码换票的 state 对齐：CAI / Claude Code 粘贴 `code#state` 时只发送 `#` 后的 state，仅 code 时不发送 state；Setup Token 与 Cookie 流程不变（#311）。

已部署机升级：更新 Node 控制面并重启一次 Node，以便 applyMigrations 执行 `033_proxy_geo_v6.sql`。不必 `wrap-cli/sync`，不必重编 `kin-oauth-auth`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.127 — 2026-10-09

- 仓库自带的 `src/config/routing.json` 有两个顶层 `codex` 键，后一个覆盖前一个，`codex.quota` 读不到。新装或用仓库默认配置首次启动时，会被当成旧版配置跑一次 OpenAI 限额迁移：重写 Codex 槽的 `policy`，并把 `routing.json` 改写成展开格式、权限改成 0600。现在合成一个 `codex` 块，取值不变（#308）。

已部署机升级：只更新 Node 控制面并重启一次 Node，无需 `wrap-cli/sync`，二进制不变。已部署机的 `routing.json` 首次加载时已补过 quota，不用改；不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.126 — 2026-10-09

- 流空闲上限可在面板「重试与切号 → 流空闲超时」配置（`failover.stream_idle_timeout_ms`，默认 180 秒，30 秒–60 分钟；未配置时用 `KIN_STREAM_IDLE_TIMEOUT`）。网关、`kernel.json` / `worker.json` 的 `idle_timeout_seconds` 与 kernel job 看门狗共用这个值。保存后热写各槽 `kernel.json`，运行中的 rust kernel 在空闲时自动重启以读取新看门狗值（#305）。
- kernel job 看门狗读的是不带前缀的 `JOB_IDLE_SECS`，此前文档里的 `KIN_JOB_IDLE_SECS` 从未生效。槽内 `kin-kernel` 启动脚本现在从 `kernel.json` 读取并导出它。crag 数据面与无启动脚本的槽仍是默认 180 秒；go 引擎槽的 `worker.json` 在下次启动时才更新。
- 工具参数流式下发开关 `failover.eager_tool_streaming`（默认关，面板「重试与切号」）。开启后给自定义工具加 `eager_input_streaming: true`，上游边生成边下发大参数，避免长 `Write` 静默超时；服务端工具不动，客户端自带的值优先（#305）。
- 统计页与日志汇总的缓存命中率分母按每行口径计算：Claude 为 input + 缓存读 + 缓存写，Codex / OpenAI 的 input 已含缓存；混用提供商按 prompt token 加权（#302，关闭 #301）。

已部署机升级：更新 Node 控制面并重启一次 Node。`share/wrap-cli/kin-kernel` 启动脚本变了，**需要 `wrap-cli/sync`** 才能让看门狗跟随面板值（逐槽重启 dataplane，不要 `docker rm`）。kernel、cli-node 等二进制不变。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`；新配置项缺省即旧行为。

## 1.3.125 — 2026-10-08

- 托管密钥可以限定平台和勾选的虚拟机（`group_type` = all / anthropic / openai + `allowed_vms`）。调度、故障转移、Codex 选槽、`count_tokens` 与 `/v1/usage` 只落在范围内的槽；调用另一平台返回 403 `key_group_mismatch`。新增迁移 `032_api_key_group_type.sql`。
- 一台完成的槽可以导出成 `vm2api-vm-package` JSON，再导入。id 被占用时顺延到下一个空号，SOCKS5 写入代理池并绑定，然后启动、排队初装、探测。账号页可以下载、导入并覆写这一台，不改 id。
- 创建槽不再预填美国时区。没有 SOCKS5 地理探测结果时显示「时区未配置」；创建、包导入或启动绑定出口后，没有时区的槽写入出口时区。手改仍会钉住，不被后续绑定覆盖。
- 普通用户导入包只能绑定自己的 SOCKS5，不能绑定本机直连或平台/他人的同凭据出口（403 `proxy_forbidden`），包里的 `seed_policy` 不生效；`package` 不能用作槽 id。运行中的槽覆写包后重载 worker。
- 修复 Codex 工具参数在 done-only、完整 item 和 completed 快照中丢失的问题（#293）。API backend 与槽位出口均按整条响应保存工具状态，支持并行工具、稳定索引、缺失后缀补发和终结去重；Anthropic 转换输出真正的 `tool_use`。已发送参数与最终快照冲突、或参数不是 JSON 对象时，流式与非流式都返回结构化 502，不把有 usage 的失败计为成功。
- Claude Code Messages 的 `thinking.display=updates` 与 `dangerous_tool_use` safeguards 分别带匹配的 thinking-display-updates / dangerous-tool-use beta（#296、#297）。门控经 kernel 已有 body 通道交给 CLI，在 SDK 最终构造请求时生成 header；不删除合法字段或换成 summarized，不用 afk-mode 替代 safeguards gate。
- 以 2.1.293 的实际请求与协议定义核对出站参数：保留调用方 thinking、output_config、工具开关和其他合法顶层字段；分离通用、模型能力、按字段与调用方 opt-in 的 beta，不再常开旧版可选功能。保留 setup-token 精简基线、API-key/OAuth 边界和 Haiku 5.5 adaptive thinking；fast-mode 只随支持模型的显式 fast 请求开启。
- Node、CLI 与 OAuth 换票二进制的 SDK 出站指纹对齐 `0.128.0`，不是 SDK 依赖升级。Bootstrap 继续只带 OAuth beta，不套用 Messages 列表。
- 槽内 kernel 副本 `share/wrap-cli/kin-kernel.bin` 与 `bin/kin-kernel` 对齐（1.3.123 只换了主文件）。`wrap-cli/sync` 本来就用主文件，槽内实际运行的 kernel 不变。

已部署机升级：更新 Node 控制面并重启一次 Node，迁移 032 启动时自动执行。`share/wrap-cli/cli-node` 与 `bin/kin-oauth-auth` 字节会变，**需要 `wrap-cli/sync`** 更新驻留 CLI（逐槽重启 dataplane，不要 `docker rm`）。kernel 无需重编。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.124 — 2026-10-08

- 决策模型不再把「引用系统提示 / 复制技能名」当成破限或诱导。综合题只看色情、暴力和破解软件授权。渗透题只有明确的攻击目标才算。面板里仍是旧内置题面的，读配置时换成新题面；改过的句子保留。
- 只有一道题落在阈值下方 0.08 以内时不拦。两道题都低于阈值，或一道题明显更低，仍然拦。
- Jev 拦截不再写入拒答缓存。已经记成「请求被协议拦截」的指纹和相似命中也不再短路，下一次重新打决策模型。硬正则本来就不进这张缓存。
- 蒸馏针不再把单独的 `<think>`、`</think>` 当蒸馏。近 24 小时 420 条命中全是贴进来的 `<assistant>` 思考记录，没有一条是「按该格式作答」的模板。`Respond in the following format: <think>` 仍拦。面板里若还留着这两个裸标签，加载时丢掉。

已部署机升级：只更新 Node 控制面，重启一次 Node。不必 `wrap-cli/sync`，不必重启槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.123 — 2026-10-08

- Claude Code 出站身份对齐 2.1.293。UA、`CLAUDE_CODE_VERSION`、槽内 cli-node、kernel 缺省和换票二进制都是 `claude-cli/2.1.293`。CCH 种子不变。
- 模型列表加入 `claude-haiku-5-5`。原生 1M，`max_tokens` 128000/128000，默认 effort `medium`，知识截止 June 2026。裸 `haiku` 仍是 Haiku 4.5。三方回退 Haiku 4.5，没有 gateway id。
- `thinking.budget_tokens` 改成 adaptive。`disabled` 只在 effort 为 high 及以下保留。
- 计费 haiku_55：$0.10 / $0.50，缓存写 5m $0.125、1h $0.20，缓存读 $0.01。prompt 超过 10 万 token：输入 $0.50、输出 $2.50、缓存读 $0.05，缓存写 1.25× / 2×。

已部署机升级：更新 Node 控制面并重启一次 Node。`share/wrap-cli/cli-node`、`bin/kin-kernel`、`bin/kin-worker`、`bin/kin-oauth-auth` 字节会变，**需要 `wrap-cli/sync`**（逐槽重启 dataplane，不要 `docker rm`）。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.122 — 2026-10-08

- 确定性蒸馏正则只放在硬前置，类别是 distill。保存蒸馏配置不再把这组正则补回去。命中仍是 403 `distill_blocked`。它们跟蒸馏总开关走，不跟硬正则开关：关掉硬正则仍拦这些短语，关掉蒸馏拦截则放行。官方客户端和 0 注入仍拦。针、指纹和结构收割留在蒸馏检测器。
- gpt 模型只跳过 distill 类硬规则。同一句里后面的硬规则仍然生效。
- 放行原因按实际检查来记：规则扫过是 `regex`，蒸馏和硬正则都关、决策模型又没配地址是 `unchecked`，模型连不上是 `fail-open`。
- 协议页「今天」显示请求、拦截、放行、Jev 清洗和 Jev 拦截。点详情可按来源看每条规则的命中词、规则和数量。
- 硬正则已经拦住的请求不再写入拒答缓存。`phishing kit` 进硬规则，安全课里的 phishing 讲解不命中。

已部署机升级：只更新 Node 控制面和 `web/dist`，重启一次 Node。kernel / `cli-node` / `kin-worker` / `kin-egress` / `kin-codex-kernel` 与 1.3.121 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.121 — 2026-10-08

- `official_full` 只在 Opus/Sonnet 5 把调用方 system 放进对话中的 `role=system`。Haiku 和 Claude 4.x（含 opus-4-6、sonnet-4-5）留在顶层 `system`，避免上游 400 `role 'system' is not supported`。
- 官方初装不再强制 `CI=1`。hello 空输出或非法 JSON 记失败，不再把空 stdout 当成成功。
- 自定义工具的 `eager_input_streaming` 布尔值原样保留，缺省不补。
- 已提交给客户端的 Claude 流如果上游中途断开且不是超时、也不是未完成的 thinking 块，补 `stop_reason=max_tokens` 收尾。日志仍记 `stream_incomplete`。
- 非官方请求不再因为正文里出现或消失「搜索 / search」而增删 `web_search`。显式开关和已回放的搜索结果不变。

已部署机升级：覆盖控制面并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.120 — 2026-10-07

- 内核线协议去掉 `kin_` 前缀，和已经发出的 cli-node 对齐。帧是 `host_ready`、`slot_ready`、`job_start`、`job_done`、`job_error`、`stream_event`、`response_headers`、`cancel_ack`。头是 `x-internal-token`、`x-terminal-state`、`x-usage`、`x-model`、`x-stop-reason`、`x-rate-limit-headers`。新内核只给子进程设 `CLAUDE_CODE_NATIVE_SLOTS`。`kin-codex-kernel` 的内部鉴权头同样改成 `x-internal-token`。
- cli-node 守护在槽还没 sync 时仍认旧的 `CLAUDE_CODE_KIN_NATIVE_SLOTS`，不把现网内核 CLI 当泄漏杀掉。两边同时在时留无前缀的那个。
- 协议入口的硬正则可以在拦截页改、关、删，或恢复内置。`vmpanel-keygen`、`ssh-keygen` 不再命中 `keygen`。每条请求记下是哪道闸拦截或放行：蒸馏、硬正则、拒答缓存、Jev 判安全、正则未命中、模型故障放行。判定顺序不变。
- Codex `web.run` 的 `POST /v1/alpha/search` 和 `/alpha/search` 由 GPT 槽转到 ChatGPT `alpha/search`。没有 hosted web_search 的模型，缺这条路由时一轮搜索会整段失败。要调用方密钥。401/403 先沿用槽里已经刷新的 token，否则该槽只刷新一次再重试。额度、鉴权和 5xx 换下一个 GPT 槽。
- 控制台侧栏收成监控、资源、协议、系统。总览不再内嵌统计图，统计、日志、用量各自一页。厂商图标按变体单独引入，去掉未生效的 Google Fonts。带内容哈希的 `assets/` 用长期 `immutable` 缓存，`index.html` 仍是 `no-store`。

已部署机升级：更新 Node 控制面和 `web/dist`，重启一次 Node。替换 `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin`（sha256 `c59a1292…`，两者相同）以及 `bin/kin-codex-kernel`（sha256 `11c8ec08…`）。**需要 `wrap-cli/sync`**（逐槽重启 dataplane，不要 `docker rm`）。`cli-node` 与 1.3.119 相同，不要换。1.3.119 写的「不要替换 `kin-kernel`」到此为止，这次必须换内核。启动时跑迁移 `031_usage_logs_intercept.sql`（`usage_logs.intercept`）。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。`kin-worker` / `kin-egress` 与 1.3.119 相同。

## 1.3.119 — 2026-10-07

- 修复 1.3.118 的 cli-node 与现网 kin-kernel 不配套：内核启动参数仍是 `CLAUDE_CODE_KIN_NATIVE_SLOTS` / `CLAUDE_CODE_KIN_HOST_REFRESH`，新 CLI 只认去掉 `KIN_` 的名字，于是落到官方 `--print`，空 stdin 报 `Input must be provided either through stdin or as a prompt argument when using --print` 后退出，内核反复重启也起不来。现在两套名字都认，先进入 native stdin 循环。

已部署机升级：只换 `share/wrap-cli/cli-node`（sha256 `5d0f966c…`），**需要 `wrap-cli/sync`**（逐槽重启 dataplane，不要 `docker rm`）。不要替换 `kin-kernel`。控制面源码与 1.3.118 相同。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.118 — 2026-10-07

- 官方初装 `/usage` 对齐槽内 cli-node 2.1.284。print 模式不再把交互式 `/usage` 丢掉，改为回写 `GET /api/oauth/usage` 的全部窗口：`five_hour`、`seven_day`、`seven_day_sonnet`、`seven_day_opus`、`seven_day_oauth_apps`、`extra_usage`（含 `monthly_limit`、`used_credits`）。两个主窗口加上任一具名字段即算完整，不再因为没有旧的 Fable `limits[]` 重试失败。
- 初装、常驻、面板终端和 `setup-token` 改设源码实际读取的 `CLAUDE_CODE_HOST_REFRESH=1`、`CLAUDE_CODE_VERSION=2.1.284`、`USER_TYPE=external`。
- 构建产物目录 `dist/` 不入库。

已部署机升级：更新 Node 控制面（`src/`、`scripts/`）并重启一次 Node。`share/wrap-cli/cli-node` 字节变化（sha256 `2a4c89c5…`），**需要 `wrap-cli/sync`**（逐槽重启 dataplane，不要 `docker rm`）。kernel / `kin-worker` / `kin-egress` / `kin-codex-kernel` 与 1.3.117 相同。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.117 — 2026-10-07

- 控制台账号池、配额、粘性改为主次摘要与完整配置弹窗；运行明细按需展开。弹窗取消不污染草稿，「应用到草稿」与全局「保存」分开，VM 本槽保存单独生效。
- 新增独立 `codex.quota`：OpenAI 5h/7d 本地闸线、并发、RPM、对话窗口在准入时生效。Claude 分档保存不改 OpenAI 限额。软闸调整不切断在飞流，不清除上游硬限制或人工关闭。
- OpenAI VM 可单独设 `max_sessions`。缺少 `codex.quota` 的旧配置在启动时补上，不覆盖凭证或操作员开关。
- 网关自己合成的 429（`fable_requires_max`、`pool_rate_limited`）不再把账号标成 5 小时额度用尽。真正的上游 429 和 `You've hit your limit` 仍记额度。
- Codex `POST /v1/responses` 流的 SSE 事件名改为 payload 的 `type`（`response.created`、`response.output_text.delta`、`response.completed`），不再每帧都是 `event: response`。

已部署机升级：只更新 Node 控制面与 `web/dist` 并重启一次。启动时若 routing 里没有 `codex.quota` 会补上，不覆盖已有限额和凭证。不要手改或覆盖 `routing.json`、`vms/`、`data/`、`.env`。kernel / `cli-node` / `kin-worker` / `kin-egress` / `kin-codex-kernel` 与 1.3.116 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽。

## 1.3.116 — 2026-10-07

- 协议入口收成一条前置闸门：蒸馏硬规则、去掉 system-reminder 并按需展开 base64 后的硬正则、拒答缓存、决策模型。决策模型走 `/v1/systemone`，题库默认六题一起问（综合、色情、破限、逆向、渗透、网络攻击），高分表示安全，任一题低于阈值拦截。题库可在面板增删改。阈值、去重、送模长度、失败放行都可配。最多 8 把 key，401 / 429 / 529 换下一把。Jev、本机 Laya、ModernBERT 共用这套。模型故障默认放行。
- 上游内容错误码（`content_policy`、`content_filter`、`cyber_policy`、`moderation_blocked`、`safety_violation`、`usage_policy`）和 Usage Policy 文案一样永久写入拒答缓存。拒答守卫开启且封禁 device 时，蒸馏、硬正则、模型违禁和这些错误码都会封禁入站 device id。

已部署机升级：只更新 Node 控制面与 `web/dist` 并重启一次。无迁移。`routing.json` 不用改。kernel / `cli-node` / `kin-worker` / `kin-egress` / `kin-codex-kernel` 与 1.3.115 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.115 — 2026-10-07

- 某一档的常驻约束开关打开后，这段文字会写进该档的 agent 块。保存的模板即使丢掉了 `{{agent_standing}}`，也不会再跳过。其它档的开关仍然分开，面板不再因为模板未引用而锁死这个开关。

已部署机升级：只更新 Node 控制面并重启一次。无迁移，`routing.json` 不用改。kernel / `cli-node` / `kin-worker` / `kin-egress` / `kin-codex-kernel` 与 1.3.114 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.114 — 2026-10-07

- 拒答缓存除精确指纹外，用户正文 MinHash 估计 Jaccard ≥ 0.90 也在 hop 前返回 503 `refusal_guard`。比较的是用户轮次，不含共享 system，短于 512 字的正文不做近似。一条约 5 万 token 的拒答，改掉大约一成仍会被拦住。面板可关掉近似，或把阈值改成 80/85/90/95。
- 拒答守卫命中（精确、近似，或上游内容拒答入库）后，永久封禁该入站 session 的 device id。之后同一 device 的任意 prompt 都不再 hop。空 device、短于 8 字符的值不封。面板可关闭封禁，并查看、解除或清空。`DELETE /api/panel/refusal-device-blocks` 同样可解封。

已部署机升级：只更新 Node 控制面并重启一次。启动时跑迁移 `030_refusal_near.sql`（拒答表增加 `signature`，新建 device 封禁表）。`routing.json` 不用改。kernel / `cli-node` / `kin-worker` / `kin-egress` / `kin-codex-kernel` 与 1.3.113 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.113 — 2026-10-07

- Claude Code Usage Policy `API Error`（`unable to respond` / `legal/aup`，内核常报成 HTTP 400 `upstream_invalid_request`）不再当无效请求，也不再 `repair-and-retry` 或换号。客户端改为 503 `refusal_guard`。该 prompt 永久写入拒答缓存（`expires_at` 为空），相同 model + prompt 在 hop 前拦住。账号不因此冷却。`stop_reason=refusal` 的缓存命中也改为 503。

已部署机升级：只更新 Node 控制面并重启一次。无迁移，`routing.json` 不用改。kernel / `cli-node` / `kin-worker` / `kin-egress` / `kin-codex-kernel` 与 1.3.112 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.112 — 2026-10-07

- 修复 GPT/Codex 槽在长输出时客户端收到空回复（日志里是 `codex_upstream`、HTTP 200、0 token，客户端反复重试）：`kin-codex-kernel` 原来用子串匹配整帧来判断 `response.completed` / `response.failed` / `"status_code":429`，而 `*.done` 帧（`response.output_text.done`、`response.function_call_arguments.done` 等）里带着整段生成内容，正文一提到 `response.completed`，内核就提前断开 websocket，丢掉后面的 `output_item.done` 和 `response.completed`（含 usage）。现在只认顶层 `type`（`response.completed` / `response.incomplete` / `response.failed` / `error`）或顶层 `status_code: 429`，和 codex-proxy-rs 一致。
- 控制台侧栏左上角版本号不再被截断：版本号（发布说明链接）单独占一行、字号加大，过长时换行；GitHub 链接移到下一行。
- 重建控制台产物。

已部署 x86 机升级：换 `bin/kin-codex-kernel`（sha256 `98715a2f…`）并更新 `web/dist`。替换后停掉 `kin-codex-kernel` 进程，再重启一次 Node：Node 留着它自己拉起的内核子进程句柄，只杀进程不重启 Node 的话，该槽会一直 503。无迁移，`routing.json` 不用改。kernel / `cli-node` / `kin-worker` / `kin-egress` 与 1.3.111 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.111 — 2026-10-07

- 控制台「设置 → 账号池」重做：顶部「实时态势」显示 Claude 席位占用 / 宽限、各 VM 排队、全局排队与 `queue_max`，并按草稿策略预估下一席落点（席位 SSE 实时更新）；参数分为开席策略（平衡 / 填充示意卡、手动开关优先）、席位（全局席位上限 `inference.session_slots` 从「协议 → Claude 内核」移到这里、宽限、每席位预算预留阶梯图）、排队（排队上限、粘性 / 全局等待、总重试时限时间轴）、重试与切号、熔断（流程示意），滑块 + 常用档位 + 一键恢复默认，范围与后端规范化一致。
- 「设置 → 配额」三个分档并排编辑，5h / 7d 闸线轴上标出本档各 VM 当前用量；5h / 7d 闸、周仓拆分改为说明卡片，并写明闸线与预调度余量的关系。
- VM 详情「运行」栏的并发 / RPM、Session 槽位、配额三块合并为「调度」块（席位格、排队、并发、RPM、席位上限、调度等级、配额闸，覆盖项高亮），一个「调度配置」弹窗可逐项选「跟随」或「本槽」；5h / 7d 用量条标出生效闸线。
- `PATCH /api/panel/vms/:id`：`max_concurrency` / `max_rpm` / `session_slots` 传 `null` = 去掉本槽覆盖，立即落回分档 / 全局值。VM 行新增 `concurrency_override`、`rpm_override` 与 `scheduling_inherited: { max_concurrency, max_rpm, session_slots }`。
- 修复 setup-token / 伪装路径重建 `anthropic-beta` 后丢掉 `thinking-display-updates-2026-08-18`，请求体仍带 `thinking.display: "updates"` 导致上游 400：出站头没有该 beta 时改写为 `omitted`（`summarized` / `omitted` 不动）；cli-hop 只做这一项改写，仍不跑完整 beta 清洗，`role=system` 轮次不被提升。
- 重建控制台产物。

已部署 x86 机升级：更新 Node 控制面（`src/`）与 `web/dist`，重启一次 Node；无迁移，`routing.json` 不用改。kernel / `cli-node` / `kin-worker` / `kin-egress` 与 1.3.110 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。全局席位上限的设置入口从「协议 → Claude 内核」移到「设置 → 账号池 → 席位」。

## 1.3.110 — 2026-10-06

- Claude 号池新增预调度（席位规划）：席位按入站 device 计（device id → metadata `session_id` → `cache_control: ephemeral` 内容哈希 → IP + UA + system + 首轮内容哈希，API key 不参与；一次性短探测不占席位）。同一 device 的并发请求共用一个席位、共享 VM 并发，在 VM 内按到达顺序等待，不拆到两台 VM。席位数沿用 `session_slots`（VM 覆盖 → 全局，上限 20）；最后一个请求结束后保留 `pool.seat_grace_ms`（默认 30 秒）；开新席位要求 5h/7d 余量 ≥ (已占 + 1) × `pool.seat_budget_reserve_pct`（默认 2%）。新 device 先回粘性 VM，否则按策略 `balanced`（占用率最低）或 `fill`（已占最多未满）开席位，同级比余量；都满时进全局 FIFO，新到请求不插队。诊断 pin 照旧绕过。跨 VM 换号时旧席位立即释放并在新 VM 开席位、更新设备绑定。
- `routing.pool`：`strategy` 只保留 `balanced` / `fill`，旧值（WRR / 轮询 / LRU / fill-first）读出为 `balanced`；新增 `queue_max`（默认 50，1–999，计入全部 Claude 排队请求：全局队列、各 VM 席位 / 并发队列、冷却 / RPM 等待；满了立即拒绝不入队）、`seat_grace_ms`（0–120000）、`seat_budget_reserve_pct`（小数，0–0.5）；删除 `max_waiters_per_account`。设置保存热生效，不再重建调度器。
- 号池排队超时 / 排队已满 / 等待用完由 429 `rate_limit_error` 改为 **529 `overloaded_error`**（code 仍为 `pool_overloaded`，新增内部原因 `pool_queue_timeout`），总带 `retry-after`（≥ 1 秒，优先取席位宽限到期）。SLA 统计照旧不计为失败；通知日报新增 529 计数。Codex/GPT 槽不变。
- 删除 Claude 会话窗口：档位与 VM 配额覆盖的 `max_sessions` / `session_idle_min` 及其准入判断移除（旧值读入时忽略），可用性不再出现「会话已满」。Codex 的 `max_sessions` 不变。
- `/api/panel/vms` 的 Claude 行改为 `seats_used` / `seats_max` / `seats_grace` / `queue_depth` / `conc_waiting`，不再带 `sessions` / `session_active` / `session_max`（Codex 行保留）；响应新增 `pool_queue: { global_queue_depth, queue_max }`。SSE `event: seats` 载荷改为 `{ seats, global_queue_depth, queue_max, ts }`，去掉 `holds`。
- 状态码语义统一（429 = 调用方 / 上游限额，529 = 容量，503 = 没有合格账号）：剩余账号全部处于上游 529 过载冷却时返回 529 `pool_overloaded`、全部处于上游 429 限流冷却时返回 429 `upstream_rate_limit`（都带 `retry-after` = 最早恢复时刻），不再一律 503；最后一跳内核槽忙 `slot_busy` 改为 529 `pool_overloaded` + `retry-after`；上游 429 透传上游 `retry-after` 响应头，上游 529 总带 `retry-after`。`count_tokens` / `GET /v1/usage` 的 Fable 无 Max 账号改为与 Messages 相同的 429 `fable_requires_max`，号池与上游 429/529 映射和响应头与 Messages 一致。Codex 槽 429 `pool_overloaded` 一律带 `retry-after`（≥ 1 秒）。日志错误类：无错误码的 503 归「无可用账号」、`kernel_unavailable` / `restore_in_progress` 归「其它」；面板总览错误率提示补 529，日志状态筛选补 503 / 529。
- 熔断配置 `pool.circuit_failure_threshold`（1–20）/ `pool.circuit_open_ms`（≥ 1000）读入即规范化，0 或非法值写成实际生效的默认 3 / 30000，面板显示与熔断器一致；上游 500/502/503（及非超时 504）进熔断的规则不变。席位键按资源归属（平台 / 用户）隔离，不同归属复用同一 device id 不会互相释放席位。（#258）
- 修复对运行中的本地槽做重载 / 启动（改代理、换绑、导入凭证、官方初始化、`/vms/:id/reload`、start）时总是 `docker rm -f` 重建容器：存活判断原来看从未被绑定的 `run/worker.sock`，现改看 PID1 内核绑定的 `run/kernel.sock`，健康槽改为 `docker restart`，不再换容器（#256）。
- 修复遥测 sidecar 丢失后不会恢复：本地槽 `docker restart` / `docker start` 后补起 `kin-worker telemetry`；内核看门狗每 10 分钟检查一次各槽，已启用遥测但容器内没有 sidecar 时重新拉起（覆盖 Docker 自动重启、宿主机重启、sidecar 因 4xx 自行退出）。检查放在看门狗关键路径之外，不拖慢内核重启判断（#257）。
- 重建控制台产物。

已部署 x86 机升级：更新 Node 控制面（`src/`）与 `web/dist`，重启一次 Node；无迁移，旧的 `routing.pool` / 档位 / VM 配额字段读入时自动规范化（不用手改 `routing.json`）。kernel / `cli-node` / `kin-worker` / `kin-egress` 与 1.3.109 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。客户端注意：号池容量不足改为 529 `overloaded_error` + `retry-after`（原 429），全部账号冷却时按原因返回 529 / 429（原 503）。

## 1.3.109 — 2026-10-05

- 修复 Claude VM 席位（`session_slots`）按在飞请求数计数：同一会话的并发请求共用一个席位，占用数改为不同席位数；VM 已满时，已占席位的会话的新并发请求仍可进入，新会话照旧等待（`session_slots_full`）。实际并发仍受 `max_concurrency` 限制。席位在该席位最后一个请求结束后释放。
- `/api/panel/vms` 的 Claude 行新增 `seats_used` / `seats_max` / `queue_depth`，来自调度器实时席位簿与等待队列；`session_active` 仍是保留到 `session_idle_min` 的会话窗口计数，两者分开展示。VM 列表与详情卡的「在飞」不再用 `session_active` 兜底。
- 新增面板 SSE `GET /api/panel/pool/stream`（需面板登录；`user` 只收到自己可见的 VM）：席位占用/释放、入队/出队后约 250ms 推送 `event: seats` 快照，15s 保活。VM 列表页订阅后即时更新席位与排队数；断线期间仍按 5s 轮询，5s 后自动重连。
- 删除 VM 后用量页和总览不再列出、也不再把该槽计入账号数、请求 / token 合计、5h / 7d 峰值和近限额。`accounts` 行仍保留；账单历史继续用全表，已删槽的花费仍带邮箱（#252）。
- 修复「设置 → 通知」测试邮件 / Telegram：`POST /api/panel/notify/test` 补上 `mergeNotifyConfig` 与 `sendNotifyTest` 的导入，不再 `ReferenceError`（#254）。
- 重建控制台产物。

已部署 x86 机升级：更新 Node 控制面（`src/`）与 `web/dist`，重启一次 Node；无迁移。kernel / `cli-node` / `kin-worker` / `kin-egress` 与 1.3.108 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。#248 未进入本版。

## 1.3.108 — 2026-10-05

- 修复长会话续聊回放网页搜索历史时偶发直接返回 400 `Invalid encrypted_content in search_result block`：这条 400 本应把搜索历史转成纯文本后在同槽修复重试一次，但长转录上游要 3–4 分钟才回 400，已超过 120 秒总重试期限，修复跳被丢弃。修复跳现不受已用尽的总期限拦截（等座最多 30 秒，仍只修复一次）。
- 出站请求体 / 请求头只在「设置 → 日志」的 Debug 模式下保存；请求头 `x-kin-debug` / `x-kin-log` 触发的单次 debug 只保存入站请求体与响应，不再保存含网关改写（persona / overlay）的出站请求体，避免租户读到（#250）。

已部署 x86 机升级：只更新 Node 控制面（`src/`）与 `web/dist`，重启一次 Node；无迁移。kernel / `cli-node` / `kin-worker` / `kin-egress` 与 1.3.107 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.107 — 2026-10-05

- 面板 `/logs`：详情改为居中弹窗（概览 / 决策链 / 性能 / 原始数据），整行可点击或键盘 Enter / Space 打开，全屏模式下也能打开；修复表头与数据行错位（#247）。
- 日志记录实际发给上游的出站 Session：迁移 `029` 给 `usage_logs` 加可空列 `outbound_session_id` 及索引；Session 列改为「出站 Session」，客户端会话另列为 `clientSessionId`，按会话筛选匹配两者任一，活跃会话与概览按出站会话统计。此前的历史行出站 Session 为空（#247）。
- Debug 模式额外记录回给客户端的状态码、响应头（脱敏）与响应体（脱敏、按 `KIN_REQUEST_LOG_DEBUG_CHARS` 截断）；出站请求体按本次请求的日志模式保存，`x-kin-debug: 1` 单次 debug 也能看到；Codex 路径补存出站请求体 / 请求头（#247）。
- 日志的供应商决策链与活跃会话只取调用方自己的数据（#240）。
- 重建控制台产物。
- 实验性 ARM64 控制面（#243，@SmileYangzy）：Node、Python、Docker CLI、Go worker / egress 原生 ARM64，slot 仍为 `linux/amd64` 经 QEMU 运行；`deploy/prepare-arm64.py` 事务式准备固定版本的 `qemu-x86_64` binfmt handler；`docker-compose.arm64.yml` / `deploy/Dockerfile.arm64-control` 支持源码构建。桥接槽位到本机 egress 的 REDIRECT 流量补限定 bridge / 子网 / helper 端口的 INPUT 放行规则。
- 发布分架构：控制面镜像新增单架构 `vX.Y.Z-amd64` / `vX.Y.Z-arm64`，`vX.Y.Z` / `latest` 改为包含两者的多架构清单；Release 新增 `kin-worker-linux-arm64`、`kin-egress-linux-arm64`。无后缀附件仍为 linux amd64，名称不变。
- 版本参数可带 `-amd64` / `-arm64`（及 `-x86_64` / `-aarch64`）后缀：一键脚本与面板一键更新都剥离后缀取版本号，与宿主架构不符时拒绝。ARM64 上写入 `VM2API_IMAGE_TAG=vX.Y.Z-arm64`；amd64 仍写不带后缀的 tag。
- `install.sh` 按 `uname -m` 识别架构，ARM64 自动下载并执行 QEMU 准备，旧版本无 ARM64 发布时直接报错；`status` 显示架构与镜像 tag。安装时 `.env` 补 `VM2API_HOST_ROOT`（只填空），`--dir` 非默认目录的面板一键更新也能挂到正确宿主目录。ARM64 源码安装与 `deploy/init-arm64-env.py` 写入 `COMPOSE_FILE`，面板一键更新在 ARM64 源码安装缺该项时拒绝执行。
- QEMU 下 slot 进程的 `/proc/<pid>/exe` 是模拟器：终止数据面进程与 PID 1 拓扑判断改按 `argv[1]` 识别，ARM64 主机上 kernel 重启不再残留旧 cli-node / kernel。

已部署 x86 机升级：更新 Node 控制面（`src/`）、`web/dist` 与部署脚本，重启一次 Node；迁移 `029` 只加列，启动时自动执行。kernel / `cli-node` / `kin-worker` / `kin-egress` 与 1.3.106 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.106 — 2026-10-05

- Web「代理 → 管理」新增「关闭 DNS type 64 / 65」开关，配置 `dns_disable_svcb_https` 为布尔值，默认关闭并持久保存。
- 开启后向 SOCKS5 透明出口下发 DNS 覆写参数 `dns_empty_types: [64, 65]`，SVCB（64）与 HTTPS（65）查询返回 `NOERROR` 空答案，不请求上游；A、AAAA 等其它查询正常转发。关闭后恢复正常查询，UDP / TCP 均支持。
- 保存后重载本机已绑定出口；集群出口在下次槽位启动或重载时读取新设置。本地直连出口不使用此设置。
- 重编 `bin/kin-egress`，重建控制台产物，增加配置持久化、API 和 DNS 服务回归测试。

已部署机升级：更新 Node 控制面（`src/`）、`web/dist` 和 `bin/kin-egress`，重启一次 Node。kernel / `cli-node` / `kin-worker` 与 1.3.105 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。DNS 开关变化会重载本机已绑定出口；集群节点需更新出口镜像后，在下次槽位启动 / 重载时生效。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.105 — 2026-10-05

- 面板 `/logs` 重写为滚动日志（虚拟滚动、分组筛选、详情抽屉、供应商链、费用明细、活跃 Session），新增 `/statistics` 统计页（今日 / 7 天 / 30 天 / 本月，按用户 / 密钥 / 模型 / 槽位聚合与排行榜）（#239）。新接口 `/api/panel/usage-logs*`、`/api/panel/statistics*` 只读；`user` 角色只看本人数据，统计维度仅 `key` / `model`。迁移 `027` 给 `usage_logs` 加可空列 `session_id`、`reasoning_effort`，此前的历史行不参与会话筛选。
- 代理池支持代理名称（#235）：编辑弹窗可填「代理名称」，列表、槽位、授权面板显示「名称 · host:port」；只改名称不重载已绑槽位。迁移 `028` 给 `proxies` 加可空列 `label`。
- 修复无调用方会话 ID 时，首条 user 第一块是逐字固定的 `<system-reminder>`（日期、工作目录）会让同一天同一目录的不同会话共用一个粘滞槽和同一个出站 session（#236）。粘滞指纹与出站 session 种子现取首条 user 中第一个不是纯 `<system-reminder>` 的文本块；全是 reminder 时仍取第一块。后续块照旧不参与，同一会话逐轮增长不会新开槽。计费 / persona 使用的首条文本不变。
- Codex `outbound_session: passthrough` 且入站没有会话 ID 时，不再发 `null`，改用同一套确定性种子派生出站 session。
- 升级后以 reminder 开头、又没有会话 ID 的在途会话会重新绑定一次槽位。
- 修复 API Key 页「复制」在 HTTP（非 HTTPS、非 localhost）访问的部署上提示「复制失败」：浏览器只在安全上下文提供 `navigator.clipboard`。复制现先用剪贴板 API，不可用或被拒时改用选区复制（弹层内也可用）；仍被浏览器拦截时打开密钥弹层，在弹层里再点「复制」，再失败则选中密钥提示按 Ctrl+C。
- 重建控制台产物。

已部署机升级：更新 Node 控制面（`src/`）和 `web/dist`，重启一次 Node；迁移 `027`、`028` 只加列，启动时自动执行。kernel / `cli-node` / `kin-worker` / `kin-egress` 与 1.3.104 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.104 — 2026-10-04

- 修复 1.3.103 起槽内 cli-node 守护进程把非内核的 `-p` 进程一律 SIGKILL：面板运维终端里的 `claude -p`、官方初装的 hello / `/usage` / 常驻以及 `setup-token` 会被杀（终端里显示 `Killed`）。守护现按进程环境识别：内核 CLI 认 `CLAUDE_CODE_KIN_NATIVE_SLOTS`（只留最早一个），初装带 `KIN_OFFICIAL_CC=1`、`setup-token` 带 `KIN_SETUP_TOKEN=1` 的不动，活跃面板会话里的任意 `claude` 不动，其余泄漏进程照旧清理；读不到环境的进程不再误杀。

已部署机升级：更新 Node 控制面（`src/`、`scripts/`），重启一次 Node。kernel / `cli-node` / `kin-worker` 与 1.3.103 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.103 — 2026-10-04

- 修复 Claude 槽内 cli-node 与宿主 Go Refresher 同时换票：两边锁不互斥，并发刷新会重复使用同一 refresh token，后到的一方拿到 `invalid_grant`；CLI 写回还会丢掉 `kinGeneration`/email/account。kernel 拉起的 cli-node 与面板运维终端现带 `CLAUDE_CODE_KIN_HOST_REFRESH=1`，临期或 401 时只重读宿主写入的凭证，换票只由宿主执行。
- 官方初装（hello、`/usage`、常驻）与 `setup-token` 改用槽内 `~/.kin/cli-node`，不再 `curl claude.ai/install.sh` 安装官方 Claude Code；这些进程同样带 `CLAUDE_CODE_KIN_HOST_REFRESH=1`。初装常驻与内核 CLI 同一二进制，改用进程环境标记 `KIN_OFFICIAL_CC=1` 识别和清理，不会误杀内核 CLI。缺 cli-node 时初装报错、`setup-token` 返回 `cli_node_missing`；删除 `scripts/repair-official-cc-bins.mjs`。已装的 `~/.local/bin/claude` 不再使用，可手工删除。
- 重编 `cli-node` 与 `kin-kernel`，重建控制台产物。

已部署机升级：更新 Node 控制面（`src/`、`scripts/`）和 `web/dist`，重启一次 Node；`bin/kin-kernel`、`share/wrap-cli/cli-node`、`share/wrap-cli/kin-kernel.bin` 字节变化，**需要 `wrap-cli/sync`**（逐槽重启 dataplane，不要 `docker rm`）。新 CLI 必须与新 kernel 一起上线。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.102 — 2026-10-04

- 修复 SSH 扩展节点的 SOCKS5 槽在换票提交时启动失败：远端 `egress.json` 字符串先编码为 Buffer，再按字节分块写入 SFTP，避免 `buffer is not a Buffer`；原子替换和 0600 权限不变。
- 修复 Cookie（sessionKey）换票的 authorize 请求漏传 `organization_uuid`，被上游以 400 `Invalid request format` 拒绝；重编 `bin/kin-oauth-auth`，授权码换票协议不变。

已部署机升级：更新 Node 控制面（`src/`）、`bin/kin-oauth-auth` 和 `web/dist`，重启一次 Node。kernel / `cli-node` / `kin-worker` / `kin-egress` 与 1.3.101 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.101 — 2026-10-04

- 修复 OAuth 凭证刷新、落盘更新及 401 恢复触发共享 kernel/CLI 重启，导致同槽其它并发请求断流的问题（#224）。CLI 在创建 API client 前读取最新凭证；刷新后仅重试当前请求，保留在途请求及现有进程。
- 修复启动时读取 VM 摘要中的套餐字段错误，把 Max 槽凭证写成 Pro 的问题（#226）。按已识别的 Max 套餐修复历史 Pro 默认值，保留 token、凭证 generation 和其它有效套餐。
- 修复出口 PID 文件过期或 PID 被复用时误认进程、误发 SIGTERM 的问题（#227）。启动、停止和探测均核对 kin-egress 可执行文件及其配置路径，兼容已替换的可执行文件和等价路径写法。
- 重新构建控制台产物，与当前前端源码保持一致。

已部署机升级：更新 Node 控制面（`src/`）和 `web/dist`，重启一次 Node。kernel / `cli-node` / `kin-worker` 与 1.3.100 相同，**不需要 `wrap-cli/sync`**，不需要重启槽容器。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.100 — 2026-10-04

- 下线控制台压测页（研报并发、能力/答题探针）及对应管理 API（`/api/panel/concurrent-test*`、`/api/panel/probe-test*`）。侧栏不再显示「压测」。虚拟机测试与 `GET /api/panel/test-models` 保留。

已部署机升级：更新 Node 控制面（`src/`）和 `web/dist`，重启一次 Node。kernel / `cli-node` / `kin-worker` 与 1.3.99 相同，**不需要 `wrap-cli/sync`**。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.99 — 2026-10-03

- 修复 GPT 槽（无 `account_uuid`、用量行 `account_id` 等于槽 id 且没有 email）在 VM 页被当成 leftover，累计/窗口费用显示 $0。`lemeryvorhees@gmail.com`（`vm-codex-01`）日志里有费用，`vm-01` 因为用量行带着 email 所以正常。现在 leftover 判定与后端一致：没有 uuid 的槽保留该行；`/usage` 用槽 email 补上；`GET /api/panel/vms` 也盖费用字段。

已部署机升级：更新 Node 控制面（`src/`）和 `web/dist`，重启一次 Node。kernel / `cli-node` / `kin-worker` 与 1.3.98 相同，**不需要 `wrap-cli/sync`**。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.98 — 2026-10-03

- Codex hop 把公开 API 的 `service_tier: "fast"` 改写成官方线值 `priority`，并在 kernel envelope 里带上 Codex 兼容头和 `x-codex-routing-hint`。客户端 Authorization 不转发，由 kernel 贴所选 OAuth。`bin/kin-codex-kernel` 按 codex-proxy-rs 出站契约补齐：body 规范化（`store=false`、string input、system→developer、拒绝字段剥离）、默认 originator/version、≥15MiB 先 HTTP、WS close 1009 不当传输重试、SOCKS5/`socks5h` 含 IPv6 literal。Unix-socket 查询契约不变。已运行的 Codex kernel 进程要重启；不要 `docker rm`。

- Codex 默认 UA / kernel `version` 对齐官方 `@openai/codex@0.160.0`（`codex_cli_rs/0.160.0 (linux x86_64)`）。目录 `auto` 失败时的 fallback 从 0.158.0 改为 0.160.0。开源 UA 形状仍是 `{originator}/{version} ({os} {os_version}; {arch})`；kernel 出站保持 linux amd64 稳定身份。

已部署机升级：更新 Node 控制面（`src/`）、`web/dist`、`bin/kin-codex-kernel`，重启一次 Node，并杀掉已跑的 `kin-codex-kernel` 子进程让新 ELF 起来。kernel / `cli-node` / `kin-worker` 与 1.3.97 相同，**不需要 `wrap-cli/sync`**。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.97 — 2026-10-03

- 修复 Claude Code 2.1.283+ 的 auto mode 分类请求（输出 `<severity>N</severity>`，`stop_sequences: ["</severity>"]`）不被识别为官方流量、被按 `official_full` 改写的问题（#220）。改写后分类提示词被换成官方 CLI 提示词，原缓存标记失效，`max_tokens` 64 被 `min_max_tokens` 抬到 128，费用放大且部分结论被截断。现在官方身份和分类用途共用同一套识别：security monitor 前缀 + 规则段标记，判决格式（`<block>`、`<severity>`、`classify_result`）只决定透传方式，不再参与识别；transcript 拆成多条 user 消息也能识别。kernel 与 cli-node 对 XML 分类的一致性校验同样去掉 `<block>` 要求，只看 “无 `tool_choice` + 含 `<transcript>`”。重编 `bin/kin-kernel`、`share/wrap-cli/kin-kernel.bin` 和 UPX 压缩的 `share/wrap-cli/cli-node`。

已部署机升级：更新 Node 控制面（`src/`）、`bin/kin-kernel`、`share/wrap-cli/kin-kernel.bin`、`share/wrap-cli/cli-node`，重启一次 Node，**需要 `wrap-cli/sync`**。Node 与 kernel/CLI 必须一起更新：只换 Node 时 `<severity>` 分类会被旧 kernel 以 400 `invalid_request_context` 拒绝。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.96 — 2026-10-03

- 修复绑定本地出口（`px-local`）的槽生成授权链接时报「该槽未绑定健康的 SOCKS5」/「虚拟机未绑定 SOCKS5，请先分配代理再生成授权链接」。本地出口没有 SOCKS URL，控制面按约定传空串表示直连，但授权链接入口和 `kin-oauth-auth` 把空串当成未绑定。现在空串按宿主机默认路由直连：授权链接、粘贴授权码换票和 sessionKey 导入都可用于本地出口槽。未绑定出口（`null`）仍拒绝，远程 SOCKS5 行为不变。
- 修复 Cookie（sessionKey）换票（含 Setup Token 运行模式）必定失败，报 `CLAUDE_WEB is not defined`。自 2026-09-27 换票服务重构起，`kin-oauth-auth` 打包产物引用了 `claude.ai` 地址常量却没有定义它，请求 `/api/organizations` 前就抛出 ReferenceError。现已补上常量并重编 `bin/kin-oauth-auth`；sessionKey 导入恢复为先经槽位出口访问 `claude.ai/api/organizations`。授权链接粘贴 code 换票不受影响。
- 修复 Arch 槽（`kin-os-arch`，镜像里没有 `hostname` 命令）「采集特征」一直报 `guest_identity_invalid`，「全槽更新 → 重载并采集」把该槽报为失败。现在没有 `hostname` 时改用 `uname -n`（同一个内核 nodename），有 `hostname` 的镜像行为不变。（#212）
- 修复非 `vm-N` 命名的槽（如 `claude-ios-*`）自愈凭据后 `.credentials.json` 留成 `root:600`，容器用户读不到票据。`slotUidGidFromHomeDir` 原来只认 `vm-N`；现在按槽 ID 走与容器 `--user` 相同的映射（非数字 ID 共用序号 1）。凭据已有 `subscriptionType` 时也会重新校正属主。

已部署机升级：更新 Node 控制面（`src/`）和 `bin/kin-oauth-auth`，重启一次 Node。kernel / `cli-node` / `kin-worker` 与 1.3.95 相同，不需要 `wrap-cli/sync`；从 1.3.94 或更早升级时，仍要按 1.3.95 说明对挂载 `kin-worker` 的槽执行 `docker restart`（不要 `docker rm`）。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.95 — 2026-10-03

- 限额重置的 `reset-status` / `reset-redeem` 固定使用 `claude-cli/<version> (external, cli)`。遥测 UA `claude-code/` 会被上游标成 `ineligible_reason=surface`，查询次数为 0。普通 `/api/oauth/usage` 仍用遥测 UA。
- 面板按平台显示按钮：Claude 槽始终显示「限额查询 / 限额重置」，Codex 槽始终显示「券查询 / 重置券」，不再要求 `credential_mode=oauth`。带 `user:profile` 的转换后 Setup Token 可以查询兑换；官方一年期 token 和 API Key 点查询仍会 400。
- 官方 `claude setup-token`（一年期、仅 `user:inference`、无 refresh）落盘为 `official-setup-token`，面板显示「官方 Setup Token」，与 Cookie/授权链转换的完整 Setup Token 区分。旧文件按 source/flavor/无 refresh+仅 inference 识别。`office-setup-token` 视为同一类型。

已部署机升级：更新 Node 控制面（`src/`）、`web/dist`、`bin/kin-worker`，重启一次 Node，并对挂载 `kin-worker` 的槽执行 `docker restart`（不要 `docker rm`）。kernel / `cli-node` 未变，不需要 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.94 — 2026-10-03

- Claude 完整 OAuth 槽可以查询并兑换原生限额重置。面板在用量窗口和详情额度区沿用 GPT 重置券的「查询 / 使用」按钮，使用前二次确认。`POST /api/panel/vms/:id/claude-reset/query` 只读；`POST /api/panel/vms/:id/claude-reset/redeem` 必须带 `Idempotency-Key`，由服务端选择下一次可兑换的 grant。请求经槽内 worker 出站，响应和落盘都不含 grant / 组织 ID。未确认的兑换会按组织挡住后续兑换。Setup Token 和 API Key 不显示这组按钮。槽内 `kin-worker` 需要带 `reset-status` / `reset-redeem` 的新二进制，只更新 Node 时查询会返回 worker 不支持。
- 修复 Claude Code auto 权限分类请求经过 Node、kernel、native CLI 时被普通请求策略改写的问题。按原始分类约定识别用途并逐 job 传递，保留分类 system/cache、合法 thinking、采样、预算和 stop；支持关闭 thinking 的模型保留显式 disabled。已知必须 adaptive 的 XML 分类只增加一次 2048 token 余量并校验上限。不静默切换客户端指定模型，旧强制工具与模型能力冲突或旧运行时缺能力时明确报错。
- 分类链路保留真实上游错误、request-id/retry-after、JSON 的上游 id/stop_sequence 和正常 max_tokens 终结；零上游执行不消耗执行预算或惩罚账户。日志只保存有界分类摘要。更新 Rust kernel 两份副本及 UPX 压缩的 cli-node，新增跨层分类和旧 CLI 组合回归。
- 修复登录页的导入排序与 JSX 格式，使 web CI 的 Prettier 检查通过；重编控制台。

已部署机升级：更新 Node 控制面（`src/`）、`web/dist`、`bin/kin-worker`、`bin/kin-kernel`、`share/wrap-cli/kin-kernel.bin` 和 `share/wrap-cli/cli-node`，重启一次 Node。**需要 `wrap-cli/sync`** 将配套 kernel/CLI 同步进 Claude 槽；各槽还需更新并重载 kin-worker，才能使用原生限额重置。不要 `docker rm` 槽，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.93 — 2026-10-03

- 槽运维终端启动时把 `CLAUDE_CONFIG_DIR` 指到 `$HOME/.claude`。令牌仍只放在该目录的 `credentials.json`；若缺少官方入口 `.credentials.json` 或家目录 `~/.claude.json`，会话里补上指向 `.claude` 内文件的链接。`claude` 仍启动该槽的 cli-node。
- 换票从授权响应原文提取 `subscriptionType`（`pro` / `max` / `team` / `enterprise`）并写入槽凭证 `claudeAiOauth`。原文没有套餐时用该 VM 已识别的 `account_tier`，仍没有则记 `pro`。重写凭证时保留已有值。
- 新版本启动时给旧凭证补上缺失的 `subscriptionType`（已识别套餐，否则 `pro`），已有值不改。
- 每个 Claude 槽只留内核的一个 `cli-node`。运维终端里的交互进程在会话还连着时保留；断开后若进程还在（cli-node 不响应 SIGHUP）则杀掉。

已部署机升级：更新 Node 控制面（`src/`）和 `share/wrap-cli/cli-node`，并把新 ELF 装进每个 Claude 槽的 `cli-home/.kin/cli-node` 后重启该槽的 cli-node。kernel 未变。不要 `docker rm` 槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.92 — 2026-10-02

- SOCKS5 透明出口的 `dns_primary` 支持自定义 HTTPS DoH URL（域名、IPv4 / IPv6 literal、路径 / 查询参数及端口），仍使用同一字符串设置；设置页可选择 Cloudflare 域名或编辑自定义 URL。自定义上游优先，其后保留原有 fallback 顺序，`auto` 和已有选项行为不变。拒绝 userinfo、fragment、无效主机 / 端口及原始逗号，避免逗号分隔的上游配置被拆成多项。域名经 SOCKS5 代理解析，不新增 DNS bootstrap 或改写传输实现。
- 代理列表 / 配置读取接口仅向管理员返回 `dns_primary`，租户响应省略该字段，避免自定义 DoH URL 的路径 / 查询令牌泄露；其它配置字段及权限边界不变。
- DoH 仅跟随 HTTPS 重定向，拒绝降级到 HTTP，避免自定义解析服务通过 307 / 308 将 DNS 查询转发为明文；正常 TLS 证书 / 主机名校验保持开启。
- VM 详情「运维」tab 新增槽容器终端（Claude 槽；GPT 槽没有容器不显示）：点「打开终端」后经 Docker Engine exec 进入 `kin-xx`，以容器自身用户运行 bash，支持全屏程序与窗口缩放；本机与集群节点槽位走同一路径。鉴权沿用集群终端的 30s 一次性 ticket（`POST /api/panel/vms/:id/shell-ticket`），仅管理员可用，同时最多 8 个会话；断开后清理该会话在容器内的全部进程。终端空行输入 `/usage`（同「探测」，显示 5h / 7d / Fable / Sonnet 窗口）、`/wrap`（重装 wrap-cli 并重启 kernel）、`/reload`（重载 worker）、`/help`、`/clear` 即执行面板快捷指令，上方也有对应按钮；`/usr/bin/...` 之类非指令输入原样交给 shell，vim / less 内不拦截 `/`。反代需对 `/api/panel/vms/<id>/shell` 透传 Upgrade（`docs/DEPLOY.md` 已更新）。集群页终端改用同一组件，行为不变。

已部署机升级：更新 Node 控制面（`src/`）、`web/dist` 和 `bin/kin-egress`，重启一次 Node；依赖、`kin-kernel`、`cli-node` 未变，无需 `wrap-cli/sync`。nginx 把集群终端那条 Upgrade location 扩到 `^/api/panel/(cluster/nodes|vms)/[^/]+/shell$`。

## 1.3.91 — 2026-10-02

- 修复客户端取消后 native CLI 的共享 stdin 被 `await cancelJob` 堵住：取消异步处理，任务真正结束后才 ack，已结束 / 未知 job 的取消也可幂等确认；一个卡住的 slot 不再堵住其他 19 个。内核按 job 状态区分 CLI 已结束与仍占有任务，拒绝错配 / 重复 ack，避免释放正在运行的新 job。
- Node 每次 hop 生成独立 ID，经鉴权 cancel 路由显式取消；提前取消和 HTTP 提交中断均安全处理，完整 JSONL 写入后才执行取消，保留断开连接兜底。
- CLI 原始 HTTP / 网络错误直接保留 code、status、type、message、retry-after，流式与非流式一致；native 请求不再经过交互式错误渲染或隐藏重试 / 非流式 fallback，真实故障不再统一成 `incomplete_response`。新增网络、中断、空流、CLI 和 kernel 故障码；本地故障不罚账号。
- 有界恢复：先关闭未 ack 的 slot 并重发取消，探活共享 stdin，必要时仅重启 CLI（3 次 / 10 分钟，等待 10/30/60 秒）。CLI 恢复耗尽或 kernel 不可达，Node watchdog 才重启容器（3 次 / 小时，等待 1/5/15 分钟）；仍失败则停重启、排除 VM 并通知。请求失败 / slot 忙不再绕过 watchdog 自行重启，cc-node/crag 例外保留。
- 健康字段改为 `healthy` / `unhealthy_reason` / `recovering` / `closed_slots` / `cli_restarts`；旧 `wedged_slots` 移除。更新 `bin/kin-kernel`、`share/wrap-cli/kin-kernel.bin`、`share/wrap-cli/cli-node`；只换 Node 代码不能修复旧槽内进程。上线时需同步这两种新二进制，保留 VM、路由与数据。

## 1.3.90 — 2026-10-01

- 修复 #198：SOCKS5 地址是 IPv6 literal（如 `socks5h://[::1]:1080`）时，Codex OAuth 换票 / 刷新 / 目录、Claude 身份引导、OpenAI 额度、出口地理查询和 `kin-oauth-auth` 换票都在连代理之前报 `getaddrinfo ENOTFOUND [::1]`。根因是 socks-proxy-agent 10.1.0 把 URL 里带方括号的主机名原样拿去连接；Node 侧统一经 `src/lib/vm/proxy-agent.mjs` 建 agent，`kin-oauth-auth` 重新打包同一修复。IPv4 / hostname 代理行为不变。
- 修复 #196：本地出口（`px-local`）的 GPT 槽位，推理由宿主 Codex kernel 自己读 `HTTPS_PROXY` / `ALL_PROXY` 走部署代理，而目录同步、额度、token 刷新、OAuth 换票由 Node 直连，同一账号出现两个出口，直连不通时这些请求失败。现在由 Node 按 kernel 原有顺序（`HTTPS_PROXY` > `https_proxy` > `ALL_PROXY` > `all_proxy`，`HTTP_PROXY` 不用于 https）解析一次，写进 kernel 配置并要求必须走该代理；kernel 启动时去掉继承的代理变量，主机侧请求用同一个地址。HTTP(S) 代理新增 `https-proxy-agent` 支持；代理地址协议不认识时直接报错，不再静默直连。本地 Claude 槽位仍直连。`NO_PROXY` 不再影响本地 GPT 槽位的出口。
- 修复 #197：同一槽位 id 下有旧账号的计费行时（1.3.89 之前的 id 复用，或同一槽位重新登录别的账号），总览计费条不再把旧账号的费用显示成当前账号、也不再出现重复 chip；旧账号显示自己的邮箱，没有邮箱时显示「vm-xx 旧账号」，只有当前账号的 chip 链接到槽位。后端计费行的邮箱改为按账号匹配。

已部署机升级：更新 Node 控制面（`src/`、`package*.json`）、`web/dist` 和 `bin/kin-oauth-auth`，`npm ci --omit=dev`（新增 `https-proxy-agent`），重启一次 Node。已在运行的本地出口 GPT 槽位 Codex kernel 需重启该槽位才会改用显式代理配置。

## 1.3.89 — 2026-10-01

- 集群 VM 放置：存在集群节点时，管理员可把 Claude / Rust VM 创建到 SSH 加入的 VPS。节点槽位使用自包含镜像 `vm2api/kin-slot-<kernel>:<sha12>`，经 SSH streamlocal 管理容器并中继 kernel / worker socket；凭据以节点副本为准，导入推送、刷新拉回。SOCKS5 出口在节点上按槽位成对部署（`kin-02` / `kin-02-egress`，网络 `kin-02-net`），槽位删除或换出口时回收；节点槽位允许使用与内存上限等量的 swap。本机/节点差异收敛到 `slotHost(vm)` 契约；Codex、官方 CC 初始化、wrap 修复/提升、引擎与 auth_scheme 切换在节点上返回 `remote_unsupported`。面板：VM 标出所在服务器（本机 `local`），集群页显示各节点 Docker 运行/总数，节点 Docker 列表按槽位把出口排在一起。新增 `POST /api/panel/cluster/nodes/:id/{preflight,slot-image}`。
- 集群页终端：nginx 必须对 `/api/panel/cluster/nodes/<id>/shell` 透传 `Upgrade`（见 `docs/DEPLOY.md`「反代」）；`Connection ""` 会让终端一直连不上。
- 节点槽位隔离：`~/.claude` 改为独立挂载（宿主侧 `claude/`），控制面对槽位文件的读写不再跟随符号链接（写用 `O_EXCL` 临时文件 + 句柄授权 + rename，读用 `O_NOFOLLOW`），槽内进程无法借符号链接让控制面读取其他槽位凭据或写出槽位目录。已有节点槽位在下次启动 / 重载时自动重建并迁移凭据。
- 节点槽位镜像 tag 只取内容哈希，不再带版本号：只改版本号的发布不会让节点上已有镜像失效。镜像缺失时启动 / 重载会自动在节点上构建（同节点同内核单飞），不再直接报错要求手动准备。
- 导入凭据换票前，把 VM 记录上的出口同步为代理池当前绑定：换票已经用池里的 SOCKS5，记录没跟上时节点槽位会因为没有出口拒绝启动，表现为换票 502。
- 新建 VM 自动编号跳过已删除 VM 留下用量 / 账号历史的序号，新槽位不再显示旧账号和旧花费；创建弹窗名称留空时交给后端编号，不再在前端推算。
- 修复 #194：SOCKS5 IPv6 地址在导入、持久化加载、探测、URL 生成和 endpoint 比较中统一规范化；socket 使用裸 IPv6，URL / 地址展示使用 `[host]:port`，保留 IPv4、hostname 和凭证编码行为。
- 设置 → SOCKS5 新增「IPv6 代理出口」，默认关闭。开启后才能探测、绑定和使用 IPv6 literal 代理；关闭会停止对应运行出口，保留槽位、绑定和探测历史，不计作代理故障。代理池和槽位网络状态显示「IPv6 已关闭」，远端出口同步失败单独提示；槽位网桥仍为 IPv4，DNS / 路由策略不变。
- 单个槽位可覆盖全局配额（5h/7d 硬闸、最大会话、会话空闲、打满阻断、周仓拆分）。未改的项继续跟随设置 → 配额；槽位详情「运行」里查看和编辑，热更新，不进容器。GPT 槽位不使用这套配额。
- 节点 Docker 页会列出已登记但还没有容器的槽位（没有出口时不会创建容器），避免这台 VPS 看起来是空的。

已部署机升级：更新 Node 控制面（`src/`、`package*.json`）和 `web/dist`，`npm ci --omit=dev`（需要 `ssh2`、`ws`），重启一次 Node；按上条补 nginx 终端路径。二进制与 1.3.88 相同。节点槽位镜像 tag 只随 `/opt/kin` 内二进制内容变化；变了之后节点槽位下次启动会自动重建镜像。

## 1.3.88 — 2026-10-01

- 修复 #191 / #94：cli-hop 的 `stop_reason=max_tokens` 是正常截断，不再被槽内 CLI 转为 API 错误；保留内容、真实 usage 和 `message_delta` / `message_stop`，不触发自动重试。交互式 CLI 的输出上限恢复提示不变。移除 Node 的旧 `max_tokens<=64 → 1024` 规避分支；可配置的 `compatibility.min_max_tokens` 下限仍生效。
- 修复 #190：kin-egress 拒绝原目标等于当前连接本地监听地址的直连流量，避免本机 / 同内网 SOCKS 对私网 direct 时形成自转发环路。控制面的启动等待和健康探测改用 `ss` 检查 LISTEN 状态，不再连接透明转发端口。
- 更新预编译 `kin-egress` 和 `cli-node`；Rust kernel、web 控制台及其他二进制源码不变。本次仅包含上述两项修复及回归测试，不包含另一个任务的集群 / 槽位放置改动。

已部署机升级：更新 Node 控制面、宿主机 / 远端出口的 `kin-egress` 和槽内 `share/wrap-cli/cli-node`，重启相关进程。仅改 Node 或版本号不能修复旧二进制；Rust kernel 无需重编。

## 1.3.87 — 2026-09-30

- 恢复面板用户管理（撤回 `3420f8a`）。admin 在侧栏「用户」页（`#/users`）新建、编辑角色/启用/自建配额、删除用户；每行「改密码」弹窗带确认密码与 8–128 位校验。改他人密码立即踢掉该用户全部会话；改自己密码保留当前会话、踢掉其它设备。`GET/POST/PATCH/DELETE /api/panel/users` 仅 admin / master key。
- 改密后 SQLite `users` 为准，`VM2API_ADMIN_PASSWORD` 不再能登录同名账号。
- 集群页接入 VPS 改为 SSH：控制面主动拨出（本机在 NAT 后可用，远端在 NAT 后可经已接入节点跳转），首连核对并固定主机指纹。常驻连接带 keepalive 和指数退避重连；指纹不符或认证失败停住等人工重连。凭证按 `VM2API_DB_SECRET` 加密落库。
- 集群节点弹出式管理面板：xterm 终端（一次性票据 WebSocket）、远端 Docker（经 SSH 转发 docker.sock：信息、一键安装、建容器、启停重启、日志、删除）、连接详情。本机另开 unix socket 桥，`docker -H unix://<data>/cluster/<id>/docker.sock` 可直接用本机 docker CLI 管远端。去掉集群页示意行。
- 集群页本机面板新增「链路」：控制面运行形态（进程 / 容器 host|bridge）、监听地址、公网出口与是否在 NAT 后（由已连接节点观测，不依赖第三方 IP 服务）、面板端口是否公网可达、本机 Docker 与槽容器数、集群出站就绪数。`GET /api/panel/cluster/local`。
- 新依赖 `ssh2`、`ws`（Node）和 `@xterm/xterm`（web）；新迁移 `026_cluster_nodes`。

已部署机升级：更新 Node 控制面（`src/`、`package*.json`）和 `web/dist`，本机 Node 部署先 `npm ci --omit=dev`（新增 `ssh2`、`ws`；镜像构建已包含），重启一次 Node。

## 1.3.86 — 2026-09-30

- 控制台侧栏左上角品牌区重做：vm2api 标识 + 放大的版本徽标（链到对应 GitHub Release）+ GitHub 仓库链接；移除 `Anthropic` / `GPT` 平台标签。侧栏折叠为图标时只留标识。
- 登录后每天首次打开控制台，右下角弹出一次 GitHub Star 提示，10 秒后自动隐藏（悬停/聚焦时暂停，可手动关闭）。按本地日期记在 `localStorage` 的 `vm2api_star_hint_day`，当天不再出现。
- `web/dist` 随本版重编。
- 管理员（`role=admin`）不再受用户级并发上限（`users.concurrency`）约束；普通用户上限不变。
- GPT-6.1 Sol 按官方价计费。标准档每百万 token：输入 $2、缓存读 $0.10、缓存写 $2.50、输出 $10。输入超过 272K 时整单按 2 倍输入和缓存、1.5 倍输出；Flex 为该档一半，Fast 为两倍。
- Codex 额度查询的 `chatgpt-account-id` 优先用 access token 里的账号 ID。导入记录没有账号 ID 时也会带上。

已部署机升级：更新 Node 控制面（`src/`）和 `web/dist`，重启一次 Node。不改 kernel / cli-node，不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.85 — 2026-09-30

- Claude Code 子 agent 不再排在主会话后面：带 `x-claude-code-agent-id` 的请求（Claude Code 2.1.139+，主线程不带）按子会话调度。会话 ID 由主会话 `session_id` + agent ID 派生（稳定 UUID），各 agent 各自一个 CLI 会话、各自串行，可用主会话所在 VM 的任意空闲执行位；会话窗口计在主会话头上，不新占 `max_sessions`。嵌套 agent（带 `x-claude-code-parent-agent-id`）同样挂在主会话下。主会话自己的多轮仍按 v1.3.7 规则串行。

已部署机升级：只更新 Node 控制面（`src/`）并重启一次 Node。不改 kernel / cli-node，不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.84 — 2026-09-29

- 控制台创建槽位恢复「平台」选项：Claude（anthropic，默认）/ GPT（openai）。虚拟机页和导入向导共用同一弹窗，两处都能直接建 GPT 空槽，账号稍后用 OAuth 或 auth.json 导入。此前 `2288ab3` 把创建请求写死为 `platform: 'anthropic'`，控制台无法新建 GPT 槽。后端 `/api/panel/vms/create` 本就按请求体 `platform` / `family` 盖章，未改。
- `web/dist` 随本版重编。

已部署机升级：只需更新 `web/dist` 静态文件，不必重启 Node。不改 kernel / cli-node，不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.83 — 2026-09-29

- cli-hop 缓存：Node 清洗后写最后消息及 `messages.length>=4` 时倒数第二 user 断点，TTL 用入站会话已 pin 值。kernel 不再重打 last。native CLI 保留消息标记，自产 system/tools 沿用同一请求 TTL，总数 <= 4，thinking 不打点。独立 CLI 非 native 行为未扩大。
- 调试日志增加有界 `cache_continuity`：入站/出站历史首差类型（图片/文本/结构）、断点与 TTL，层级标为 Node 对象，不把 Node 出站当成最终 wire，不保存完整提示词和图片。
- C1 客户端图片预算：运行中的 OMP 是 18.4.2 二进制（`/home/mci777/.bun/bin/omp`），可读源码只有 `/mnt/x/oh-my-pi` v16.4.3 与全局 `@oh-my-pi/pi-coding-agent@17.4.0`。18.4.2 二进制仍按 provider 名查表（unknown 地板 5），没有 `compat.imageBudget` 入口。未改旧 node_modules、未重命名 provider、未把未知代理默认成 Anthropic。精确阻塞见 issues CSV。
- 原事故 SQLite replay 因 200k/24 条截断跳过，不用客户端重建冒充。线上 usage 与 f123 差异闭环前不宣称缓存已治愈。
- 发布基于 main v1.3.82，合入缓存连续性 PR #176；该 PR 原预留 1.3.81，因 1.3.82 已先发布顺延为 1.3.83。本版不改 kernel / cli-node 字节。

本机改动未部署。覆盖控制面并重编 kernel / cli-node 才生效；不要 `wrap-cli/sync` 除非二进制字节变化。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.82 — 2026-09-29

- cli-hop 恢复调用方 system：kin 分支只保留 billing、可选身份句、Timezone 和 Node/caller 原文，不再追加槽内 cwd、Platform、Notes 或默认 agent。真实 Claude Code 子代理的 agent prompt / Notes 不再误删，首尾空白保留。
- 常驻约束默认不启用：`agent_standing_presets` 缺 map/key 为关闭，显式 true 仍开启；三种预设和约束文本不改。控制台预览与开关保存使用相同默认值，usage 不再扣除未注入的约束。
- cli-node 按 Linux x64 baseline 重编并 UPX 压缩。补齐 native 快捷入口配置初始化与版本常量导入；否则重新编译的 native job 会在启动或首次查询时失败。
- 发布基于 main v1.3.80；不合入独立的缓存连续性 PR #176（该 PR 预留 1.3.81）。

部署需替换槽内 cli-node 并重启对应 kernel/CLI，配置热读不能加载新 ELF。保留旧文件回滚，不删除槽容器，不覆盖 live routing.json。system 文本变化后首次前缀冷写；不保证 cache_read 数值必然上升，0注入、约束关闭、无 agent 的真实模型输出单独验证。

## 1.3.80 — 2026-09-29

- 虚拟机页：每行和每张卡片右侧加「⋯」扩展菜单——测试链接、查看统计、重新授权、刷新令牌、恢复状态，重置槽位和删除排在分隔线后。点击一台 VM 不再跳到 `/vm/:id`，改为弹出详情卡；卡内保留「完整页面」入口，详情页不变。
- 虚拟机列表更紧凑：类型列显示调用形式 `Console` / `OAuth` / `API`（Claude 槽刷新走 OAuth 接口、推理走 `Authorization: Bearer` 调 Console，所以完整 OAuth 与 Setup Token 都归 Console；只有 `x-api-key` 是 API；GPT 槽是 OAuth），Console 用 Anthropic 陶土橙、OAuth 蓝、API 白。`pro` / `max` 挪到账号列，优先级写成「优先级-N」，今日与 7D 请求合成一列。列头可拖动排序，顺序存浏览器，Alt+←/→ 可用键盘移动，右上角一键恢复默认。
- 用量窗口在列表、网格卡片、详情卡、统计弹窗共用一套：5h / 7d / Fable 三行，条、百分比、窗口费用、重置倒计时对齐。GPT 槽的「查询额度 / 重置券」放在窗口下方。
- 成本列的累计改取 `/usage` 账号行。`/api/panel/vms` 本来就不带费用字段，此前读 `vm.total_cost` 恒为 0。
- 统计弹窗改成可视化：指标卡、今日 / 最高日信息卡、费用与请求双轴趋势、模型分布环形图、入站端点分布。后端 `GET /api/panel/vms/:id` 的 `billing.usage_stats` 带出近 30 个上海自然日的按日用量、模型排名和入站路径排名，日界与 `billing.today` 一致；老前端忽略这个字段。
- 详情卡和四个弹窗改用原生滚动：Radix `ScrollArea` 在弹窗里不出滚动条，长内容下半部分看不到。
- Sonnet 5.5 在 Node 出站清洗中沿用 Opus 5.5 的兼容策略：强制 `tool_choice` 转为 `auto`，指定客户端工具加 `strict: true`。不注入提示词，不保证一定调用该工具；Sonnet 5 保持原强制调用语义。
- Messages / Chat / Responses 保留 strict 工具标记与结构化输出；`output_config.effort` 不再挡住 `response_format` / `text.format` 的 schema 转换，cli-hop 补齐嵌套对象的 `additionalProperties`。Responses 补传工具选择。

已部署机升级：只覆盖控制面并重启 Node 一次；`web/dist` 是静态文件，单独更新不必重启，但 `billing.usage_stats` 需要新的 Node 才有。不改 kernel / cli-node，不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.79 — 2026-09-29

- 槽位 `settings.env` 不再把 `CLAUDE_CODE_USE_BEDROCK` 和 `CLAUDE_CODE_USE_VERTEX` 写成 `1`。官方 CLI 会把 `1` 当成启用 Amazon Bedrock / Vertex，推理去连 `169.254.169.254` 拿 AWS 凭证，不再请求 Anthropic。这两个变量现在固定为 `0`，调用方传入的 `1` 不会生效。

已部署机升级：覆盖控制面并重启 Node 一次。已有槽的 `settings.json` 要等下一次种子重写（保存种子策略或官方初始化）才会变成 `0`。kernel / cli-node 未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.78 — 2026-09-29

- Claude Code 出站身份对齐 2.1.284。默认 Sonnet 为 `claude-sonnet-5-5`：`max_tokens` 128000/128000，默认 effort `medium`，知识截止 June 2026。Sonnet 5 仍保留，缺省输出 64000。
- 计费头在 first-party 且 prompt/turn 索引合法时，于 `cc_turn_origin` 后追加 `cc_prompt_index` 与 `cc_turn_index`。`cch` 种子和公式不变。
- 槽位种子默认写入 `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`。cli-node 在该开关打开时，用 body 里的 `cc_prompt_id` 发送 `x-claude-code-prompt-id`。
- 换票二进制 `kin-oauth-auth` 按 2.1.284 重编并 UPX 压缩到约 14MB。Node、worker 回退和二进制的 UA 都是 `claude-cli/2.1.284`。

已部署机升级：覆盖控制面并重启 Node 一次，使新的 `bin/kin-oauth-auth` 生效。仓内 kernel / cli-node ELF 这次没有重编，不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.77 — 2026-09-29

- 双号池空闲位优先：粘性 / family / 设备只是偏好。绑定槽忙时这一轮借同平台空闲合格槽，绑定不动；预约竞争失败不再停下等原槽，前 4 个候选失败后第 5 个仍可达。
- 重试预算：同一请求在同一 VM 最多 3 次实际执行（含传输层隐藏重试），空跳先换空闲 VM；不再累计逻辑 slot 坏位、不再因计数把 VM 标过载或重启 CLI。`max_total_attempts` / `max_account_switches` 用完后只尝试未试过的 VM，直到总 deadline。
- 占位闭环：预约被额度 / 熔断 / Fable 拒绝时按逆序归还本次拿到的执行位、额度计数与会话窗口；`release()` 幂等。活跃请求的会话窗口不被空闲过期清掉，空闲从最后一次释放起算。迁移不回收其他在飞请求的执行位；迟到的完成不会把已迁走 / 已释放的绑定写回。
- 显式子请求（有 `parent_session_id` / `root_session_id` 且父会话本地已绑定）计入父会话窗口，不新占 `max_sessions`，仍各占执行位；借到别的 VM 的一轮不在那里新开长期窗口。
- OpenAI：并发 / RPM 同步检查并占位，kernel 初始化期间不再超卖；候选每跳重新读取、不再截断前 4 个；会话窗口按 `max_sessions` 计，不再拿 `session_slots` 顶替；绑定槽忙不解绑；`previous_response_id` 续接只在原账号，原账号不可用返回 `409 response_not_portable`。
- #163：裸 429 不再按模型名定范围，改为当前执行单元短冷却并触发一次 `/usage`（与定时探测同一单飞、有界队列、超时与退避，失败不写 0%）；点名模型的才按模型冷却，每分钟限流按 RPM。正在服务或持有会话的账号，最新真实样本超过 `usage_probe.stale_sec` 即重新探测，不再以 reset 未到当作新鲜。额度 / 凭证硬排除时，该账号所有绑定会话连同会话窗口一起迁走。
- 错误与日志：真实容量耗尽返回 `429 pool_overloaded`（号池负载过高，稍后再试），仅在已知恢复时刻带 `Retry-After`；没有合格账号返回 `503 pool_unavailable`；执行过的失败保留上游本义与最后执行的 VM / 账号 / 尝试数，零执行记 0。日志里没分到执行位显示「未分配执行位」，不再显示「未绑定账号」。

已部署机升级：覆盖控制面与前端并重启 Node 一次。kernel / cli-node 未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.76 — 2026-09-28

- 空跳或客户端取消：坏掉的 native slot 直接跳过，同一会话改用下一个，直到 20 个用满。不在这次错误上重启 CLI。VM 还有坏 slot 且没有在飞请求时，闲时重启 CLI。20 个 slot 都坏了，把 VM 标成过载并重启 CLI。

已部署机升级：只覆盖控制面并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.75 — 2026-09-28

- 代理池页重做：左侧「席位」总览（每条代理一列、每格一个绑定位，按健康着色，悬停联动右侧列表、点击定位）+ 待接代理槽位拖拽绑定；「添加代理」粘贴导入带结果回执（重复 / 无法解析分列，账密不回显）与本地出口；「管理」收纳全部测通 / 测地理、每条绑定上限、探测间隔、出口 DNS、跟随代理时区。
- 右侧代理列表改为行卡片：大号 `已绑/上限` 计数 + 席位格、延迟信号格、出口地理、可搜索的绑定选择器（无代理槽位优先，已绑槽位标注来源并换绑），搜索、席位筛选与排序。

已部署机升级：只覆盖前端（`web/dist`）。控制面、kernel 与 cli-node 未变，不必重启 Node，不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.74 — 2026-09-28

- agent prompt 常驻约束改为全局一份（`compatibility.agent_standing`），作为 agent 块第一段：官方 / 0注入 在 `caller_agent` 之前，官方完整在官方 agent 全文之前。
- 按档开关（默认全开）：`agent_standing_presets` 是否加约束，`agent_standing_hide_presets` 约束是否从客户端 usage 扣除（独立于整档遮罩），`persona_env_presets` 是否写槽位 `# Environment` 时区。
- 新增整档 usage 遮罩 `persona_hide_presets`：按档控制注入块（billing / identity / agent / Environment）是否计入客户端 usage，缺省跟模板 `hide`（0注入 开，其余关）。槽位单独指定人设与 cli-hop 0注入 都按该档生效。
- 官方提示词、0注入 新增 Environment 块（只含槽位时区，排在 agent 块之后，不挂 cache）；自定义档空模板回落官方，同样带上。
- system提示词页重做：顶部四档卡片，左侧「注入」「usage 遮罩」两组开关 + 常驻约束 + 可折叠模板，右侧固定预览最终 system prompt（不含 billing，真实常量，按槽位时区渲染）。

已部署机升级：覆盖控制面与前端并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。官方提示词档默认多出常驻约束与 Environment，约束默认从 usage 扣除；不要可在 system提示词页按档关掉。live 已自定义的 0注入 模板不会自动多出 Environment 块，需在该档「恢复预设」。

## 1.3.73 — 2026-09-28

- 人设从设置 → 协议迁到独立页 `system提示词`
- 配置弹窗改为块编辑 + 出站预览，去掉长说明
- 0 注入默认把常驻约束写在 `caller_agent` 最前，可编辑；模板去掉 note 字段

已部署机升级：覆盖控制面与前端并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`（未改过的 0 注入会跟新内置常驻约束）。

## 1.3.72 — 2026-09-28

- 预热拦截改为照搬 sub2api `detectInterceptType`：haiku `max_tokens=1` 探测需 `claude-cli` UA；messages/system 必须是 `{type,text}` 数组，含字符串 content 的请求不拦截；模拟响应（含流式）与 sub2api 一致。
- 额外一条保护：带 tools 的请求一律不拦截，避免长对话里提到 `Warmup` 或标题生成句被误回 "New Conversation"。

已部署机升级：覆盖控制面并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.71 — 2026-09-28

- 修复预热拦截误伤正常对话：旧逻辑扫描整段历史，长会话里只要出现过 `Warmup` 或标题生成句就被回 "New Conversation"。现在只拦截无 tools、至多两条消息的旁路请求，且只看最新一条 user。
- 预热拦截与健康缓存改为默认开启（设置 → 探测可关）。

已部署机升级：覆盖控制面并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。live `routing.json` 里已显式写成关的开关保持关，需要在面板打开。

## 1.3.70 — 2026-09-28

- 探测/测试请求不再占主会话席位：单条短 user、无 tools 的一次性请求（sub2api 账号测试、new-api 渠道测试、验证脚本）跳过 session seat，只占并发。粘性身份不变。
- 新增「拦截预热请求」全局开关（设置 → 探测，默认关）：仅 Claude 模型 `/v1/messages`，Claude Code 的 Warmup、标题生成、SUGGESTION MODE、haiku `max_tokens=1` 连通性检查在选号前直接返回模拟响应。流式 haiku 探测与非流式一致返回 `#` / `max_tokens`。
- 新增 `max_tokens` 下限（默认开，128，可关、可改）：所有 Claude 出站路径（含 chat/responses 转换）生效；开启 thinking 时保证 `max_tokens` 大于 `budget_tokens`。cli-hop 原有 ≤64→1024 保留。
- 健康缓存兼容 new-api / sub2api / CLIProxyAPI：识别 new-api 不带 max_tokens 的 chat/responses 测试和 sub2api 账号测试载荷；Claude 与 GPT 分开快照（GPT 探测模型留空则不缓存 GPT）；Chat 流式末块带 usage 与 `[DONE]`，Responses 流式补 `response.created` / `response.completed`。
- 新增 `GET/HEAD /healthz`（无鉴权，`{"status":"ok"}`）。
- 设置「探测」页改为结构化开关与快照状态。

已部署机升级：覆盖控制面与前端并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`（下限缺省即开启 128；预热拦截与健康缓存需在面板打开）。

## 1.3.69 — 2026-09-28

- 修复调度座位泄漏：family 锁定在另一台 VM 时，已占用的并发/session seat/配额不释放，直到重启 Node。用 `x-kin-vm` 指定非 family 所在 VM 的请求每次泄漏 2 个座位，把该 VM 占满后主会话持续 `all_accounts_busy`（45s 后 503）。现在重选前先归还座位；显式指定 VM 优先于 family 绑定。

已部署机升级：覆盖控制面并重启 Node 一次（同时清掉已泄漏的座位）。不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.68 — 2026-09-28

- GPT 槽按 VM `allowed_models` 过滤；OpenAI 号池增加 RPM 窗口与等待队列（满员排队，默认 100）。
- Codex 官方客户端识别补 `codex_cli_rs` / `originator`。
- worker OAuth UA 与 telemetry CLI 版本对齐 2.1.281。

已部署机升级：覆盖控制面与前端并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.67 — 2026-09-28

- 发布出站 session 重建到已部署机。线上已有 1.3.66 控制面（非本提交），本次用独立版本号覆盖。

已部署机升级：覆盖控制面与前端并重启 Node 一次。`cli-node` 已单独同步，不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.66 — 2026-09-28

- 出站 session 默认重建：入站 session 只作调度身份，不再透传到上游。同一 VM 保持重建值，切换 VM（含切回）换代。
- `X-Claude-Code-Session-Id` 与 `metadata.user_id.session_id` 使用同一重建值。官方 Claude Code 2.1.281 出站头对齐。
- 设置页「出站 session」可切回透传。Codex hop 的 `session-id` / `prompt_cache_key` 同样重建。

已部署机升级：覆盖控制面与前端并重启 Node 一次。Claude wrap 槽的 `cli-node` 需单独同步到带 hop session 的版本。不要 `docker rm` 槽。

## 1.3.65 — 2026-09-27

- 修复官方 Claude Code 客户端工具 `WebSearch` 被改写成服务端 `web_search`：ToolSearch 加载 `WebSearch` 后必定 502 `incomplete_response`（#134）。现在带 `input_schema` 的 `WebSearch` 原样转发，模型调用的是客户端 `WebSearch`；请求里已有它时不再额外注入服务端搜索。
- 自定义工具保留 `defer_loading: true`，Claude Code 延迟加载的工具不再每次全量发送。
- 提示词触发注入的服务端搜索与 Claude Code 自身定义对齐：`web_search_20250305` / `web_search` / `max_uses: 8`。调用方自带的 `web_search` 保留原参数。

已部署机升级：只覆盖控制面并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.64 — 2026-09-27

- 更新 OAuth 换票：完整 scope、Setup Token 运行模式、二进制换票服务与 VM SOCKS5 出口。
- 更新 usage 用量获取：完整 OAuth 正常采集 5h / 7d 官方用量。
- 更新套餐获取：按官方 usage / Fable 结果判定 Pro / Max。

## 1.3.63 — 2026-09-27

- 修复 GPT 槽 5h / 7d 额度在 Web 上显示为 0%、无重置时间：落盘的 usage 视图读回时被当成原始 extra 二次解析而全部清空；现从 `codex.extra` 重建，并兼容已存视图。
- GPT 槽额度查询时持久化上游 `plan_type`，Web 套餐标识按 codex-proxy-rs 映射显示（如 team → Business）；内部 tier key 仍为 `codex`。

已部署机升级：覆盖控制面与前端并重启 Node；额度数值立即恢复，套餐标识需点一次「查询」后出现。

## 1.3.62 — 2026-09-26

- 修复带 `type: setup-token` 标签但实际包含 `user:profile` / `user:sessions:claude_code` 的完整 OAuth 导入被错误降级为 inference-only。现在以实际 scope 集合为准，保留 profile 权限并允许官方 `/profile` / `/usage`。

## 1.3.61 — 2026-09-26

- 修复 native CLI 被 OOM 杀死或管道关闭后，Rust 内核仍宣告槽可用并持续返回 `native stdin: Broken pipe`：退出统一清理在途任务与调度状态，健康清零后由 watchdog 恢复，不重放推理。
- 原生槽默认内存由 `500m` 调整为 `1g`，保留 `KIN_VM_MEMORY` 显式覆盖；已有容器需单独调整限制。
- 完整成功的官方 usage 按 Fable 7d 判 Max，否则默认 Pro；修复额度探测旧参数、失败结果传递、旧 Max 窗口覆盖新 Pro，以及未确认套餐显示。
- 修复 OAuth / Setup Token 授权码导入的 `Assignment to constant variable`，并让 revoke / 无效凭证自动关闭调度、在 Web 显示准确状态。
- 修复 Web 手动调度开关刷新后回弹；新增相关 Node/Web/Rust 回归覆盖。

已部署机升级：覆盖控制面、前端与 kernel 并重启 Node 一次；同步 Claude 槽内 kernel，不 `docker rm` 槽。

## 1.3.60 — 2026-09-26

- 槽不存在时，kernel 健康检查不再对 `null` 读 `codex_kernel`。`isCodexVm(null)` 按 Claude 处理，面板不再抛 TypeError。

已部署机升级：只覆盖控制面并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.59 — 2026-09-26

- 换票回填 `email` / `account_uuid` / `org_uuid`：先展平 helper/token 里的 `oauth_account`，缺了再经槽 SOCKS5 打 bootstrap。不跑官方初装，不 PATCH Grove。
- Setup Token 与完整 OAuth 一样可以 hop 官方 `/api/oauth/usage`。面板额度仍只读 Extra；官方结果只用来校准 Extra。从未采样的槽 hop 一次。
- 计费 5h/7d 按该账号 Extra `reset` 切窗；没有 reset 时才退回墙钟回看。舰队 5h/7d 是各账号 Extra 窗之和。
- GPT/Codex 缓存命中按 `cache_read / input`（input 已含 cached）。Claude 仍是 `read / (input + read + write)`。

已部署机升级：只覆盖控制面和前端并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.58 — 2026-09-26

- 默认地址不再指向 `ccmax20.cc`，改用本项目后端。通知里的控制台链接默认留空，留空时用后端自己的 `base_url`；手动填的地址仍然优先。
- 控制台前端没保存 API Base 时连当前页面所在的后端。部署在 vercel、netlify、github.io、grok.me 上的前端不再自动连 `ccmax20.cc`，需要在登录页填后端地址。`ccmax20.cc` 不再算同源面板。
- `docs/API.md` 示例改用 `http://127.0.0.1:8787`。

已部署机升级：只覆盖控制面和前端并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。线上 routing.json 里已存的 `console_url` 不会被改写，要改用后端地址就在通知设置里清空。

## 1.3.57 — 2026-09-26

- cli-hop 的组织访问权限拒绝不再被改写成空响应：SSE 与非流式 provider error 均恢复为 403，保留原始错误并进入现有 permission-denied 冷却/换号策略。此修复不改变 session 识别或探测占席规则。
- Claude 选槽按入站 `metadata.user_id` 识别身份，读取发生在出站清洗之前，没有 metadata 时退到显式 `device_id`。session、family 和设备亲和的 key 都不再带 API key：同一 session 换 API key 仍命中原绑定；共用一个 API key 的不同设备互相隔离。同设备的新 session 优先放到该设备所在 VM，每个 session 各占一个槽；满了就溢出到别的 VM，已有绑定不动。短 Haiku routing probe 留在设备所在 VM，但不占 session 槽。
- 旧的按 API key 隔离的 sticky 行不做批量删除：请求命中时复制一份到新 key，旧行原样保留。没有可信 session_id 的请求继续用旧规则。出站身份替换和协议转换没有改。

已部署机升级：只覆盖控制面并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。旧 sticky 行保留，回滚代码后仍可读。

## 1.3.56 — 2026-09-26

- 账号探测会用 Fable 消息确认套餐：当前模型 `claude-fable-5-1` 能通就是 Max，两个 Fable 模型都 403 才是 Pro。429 和传输失败不改等级。
- Setup Token 没有官方 `/usage`，探测不再只读响应头然后把号留在 Pro。探测成功后控制台标成 Max。
- 还没有套餐证据的 Claude 槽不再一律显示 Pro。

已部署机升级：只覆盖控制面和前端并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.55 — 2026-09-26

- 取消请求按客户端生命周期结束处理：不计错误、不解绑长期 session；Node 等待读完 `kin_job_done` / trailers，避免正常 `message_stop` 被误判为客户端断开。
- Claude family 透传 parent/root/device；主 session 与 Sonnet/Haiku 子 session 固定同一 VM，各占独立 session 槽位。family 满载不跨 VM，generation 恢复整族迁移。
- 账号池空跳、family 调度和取消隔离补齐测试。升级会同步控制面与二进制；不要 `docker rm` 槽。

发布资产包含更新后的 `kin-kernel`、`kin-codex-kernel`、`kin-cookie-auth`、`kin-egress`、`kin-worker`、`cli-node`、`cc-node` 和 crag kernel。

## 1.3.54 — 2026-09-25

- 流里出现 `message_stop` 就结束这一跳，即使没有可见正文。没有 `message_stop` 的空跳先在同号重试，然后暂停该号约 60 秒并换下一个号。
- 发出去之前，只剩无签名 thinking 的空 assistant 轮会被删掉，相邻用户消息合并。
- OpenAI Responses 的 `tool_choice.name` 放到顶层。

已部署机升级：只覆盖控制面并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.53 — 2026-09-25

- 没有可见输出的跳不再回收内核。以前这会被当成槽泄漏，`SIGKILL` 监督进程里的 CLI 并重启内核，同槽重试打在刚被拉起的进程上。
- 传输失败和连接错误仍会回收。crag / cc-node 还活着时，看门狗不再重启该槽。

已部署机升级：只覆盖控制面并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.52 — 2026-09-25

- 空跳或只有 thinking、没有 `stop_reason` 的请求，同号重试一次后返回 502 `incomplete_response`。这一次请求不再停调、不换号。同一个号在另一次请求里再次空跳，才暂停该号 60 秒。（#131）
- 入站体上限默认 128MB。超限在选号前返回 413 `body_too_large`。（#131）
- Codex 模型同步带上 `gpt-6-sol` 和 `gpt-6-luna`。（#131）
- Haiku 的 cli-hop 在 thinking 关闭时丢掉 `context_management`，避免旁路请求把槽打成 502 后拖垮号池。（#121）
- 「不要透露隐藏推理」这类否定句不再被蒸馏守卫拦成 403。（#129）

已部署机升级：只覆盖控制面并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.51 — 2026-09-25

- crag 不再把写死的 “persistent Crag request slot” 当作 agent 提示词。系统内容改跟槽位人设：0 注入、官方提示词、完整官方提示词。
- 本版 `kin-kernel-crag` 换成去掉该提示词的内核。`cli-node` 和 `cc-node` 未变。

已部署机升级：只换 crag kernel。内核页拉取 GitHub 后，按 crag + cc-node 重装。不要 `docker rm` 槽。

## 1.3.50 — 2026-09-25

- 内核页三种搭配：默认 `cli-node + kernel`；`cc-node + kernel` 用同一份 wrap kernel；`crag + cc-node` 用 crag kernel，`claude_bin` 指向仓内 `cc-node`。
- GitHub 拉取必须同时下载 `kin-kernel`、`cli-node`、`cc-node`、`kin-kernel-crag`。本版 Release 带上 `cc-node`（Claude Code 2.1.281，UPX）和更新后的 crag kernel。
- 计费回填不再把故意未标价的行按标准价重算，面板显示计费档。（#125）
- 面板显示 Claude 槽位熔断，并可以手动复位。扫描候选槽不再吃掉半开探测。（#126）
- Codex 对话的工具调用继续走 Responses 清洗。Codex 故障切换仍只用自己的错误集。

已部署机升级：`cc-node` 是新二进制，crag kernel 也换了。镜像安装拉新镜像并重启控制面。源码安装覆盖控制面、`share/wrap-cli/cli-node`、`share/wrap-cli/cc-node` 和 `share/crag/kin-kernel`，重启 Node 一次，然后到内核页重装。不要 `docker rm` 槽。

## 1.3.49 — 2026-09-24

- `share/wrap-cli/cli-node` 改为 Bun `bun-linux-x64-baseline` 重编（同 patch、同 Bun 1.3.14，UPX 5.0.1）。不支持 AVX2 / BMI2 的 CPU 不再在槽内 SIGILL，也不再只报 `wrap cli-hop 未就绪`。（#122）
- 控制面容器启动时，镜像内 `cli-node` 与 `share/wrap-cli/cli-node` 不同就覆盖，并在 `KIN_AUTO_SYNC_WRAP=1` 时同步到各槽。
- 没有可见输出的跳不再改写成 502。按空跳留在原 VM 重试，不再记成过载，也不再写 `overload_until`。（#123）
- Codex 的 200 流只要带了 token 就写入用量、`service_tier` 和费用，不再记成 `codex_upstream`。日志和 VM 计量条因此能显示实际计费。（#123）
- 自定义槽位 id 在虚拟机列表和日志里显示真实名字，不再显示「未绑定账号」。（#123）

已部署机升级：`cli-node` 二进制变了。镜像安装拉新镜像并重启控制面，启动脚本会覆盖 `cli-node`，`KIN_AUTO_SYNC_WRAP=1` 时自动 `wrap-cli/sync`。源码安装覆盖控制面和 `share/wrap-cli/cli-node`，重启 Node 一次，然后 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.48 — 2026-09-24

- 账号被额度硬闸踢出后，会话的全部粘滞别名一起解开，并让出该账号的会话窗座位，下一轮可以绑到别的 VM。
- 选号失败不再被上一跳未完成的 assistant 改写成 502 `incomplete_response`。空池对客户端仍是 503 `overloaded_error`。空池日志不再打印 `soonest=0s`。
- Haiku 子代理认母会话改为入站 `metadata.user_id.device_id`。同一 API key 上另一台设备的最近会话不再被占用。同一 `device_id` 两分钟内的母会话是这条主体 session；没有母会话时，该 `device_id` 的这批请求仍只占一个位。

已部署机升级：只覆盖控制面并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.47 — 2026-09-24

- Haiku 子代理（技能路由短请求）不再各自占一个 session。同一 API key 两分钟内有母会话时，跟母会话的 VM 和同一个 session 位；没有母会话时，同一 `device_id` 的这批请求只占一个位。

已部署机升级：只覆盖控制面并重启 Node 一次。二进制未变，不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.46 — 2026-09-24

- 手动设置的账号并发和 RPM 不再被启动时的套餐同步或全局默认值覆盖；继承默认值的账号照常更新，值未变化时不再重写 VM 文件。（#105）
- 虚拟机详情显示实际的遥测状态和进程拓扑：区分未启用、运行中、已开启但进程未运行、状态未知；支持自定义容器名的槽位。（#106）
- 「探测」读取请求响应头缓存时会保存检查记录，刷新详情后不再显示“未探测”；没有响应头样本时明确提示不可用。官方 `/usage` 探测与计费入库流程不变。（#107）

已部署机升级：覆盖控制面和前端，重启 Node 一次。不涉及 kernel / worker / egress 二进制，不要 `docker rm` 槽。

## 1.3.45 — 2026-09-24

- 透明出口 DNS 自动 fallback：kin-egress 按 CF DoH → Google DoH → 8.8.8.8:53 → 1.1.1.1:53 依次尝试（单个 4s），记住上次成功的上游。出口连不上 1.1.1.1:443 时槽位不再整体解析失败。
- 代理页新增「出口 DNS」下拉：选择优先使用的 DNS，其余自动排在后面兜底；保存后重载已绑定出口，不重建槽。

已部署机升级：覆盖控制面、前端和 `bin/kin-egress`，重启 Node 一次。已运行的 kin-egress 需在面板切换一次出口 DNS 或重启出口后才用上新二进制。不要 `docker rm` 槽。

## 1.3.44 — 2026-09-24

- 测试对话、设置 → 协议、虚拟机详情、内核页文案区分运输（Rust cli-hop）和数据面（wrap `cli-node` / crag 官方 Claude）。
- 测试日志不再把 rust cli-hop 一律写成 wrap。

已部署机升级：覆盖控制面和前端并重启 Node 一次。不改槽 ELF。不要 `docker rm` 槽。

## 1.3.43 — 2026-09-24

- 内核页两个对等卡片：wrap（`cli-node`）和 crag（官方 Claude Code）。点卡片确认后切换，槽表显示每槽内核。Codex 不动。
- crag wrapper 在槽内有 `glibc239` 时用它加载 ELF（debian-12 没有 GLIBC 2.39）。
- 部署 overlay 现在会铺 `share/crag/kin-kernel`。

已部署机升级：覆盖控制面和前端并重启 Node 一次。内核页可在 wrap / crag 之间切换。不要 `docker rm` 槽。

## 1.3.42 — 2026-09-24

- 内核页可切换数据面：wrap（`cli-node` 一进程 20 native 槽）或 crag（官方 Claude Code，一槽一 `claude -p`，懒启动）。
- `POST /api/panel/dataplane` 写 `routing.inference.dataplane`、铺对应 ELF、`writeKernelConfig`、重启槽内核。不改凭证，不删容器。
- GitHub 拉取现在会顺带下载 Release 附件 `kin-kernel-crag`（没有就跳过）。仓内路径 `share/crag/kin-kernel`。
- 切 crag 要求槽内已有官方 `/home/kincli/.local/bin/claude`。

已部署机升级：覆盖控制面和前端并重启 Node 一次。要用 crag：内核页切数据面，或 `wrap-cli/sync` 后重启槽 dataplane。不要 `docker rm` 槽。

## 1.3.41 — 2026-09-24

- 槽内核加 job 看门狗。CLI 超过 `KIN_JOB_IDLE_SECS`（默认 180 秒）没有任何输出帧，就给客户端回 `job idle timeout` 并发 `kin_cancel`，slot 在 CLI 回 ack 后释放。以前这种静默 job 会永久占住 slot，20 个占满后整个槽一直 `slot_busy`。
- `kin_cancel` 超过 `KIN_CANCEL_ACK_SECS`（默认 30 秒）仍无 ack，该 slot 标为不可用并计入 `/internal/health` 的 `wedged_slots`。迟到的 ack 会让它恢复。
- 客户端在 CLI 静默期间断开，现在立即取消 job，不再等下一帧。
- 控制面：`ready_slots=0` 且 `wedged_slots>0` 视为内核坏了，不再当“忙”一直等，按原有路径重启槽内核。
- 文档：`502 incomplete_response` 的含义、常见原因和自查命令写进 [docs/API.md](docs/API.md)。同一个槽全部失败、每次约 20–30 秒、面板代理探测却是绿的，多半是宿主机防火墙拦住了槽容器到 `kin-egress` 网关这一跳。
- 部署：[docs/DEPLOY.md](docs/DEPLOY.md) 新增「防火墙（UFW / firewalld）」。绑远程 SOCKS5 的槽要放行 `keg*` 网卡到 20000–35999 端口（TCP + UDP）的入站；vm2api 不改宿主 INPUT 规则。本地出口不涉及。

已部署机升级：覆盖控制面并重启 Node 一次，再 `wrap-cli/sync` 把新 `kin-kernel.bin` 铺到槽并重启槽内 dataplane。不要 `docker rm` 槽。开了 UFW / firewalld 入站默认拒绝的机器，按 DEPLOY.md 放行一次。

## 1.3.40 — 2026-09-24

- 额度、刷新、profile、models、count-tokens 改到槽内 `kin-worker oauth`。Node 不再直连 Anthropic。
- hello 之后在槽里跑 CLI `/usage`，失败再试 2 次。账号等级以官方 `/api/oauth/profile` 为准。
- 去掉 `quota_via`、`cli_stats`、`usage_fallback`、`stats_prompt`。旧键读入时丢弃。删除宿主 `host-anthropic` 与 `host-token-refresh`。
- `kin-worker` 带上 oauth 子命令。发布的 `kin-kernel` 仍是仓内动态 ELF，不是 v1.3.39 附件上那份 UPX。

已部署机升级：覆盖控制面并重启 Node 一次。`kin-worker` 按文件挂进槽，已有槽要 `docker restart` 才能看到新二进制，不要 `docker rm`。不要覆盖 `routing.json`。内核不用 `wrap-cli/sync`。

## 1.3.39 — 2026-09-24

- cch 对齐 Claude Code 2.1.280。种子 `0x4D659218E32A3268`。哈希原文字符串：第一处 `cch` 回到 `00000`，清空所有 `"model"` 值，切掉 `fallbacks`、`fallback_credit_token` 和数字 `max_tokens`。发出去的 body 仍保留原值。
- 主 Messages beta 对齐 2.1.280 linux-x64 sdk-cli 抓包。`advanced-tool-use` 与 `thinking-binding-controls` 一起发，并带上 `mid-conversation-system-clear-at`、`extended-cache-ttl`、`cache-diagnosis`。不加 `context-1m`。
- 重编 `share/wrap-cli/cli-node`，UPX 5.0.1，124MB 压到 33MB。
- GitHub 拉取和一键内核重装同时下载 Release 里的 `kin-kernel` 和 `cli-node`，写进仓内后再铺到槽。缺 `cli-node` 附件就失败，不再只用仓内旧母本。

已部署机升级：覆盖控制面并重启 Node 一次。槽内二进制这次没有新文件，不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.38 — 2026-09-24

- 额度用尽现在会挡住调度（对齐 sub2api `RateLimitService`）。kernel cli-hop 先回 200 再流出 `event: error`，也会把额度用尽包成 502 `provider_error`。传输层按报错内容还原成 429 / 529 / 401，不再落进 `http_200` 直接停止。
- `You've hit your limit · resets 11am (America/New_York)` 按原文时区解析出 reset，写进 `rate_limit_reset_at`。解析不出就冷却 30 分钟，并触发一次 `/usage` 探测。529 写 `overload_until`，10 分钟。不再沿用已过期的旧 reset。
- 调度先看 `rate_limit_reset_at` / `overload_until`。被动用量、选号时的额度同步、成功请求都不能提前解除。只有到了 reset，或上游再回 `5h-status=allowed`，才解除。被挡住的号会解掉会话绑定。
- 空跳（没有任何可见输出）先同号重试一次，仍然失败就暂停该号 60 秒并切号，不再直接回 502。诊断固定 vm 时保持原来的行为。额度用尽、过载、鉴权错误不再 SIGKILL 槽内 CLI。
- 面板显示“限流中 / 过载冷却”和解除时间。新配置 `rate_limit.fallback_cooldown_min` / `overload_cooldown_min` / `empty_response_cooldown_sec` 有默认值，不用改 `routing.json`。

已部署机升级：覆盖控制面并重启 Node 一次，不需要 `wrap-cli/sync`。二进制未变。不要 `docker rm` 槽。

## 1.3.37 — 2026-09-23

- 播种默认 `grove_enabled: false`（`settings.json` / `kin-seed.json` 一起）。调用方传 `true` 也会被压回 false。不向 Anthropic 账号发 PATCH。
- 遥测开：写 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，`disable_nonessential_traffic: true`，其它 kill switch 仍删除。遥测关：该项写 `0`，旗标 false。面板预设、遥测页、官方初装 env、播种对齐脚本同一极性。
- 官方 Claude Code 把该变量的任何已设值（包括 `"0"`）都当成 essential-traffic。已有槽的磁盘文件要等下一次播种或官方初装才变。

已部署机升级：覆盖控制面和前端并重启 Node 一次，不需要 `wrap-cli/sync`。二进制未变。不要 `docker rm` 槽。

## 1.3.36 — 2026-09-23

- Setup Token 导入选择 session 时，`curl: (97) User was rejected by the SOCKS5 server (1 1)` 是槽位 SOCKS5 拒绝了用户名或密码。sessionKey 还没发出去。面板改为 `proxy_auth_rejected`（400），不再把这段 curl 报错当成 sessionKey 失效或 Cloudflare。

已部署机升级：只覆盖控制面并重启 Node 一次，不需要 `wrap-cli/sync`。二进制未变。不要 `docker rm` 槽。

## 1.3.35 — 2026-09-23

- 加强经中继转发的官方 Claude Code 识别。sub2api 只在 body 还带着 billing 块时认 `Go-http-client`；有的中继会把 billing 头剥掉，只留下 `anthropic-beta: claude-code-20250219`、官方 `user_id` 和官方 system 正文。这类请求现在也算官方流量：不注入 persona、不改 system 前缀。只有身份那一行、没有这个 beta 的第三方请求仍然不认。

已部署机升级：只覆盖控制面并重启 Node 一次，不需要 `wrap-cli/sync`。二进制未变。不要 `docker rm` 槽。

## 1.3.34 — 2026-09-23

- 修正 1.3.33：结尾的 `role=system` 提醒对所有 cli-hop 请求都保持原位，不再只限被识别为官方 Claude Code 的请求。经中继转发的官方客户端 UA 被改成 `Go-http-client`、billing 头也被剥掉，会落到第三方分支，第 2 轮仍然整段重写缓存（线上 `6cd037a8`，`cache_prefix` 断在 `system`）。不支持 `role=system` 的模型（Haiku）仍然搬移。

已部署机升级：只覆盖控制面并重启 Node 一次，不需要 `wrap-cli/sync`。二进制未变。不要 `docker rm` 槽。

## 1.3.33 — 2026-09-23

- 修复官方 Claude Code 走 cli-hop 时 prompt cache 只写不读。Node 按 VM 的 HTTP beta（不含 `mid-conversation-system`）把每轮的 `role=system` 提醒（`<total_tokens>` 等）搬进 `system[]`，`system` 每轮都变长，缓存前缀从 system 开始就对不上。但 cli-node 发出的请求自带这个 beta，内核也不转发 envelope 头。现在 cli-hop 的 envelope 不再按这组 beta 改写 body；只有不支持 `role=system` 的模型（Haiku）仍在 `prepareCliHopBody` 里搬移。第三方请求路径不变。
- 官方 Claude Code 结尾的 `role=system` 提醒（首轮是 SessionStart 上下文，之后是 `<total_tokens>`）不再搬进 `system[]`，按原位置发出。原先 cli-node 把它拼进主提示词那个 system 块，第 2 轮以及每次提醒内容变化的那一轮都会整段重写缓存。第三方请求当时仍然搬移，后续版本起也保持原位。
- 新增缓存前缀检测：同一账号、同一出站会话的每一轮，和上一轮比较 tools → system → messages，第一处不同写进调试日志的 `cache_prefix`，并在 Node 日志打 `[cache-prefix] … broke at …`。之前只看 token 数，只写不读的问题好几天都没被发现。客户端 `/compact` 后报一次断点属正常。
- `/wrap` 改为槽更新页：从 GitHub 拉取或本地上传，都只更新仓内 kernel；cli-hop 重装按勾选的槽或全部槽逐个执行并显示进度，「替换此槽」只改一台。右侧卡片新增「一键全部重装最新内核」，把最新 `cli-node` 和 cli-hop `kin-kernel` 装进全部槽。

已部署机升级：覆盖控制面（含控制台前端）并重启 Node 一次。缓存修复不需要 `wrap-cli/sync`，二进制未变。不要 `docker rm` 槽。

## 1.3.32 — 2026-09-23

- 按当前本地 patch 重编 `share/wrap-cli/cli-node`，UPX 5.0.1。零注入账单头固定进程内 `cc_prompt_id`，不再写出随请求变化的 `cch`。无 ttl 断点仍按已有断点或 `kernel.json` 的 `default_cache_ttl` 补齐，缺省 `1h`。
- `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 仍是 1.3.31 那一份。

已部署机升级：覆盖控制面并重启 Node 一次，再 `wrap-cli/sync`。只换磁盘上的 `cli-node` 不会换掉正在跑的进程。不要 `docker rm` 槽。

## 1.3.31 — 2026-09-23

- 粘性会话不再因容量不足换 VM：已绑定账号抢座位失败时在原账号排队；等待队列满或内核返回 `slot_busy` 时只让本次请求借用别的账号，绑定保持不变，下一轮回到原 VM。额度用尽、鉴权失败、禁用和冷却仍然解绑换号。
- `bin/kin-kernel` 重编：VM 内 session 固定到同一个 slot，24 小时未使用才释放；绑定的 slot 忙时只借用、不改绑；新 session 优先用没人绑定的 slot。slot 达到 `KIN_SLOT_MAX_JOBS` / 寿命上限后原地重置计数，不再标记 Dead（原先 native host 不会重新上报，槽位会永久减少并把会话挤走）。
- 额度窗口（5h/7d）过期后面板不再一直显示 0%：对这些槽 hop 一次 `/usage`，之后间隔 15 分钟。

已部署机升级：覆盖控制面并重启 Node 一次，再 `wrap-cli/sync`（或面板内核热更新 `v1.3.31`）让槽内换上新 `kin-kernel`。不要 `docker rm` 槽。

## 1.3.30 — 2026-09-23

- 缓存 TTL 优先级统一：`x-kin-cache-ttl` 头 → 请求断点上显式 `5m`/`1h` → 设置菜单。官方 Claude Code 的无 ttl 断点不再落成隐式 `5m`，改用菜单值；原先官方流量直接跳过 TTL 解析。
- 同一会话（出站 session id）只写一种 TTL：首轮解析结果钉住，空闲超过该 TTL 后才重新解析。中途改菜单不再让同一前缀在 `5m`/`1h` 之间切换。
- 本地代理（`px-local` / `scheme=local`）按宿主机默认路由直连（`mode: direct`）：不启 kin-egress，kin-egress 未运行不再记 `egress_down`，空 worker 代理不再判 `worker_proxy_missing`。操作者手动禁用本地出口仍拦截；远程 SOCKS5 仍走 kin-egress。

已部署机升级：只覆盖控制面并重启 Node 一次，不需要 `wrap-cli/sync`。二进制未变。不要 `docker rm` 槽。

## 1.3.29 — 2026-09-23

- 修复 native Claude 多轮 prompt cache 只写不读：Node 清理旧断点，CLI 保留当前尾部并为 `messages.length >= 4` 的倒数第二个 user 写入稳定断点。
- 同步 `share/wrap-cli/cli-node` 为双断点修复后的 CLI 二进制；面板选择的 `5m` / `1h` TTL 继续由每轮 native job 统一使用。

已部署机升级：覆盖控制面并重启 Node 一次，再执行 `wrap-cli/sync` 重启槽内 dataplane。不要 `docker rm` 槽。

## 1.3.28 — 2026-09-23

- cli-hop 接受 `claude-opus-5.5`，出站写成 `claude-opus-5-5`。思考用 adaptive，缺省 effort 是 medium。价目按官方 $4 / $20。
- 出站 Claude Code 版本从 `2.1.278` 改为 `2.1.280`。`2.1.278` 会被上游拒成 `claude_code_version_too_old`。
- 去掉 Codex Rotate 插件（`X-Codex-Turn-State` 采集/注入）。官方插件默认关闭，路由缺省对象曾把它当成开启。设置页不再提供开关。

已部署机升级：控制面覆盖后重启 Node 一次，再 `wrap-cli/sync`，让槽内 kernel 读到新的 `cli_version`。`bin/kin-kernel` 本身没变。不要 `docker rm` 槽。

## 1.3.27 — 2026-09-22

- cli-node 补上的无 ttl 断点改成与 Node 已写断点相同的值。没有已有断点时用 `kernel.json` 的 `default_cache_ttl`，再缺省 `1h`。避免 system 的隐式 `5m` 落在后面的 `1h` 前面。ELF 经 UPX 压到 50MB 以内。
- `wrap-cli/sync` 铺完文件后按 `/proc/pid/exe` 结束槽内正在跑的 `cli-node` 和 kernel，再拉起。不再用 `pkill -f`：那条命令的参数里就有同样的路径，shell 先被杀掉，旧进程继续占着旧 inode。

已部署机升级：先更新控制面并重启 Node 一次，再 `wrap-cli/sync`。只换磁盘上的 `cli-node` 不会换掉正在跑的进程。不要 `docker rm` 槽。

## 1.3.25 — 2026-09-22

- OpenAI 号池按权重、会话粘滞和 smart 分数选槽，不再按额度压力排序（#80）
- cli-hop 缓存 TTL 跟设置 → 协议，缺省 **1h**，不再写死 5m。请求头 `x-kin-cache-ttl` 仍可覆盖。空的 kernel `default_cache_ttl` 也回落 1h（#81）
- kernel 重装页可从本仓库 GitHub Release 下载 linux amd64 `kin-kernel`，校验 ELF 后写入并同步所选槽。下载地址只允许 `dofastted/vm2api`，失败或不是合法 ELF 时不写文件（#82）
- `session_slots` 是单槽同时在飞的座位上限；`max_sessions` 仍是不同对话窗口。粘滞账号暂停、等待队列满或预约失败时换到别的 VM。普通 502/503/504 冷却 15 秒并换号；Usage Policy 502 仍暂停该账号 1 小时，`slot_busy` 仍不停车（#83）

已部署机升级：`bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 有变，必须 `wrap-cli/sync` 并重启槽内 dataplane。不要 `docker rm` 槽。

## 1.3.24 — 2026-09-22

- cli-hop 对齐 sub2api 默认：不再改写 messages 上的 `cache_control`，system 断点也保留。只给最后一个非延迟工具补 5m 断点
- 仍钉住 `<total_tokens>`。kernel 继续 `preserve_cache_breakpoints`，不重打断点

已部署机升级：只更新控制面并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.23 — 2026-09-22

- cli-hop 的两个 message 断点都在 Node 打完，最后一条不再剥给 kernel 重打。kernel 收到 `preserve_cache_breakpoints`，不再改断点
- `messages` 里的 `<total_tokens>` 和 `system[]` 一样钉成 2.1.278 的 `15000000`，避免历史 system 提醒改掉已写出的前缀

已部署机升级：只更新控制面并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.22 — 2026-09-22

- cli-hop 把抬进 `system[]` 的 `<total_tokens>` 钉成 Claude Code 2.1.278 的固定 `15000000`。历史里的 `role=system` 不改。下一轮前缀能读到上一轮写下的缓存，不再整段重写
- 控制台日志改为 hub 样式，并带上用量图（#77）
- cli-hop 探测请求里过小的 `max_tokens` 抬到 1024，避免 wrap 把 max_tokens 打满当成失败（#73）

已部署机升级：只更新控制面和前端并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.21 — 2026-09-22

- 原子重写槽内 `kernel.json`、`worker.json`、`internal.token` 时，先把临时文件 chown 成槽 uid 再 `rename`。内容没变也会把已经变成 root 的 `kernel.json` chown 回去。避免控制面写出 `0600` 新 inode 后，槽进程读配置 `Permission denied`，容器 `unless-stopped` 重启循环（#71）
- cli-hop 用这一次请求的 `metadata.user_id` 同时作为 native slot 和 CLI cache key。同一会话的后续轮次读得到上一轮写下的缓存
- `bin/kin-codex-kernel` 转发 `x-codex-primary-reset-after-seconds` 和 `x-codex-secondary-reset-after-seconds`，并上报 `usage_limit_reached`、`upstream_auth`、`upstream_status`。websocket 增加 open timeout 与 keepalive failed

已部署机升级：`bin/kin-kernel` 与 `share/wrap-cli` 有变，必须 `wrap-cli/sync` 并重启槽内 dataplane。不要 `docker rm` 槽。Codex 槽使用新的 `bin/kin-codex-kernel`。

## 1.3.20 — 2026-09-22

- 本机出口即使没有 SOCKS URL 也视为已绑定直连出口；重置、worker reload、Codex kernel 配置与 GPT host hop 不再误判为未绑定
- incomplete 在下游已经 commit 或 transport 异常时同样立即释放全部粘滞会话键，不再占住 session window
- GPT / OpenAI 平台模型不再进入 Claude 蒸馏拦截；Claude 模型仍保留原有 harvest、指纹和思维链提取规则

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.19 — 2026-09-22

- 半截请求不再占会话槽：incomplete 立刻丢掉这次对话键，并马上回收内核槽，不再等 30 秒回收冷却
- `slot_busy` 的 503 不再把账号暂停 1 小时。槽满只回收内核，不再把整号打进冷却后让客户端看到「号池负载过高」
- 官方用量若以百分数 26 写入，按 26% 比较，不再当成 ≥100% 进入冷却。0–1 的真实 rejected（例如 0.84）仍然拦截

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.18 — 2026-09-22

- 没有调用方 session id 时，粘滞只哈希首条 user 的第一段文本。后面的文本块每轮都会变，不再因此新开一个 session 槽
- 同一会话的连续请求留在这一条槽上，消耗的是 RPM 和并发，不是 session 位置

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.17 — 2026-09-22

- Pro 95% 线提前挡住并发：窗口剩余不足 5 个点时不再放进第二条在途请求，避免冲过上游 rejected
- 会话已绑定的槽在 RPM 或并发满时留在原槽排队，不再另开一个会话。Opus 不再进 OpenAI 槽，GPT 也不进 Claude 槽
- 清冷却会清掉磁盘上的可恢复冷却，并把已经打满的 5h/7d 窗口标成过期，列表状态马上刷新。凭证吊销仍保持停用

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.16 — 2026-09-22

- Claude CLI 把 5h 窗口用尽包成 HTTP 502 `You've hit your limit`。这条改为账号额度用尽：冷却到窗口重置，并换到还有额度的账号。普通 500/502/503/504 仍暂停该账号 1 小时且不换槽
- 会话槽已满时，新会话进入等待队列，直到最老的会话空闲。已经绑定的会话仍留在原槽

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.15 — 2026-09-22

- 有调用方 session id 时，粘滞只认这一条。内容指纹、设备号和 envelope 不再把同一条对话拖到别的 VM。已绑定的账号和出站 session 不会被后一次成功改写
- `session_slots` 只数不同的对话，不再用正在飞的请求数占槽
- cli-hop 进内核前写入同一个 `metadata.user_id`
- HTTP 500/502/503/504 暂停该账号调度 1 小时，并把这次请求写入拒答缓存，1 小时后过期。不再因此换槽。响应头超时仍按原逻辑重试；529 仍是 15 秒短冷却

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.14 — 2026-09-22

- 设置 → 协议仍是人设和缓存 TTL 的唯一开关，写在 `routing.json`。保存后把解析结果投影到 Claude 槽 `vms/<id>/run/kernel.json`（`persona_preset`、`system_layout`、`default_cache_ttl`）。kernel 热读该文件，不必重启槽。Codex 槽不写。手改 `kernel.json` 会被下一次投影盖掉
- 保存提示用服务端回读的方案名，并报告热更新了几个槽。`官方完整提示词` 的 `persona_inject` 写回 `official_full`，不再折成 `rewrite`
- 虚拟机环境里保存时区或跟随代理时区，会把 `timezone` 热写进该槽 `kernel.json`。容器环境变量 `TZ` 仍要换容器才变

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.13 — 2026-09-22

- VM 列表状态条显示当前凭证的实际可用性（可用、凭证有效、限制、已过期、无凭证），不再用 7 日请求成功率。调度关但票还活着时显示「凭证有效」
- 列表、卡片和详情的 5h / 7d 用量同时显示该窗口的调用费用合计
- 平台筛选在 Claude 旁增加 OpenAI（GPT）按钮

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.12 — 2026-09-22

- 没有调用方会话时，出站 `session_id` 不再每跳 `randomUUID`。种子是账号、客户端（IP、去掉版本号的 UA、API key）和首条 user 文本
- 同一账号的粘性行复用已保存的 `session_id`。首句被裁短也不重铸；换号才重铸，回到原账号恢复原 id
- 非官方计费头 `cc_prompt_id` 改成同一个 UUID，连续对话不再每次重建 prompt cache

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.11 — 2026-09-22

- 拒答缓存命中直接 HTTP 500（`refusal_guard`），蒸馏命中仍返回配置的错误码（默认 403 `distill_blocked`）。两条都在 Codex hop 和 `count_tokens` 之前拦住，请求正文不会进槽
- 蒸馏硬正则补上知识/模型蒸馏和提取思维链（extract/dump chain-of-thought、提取/蒸馏思维链）。官方、0 注入、面板删规则也不放行。化学 distill、单独「思维链 / 请分步解答」仍不拦
- 槽内 `kin-worker` 完整读取 `worker.json` 遥测（env、betas、headers、身份）。文件变更按 mtime 热更新，不必重启进程。事件 beta 对齐 Claude Code 2.1.278 主会话，不再回退 2.1.241
- 初装保存把 `official_cc.inference` 固定为 cli-hop。虚拟机种子页在遥测打开时锁定 DNT 与非必要流量，并标明外部「同步遥测」会在下次换票重新打开本槽遥测

## 1.3.10 — 2026-09-22

- cli-hop 出站只写 `5m`。wrap 的 tools/system 不带 ttl，Anthropic 当成 `5m` 且排在 messages 前面；后面再写 `1h` 会 400。控制台默认仍是 `1h`，但 cli-hop 不把它写到线上。
- 粘性会话按平台分开：同一对话只占一个 VM session 槽，未命中时等待，不再另开第二个会话
- 模型页拆成 Claude 与 GPT 两个池；切换目录在页头，GPT 隐藏 Claude 的 1M 控件，未保存修改要确认后才换池
- 主 Messages 仍是 `claude-cli/2.1.278 (external, sdk-cli)`，不改成 `claude-code`；beta 用 `thinking-binding-controls-2026-08-01` 替换 `advanced-tool-use`。`x-claude-code-compaction` 只在客户端已经发送时转发
- 面板保存 `cache_ttl` 或 `persona_preset` 时重写 Claude `kernel.json`（`default_cache_ttl`、`system_layout`、`cli_version`）。Codex 槽不写
- `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 换为同一份新 ELF：`CLAUDE_CODE_ENTRYPOINT=sdk-cli`，`CLAUDE_CODE_VERSION` 缺省 `2.1.278`，放行 `x-claude-code-*` 条件头，并读取面板写入的 `default_cache_ttl` / `system_layout`。升级必须 `wrap-cli/sync` 并重启槽内 dataplane，不要 `docker rm` 槽
- `share/wrap-cli/cli-node` 换为已打补丁的 Claude Code 包，UPX 5.0.1 从 110MB 压到 28MB。`package.json` 仍是 2.8.4；出站 UA / billing 读 `CLAUDE_CODE_VERSION`，缺省 `2.1.278`
- 部署改为拉预构建镜像：控制面与槽位 OS 镜像随 Release 推到 ghcr，`install.sh` 只下载 compose/.env（不再 clone 仓库），`docker compose pull && up -d`，服务器上不再构建前端与镜像；源码模式用 `--from-source` 或 `docker-compose.build.yml`
- 安装目录不再限定 `/opt/vm2api`：槽容器的 `-v` 源路径由控制面自省自身 Mounts（或 `VM2API_HOST_ROOT`）换算成宿主路径，命名卷同样成立
- 槽位镜像缺失时先 `docker pull` 再用仓内 Dockerfile 兜底构建；启动阶段只拉不构建，冷启动不再被 apt 阻塞
- 首次启动自动补本机出口 `px-local`，并允许本机出口直接启动槽（此前只认带 SOCKS URL 的出口）

## 1.3.9 — 2026-09-21

- cache TTL 现在贯穿请求 header/body、Settings compatibility、Unix socket envelope 与 Rust kernel；请求级 `5m` / `1h` 覆盖不会通过共享 kernel 配置串值，官方 Claude Code 继续保留客户端自有断点
- `VERSION` 成为唯一应用版本源；控制台从运行态 `/api/panel/me` 显示版本，Release 校验 tag，打包自动重建前端，避免旧构建版本漂移
- 蒸馏硬拦截 memory-stage-one / MUST distill / MUST extract durable memory 收割包装（含信封 JSON 外包的收割），官方、0 注入、面板删针也不能放行；单独 `Persistable response items` 仍不是针
- 拒答缓存只记 `stop_reason=refusal` / `content_filter` / refusal 块；wrap `Usage Policy` 文案不再当拒答，也不再剥信封 JSON 指纹（当时 262 条全是正常信封会话误入，hit_count=0）
- wrap Usage Policy 502 仍可 failover，不再映射成 403 `content_filter_refusal` 停换号
- 内核页改名为 **kernel重装**；槽同步优先仓内最新 `bin/kin-kernel`（`KIN_KERNEL_BIN`），不再被旧 wrap 母样本 ELF 盖回去
- 可上传 linux amd64 kernel 二进制替换仓内 kernel，再同步到所选 VM

## 1.3.8 — 2026-09-21

- cli-hop 固定以 5m 写入多轮会话断点，避免 wrap 的 ttl-less 5m 断点后出现 1h 而被上游 400；覆盖 `/v1/chat/completions` 入站转换
- SSE 聚合不再用空 assistant 信封覆盖真实上游错误；同一 session 请求串行，不同 session 继续并发
- 控制面启动后立即核验并修复已启用出口，不再等待下一轮代理池定时探测
- 虚拟机列表行内新增删除入口（列表与网格视图），需键入槽位 ID 确认；活跃槽位仍需先切换活跃
- 槽位命名不再限定 `vm-` 前缀：`vms/*.json` 全部纳入列表、DB 镜像、指纹对齐与备份恢复；`active`/`create`/`import` 与 `-chat` 后缀保留为非法 ID
- 空 cli-hop 终止帧不再提交或视为成功；同一 VM 仅恢复重试一次，避免单请求遍历整个账号池
- 显式 session 作为并发串行与粘性主键；`claude-opus-4-8` 固定走 Anthropic，Fable 无 Max 返回专用 429
- 覆盖安装枚举旧命名 VM，并要求槽内 kernel 同步与重启全部成功后才报告升级完成
- 默认 Session 槽位设置与现有设置行对齐，并同步更新所有未单独覆盖的 Claude VM
- Protocol 人设方案与自定义模板现在会在 Rust cli-hop 请求阶段按全局/每槽解析后实际传给内核

## 1.3.6 — 2026-09-21

- Rust kernel 固定预开 20 个 Claude native CLI session 位
- 新增全局与每槽 `session_slots` 热准入上限，独立于并发、RPM 与 sticky session
- 设置页和 Claude VM 详情支持 Session 槽位配置；Codex 槽保持隐藏
- routing 持久化失败时完整恢复内存运行态，避免半应用配置

## 1.3.5 — 2026-09-21

- Claude Code 身份、User-Agent 与默认 beta 序列同步官方 2.1.278 抓包
- official 请求条件透传 request class、agent type、前序工具耗时与 context compacted 标记
- SSE 聚合保留 `stop_details`、`safeguard_results` 与 `diagnostics`

## 1.3.4 — 2026-09-21

- OpenAI 模型无论入站 chat、messages 还是 responses，hop 都洗到 `/v1/responses`
- 请求日志记录清洗后的 path/protocol；原来的入站协议留在 `hop_meta`
- API 类 OpenAI 上游改为官方 Responses，不再 POST `/v1/chat/completions`

## 1.3.3 — 2026-09-21

- Codex Rotate 插件：采集并注入 `X-Codex-Turn-State`（292/332），设置 → 协议可开关，默认关闭
- OpenAI / Codex 用量保留 `cached_tokens` 与 `cache_write_tokens`，计费和日志不再把上游缓存读成 0
- 面板公开 routing 脱敏 SMTP / Telegram 密钥
- 官方 CCH 按 xxh64 body hash 计算

## 1.3.2 — 2026-09-21

- 控制台左上角在 vm2api 徽标下显示构建版本号
- Vite 从仓库 `VERSION` 注入版本，Docker 前端构建同步复制版本文件

## 1.3.1 — 2026-09-21

整合 VM 列表可视化升级与 1.3.0 网关遗漏修复。

- VM 列表加入 fleet pulse 与用量仪表，重整桌面和移动端信息层级
- 并发预约竞态失败后尝试其他账号，全部繁忙时进入账号等待队列
- thinking-only、缺少 `stop_reason` 或非 assistant envelope 的响应不再误判成功
- 同槽兄弟请求阻止即时回收时，最后一个请求结束后补做 wrap 回收
- 控制台缓存 TTL 仅支持 `5m` / `1h`；请求显式 TTL 覆盖默认值，所有出站断点统一复写
- Compose 默认镜像更新为 `vm2api:1.3.1`

## 1.3.0 — 2026-09-20

- 官方 Claude Code init 同时读取并保留 `~/.claude.json` 与 `CLAUDE_CONFIG_DIR/.claude.json`，不再在身份同步后删除 CLI 生成文件
- routing 配置缺失或损坏时启动显式失败；VM 创建/启动响应不再返回账号、指纹、代理凭据及宿主运行时标识
- 确认发布 kernel 在 `tool_use` 终止帧送达后归还 native slot，连续工具调用可独立恢复

## 1.2.22 — 2026-09-20

修复 Anthropic 工具循环缓存命中固定在约 53.2K，并让一键更新与 Docker 更新自动替换槽内 kernel。

- Node 重写稳定的上一轮 user 断点，并移除当前尾部断点；槽内 kernel 只补当前尾部，不再清除历史 marker
- cli-hop 断点统一为 5m，避免 wrap/kernel 的 5m marker 后出现 1h 而被 Anthropic 拒绝
- `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 同步更新；一键更新默认调用 `wrap-cli/sync`，Docker 更新检测发行 kernel 变化后自动同步所有槽
- 槽同步按文件内容判断，不会因二进制大小相同或旧文件 mtime 更新而跳过；替换和重启 dataplane 均不 `docker rm` 槽

已部署机升级：使用一键更新即可同时更新控制面、模板与槽内 kernel。实测工具循环 `cache_read` 为 `12532 → 14584 → 16636`，不再固定。

## 1.2.21 — 2026-09-20

57K 掉回 53K 不是 TTL。线上所有 `kernel.json` 都是 `system_layout=zero`，wrap 只打 persona，不重打 last+prev user；Node rewrite 的 message 断点到不了 Anthropic。不必 overlay 整份 routing，也不必 `wrap-cli/sync`。

- `resolveCliSystemLayout` 跟 `persona_preset`（`official_full` → identity），不再在缺 routing 时静默写成 zero
- 已有槽位 `kernel.json` 改成 identity 后 `docker restart`（不是 `docker rm`）
- 线上 `cache_ttl` 从误写的 `5m` 改回 `1h`

已部署机升级：覆盖 `src/lib/vm/slot-engine.mjs`，改 `kernel.json` + `routing.json` 的 `cache_ttl`，重启槽容器和 Node 各一次。

## 1.2.20 — 2026-09-20

cli-hop 不再吃 routing 的 `messages=fill`。1.2.19 常量改回 rewrite，但 hop 仍传入线上 fill；入站已有 last-user 标记时 fill 空转，再 drop last 就只剩 ~53k persona。不必换槽内 kernel。

- `prepareCliHopBody` 强制 `messages: rewrite`，并继续关掉 system/tools tail
- 多轮 leftover 是上一条 user，`cache_read` 应随对话增长
- 不要 overlay `routing.json`

已部署机升级：只覆盖 `src/lib/protocol/outbound-attempt.mjs` 并重启 Node 一次。不必 `wrap-cli/sync`。

## 1.2.19 — 2026-09-20

cli-hop 断点回到 1.2.0 rewrite。线上 kernel 是 `system_layout=zero`，不会重打 messages，剥光后 cache_read 就钉在 ~53.2k persona 前缀。不必换槽内 kernel。

- Node 重打最后一条 + 上一条 user，再去掉最后一条 stamp，留给 wrap 打当前 last user
- leftover `role:system` 仍不打断点；tools / system tail 仍关
- 官方和第三方同一套 stamp，conversation 增长后 cache_read 应超过 53.2k

已部署机升级：只覆盖 `src/lib/protocol/outbound-attempt.mjs` 并重启 Node 一次。不要 overlay `routing.json`。不必 `wrap-cli/sync`。

## 1.2.18 — 2026-09-20

连续 session 的 `provider error: Connection error` 是 wrap CLI 本地断流，不是 Anthropic。`message_start` 曾被当成已提交，导致不重试；1.2.17 回收又被 inflight 挡住。不必换槽内 kernel。

- 下游提交改到可见输出或 `message_stop`；只有 `message_start` 的 Connection error 不写给客户端
- 同号重试一次，并 **强制** `docker restart` 回收 wrap（不再被 busy/inflight 短路）
- 客户端代码是 `wrap_connection_error`，不是 `upstream_error`

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.2.17 — 2026-09-20

连续 session 半截后 kernel 槽不释放，下一跳空等 30s 再报 `no free slot`，面板还写成上游错误。不必换槽内 kernel。

- 半截 / Connection error 且没有并列 hop 时回收 wrap（pid1 走 `docker restart`，不是 `docker rm`）
- `slot_busy` 对客户端是 `overloaded_error`，不是 `upstream_error`
- 面板测试文案标明这是 VM 内核槽占满

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.2.16 — 2026-09-20

蒸馏针名单回到 1.2.1。今天加的信封收割句是误拦根因。不必换槽内 kernel。

- 去掉 `Persistable response items` / `Memory-stage-one extractor` / `MUST extract` / `MUST distill`，也不再扫 messages 里的 system/developer
- 指纹、`<think>`、contest+harvest 与 1.2.1 相同
- 信封流量仍按 API key 粘 `k{id}:envelope`，避免 403 重试把同一会话拆到多个号

已部署机升级：只更新控制面并重启一次。必须覆盖 `src/config/distill-rules.json`。不必 `wrap-cli/sync`。

## 1.2.15 — 2026-09-20

信封流量不再误拦蒸馏，同一 API key 信封会话粘到一个账号。不必换槽内 kernel。

- `Persistable response items` 只当运输包装，不再单独 `distill_blocked`；收割句、其它 needle、指纹、contest+harvest 仍拦
- conversation 模式下信封请求绑 `k{apiKeyId}:envelope`，忽略每跳不同的 `thread_id` / first-user hash
- `ip` / `session` 模式不改；无信封流量仍走 header / metadata / first-user hash

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1215)

## 1.2.14 — 2026-09-20

第三方 cli-hop 改回 1.2.1 剥光，让 cache_read 随对话增长。不必换槽内 kernel。

- 保留 1.2.12 的 convert 块形状对齐（chat / Messages / responses 升块并保留 `cache_control`）
- unofficial hop 不再 Node rewrite last+prev；官方和第三方都剥光，由 kernel 重打最后一块 + 上一条 user
- 避免 leftover `role:system` 被打上断点，把 `cache_read` 钉在 ~53k persona 前缀

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1214)

## 1.2.13 — 2026-09-20

修正 Compose 镜像名。不必换槽内 kernel。

- `docker-compose.yml` 的 `image` 从错误的 `vm2api:1.2.12,,` 改为 `vm2api:1.2.13`

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1213)

## 1.2.12 — 2026-09-20

第三方 OpenAI 兼容口与 Anthropic Messages 的 cache 断点对齐。不必换槽内 kernel。

- 清洗后 system / messages 升成可挂断点的 text 块，保留 tools 与文本块上的 `cache_control`
- 非官方 cli-hop 改回 Node rewrite（last + 倒数第二个 user），官方仍剥光交给 kernel
- 三种入站协议 stamp 位置一致，避免 `cache_read` 冻在 system 前缀

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1212)

## 1.2.11 — 2026-09-20

控制面调度补齐等待计划、额度受限三态和设置/列表。不必换槽内 kernel。

- 槽满（`ready_slots=0` 且 CLI 在）按 `slot_busy` 等待或改选，不标 `worker_unhealthy`
- 半截 assistant 不再经 `preferLastResult` 变成 HTTP 200
- 等待按账号计数，超时绑 wait plan；hop 吃剩余预算
- 额度用尽 / 429 / 冷却写成 **受限**，不拨操作员调度关；窗口到了自动恢复
- 列表芯片：在池 / 受限 / 关闭调用；设置页露出等待人数和两类超时
- Windows 上 Vite 8 / Vitest 4 能装到 rolldown 的 win32 绑定

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1211)

## 1.2.10 — 2026-09-20

修复 Docker web 构建，并换仓内 `kin-cookie-auth`。不必换槽内 kernel。

- 401 跳登录补上必填 `search`，`tsc -b` 通过，compose 不再卡在 Dockerfile 第 7 步 `pnpm build`
- `kin-cookie-auth` 按 rust cli-hop 2.1.263 对齐 sessionKey 换票请求头（`claude-cli` + stainless，不再用合成 Chrome UA）

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1210)

## 1.2.9 — 2026-09-20

thinking-only 残包不再当 HTTP 200；一键安装与 HTTP 面板登录加固。不必换槽内 kernel。

- `stream:false` 组包未完成不算 committed；只有 thinking / `stop_reason=null` 的假 `verified` 同槽再 hop，拿到正文再 200
- 重试用尽才 502 `incomplete_response`，禁止 `terminal_state=verified` + 空正文
- 槽满（`ready_slots=0`）等空槽，不 `docker restart`，也不往满槽塞请求
- 一键安装：空 `.env` 补默认管理台 `admin` / `123456`（不覆盖已有密码）与随机 API key；缺 `!CHANGELOG.md` 则补上并在 compose 失败时重试
- HTTP 裸 IP 登录：Bearer 写入 localStorage；Cookie `Secure` 跟请求走；401 回登录页，不再摊英文 Missing credentials

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-129)

## 1.2.8 — 2026-09-20

修复 compose build：`.dockerignore` 的 `*.md` 把 `CHANGELOG.md` 挡在构建上下文外，`COPY CHANGELOG.md` 失败。不必换槽内 kernel。

- `.dockerignore` 增加 `!CHANGELOG.md`

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-128)。卡住的 1.2.7 构建可先在仓库根 `.dockerignore` 加一行 `!CHANGELOG.md` 再 `docker compose up -d --build`。

## 1.2.7 — 2026-09-20

控制面：版本检查与一键更新。不必换槽内 kernel。

- `deploy/install.sh`：安装 / 更新 / 检查 / changelog / 状态（参考 sub2api 与 CLIProxyAPI）
- 面板 `GET /api/panel/version`、`GET /api/panel/changelog`、`POST /api/panel/update`；`GET /me` 带 `version`
- 设置页「关于」：当前版本、GitHub 最新 Release、changelog、复制一键命令
- 镜像 COPY `VERSION` / `CHANGELOG.md`；已挂 `docker.sock` 时可由面板拉起宿主机升级助手

已部署机升级：只更新控制面 Node（含 web）并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-127)。

## 1.2.6 — 2026-09-20

控制面：本地出口导入、kernel 探活、Setup Token 额度。不必换槽内 kernel。

- 本地出口绑槽后允许导入 / host hop（空 SOCKS URL 视为直连，不再报未绑定）
- 调度、面板 live credential、VM 详情健康检查打 rust `kernel.sock`，不再探不存在的 `worker.sock`
- Setup Token 写入凭证时把 `inference` 规范成 `user:inference`
- Setup Token Extra 5h/7d 进面板详情；手动额度探测真正 hop
- 额度卡展示剩余百分比与重置时间

已部署机升级：只更新控制面 Node（含 web）并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-126)。

## 1.2.5 — 2026-09-20

仓内预编译 linux amd64 二进制，clone / compose 即可部署，不必在服务器上编 kernel 与 wrap CLI。

- `bin/kin-{kernel,codex-kernel,cookie-auth,egress,worker}` 与 `share/wrap-cli` 进 git；Release 再挂一份 ELF
- 已部署机升级：控制面重启一次 + `POST /api/panel/wrap-cli/sync` 换槽内 CLI（见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-125)）

## 1.2.4 — 2026-09-20

协议页简化 UI。缓存 TTL 默认 1h，可改 5m。

## 1.2.3 — 2026-09-20

控制面：拦截 memory-extractor 收割；创建槽开机失败仍可见；控制台集群/列表改版。

- 非官方 OpenAI chat 冒充 Claude Code、索要 durable-memory JSON 的 payload 在 hop 前拦截
- 创建槽位开机失败改 200 + `start_error`，列表立刻出现 error 行，不再当创建失败
- 集群页改为本机 VPS + 扩展节点拓扑（控制面尚未接入，示意为 RFC 5737）
- 虚拟机列表去掉重复 KPI 卡，筛选/工具收成两行

已部署机升级：只更新控制面 Node（含 web）并重启一次。已在 1.2.2 不必再 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-123)

## 1.2.2 — 2026-09-20

修复缓存问题；换票逻辑更新。

- 额度缓存空刷新不再覆盖仍有效的 reset credits
- sessionKey / 授权码换票改走仓内 `bin/kin-cookie-auth`，控制面不再带过程源码
- 已部署机升级：控制面重启一次 + `POST /api/panel/wrap-cli/sync` 换槽内 kernel（见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-122)）

## 1.2.1 — 2026-09-19

模型测试路径不再因缺 `message_stop` 刷成 api_error。

- wrap JobDone 若未带 `message_stop`，kernel 补发，hop 不再标 incomplete
- cli-hop 剥光 messages 上的 `cache_control`；kernel 按 Claude Code 打最后一块（跳过 thinking）并打上一条 user，避免 tool 循环把 cache_read 钉在 ~45k system 前缀

## 1.2.0 — 2026-09-19

messages 缓存断点对齐 sub2api/Parrot。

- 最后一条 + 仅当 messages≥4 打倒数第二个 user
- cli-hop 丢掉 last 后留下倒数第二个 user，wrap CLI 重打当前 last user，不再重复

## 1.1.9 — 2026-09-19

cli-hop prompt cache restamp；环境时区可自定义；代理出口地理检测。

- 默认 messages 断点 rewrite：重打最后一条 + 上一条，避免 cache_read 冻在 ~43.5k system
- cli-hop 只打 conversation 断点，剥 tools/system 和 last-message 让 wrap CLI 落点，不超 4 断点上限
- 创建槽位和环境设置支持任意 IANA 时区（自定义输入）
- `POST /proxies/geo` · `POST /proxies/:id/geo` 经 SOCKS5 查出口 IP 的国家 / 城市 / 时区
- 绑定代理后槽位默认采用出口时区；手动钉过的时区不被覆盖

## 1.1.8 — 2026-09-19

面板分档配额立刻生效；东京时区；Fable 5.1 官方模型 ID。

- 控制面板 5h/7d、RPM、并发、session 走 live policy；session 占用保持到空闲超时
- 槽位创建支持东京 JST，有效 IANA 时区在创建/指纹/重建时保留
- 内置目录改为 `claude-fable-5-1`，点号 ID 作兼容别名

## 1.1.7 — 2026-09-19

Opus/Sonnet extra-usage 429 与 GPT `/v1/messages` 未绑槽一并修掉。

- wrap/kernel `CLAUDE_CODE_ENTRYPOINT=cli`，订阅 OAuth 不再按 sdk-cli extra usage 429
- HTTP 2xx leftover `stream_incomplete` 不再刷成超时
- GPT 模型打 `/v1/messages` 转到 Codex 槽，回 Anthropic 信封，日志带 `vm_id`

## 1.1.6 — 2026-09-18

同步源仓 wrap 内核：复用槽内 `.claude`，submit 更快起 job。

- wrap 指向凭证父目录，不再写临时 config + dummy OAuth
- `kin_job_start` 先于 extra maps；热路径不再 `await retire_idle`

## 1.1.5 — 2026-09-18

同步源仓内核/后端补丁：wrap Extra 5h 头、slot 回收、官方 max_tokens、GPT 额度 failover。

- wrap `kin_job_done` Extra 5h 头进 trailer；ReadyBlocked 不再 30m 误杀；job 后清 tenant
- 缺 `max_tokens` 填官方 per-model 默认，不覆盖调用方
- GPT `x-codex-*` 入库，5h/7d 调度关，429 最多 4 槽 failover
- 本地与 CI 统一格式：Biome / gofmt / Prettier，全文 LF
- README 恢复详细说明；许可改为非商用开源，商用需书面授权

## 1.1.4 — 2026-09-17

补齐 cli-hop CI 夹具，和源仓 simulated job_error / CONNECT 桥一致。

- simulated CLI 对 `[job_error]` 发 `kin_job_error`，槽可回收
- 补回 `scripts/http_to_socks.py`，适配 `crates/kin-kernel` 布局

## 1.1.3 — 2026-09-17

gateway-worker 对齐源仓：local_cli 走 wrap CLI，不再 HTTP hop 到 Anthropic。

- `provider=local_cli` 启动 MultiplexCli，`/internal/v1/messages` 走 cli-hop
- 去掉 anthropic_api HTTP hop，避免 OAuth extra usage 429

## 1.1.2 — 2026-09-17

仓内携带部署二进制；文档写清运行形态。

- git 带 linux amd64 `bin/kin-{kernel,egress,worker,codex-kernel}` 和 wrap 母样本 `share/wrap-cli`
- Compose 拷到 `./bin` / `./share`，不再在服务器上编 Rust/Go；缺 `kin-os/ubuntu:24.04` 才编槽位 OS
- 入口用 `mv` 替换占用中的 `kin-kernel`，避免 `Text file busy` 重启循环
- 文档：1 个控制面容器 + 每个已启动槽 1 个 `kin-*` 容器，不是父容器多进程

## 1.1.1 — 2026-09-17

补回授权链接换票缺件。

- 补回 `scripts/session-import-cffi.py`（源仓 CookieAuth / Chrome TLS），控制面镜像安装 `curl_cffi`
- 补回官方 Claude Code 常驻脚本 `scripts/official-cc-resident.py`

## 1.1.0 — 2026-09-17

推荐 Docker Compose 部署，并修槽位启动。

- 文档把 Compose 定为生产推荐路径（`/opt/vm2api` + `docker.sock` + host 网络）
- 槽位客户镜像配方进仓：`docker/kin-os/`（`node docker/kin-os/build.mjs`）
- 修复本地出口启动误判 `egress network missing`（inspect 同时返回 `name` 与 `network`）
- 文档要求 `bin/kin-*` 为 **755**：槽 UID 是 `10000+序号`，`700` 会 permission denied
- 标明 Docker Desktop / WSL 下 `127.0.0.1:8787` 可能打不到 host 网络
- 控制面可用 Docker Compose 部署（槽位仍在宿主机引擎）
- 同步源仓运行时补丁：换票后回收 wrap、官方凭证软链、未确认 401 不再当吊销
- 同步源仓 GPT 额度：重置券缓存失败不覆盖、探测带回 `cred_status`

## 1.0.0 — 2026-09-16

首个公开版本。

- Setup Token → Console API，产品面 0 提示词注入
- 推理只走 Rust 内核 + Claude Code 原生 subagent（最大 20）
- 删除 Go HTTP hop；`kin-worker` 只保留 telemetry
- 代理池支持远程 SOCKS5 与本地出口（宿主机 NAT）
- Vite 管理台（`GET /console`），环境变量 admin，无用户管理
- 协议口 `/v1/messages` 及 OpenAI 兼容入口
- GitHub Actions：测试 + `v*` linux amd64 Release
- 文档：技术路线图、部署说明、版本构建

交流：[t.me/VM2API](https://t.me/VM2API)
