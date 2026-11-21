# 03 — M1：codex-tui-helper-helper 最小闭环

> Iteration 1 · 2026-11-21 · branch `devin/codex-tui`

## 范围

M1 交付可用 PTY 驱动真实 `codex` TUI 的槽内 helper，对外维持既有
`/internal/v1/codex/*` socket 契约不变，控制面调度、配额、风控零改动。
不交付：进程池复用、vterm 屏幕流、usage 端点、会话恢复（均为 M2）。

## 新增组件

| 路径 | 职责 |
| --- | --- |
| `worker/internal/codextui/config.go` | 读取 `run/codex-kernel.json` + `CODEX_TUI_*` 环境旋钮 |
| `worker/internal/codextui/home.go` | 槽级 CODEX_HOME：`auth.json`（凭证文件→ChatGPT auth 形态）与 `config.toml`（`approval_policy="never"`、`sandbox_mode="read-only"`、per-turn trust） |
| `worker/internal/codextui/prompt.go` | envelope 解码；instructions+input items → 单段纯文本 |
| `worker/internal/codextui/tui.go` | 200×50 PTY（creack/pty）+ vt10x 屏幕渲染；composer 检测、bracketed paste、Enter 提交 |
| `worker/internal/codextui/rollout.go` | rollout JSONL 发现（`session_meta.cwd` ↔ per-turn 目录关联，两侧 `EvalSymlinks` 归一）与增量尾随 |
| `worker/internal/codextui/responses.go` | rollout → 上游 `response.*` SSE 词表翻译（created/output_item/output_text/completed/failed + usage） |
| `worker/internal/codextui/engine.go` | 单请求单进程 turn 执行：并发信号量、cancel 表、idle/turn 超时 |
| `worker/internal/codextui/server.go` | unix socket HTTP：health / responses / cancel，`x-kin-internal-token` 常量时间校验 |
| `worker/cmd/codex-tui-helper/main.go` | 入口；兼容 supervisor 的 `<bin> <config-path>` 位置参数 |

## 控制面接线

`codexKernelBinPath()`（`src/lib/transport/codex-kernel-supervisor.mjs`）查找顺序改为：

1. `CODEX_TUI_BIN` 环境变量（显式切换开关）
2. `KIN_KERNEL_BIN` 同级 `codex-tui-helper`（镜像内共存自动优先）
3. `bin/codex-tui-helper`
4. 原 `kin-codex-kernel` 回退

部署侧只要把 `codex-tui-helper` 放进槽镜像并置 `CODEX_TUI_BIN`，整槽
codex 出口即切换为真实 CLI 的 TLS/身份/行为特征；socket 契约不变。

## turn 生命周期

1. `ensureHome`：凭证文件 → `CODEX_HOME/auth.json`（`auth_mode=chatgpt`），幂等；
   `sessions/`、`history.jsonl` 跨 turn 持久。
2. `turn-<request_id>` 目录创建并写入 `config.toml` `[projects."<dir>"] trust_level="trusted"`。
3. `pty.StartWithSize(200×50)` 拉起 `codex -a never -s read-only -m <model>`；
   环境只含 CODEX_HOME/TERM/PATH 等，不含任何 `*_proxy` —— 出口走槽透明
   SOCKS5/CONNECT，固定槽 IP。
4. vt10x 屏幕轮询等 composer `›`；onboarding/login/trust 屏归类为错误。
5. bracketed paste 注入 prompt → 等 paste chip/回显 → Enter。
6. rollout 文件按 `session_meta.cwd` 关联（共享 CODEX_HOME 下并发安全），
   逐行翻译为 `response.*` SSE 直推控制面。
7. `task_complete`/`turn_complete` → `response.completed`（含 usage）；
   error/abort → `response.failed`；进程退出或超时兜底 failed。
8. Esc → SIGTERM → kill，turn 目录回收。

## 已验证

- `go build ./...`、`go vet` 干净。
- 单测：prompt 组合（string/items/工具项）、SSE 翻译词表、rollout
  cwd 关联（含 macOS `/var`→`/private/var` 符号链接场景）、home 初始化。
- 端到端冒烟：`TestRunTurnEndToEndWithFakeCodex` 用假 codex 脚本走通
  PTY→paste→rollout→`response.completed`（含 `id=sess-fake`）全链路。

## 已知限制（M2 承接）

- 每请求起一个新 TUI 进程（冷启动 ~1–2s）；M2 预热进程池消抖。
- 流式粒度是「item 完成级」，不是 token 级；M2 加 vterm 屏幕流。
- 多轮会话以全文重放方式注入（fresh TUI per request）；M2 评估
  `codex resume` 接 `previous_response_id`。
- 共享 CODEX_HOME 的 refresh token 轮换存在竞态窗口（M2：按
  `last_refresh` 漂移检测后序列化重注入）。
- 未做真实 `codex` + 真实账号冒烟（需要 ChatGPT 凭证；测试钩子已就绪）。
