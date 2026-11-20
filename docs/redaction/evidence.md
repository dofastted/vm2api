# 源码证据与复用边界

日期：2026-10-28。本文是 vm2api 脱敏插件设计的事实索引，不是已实现功能说明。

## 1. 证据身份

- ZIP：`redact-source-and-roadmap.zip`，355 个成员，SHA-256 `b1ce4b6fcdad1096dcf914394b008e60a990451204aafc36ef2690eefc4c81c2`，与原 `ARCHIVE.sha256` 一致。
- 本轮验证 ZIP CRC、成员唯一性与路径安全；`internal/redact`、`internal/masking`、`internal/gwmw`、`plugins/redact` 范围共 54 个归档文件与对应参考源码逐字节相同。
- 原 `README.zh-CN.md`、`TECHNICAL-ROUTE.zh-CN.md`、`verification.txt` 及归档保持原样。本轮运行记录在本目录 `verification.md`，不借用上轮测试结果。权威设计在 vm2api 的 `docs/redaction/`，本轮原外部设计副本已移除。
- 下文 `engine/...` 是来源快照中的历史路径，不是仓库内 Go 脱敏引擎的路径。仓库内引擎位于 `redact/internal/engine`；`src/...`、`web/...` 相对于 vm2api 仓库根目录。
- 代码图用于导航，事实以源码读取为准。Rust codegraph 本轮返回 `Session terminated`；CGC 可用，但有旧行号与同名函数误关联。LSP 已用于查询配置工厂引用，返回只含声明，因此没有以该结果声称调用链完整。

## 2. 可复用 Go 核心

| 事实 | 源码证据 | 设计含义 |
| --- | --- | --- |
| `Options` 有 Secrets/Personal/Words/Rules/Kinds/Shape/Actions/Allow/Model，无 Enabled | `engine/internal/redact/redact.go:37-73` | 总开关必须由 vm2api 宿主独立拥有 |
| Wanted 是 Secrets 或 Personal 或非空词数组；插件 Essential/InUse 自动保活 | `engine/internal/masking/masking.go:21-36`；`engine/plugins/redact/redact.go:19-46` | 撤销服务注册不等于可靠关闭 |
| 纯算法只依赖标准库和 publicsuffix；模块为 Go 1.26.8 | `engine/internal/redact/redact.go:19-35`；`engine/go.mod:1-3,22` | 迁移纯核心，不复制 settings/pluginrt/GUI；不能从外部模块直接 import 原 internal 包 |
| Mask/MaskJSON 只返回处理结果；网关另行阻断 block/处理失败 | `engine/internal/redact/redact.go:681-685`；`engine/internal/redact/json.go:383-448`；`engine/internal/gateway/redact.go:30-66,150-193` | 发送权限由宿主守住，不能在失败后使用原 body |
| 自定义规则使用 RE2，有捕获组/前缀和数量长度约束 | `engine/internal/redact/rules.go:15-110` | 保存前实际编译、校验，原样复用约束 |
| 原值、key、known、shape 等为进程共享状态 | `engine/internal/redact/redact.go:490-584`；`engine/internal/redact/known.go:20-84` | RWMutex 不是租户权限；必须实例化所有相关状态 |
| 标签为 HMAC 的 Base32 前 8 字符；普通标签无原值碰撞比较 | `engine/internal/redact/redact.go:545-566` | 40-bit 不适合多租户规模照搬；更长标签与碰撞拒绝必须同步改 parser/tail |
| Value/Restore 无租户参数，原值依赖内存而非可解密密文 | `engine/internal/redact/redact.go:633-638,1171-1229` | 不提供按标签查询原值的公共 API；还原必须绑定作用域和请求授权集合 |
| 映射满 200000 项后遍历 map 删除一半，无活跃流保护 | `engine/internal/redact/redact.go:498-584` | 不是 LRU；需要字节预算、空闲淘汰、活跃引用 |
| sentKnown 缓存键只有文本与部分类别选项，不包含租户、规则或完整策略 | `engine/internal/redact/known.go:215-277` | 缓存必须归属 Scope，并纳入策略版本；不能跨策略复用首次决定 |
| tool ID、schema/grammar、签名、编码内容等有保护 | `engine/internal/redact/json.go:19-60,75-190` | 避免破坏协议，但不能宣传任意字段 DLP |
| 工具 arguments/partial_json 需要内层 JSON 转义 | `engine/internal/redact/redact.go:705-727,830-923`；`engine/internal/redact/json.go:470-496` | 不用全局 ReplaceAll；工具实际参数不按同名协议键跳过 |
| 原签名处理是两遍 known-value 重遮，不是签名验证 | `engine/internal/redact/json.go:368-448` | vm2api 需有显式签名内容政策，不能猜测签名可重写 |
| Writer 整体 JSON 缓冲，SSE 单 pending，非 identity 压缩透传 | `engine/internal/redact/writer.go:18-25,60-127,167-245` | 不能原样承诺多路交错、无限流、有界内存或压缩还原 |
| kept 的 url/image_url/file_id、定义中的非 description 等可能保留原文 | `engine/internal/redact/json.go:19-50,118-172` | 保护范围必须按字段公布，不能写“所有内容绝不外泄” |
| 符合占位符语法的输入在候选阶段受到保护，但不验证来源 | `engine/internal/redact/redact.go:1095-1107` | 新插件不能仅凭形状跳过；只能保护本 Scope 确认生成的标签 |
| Shape 保留前缀/长度等，且仍使用状态；Scrub 是不可逆清理 | `engine/internal/redact/shape.go:28-30,85-187`；`engine/internal/redact/scrub.go:11-55` | 本设计不启用 Shape/模型；不把日志 Scrub 与可启停可逆脱敏混为一谈 |

## 3. vm2api 配置、权限、日志的现状

| 事实 | 源码证据 | 设计含义 |
| --- | --- | --- |
| 路由设置 GET/PUT 已存在；PUT 校验、准备 runtime、保存，失败恢复运行态快照 | `src/lib/admin/panel-routes.mjs:5172-5269` | 扩展原 API，不另建插件配置通道 |
| 旧 `/admin/routing` 写入口也存在 | `src/lib/admin/panel-routes.mjs:1207-1240` | 新策略校验和准备不能只加在 panel 分支 |
| `persistRoutingPatch` 目前会修改共享对象并直接写文件 | `src/lib/admin/routing-runtime.mjs:432-541` | 不宣称现有过程已原子；脱敏 publication 需在落盘成功后执行，重叠保存需串行化 |
| `loadRoutingConfig` 校验/归一化部分字段 | `src/lib/admin/routing-runtime.mjs:574-598` | 新配置须接启动和外部 reload；非法启用配置不能归一为 disabled |
| 路由文件权威路径来自 KIN_ROUTING_FILE 或 project/src/config/routing.json | `src/lib/core/config.mjs:85-104` | 不硬编码到另一个 settings 文件 |
| 管理入口先认证，再按角色守卫 | `src/lib/admin/panel-routes.mjs:1352-1386`；`src/lib/admin/panel-acl.mjs:31-51` | 总开关只允许 admin/master；普通推理 key 不允许覆盖 |
| Node 入站现有清洗只删除设置/身份字段，不做正文秘密识别 | `src/lib/protocol/seed-policy.mjs:183-216`；`src/lib/protocol/handle-protocol.mjs:699-702` | 新内容脱敏接 Node 共享异步清洗阶段，不把原同步函数改造成隐式外部调用 |
| Node 结构清洗与内容形状规范化已有专门函数 | `src/lib/protocol/sanitize.mjs:140-191` | 新增脱敏不替代原协议清洗、角色/字段和 cache 处理 |
| routing 的 GET 使用显式字段投影，未包含 redaction | `src/lib/admin/panel-api.mjs:1476-1498` | 新字段必须加 buildRouting，光落盘不足以让面板读到 |
| SettingsPage 有草稿、服务端快照、保存失败保留、成功刷新 | `web/src/features/settings/index.tsx:58-184` | 开关复用 SaveBar，不做即点即生效的第二套保存流程 |
| ProtocolPane 已使用 SettingRow/Switch | `web/src/features/settings/protocol-pane.tsx:51-121` | 加同类设置区，不另建插件市场/安装页 |
| Web 当前 ProtocolPane 仅接 compat/inference，SettingsPage 已有 dirty/discard/快捷键 | `web/src/features/settings/index.tsx:185-214,393-413` | 新 redaction 使用独立受控 props/顶层草稿，runtime 不进入可编辑配置 |
| `redactSecrets` 是三种凭据形状的日志字符串清理 | `src/lib/core/security.mjs:17-23` | 不是请求脱敏器，也没有反向映射能力 |
| debug 请求/响应会保存内容，仅经既有清理 | `src/lib/admin/request-log.mjs:324-357` | enabled 请求不能让恢复后的正文经旧 debug 旁路重新落盘 |
| 请求预算默认 32 MiB，面板受上限约束 | `src/lib/core/config.mjs:61-82` | 处理后扩张也要复核；模型不是处理超限输入的兜底 |

## 4. 规范读取与限制

已执行 `.trellis/scripts/get_context.py --mode packages`，项目无 packages 配置，spec 层为 frontend/protocol。已读 shared guides、cross-layer/code-reuse guide、两层 index、frontend component/state/type 文件和相关协议契约。两个模块 index 没有独立的 Pre-Development Checklist；frontend 多个指南仍是模板，实际约定以 SettingsPage/ProtocolPane 当前实现为准。

协议约束必须延续：

- `.trellis/spec/protocol/cli-hop-cache.md:13-37,124-155`：caller markers/TTL 的所有权及 CCH 在最终序列化后的密封。
- `.trellis/spec/protocol/index.md:320-354`：Responses WS create 复用 handleProtocol，连接本地 full replay、容量、取消与真实终态。
- `.trellis/spec/guides/cross-layer-thinking-guide.md:105-132`：完整数据流、可信身份与副作用顺序，不能把会话启发式指纹当权限。

推理分支挂点和覆盖矩阵在 `design.md` 中逐项给出；未实施前不得将该矩阵标为运行时已覆盖。实际本轮 smoke 证据见 `verification.md`。

## 5. 实际外发和响应挂点

| 路径/事实 | 当前源码证据 |
| --- | --- |
| Codex 在 Claude canonicalBody 建立前分支 | `src/lib/protocol/handle-protocol.mjs:800-876` |
| API backend 也在 Claude runner 前返回，且可转 Responses upstream | `src/lib/protocol/handle-protocol.mjs:1116-1237`；`src/lib/pool/api-protocol.mjs:207-290,351-676` |
| persona 每 attempt 可从原 personaIn 重渲染 | `src/lib/protocol/handle-protocol.mjs:1359-1454` |
| Node finalizer 继续处理 betas/display/CCH，显式 envelope 另有绕过路径 | `src/lib/transport/go-worker-client.mjs:408-482,724-744` |
| Claude CLI 最后紧凑化、CCH、Content-Length 后才 fetch | `local-src/cli-node/src/services/api/client.ts:351-409` |
| API Go forward 才是真正 HTTP 发送 | `src/lib/transport/api-kernel-client.mjs:115-181`；`api-kernel/internal/server/server.go:64-117` |
| Codex Node 续接和重试、kernel HTTP/WS 都是独立路径 | `src/lib/protocol/handle-codex.mjs:214-273,760-949`；`.local/codex-kernel/src/openai/mod.rs:525-642` |
| WS replay 保存客户端视图，续接先展开再进入 handleProtocol | `src/lib/protocol/responses-ws.mjs:176-239,553-619` |
| classifier 先按原始 official/system/action 识别，用途例外不代表隐私例外 | `src/lib/protocol/handle-protocol.mjs:908-950`；`src/lib/protocol/request-purpose.mjs:43-138` |
| 目前确有账户 thinking ownership 过滤及记录 | `src/lib/protocol/handle-protocol.mjs:1360-1368,1452-1454,1723-1849`；`src/lib/pool/thinking-owner.mjs:26-32,117-163` |
| Claude 回复在 tool-name 还原/assembler/converter 中处理 | `src/lib/protocol/handle-protocol.mjs:480-529,1595-1713` |
| Codex 聚合检查工具参数前缀，terminal 完整 output 可覆盖累积 delta | `src/lib/protocol/codex-convert.mjs:331-378,653-740` |
| search/images 可直接由 Node postCodexJson 外发 | `src/lib/protocol/handle-codex.mjs:1131-1172,1197-1297,1319-1458` |
| multipart image edits 在单独入口归一化并调用图片处理 | `src/lib/protocol/handle-protocol.mjs:1944-2044` |
| remote image URL 还可能产生独立下载请求 | `src/lib/protocol/images.mjs:114-151` |

两个已核对的文档漂移：`official-303.md` 的独立 lean 档已被 `persona-template.mjs:22-23,283-306` 的退休别名替代；`docs/PROTOCOL.md:129` 的“无账户签名归属过滤”与当前 handler 不符。本轮在设计中记录事实差异，不顺带修改无关协议功能。

真实验收入口（本轮只读，未运行）：`test/e2e/helpers/real-chain.mjs:73-108,240-343` 用实际 kernel/CLI 与 loopback capture，但调度器是单次 adapter，不能证明完整池并发；`test/e2e/auto-mode.e2e.test.mjs:150-410` 可作为 classifier 的真实链路参考；`api-kernel/internal/server/server_test.go:16-89` 使用真实 Go handler＋回环 HTTP；`test/unit/responses-ws.test.mjs:33-75,164-242` 使用真实 WS surface 但可注入 Codex ops，不能替代 Codex ELF 的最终 wire 验收。
