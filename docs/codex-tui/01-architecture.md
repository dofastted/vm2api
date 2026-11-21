# Codex TUI 防封专项 — 总体架构设计（RFC-01）

> 状态：草案 v0.1（2026-11-21）· 归属：`docs/codex-tui/` 为 codex TUI 方案的唯一权威 wiki，每个迭代必须同步更新本目录。

## 0. 背景与差距分析

vm2api 现有 codex 路径（`kin-codex-kernel`，每槽一个自研二进制，监听
`vms/<id>/run/codex-kernel.sock`，提供 `/internal/v1/codex/responses`）是
**HTTP 层模拟**：它手工构造 `chatgpt.com/backend-api/codex/responses` 请求，
可配置 `user_agent`、`upstream_transport`(websocket/http)、`client_features`、
`analytics`、`telemetry_runtime` 与 `device_id`（`codex-installation-id`）。

它对防封的根本性缺陷：

| 维度 | kernel 模拟 | 真实 codex CLI |
|---|---|---|
| TLS ClientHello / JA4 | 由自研 HTTP 栈决定，与 codex 的 reqwest+rustls 不一致 | 原生 rustls 指纹，与官方完全一致且随版本演进 |
| 请求头集合/顺序/HTTP2 帧 | 人工还原，任何上游新增字段即过时 | 永远正确 |
| `client_metadata` | codex core 会把 `thread_source`、`turn_trigger`、`session_id`、`installation_id`、`sandbox_mode`、`turn_started_at_unix_ms` 等十余个字段随请求上行；自研 kernel 要么缺失要么伪造，构成强特征 | 由 codex-core 真实生成 |
| `SessionSource` | `cli`/`exec`/`vscode`/`mcp` 在上行 metadata 中可区分；`codex exec --json` 标记 `SessionSource::Exec` | TUI 进程产生 `SessionSource::Cli`，与真实用户一致 |
| 行为面 | usage 查询、token 刷新、模型目录、feature flag、websocket 降级重试等节奏需要逐个模仿 | 全部由官方二进制天然完成 |

结论：与 Claude 路径「rust cli-hop → patched Claude Code → CLI TLS」同构，把
codex 出口从「自研 kernel」换成「真实 `codex` TUI 进程 + PTY 驱动」，是消除
整个指纹面的唯一收敛解。本方案借鉴 magpie `claude-tui-helper`（PTY 200×50 +
bracketed paste + rollout transcript 回读）。

## 1. 目标架构

```
client (任意 UA / 任意协议)
   │ HTTPS
   ▼
Node 控制面 (vm2api 既有)
   │ 鉴权 / 密钥 / 多协议清洗 (chat|completions|responses|messages)
   │ 封控前置 (RISK 门禁) / 调度 / 配额
   ▼ Unix socket  /internal/v1/codex/responses  ← 契约不变
slot-N Docker 容器（每账号一个）
   ├─ kin-codex-tui-helper (新组件，替代 kin-codex-kernel)
   │    ├─ PTY (200×50) → 真实官方 codex TUI 二进制 ×M 个热进程
   │    ├─ bracketed-paste 注入用户消息 + Enter
   │    ├─ vterm 屏幕解析 → 增量流式
   │    ├─ tail ~/.codex/sessions/**/rollout-*.jsonl → 权威结果/usage
   │    └─ /internal/v1/codex/usage → 容器内官方 usage 端点代理查询
   ├─ ~/.codex/ (auth.json, config.toml, sessions/, history, installation ids)
   ├─ 唯一出口：容器内 HTTP CONNECT → 槽位 SOCKS5 → 固定住宅 IP
   └─ DoH 经由 kin-worker，无外泄 DNS/NTP
```

关键：**入站侧不变**。控制面继续接受任意 user-agent、任意协议入口
（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`→可选转换、
`codex` CLI 原生直连），统一清洗收敛成 codex turn；
**出站侧唯一**：容器内只有真实 `codex` 进程产生的流量可以出网。

## 2. 核心组件

### 2.1 `kin-codex-tui-helper`（替代 `kin-codex-kernel`）

部署在槽容器内，监听同一 Unix socket，对 Node 暴露**与现有 kernel 完全相同的**
`/internal/v1/codex/responses` 契约，因此池化调度、配额、风控、计费零改动。

内部职责：

- **进程池**：每槽 M 个（默认 4，可配）预热 `codex` TUI 进程，各绑定一个
  codex session；空转 `session_idle_ttl_seconds` 后回收（沿用 CRAG 热进程模型）。
- **PTY 驱动**（对齐 magpie `internal/claudetui`）：
  - 独立 PTY session，固定窗口 200×50，`TERM=xterm-256color`；
  - 用户消息经 **bracketed paste** 写入 composer，回显确认（屏幕解析）后按 Enter；
  - 以 `/`、`!`、`#` 开头的消息前置换行防止被解析为 TUI 命令；
  - 图片/文件先落临时目录再粘贴路径。
- **输出采集双通道**：
  - **流式**：vterm 屏幕解析取 assistant 增量（TUI 渲染区）；
  - **权威结果**：tail `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<thread_id>[_<rollout_id>].jsonl`，
    得到结构化 `response_item`（含 reasoning、tool calls）与 `token_usage_record`
    （usage 嵌套 `payload.usage`）、`event_msg` 终态（`task_complete`/`error`/`stream_error`/`turn_aborted`）；
  - rollout 是延迟/截断仲裁的最终依据；屏幕流仅用于低延迟增量交付。
- **会话续接**：控制面会话 ↔ codex session id 映射；热进程直接复用；
  冷会话通过 `codex` TUI 的 resume 能力或新建 session + 重放历史（二选一，见 §4 决策点）。
- **usage 查询**：容器内以同一 `auth.json` 调用官方 usage 端点，结果经 socket
  回传控制面；**绝不**从宿主机发起，保证请求-IP 与推理-IP 同源。
- **app-server 后端**（源码演进备注，ddfaef9）：新版 TUI 默认探测共享
  app-server daemon socket，命中后会话挂在 daemon 上、杀 TUI 不等于杀 turn。
  helper spawn 一律带 `--no-daemon` 走内嵌后端，保证进程级生命周期；M2 进程池
  若改常驻 worker，可评估复用 daemon 的可行性（此时 kill 语义需重新设计）。
- **登录/刷新**：`codex login`（ChatGPT OAuth 走容器内 loopback 回调），
  access token 过期由 codex 自身刷新机制完成；控制面只负责注入/导出
  `auth.json` 与触发 `codex login status` 探测。

### 2.2 槽位网络（强化现有约束）

- 沿用 `worker` SOCKS5 CONNECT 隧道（不做 TLS 终止——真实 codex 的
  ClientHello 原样透出）。
- **新增硬门禁**（slot-gate）：容器内除 `codex` 进程、helper 自身 socket、
  DoH 外，**禁止任何其他出网**；env 无 `http_proxy` 注入 CLI 进程
  （沿用 `kernelEnv` 思路，proxy 只经 CONNECT 链路，避免双出口）。
- DoH 经 `kin-worker` 域路由，禁止容器内 53/853 裸端口。

### 2.3 时区与地理一致性

- 槽创建时按出口 IP GeoIP 写入 `TZ`（容器 `TZ` env + `/etc/localtime`）；
- codex telemetry/系统时间随之与 IP 地理一致；控制面 `telemetry_runtime`
  的 `runtime_os`/`runtime_arch` 与容器实际一致（不再伪造）。

### 2.4 设备信息（每账号唯一且真实）

| 项 | 生成方式 | 持久化 |
|---|---|---|
| `auth.json` account_id/tokens | 官方 OAuth 真实签发 | `vms/<id>/codex-home/auth.json` |
| installation id | 首次启动由 codex 自身生成（不预制，避免格式漂移） | 同上 |
| `~/.codex` 全量状态（sessions/, history.jsonl, config.toml, log/, state） | 槽内自然生长 | 容器持久卷 |
| machine-id / hostname / MAC / SMBIOS | 沿用 vm2api pillar-1 拟真，生成一次固化 | 槽镜像层 |
| 时区/locale | 按出口 GeoIP | 镜像层 |

原则：**能由官方二进制自己生成的绝不手工伪造**，只有官方不读的维度（硬件层）才拟真。

### 2.5 行为特征

- 进程真实 → header/metadata/TLS/重试/降级全部真实，无「需要模仿」的面；
- 剩余风险面在**调度层**：单账号突发并发不像人。helper 进程池限制真实并发，
  控制面 per-slot RPM/并发上限与账户等级对齐（复用 `openai-quota-policy`）；
- 上游可观测的并发形态 = M 个真实 TUI session；不跨账号复用 IP/容器。

## 3. 入站收敛（任意 UA → codex）

控制面现有清洗层保留并扩展 codex 映射：

| 入口 | 处理 |
|---|---|
| `POST /v1/responses`（官方 codex CLI 直连） | 最小清洗直转 turn（instructions+input 逐项映射） |
| `/v1/chat/completions`、`/v1/completions` | 现有 chat→codex 转换，产物收敛为单条 user 消息或结构化 input |
| `/v1/messages`（Anthropic） | 现有 convert 开关，默认 reject |
| 任意 User-Agent | 不检查不拒绝；只有出口身份是统一的 |

上游返回统一映射回各入口协议（SSE 帧、usage、stop reason）。

## 4. 待决策点

1. **冷会话历史重放**：新会话首轮直接 paste 清洗后的完整上下文（零状态，
   推荐，行为=新会话）；还是复用 `codex resume` 拼接旧 rollout（状态真实但
   构造 rollout 有伪造风险）。建议先零状态方案。
2. **流式粒度**：M1 先 rollout item 粒度（准实时、可靠）；M2 加 vterm
   屏幕增量（真流式）。`codex exec --json` 作为降级通道**禁用**（Exec 特征）。
3. **M（每槽 TUI 进程数）**：默认 4；与账号限额经验值对齐，文档化调参。
4. **codex 版本钉死**：槽镜像固定官方二进制版本，`config.toml` 禁自更新；
   升级走镜像发布（UA/特征随官方版本天然更新）。

## 5. 里程碑

- **M1 TUI 最小闭环**：helper + PTY 驱动 + rollout 回读 + 单热进程；
  socket 契约对齐 kernel；`/v1/chat/completions` 与 `/v1/responses` 可通。
- **M2 生产化**：进程池 + 会话热续接 + vterm 流式 + usage 端点封装 +
  slot-gate 出网硬门禁 + TZ/GeoIP 联动。
- **M3 防封加固**：并发形态治理、观测项巡检（JA4/JA3、header diff vs 真实
  CLI）、回归基准（干净度套件 codex 版）、蓝绿版本升级。
- 每里程碑交付物：代码 + 本 wiki 更新 + CHANGELOG 条目。

## 6. Wiki 规范

`docs/codex-tui/`：

| 文件 | 内容 |
|---|---|
| `README.md` | 索引 + 迭代日志（每迭代追加，写明版本/变更/验证） |
| `01-architecture.md` | 本文；每次架构变更必须更新并升版本号 |
| `02-fingerprint-checklist.md` | 五维防封清单 → 控制点 → 验证方法 |
| `03-tui-driver.md` | PTY 驱动协议细节（M1 落地时编写） |
| `04-ops.md` | 部署/槽位/代理/时区/升级运维手册（M2 落地时编写） |
| `decisions/` | 决策记录（ADR），每决策点一份 |
