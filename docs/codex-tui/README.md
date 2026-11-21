# Codex TUI 专项 Wiki

codex 企业级防封二开的唯一权威文档目录。**规则：每个迭代的代码变更必须同步更新本目录**（设计文档升版本 + 迭代日志追加行 + CHANGELOG 条目）。

## 索引

| 文档 | 内容 | 版本 |
|---|---|---|
| [01-architecture.md](01-architecture.md) | 总体架构、组件、里程碑 | v0.1 |
| [02-fingerprint-checklist.md](02-fingerprint-checklist.md) | 五维防封清单 → 控制点 → 验证 | v0.1 |
| [03-m1-helper.md](03-m1-helper.md) | M1 交付：codex-tui-helper 组件表、接线、turn 生命周期、验证与限制 | v0.1 |
| [04-ops.md](04-ops.md) | 出口门禁、TZ/GeoIP、usage 端点、巡检清单 | v0.1 |
| [05-dataflow.md](05-dataflow.md) | 数据流全景：首次进入 codex、单/多轮时序、长对话、异常路径 | v0.1 |
| decisions/ | ADR 决策记录 | — |

## 背景资料

- 现有实现：`src/lib/transport/codex-kernel-{supervisor,client}.mjs`、`src/lib/protocol/codex-route.mjs`、`src/lib/oauth/codex-oauth.mjs`、`src/lib/pool/openai-*`
- 参考实现：magpie `internal/claudetui`（PTY + bracketed paste + transcript tail + preload tap）、`internal/claudebridge`（MCP 回调）
- 上游行为面：openai/codex `codex-rs`（`SessionSource`、`responses_metadata.rs` 的 `client_metadata` 键、`x-codex-installation-id`）

## 迭代日志

| 迭代 | 日期 | 内容 | 文档更新 |
|---|---|---|---|
| 0 | 2026-11-21 | 差距分析 + RFC-01 总体架构定稿 | 01/02 新建，v0.1 |
| 1 | 2026-11-21 | M1：worker/internal/codextui + cmd/codex-tui-helper；supervisor 增加 CODEX_TUI_BIN/同级查找切换；单测 + fake-codex 端到端冒烟通过 | 03 新建 |
| 2d | 2026-11-21 | M2d：`GET /internal/v1/codex/usage`（account_id + 每 worker rollout 最新 token_usage_record）；04-ops 文档：出网白名单审计、TZ/GeoIP 接线、巡检清单 | 03/04 |
| 2a | 2026-11-21 | M2a：TUI 进程池——常驻 worker + `/new` 会话隔离 + session 亲和 + `codex resume` 兜底；turn 超时 Esc 中断保进程；按 model 分池驱逐 | 03 追加 |
| 1a | 2026-11-21 | 对照 openai/codex 最新源码（ddfaef9）复核：修正 rollout 类型为 `token_usage_record`（usage 嵌套 payload.usage）、补 `stream_error` 终态、spawn 加 `--no-daemon`（新版 TUI 默认探测共享 app-server daemon，内嵌后端保证进程级 kill 语义）；确认 `›` composer、`[Pasted` chip、`codex resume <id>`+标志合并、auth.json 结构、project trust 祖先查找 | 03 修订 |
| 3a | 2026-11-21 | 05-dataflow 新建：端到端数据流图（首次 spawn 序列、会话亲和多轮、长对话/上下文溢出、异常路径） | 05 新建 |
| 3 | 2026-11-21 | **真机冒烟通过**：真实 codex 0.171.0 TUI + ChatGPT OAuth(auth.json) + socks5h 固定出口（75.37.237.55），`POST /internal/v1/codex/responses` 端到端 `response.completed`（回复 pong），rollout 落盘 `codex-home/sessions/`，env context 时区=America/Los_Angeles 与出口 IP 属地一致。配套修复：路径归一化为绝对路径（codex 拒绝相对 CODEX_HOME）、非 overload 错误透传 `response.failed`、`proxy_url`→spawn 注入 HTTPS_PROXY/ALL_PROXY、composer 检测改用 `›`/`for shortcuts`（vt10x 散布渲染致行锚定失配） | 03/04 修订 |
