# 推理数据面（实现备查）

> **产品主路线**见 [技术路线.md](技术路线.md)：Setup Token → Console API、Claude Code 原生 subagent、TCP → Console endpoint、0 提示词注入。
> 本文只记当前进程怎么挂。公开仓 **只走 rust cli-hop**。Go HTTP 转发不再启用。

Node 只做控制面（鉴权、协议、人设、调度、面板）。**不直连** `api.anthropic.com`。无直连回落，也无 Go hop 回落。

## 唯一推理路

`engine=rust`：envelope → Claude kernel → patched Claude Code `native_messages`（预开 20 slot）→ CLI TLS → 本机 HTTP CONNECT → 槽 SOCKS5 → Console / Anthropic。

`dataplane=crag` 的原生 V2 走同一 rust cli-hop 和 Unix socket，按需启动或复用独立的官方 Claude Code 进程，不使用 wrap 预开的 native slot。

```
client ──nginx──► Node :8787
                     │ fingerprint / persona / pool
                     └─ rust cli-hop
                           envelope → Claude kernel
                           provider=local_cli → Claude Code native_messages
                           CLI TLS → CONNECT → 槽 SOCKS5 → 上游
```

代码钉死：

- `resolveHopEngine` 永远返回 rust；缺二进制 / 不健康时 **blocked**，不切 Go。
- `resolveOfficialCcInference`：engine=rust 时 **强制** `cli-hop`。
- `writeKernelConfig`：`provider: local_cli`。
- 历史 `go` / `fallback_to_go` 写入一律收成 rust / false。
- Go hop 服务端已删除。`kin-worker` 只剩 `telemetry` 子命令。

## 面板最终输入契约

公共协议先转换成 Anthropic Messages，再按本次目标槽的实际健康身份选择
`prepareCliNodeRequest` 或 `prepareCragRequest`，不是按全局默认内核猜测。
两路在 `prepareWorkerPayload` 收口；预构造的 Messages envelope 也经过同一输入边界。
Codex `/internal/v1/codex/responses` 不套用 Messages 校验。

发往 `/internal/v1/messages` 的 JSON 结构如下；可选字段仅在符合能力和认证条件时出现：

```json
{
  "request_id": "11111111-2222-4333-8444-555555555555",
  "body": {
    "model": "claude-sonnet-5",
    "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hello" }] }],
    "max_tokens": 128
  },
  "headers": { "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
  "stream": true,
  "delivery_mode": "realtime",
  "preserve_cache_breakpoints": true,
  "cache_ttl": null
}
```

`messages` 必须非空，且规范化后仍有内容；system、工具、thinking 和 beta 按本轮请求另行组入。
`headers` 是协议上下文，不是官方 CLI 最终 TLS 请求头；Authorization 由槽内 CLI 管理。
可选 envelope 字段为：受信分类器的 `request_context`、声明 `caller_cwd` 能力的 CRAG 的有效绝对目录，
以及通过 readiness 且支持 `gateway_policy_v1` 的 CRAG 的 `gateway_policy`。
`gateway_policy` 包含剩余 `queue_wait_ms`、`first_byte_timeout_ms`、`stream_idle_timeout_ms` 和 `session_idle_ttl_seconds`。
租户隔离来自已认证身份，通过内部 HTTP 头传递，不接受公共请求 body 的同名字段。

| 最终 body | cli-node / wrap | 原生 CRAG V2 |
|---|---|---|
| 消息 | Anthropic 内容块，交给 `native_messages` | 同样保留完整历史；内核决定冷启动导入、热续接或 MCP 工具结果 |
| system | 保留面板选定的人设、布局和缓存断点 | 普通请求由 `prepareCragPrintBody` 投影成能力允许的 `crag_prompt: {mode, text}`；不重复下发官方 system |
| 模型策略 | 结构化字段交给 native CLI | 支持模型指令时另有面板生成的 `crag_model: {id, capabilities, params, betas}` |
| 内核扩展 | 移除所有 `crag_*`、`cache_ttl` / `cacheTtl`、`session_slots`、`effort` | 移除 wrap 的 `auto_compact_window`；`crag_options` 仅保留内核支持的 model、max_tokens、effort、cache_ttl、session_slots 别名，不接受 transport 等旁路选项 |
| 缓存与历史 | 保留已有缓存策略与合法逐消息控制 | 不为消除错误而重写 tool ID、thinking 签名、工具结果或缓存断点；这些参与续接校验 |

公共清洗仍负责客户端/OpenAI 残留字段、字符串到内容块、角色归一化及空消息处理。
最终边界额外移除 body 内的 `gateway_policy`、`request_context`、`kin_outbound_shape`、`request_id` 和 `delivery_mode`；
内部控制由面板另行组入 envelope。保留未知官方扩展字段，不以固定旧字段白名单截断新 API 能力。
因此这是内核输入契约，不是完整 Anthropic JSON Schema 校验器。

在写 socket 前拒绝：缺 model、空消息列表、清洗后全空消息、非文本/内容块的 content、缺类型的内容块、
非字符串 text、缺 ID/名称的 tool_use、缺 tool_use_id 或非法嵌套 content 的 tool_result。
返回 `400 invalid_kernel_request`、`upstreamExecutions=0`；不触发修复重试或账号冷却。
不在面板新建第二份 pending/consumed 工具账本，合法压缩请求中的继承历史也不能因“已出现过工具结果”就删除。

`Claude editor did not render pasted input` 是 CRAG PTY 粘贴后的屏幕确认超时，发生于提交 Enter 之前，
不能仅凭此错误判断请求体有脏字段。原生内核已做换行和控制字符的终端投影；面板不得据此清洗原始历史字节。
编辑器就绪、屏幕解析、粘贴确认和一次 Enter 仍是内核职责，不能靠增加面板重试掩盖。

`tool_result replayed` 是内核工具状态冲突，保留原生 409；续接过期保留 410，不再统一降成 400。
不能删除 tool_result、改 ID、清空防重放状态或换槽重发来规避。排查需要本轮末尾内容与原批次交付/认领记录；
仅有截断的请求前缀不足以区分真实重放和内核误判。

## 面板拥有整流：原生交接 v1

仅当受管 CRAG 的认证 health 在 `capabilities` 中声明 `native_handoff_v1`，面板才在内部
`gateway_policy` 中设置布尔值 `native_handoff_v1: true`。分类器继续使用独立的
`request_context` 契约，不冒充普通推理。配套发行包为 CRAG 2.8.17，但仍不能仅凭版本号推断支持；
CRAG 2.8.16 没有该能力，旧槽保留 legacy 路径，不能将只更新 Node 宣称为两项故障已修复。

职责分工：

- CRAG 只执行一次主模型请求，交接 provider 原始 message ID、model、stop、usage 和结构化错误；
  不执行交互式恢复，不抬预算，不替面板关闭思考，也不把 refusal 改成工具成功。
- 面板验证原生事实，决定公共 JSON/SSE 交付、拒绝、记账及既有重试/切号策略。正文和思考可实时
  交付；客户端工具 ID、参数和终态须等完整响应及权威终态验证后才公开。非 `tool_use` 停止中的
  客户端工具块由面板抑制，`server_tool_use` 等服务端记录保留，不另建 pending/consumed 账本。
- 内核仅为真正 `tool_use` 且匹配完整 MCP 回调集的响应登记安全 handoff。新模式每个调用方回合
  使用独立原生进程，工具结果按原有租户、集合、历史、期限和防重放校验交给下一进程；不重跑客户端
  工具。这牺牲热进程复用以隔离 CLI 的交互恢复，存在额外启动开销，不保证历史热进程性能或缓存命中。
- CLI 内部 MCP 取消是原生观察，不是调用方取消。它不能抢先覆盖随后到达的 provider refusal；
  调用方断连及 `/internal/v1/cancel` 仍取消真实回合，已取消的真正工具回调不被恢复为成功批次。

原生事实通过内部 SSE `kin_provider_result` 及 JSON/verified/流式回包的
`x-kin-provider-result` 头或 trailer 交接，面板均从公共响应中剥离。摘要包含
`message_id`、`model`、`stop_reason`、`stop_sequence`、`usage`、`usage_complete`，可带
`stop_details`、实际 `http_status`、原始 `error` 和 `request_id`。元信息有独立大小限制；
无法交付必要成功证明时失败关闭，不把丢失的字段猜成成功。

`usage_complete` 只说明模型用量是否完整，不等于客户端交付成功。原生终态已确认而后续传输失败时，
保留已确认用量；尚无最终用量只保留真实观察值，不以首帧或估算替代最终值。相互冲突或非法摘要
失去权威，不能再给计费提供最终用量，也不能覆盖实际收到的错误。
真实 HTTP/SSE 错误及调用方取消仍保留原状；如果取消早于任何 provider 响应观察，摘要和用量可以
缺失，不补造 message ID、model 或 token 数。

声称成功却缺少必要证明，或证明非法、冲突、不完整时，分别返回 `native_handoff_missing`、`native_handoff_invalid`、
`native_handoff_conflict`、`native_handoff_incomplete`；不自动重放、不给账号施加冷却，也不补造
`stop_reason=max_tokens` 成功收尾。真实 `max_tokens` 原样完成，真实 refusal 不触发客户端工具；
既有 409/410 保留真实失败，不能从 410 反推拒绝原因或靠删除历史复活续接。

回归入口：面板 `test/unit/native-handoff.test.mjs`；供应仓 `kernel/tests/native_handoff.test.mjs`
与 `native_v2` 中的 `real_claude_native_handoff_*`。联合回归使用真实 Node 传输、编译后的签名/授权
测试内核、官方 Claude 2.1.321 和 loopback 上游，覆盖 print/TUI、4096 adaptive 截断、拒绝、
连续两批工具及真实错误。公开 RFC 8032 测试向量只用于隔离测试，不是生产发行授权。

上线必须分别更新面板及具备新能力的受信签名内核包，按现有流程排空请求和工具续接、安装后核对
运行中 core 摘要与能力。源码、测试通过、下载包和正在运行的槽不是同一证据；本轮没有切换运行槽。

## 面板到槽的 CPU 并行

- `PoolScheduler` 仍只有一个权威实例。每次执行先原子取得许可；粘性绑定、会话席位和执行许可独立。见 [调度准入](performance/scheduler-admission.md)。不要复制 `src/server.mjs` 进程来扩展编解码。
- 大推理请求的 JSON 编码、缓冲 JSON 回包及缓冲的非 2xx SSE 错误可由最多两个按需启动的 Node worker 处理。编码以估算大小、解码以实际字节判断 256 KiB 门槛；超过预算或 worker 繁忙走原线程，不排无界队列。worker 故障只回退本地编解码，不重放 HTTP。
- HTTP I/O、成功 SSE 的分帧和回调、可见提交及取消仍由原线程处理。既有 413、回包上限和提交后不重试的规则不变。客户端模块保留历史 `go-worker-client` 名称，不代表恢复 Go 推理。

本机 Unix socket 合成回环（2 路并发，预热 1.2 秒，每组约 3 秒；不计 fixture CPU）：请求、回包各约 1.79 MB 时，吞吐 65.0 → 89.8 req/s，请求 p95 47.28 → 29.84 ms，面板事件循环 p95 16.40 → 3.02 ms；面板总 CPU 时间 3.01 → 6.53 秒。203 B 请求、137 B 回包未启动 worker，请求 p95 均为 0.68 ms。收益是大包响应性，不是 CPU 效率或真实上游吞吐。

槽内 Claude `kin-kernel` 的 Tokio 线程预算和生效边界见 [Docker CPU 限制](docker-cpu-limits.md)，与账号并发、CLI 子进程和上游模型计算分开。

## 不要和这两件事搞混

| 名字 | 是不是推理 |
|---|---|
| 官方 Claude Code **初装**（wipe → hello → /stats） | **不是**。换票后用槽内 cli-node 跑一次（不再另装官方 CLI）。推理不跑初装的常驻 CLI。 |
| kernel `HopClient` / `provider=anthropic_api` | **退役的 rust HTTP hop**。不要再当现网。 |
| `worker/` 凭证客户端 | 换票 / ensure 仍可能用到，**不**再做 `/v1/messages` hop。 |

## 槽位约束

- 强制槽 SOCKS5（`proxy_required=true`）。
- wrap 预开 20 native slot；面板「并行」只改 Node inflight，不重启 kernel。
- Extra 5h 以 Messages **headers** 为准。wrap 必须把 `anthropic-ratelimit-unified-5h-*` 从 CLI → kernel trailer → Node `ingestHeaders`。

## vm2api 托管原生 CRAG V2

仅当通过 readiness 的原生 worker 健康报告明确带 `gateway_policy_v1: true`，vm2api 才在经内部 token 认证的 `/internal/v1/messages` envelope 下发 `gateway_policy`。旧 worker 不收到该字段，继续使用原来的处理方式。

| 设置 | 生效边界 |
|---|---|
| `pool.queue_max` | vm2api 全池等待上限，不复制成每个 CRAG worker 的队列深度。 |
| `pool.sticky_wait_timeout_ms` / `pool.fallback_wait_timeout_ms` | 分别约束粘性与全池等待阶段。送入 CRAG 的是当前阶段剩余额度，并受 `failover.total_retry_deadline_ms` 截止约束；无额度只尝试立即准入。worker 保留独立容量和队列深度上限，未下发等待额度时才使用启动配置的排队时限。 |
| `failover.session_queue_timeout_ms` | 同会话进入调度前的串行等待；`0` 不限时，不占号池等待队列或 worker 槽。 |
| `KIN_UPSTREAM_TIMEOUT` / `failover.stream_idle_timeout_ms` | CRAG turn 的首个有效内容等待 / 后续内容间静默上限；HTTP 响应头、verified 完整交付和推理总时限是不同的计时点。已开始的 turn 保留原策略。 |
| `sticky.ttl_seconds` | vm2api 的账号/VM 绑定记忆；已保存的绑定不会因改值而重写到期时间。 |
| `inference.session_idle_ttl_seconds` | CRAG 已结束 turn 的热进程保留时间。缩短后，新请求可拒绝复用已经超龄的进程；延长不会延长已停车会话的原到期时间。与工具等待无关。 |

账号并行、逻辑会话席位、内核热进程、物理进程槽和当前上游并发各自计数。释放逻辑席位不等于解除账号/VM 粘性绑定；热进程也不等于在途推理。CRAG 可以回收空闲进程，不会为排队请求抢占正在推理或等待工具的进程。热会话和工具续接由已认证身份隔离，不接受调用方指定的 `x-tenant-id`。

面板仍写 `kernel.json` 作为启动/兼容配置。支持该协议且健康的原生 CRAG 不因单独修改流空闲时限而重启；新请求使用新值。旧 worker 和请求体大小变更保留原来的空闲重启行为。
