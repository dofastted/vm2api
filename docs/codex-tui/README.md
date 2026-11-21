# Codex TUI 专项 Wiki

codex 企业级防封二开的唯一权威文档目录。**规则：每个迭代的代码变更必须同步更新本目录**（设计文档升版本 + 迭代日志追加行 + CHANGELOG 条目）。

## 索引

| 文档 | 内容 | 版本 |
|---|---|---|
| [01-architecture.md](01-architecture.md) | 总体架构、组件、里程碑 | v0.1 |
| [02-fingerprint-checklist.md](02-fingerprint-checklist.md) | 五维防封清单 → 控制点 → 验证 | v0.1 |
| [03-m1-helper.md](03-m1-helper.md) | M1 交付：kin-codex-tui 组件表、接线、turn 生命周期、验证与限制 | v0.1 |
| 04-ops.md | 槽位/代理/时区/升级运维手册（M2） | — |
| decisions/ | ADR 决策记录 | — |

## 背景资料

- 现有实现：`src/lib/transport/codex-kernel-{supervisor,client}.mjs`、`src/lib/protocol/codex-route.mjs`、`src/lib/oauth/codex-oauth.mjs`、`src/lib/pool/openai-*`
- 参考实现：magpie `internal/claudetui`（PTY + bracketed paste + transcript tail + preload tap）、`internal/claudebridge`（MCP 回调）
- 上游行为面：openai/codex `codex-rs`（`SessionSource`、`responses_metadata.rs` 的 `client_metadata` 键、`x-codex-installation-id`）

## 迭代日志

| 迭代 | 日期 | 内容 | 文档更新 |
|---|---|---|---|
| 0 | 2026-11-21 | 差距分析 + RFC-01 总体架构定稿 | 01/02 新建，v0.1 |
| 1 | 2026-11-21 | M1：worker/internal/codextui + cmd/kin-codex-tui；supervisor 增加 KIN_CODEX_TUI_BIN/同级查找切换；单测 + fake-codex 端到端冒烟通过 | 03 新建 |
