# 面板 API

基址 `/api/panel`。需要**面板登录会话**或 Master `VM2API_API_KEY`。协议密钥不能调面板。信封 `{ ok, data }` / `{ ok: false, error }`。调用方应从 `data` 取业务体。

登录：`POST /api/panel/login` `{ username, password }` → token + Cookie `kin_panel_token`（7 天，HttpOnly）。`POST /api/panel/logout` 撤销。`GET /api/panel/me` → `{ user, role, views, capabilities, version }`。`GET/PUT /onboarding` 为首配进度（见「引导」）。

`/admin/*` 仅 master / admin 角色。恢复备份期间协议口 503。

## RBAC

| 角色 | 页面 | 能力 |
|------|------|------|
| `user` | 虚拟机 / 代理池 / 密钥 / 计费 / 日志 | 只管自己的 VM、代理、key；自建配额 `vm_create_quota` 0–100；不能调度平台池 |
| `super` | 总览 / 集群 / 用量 / 日志 + 虚拟机 | 读 VM + 拨调度 / 清冷却；集群只读节点列表 |
| `admin` | 全部 | `*`。可管理用户 VM，但 admin/master **未 pin** 的 `/v1` 只打未分配平台池 |

环境变量 `VM2API_ADMIN_USER` / `VM2API_ADMIN_PASSWORD` 只在库里还没有同名用户时灌进第一个 admin；之后以 SQLite `users` 为准，面板「用户」页可增删改、改密码。密码 scrypt。不能删/停用最后一个 admin。

`vms/*.json` 的 `owner_user_id` / `origin`（`platform` \| `admin_assigned` \| `user_created`）是属主 SSOT。`PATCH /vms/:id/owner` 仅 admin。自建 VM 不能收回进平台池。

## 引导

所有已登录角色与 master API key 可调，不是公开接口。状态按用户名存在 SQLite `settings` 键 `onboarding_state`；master key（`apiKeyKind=master`）键为 `__master__`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/onboarding` | `{ user, role, status, updated_at, needs_welcome, base_url, steps[{id,done}], done_count, total }`。缺记录 `status=pending`。`needs_welcome = status === 'pending' && (total === 0 \|\| done_count < total)`，前端不要重算。`base_url` 只在设置了 `PUBLIC_BASE_URL` 时返回（去尾 `/`），否则 `null`，前端用浏览器当前 origin。步骤只含 `id`/`done`，文案与链接由前端按 id 渲染。 |
| PUT | `/onboarding` | `{ action: "complete" \| "dismiss" \| "reset" }` → 200 同 GET。其它 action 400 `{ ok:false, error:{ code:"invalid_action", message } }`。`complete`/`dismiss` 写入标记；`reset` 删除该用户记录（回到 pending）。 |

步骤按角色裁剪（顺序固定），完成态复用现有列表的属主裁剪（`/vms`、`/proxies`、`/api-keys`、`/request-logs/stats`）：

| id | admin | user | super | 完成条件 |
|---|---|---|---|---|
| `admin_password` | ✓ | | | 环境密码不是默认 `123456`，或 env 管理员已在 `users` 表 |
| `egress` | ✓ | ✓ | | 可见代理 ≥ 1（`px-local` 计入） |
| `slot_account` | ✓ | ✓ | | 可见槽 `has_token` ≥ 1 |
| `schedulable` | ✓ | ✓ | ✓ | 可见槽 `has_token && schedulable` ≥ 1 |
| `api_key` | ✓ | ✓ | | 可见未删且 `status=active` 的协议密钥 ≥ 1 |
| `first_request` | ✓ | ✓ | ✓ | 可见 usage_logs 中 ≥ 1 条 2xx |


## 用户

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/users` | 列表（含 `vm_create_quota`） |
| POST | `/users` | `{ username, password, role, enabled, vm_create_quota? }` |
| PATCH | `/users/:id` | 改角色/密码/启用/配额；改密会撤销该用户其它会话 |
| DELETE | `/users/:id` | 软删除用户并撤销会话；将其 `admin_assigned` VM 收回平台池，保留调度开关与额度冷却；`user_created` VM 保持原归属，不自动转入平台池 |
| PATCH | `/vms/:id/owner` | admin：`{ user_id }` 分配，`{ user_id: null }` 收回（仅 `admin_assigned`） |
| GET | `/billing` | 用户计费汇总。`from`/`until`/`group_by=vm|key`。user 隐式只看自己；admin 可 `user_id=` |

启动时会修复旧版本遗留的已删除用户 VM 归属：仅收回 `admin_assigned`（旧记录未写 `origin` 时按已有归属规则推断），不收回租户自建 VM、停用用户或无用户记录的 VM。修改经 `vms/*.json` 写入并同步到 SQLite，不重启槽位。


用户名 `^[a-zA-Z][a-zA-Z0-9._-]{1,31}$`，密码 8–128。`vm_create_quota` 整数 0–100，默认 0。

## 总览 / 槽位

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/dashboard` | 总览：健康、KPI、`proxy_pool`、`ops`（默认近 1h SLA/TTFT）、`billing` |
| GET | `/vms` | 列表（`has_token`、`cred_status`、`proxy_configured`、`can_import_credential`、`account_tier`、`schedule_level`、`schedule_level_mode`、`worker_credential`、Fable 轨；Claude 行 `seats_used` / `seats_max` / `seats_grace` / `queue_depth` / `conc_waiting` / `inflight`）；响应另带 `pool_queue: { global_queue_depth, queue_max }`。`availability.key` 取值 `ok` / `drain` / `quota` / `cool` / `rest` / `off` / `bad` / `none`，`drain` = 临近闸线（仍接单），`rest` = 工作时段外休息中 |
| GET | `/pool/stream` | SSE。`event: seats`：`{ seats: { [vmId]: { seats_used, seats_max, seats_grace, queue_depth, conc_waiting, inflight } }, global_queue_depth, queue_max, ts }`，缺席的 VM 表示空闲；每次请求开始/结束都会推。`event: proxy`：`{ proxies: { [vmId]: { id, status, enabled, blocked_reason, latency_ms, last_error, last_probe_at } }, ts }`，每次探测或代理状态变化推送。两类帧都按 250ms 节流，租户只收到自己 VM 的条目 |
| GET | `/vms/:id` | 详情 + 调度等级 + 代理健康 + `billing.today/window_5h/window_7d/by_model/usage_stats`（`usage_stats` = 近 30 个上海自然日的按日用量 + 模型 / 入站路径排名，日界同 `billing.today`） + `account.runtime_window` |
| PATCH | `/vms/:id` | 热改并发/RPM、OpenAI 会话上限、Claude 席位/配额、模型白名单、槽策略、Claude `schedule_level`、`weight`（Codex 选槽权重 1–100，`null` 回默认 1）、`active_hours` 或 `timezone`（不重启槽）。`timezone` 为任意有效 IANA 名称，会钉住该槽（后续绑定不覆盖）；`timezone_follow_proxy: true` 重新跟随已绑代理的出口时区 |
| POST | `/vms/pool-policy` | 批量槽策略。`{ ids: [...] }` 或 `{ all: true }`，可带 `weight`(1–100) / `schedule_level`(1–10 或 `"auto"`) / `max_concurrency`(1–256) / `max_rpm`(0–1000000) / `max_sessions`(0–256)；`null`（或 `""`）取消钉住：weight 回默认 1、schedule_level 回 auto、上限回 tier / 全局默认，语义与逐槽 PATCH 一致。只写 `vms/*.json`、不重建槽详情，100+ 槽一次调用即可（逐个 `PATCH /vms/:id` 每槽约 4s，并发下发会压住控制面）。返回 `{ updated, missing, failed, items: [{ id, weight, schedule_level, max_concurrency, concurrency_override, max_rpm, max_sessions }] }` |
| POST | `/vms/:id/probe` | 槽 SOCKS5 探官方 `/usage` + Fable（Pro 跳过 Fable） |
| POST | `/vms/:id/exit-probe` | 测这个槽真实出口的 IP 与地理（仅 admin）：SOCKS5 槽经代理查；本地代理槽查它所在 VPS 那条本地代理并刷新该行地理。未绑定 502 `proxy_required` |
| POST | `/vms/schedule/hold` | kernel 升级排空：`{ reason? }` 默认 `kernel_update`。将当前 **可调度** 槽标为不可调度（`schedule_disabled_reason=reason`，不改容器状态）；等待这些槽在途请求归零（最长约 120s）。成功 `{ paused, inflight: 0, drained: true }`。超时 409 `slots_busy`，**自动恢复** 本次 hold 的槽调度。手动关调度或凭证失效的槽不受影响 |
| POST | `/vms/schedule/resume` | 与 hold 配对：`{ reason? }` 默认 `kernel_update`。恢复 `schedule_disabled_reason` 等于该 reason 的槽为可调度；返回 `{ restored }`。`deploy/install.sh upgrade` 在 kernel 同步后调用 |
| POST | `/vms/:id/schedulable` | `{ schedulable }` 是否入池；不改容器 |
| POST | `/vms/:id/cooldown/clear` | 清账号/模型冷却、粘性钉和 `/usage` 429 旗标，重新入池 |
| POST | `/vms/:id/test-chat` | loopback `POST /v1/messages`，master 可钉槽；官方 CC 入站 + 4 块 system。默认 prompt `hello` |
| GET/PUT/DELETE | `/vms/:id/test-schedule` | 每 VM 一条真实对话定时计划，回 `{ schedule }`。PUT 保存结构化调度 `{ enabled?, frequency, minute?, time?, weekdays?, timezone, model, prompt, max_tokens?, reasoning_effort? }`（`frequency`=`hourly`/`daily`/`weekly`；服务端内部编译五字段 cron，响应不回 `cron` 字符串）。`enabled` 缺省 `false`；Claude 用 `max_tokens`，Codex 用 `reasoning_effort`。GET/PUT 含最近结果、下次运行时间与运行状态；到点 `runVmTestChat` 并计用量；重启恢复计划但不补跑停机错过；删 VM 时清计划。租户可读写自己槽的计划 |
| GET/PUT | `/test-schedule/default` | 全局默认调度模板（仅调度时间结构）。GET 所有已登录角色可读；**PUT 仅 admin/master**（body `{ schedule: { frequency, … } }`，`schedule: null` 清除） |
| POST | `/test-schedule/sync` | 覆盖写调度时间：`{ scope: "all" \| "ids", vm_ids?, schedule }`。MVP **只**同步 `frequency`/时刻/星期/分钟/`timezone`，**不同步** prompt、模型、token·effort、`enabled`。无计划槽创建且 `enabled=false`（模型/Prompt 取该槽已有计划或 test-chat 默认 `hello` + 首个可测模型）。租户 `scope=all` 仅自己的槽；逐槽权限同 test-schedule |
| POST | `/vms/:id/count-tokens` | Setup Token / Console API Key 经槽 Go worker SOCKS 打官方 `POST /v1/messages/count_tokens`。body `{ model, messages, system?, tools? }`。完整 OAuth 400 `count_tokens_unsupported`。成功 `{ input_tokens, model, credential_mode, vm_id }` |
| POST | `/vms/:id/oauth/refresh` | 只转发 worker `Ensure`，不回 token |
| POST | `/vms/:id/oauth/to-setup-token` | 把当前完整 OAuth 活票改成 Setup Token（保留 refresh/过期）。已是 setup-token 则幂等 |
| POST | `/vms/:id/oauth/generate-auth-url` | PKCE 授权链接；无 SOCKS5 拒绝。`{ flavor: "claude_code" }` 为官方 Claude Code 授权页。`{ flavor: "setup_token" }` 为 inference-only PKCE，不启槽内 CLI |
| POST | `/vms/:id/oauth/exchange-code` | 粘贴授权码，经槽代理换票。完整 OAuth 才排队初装。flavor 以 session 为准 |
| GET/POST | `/vms/:id/official-cc-bootstrap` | 初装进度 / `{ manual:true }` 再跑 |
| GET/PUT | `/vms/:id/seed-settings` | 播种；强制保留 telemetry/bedrock/vertex 等 env |
| POST | `/vms/:id/collect-identity` | guest 采集（locale/tz/`guest_machine_id`） |
| POST | `/vms/:id/reload` | 重载该槽 worker |
| GET | `/wrap-cli` | kernel / wrap 样本 inspect：`ok, dir, kernel_bin, glibc_shim, wrapper, meta, kernel`。`kernel.source` 为 `configured`（仓内 `KIN_KERNEL_BIN` / `bin/kin-kernel`）或 `sample` |
| POST | `/wrap-cli/make` | `{ glibc_vm? }` 重整 share/wrap-cli；叠上仓内最新 kernel；可从指定槽拷 glibc shim |
| POST | `/wrap-cli/kernel` | 原始 `application/octet-stream` linux amd64 ELF。替换仓内 `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin`。不自动同步槽位 |
| POST | `/wrap-cli/kernel/release` | `{ ids?, restart?, tag? }` 下载 GitHub Release 的 `kin-kernel`（默认 latest；`tag` 必须是 `vX.Y.Z`）。校验 linux amd64 ELF 后替换仓内二进制，再按 `/wrap-cli/sync` 铺到槽并 bounce dataplane。不 `docker rm`。下载或 ELF 失败不写文件。HTTP 200 表示槽同步也成功 |
| POST | `/wrap-cli/sync` | `{ ids?, restart? }` 铺到槽 `.kin`（cli-node ELF + **最新** kernel.bin + 包装器）。kernel 优先仓内二进制，不被旧母样本盖回。`restart` 默认 true：有 kernel 字节变化时复制并 rust 槽 bounce kernel。**`restart: false`** 只读对比仓内 kernel 与各槽 `.kin`（含待重启标记），**不** hold 调度、**不**复制、**不**重启；用于升级前判断是否需要动槽 |
| POST | `/vms/:id/wrap-cli/promote` | 从该槽晋升 wrap 文件，不复制凭证/SOCKS。下次 sync 仍优先仓内最新 kernel |
| POST | `/vms/:id/wrap-cli/repair` | 单槽重装 kernel。`{ wrap, kernel }`；wrap 成功时 HTTP 200 |
| POST | `/vms/:id/start` · `/stop` | 容器生命周期。运行中容器除非显式 recreate，禁止 `docker rm -f` |
| POST | `/vms/:id/activate` | 标 active |
| POST | `/vms/:id/reset` | 销毁容器与家目录，再按原槽位重建（保留 ID/代理/种子；凭证清空） |
| POST | `/vms/:id/reset-fingerprint` | |
| POST | `/vms/:id/allocate-proxy` | 从池分配 SOCKS5 |
| POST | `/vms/:id/update-claude-code` | 410，`claude_cli_removed` |
| DELETE | `/vms/:id` | 不能删 active；只解绑本槽代理 |
| POST | `/vms/create` | 种子 VM + Claude Code home；依赖私有 `kin-computer`。未安装返回 400 `computer_service_missing`，身份生成失败返回 400 `computer_create_failed`。Docker 槽可在 `machine` 里可选传 `docker_cpus`（见下） |
| POST | `/vms/import` | sessionKey 导入（必须已有 VM+代理） |
| GET | `/vms/fleet-status` | 全槽更新状态 |
| POST | `/vms/fleet-update` | 全槽 roll / 采集 |
| POST | `/vms/reconcile-fingerprints` | 用官方 `~/.claude.json` 对齐指纹 |
| POST | `/probe` | 全量额度探测 |
| GET/POST | `/health-probe` | 读/跑官方 hello 健康探测缓存 |
| GET | `/usage` | 用量汇总（含缓存 token、官方价；账号行 `credential_mode` = `oauth` / `setup-token` / `official-setup-token` / `apikey`） |
| GET | `/models` | 策略目录（不 hop worker） |
| GET | `/oauth` | 全槽脱敏 credential |

`/vms`、`/vms/:id`、`/usage` 的账号行带窗口估算 `estimate_5h` / `estimate_7d` / `estimate_fable`（Fable 只在有 `7d_oi` 窗口的 Claude 号上非空）和 `window_fable_cost`。结构：`{ status, spent_usd, total_usd, remaining_usd, total_tokens, used_ratio }`。总量 = 窗口内官方费用 ÷ 已用比例，按官方价算，不乘分组倍率。`status` 不是 `ok` 时 `total_usd` / `remaining_usd` 为 `null`：`no_data`（无用量读数）、`no_reset`（无重置时间或已过期）、`log_gap`（日志没覆盖窗口起点，或已用比例动了但网关内无花费）、`low_usage`（已用 < 5%）、`unpriced`（窗口内有未定价请求）。token 字段 `total_tokens` / `today_tokens` / `window_*_tokens` 都是输入 + 输出 + 缓存读 + 缓存写，每类只算一次。

`cred_status`：`无凭证` / `可用` / `5h 警告` / `5h 限制` / `7d 警告` / `7d 限制` / `普通限制` / `不可用` / `被吊销` / `探测失败`。Fable 不可用 / 7d_oi / 家族冷却不抬账号级限制。等级：官方 `/usage` 有 Fable 模型或真实 7d_oi = Max；无 Fable 的 `plan_denied` = Pro。落盘 pro 不能盖掉 usage 里的 Fable。

`account.runtime_window`：`rate_limited_at` / `rate_limit_reset_at` / `overload_until` / `session_window_start|end|status`。

`schedule_level` 是当前有效调度等级，范围 1–10；`schedule_level_mode` 为 `manual` 或 `auto`。`PATCH {"schedule_level": 1..10}` 写入手动等级，`null` 或 `"auto"` 清除手动值。自动模式按 Claude 7D 重置剩余时间滚动分档：不足 24h 为 7，之后每 24h 降一级，144h 及以上或无有效重置时间为 1。Claude 同等级内按 `routing.pool.strategy`（`balanced` / `fill`）开新席位；`weight` 只用于 Codex 选槽，与调度等级无关。整池改这两项用 `POST /vms/pool-policy`（只写记录，不重建槽详情）。

### 平台独立的槽位限额

`max_concurrency` / `max_rpm` 传数字钉住本槽，传 `null` 清除覆盖并立即使用本平台全局值。Claude 跟随 `tiers`；OpenAI 跟随 `codex.quota`，不受 Claude 分档保存影响。

`active_hours` 是本槽每日工作时段：`PATCH {"active_hours": {"start": "HH:MM", "end": "HH:MM", "timezone": "IANA", "days": [0-6]}}`，`null` 清除恢复 24h 接单。`start` 晚于 `end` 为跨夜班次（如 20:00–08:00）；`days` 约束窗口可开始的星期（0 = 周日，缺省每天），跨夜窗的下半段不受次日是否列出影响。时区取窗口自带值 → 槽位 `timezone` → UTC。窗口外该槽不参与调度：Claude 池返回 `rest_period`（模型/额度门禁之后才判，只有本可接单的槽才计入开窗时间）；Codex 池直接跳过，续接 `previous_response_id` 时绑定槽在休息返回 409 `response_not_portable`；两侧整池都在休息时均 503 `pool_unavailable` 并带 `Retry-After`（最近开窗时间）。pin 诊断不受影响，健康探测不挑休息中的槽。夏令时切换日按实际时刻判定：开窗落在被跳过的小时则在跳变时刻开窗，重复的小时不截断班次。导出包无窗口时写 `active_hours: null`，写回会清除窗口；面板 `availability.key` 显示 `rest`（仅当槽本可接单时；冷却/额度等真实原因优先）、`schedule_state` 为 `restricted`、`restriction_until` 为下次开窗。列表/详情另返回 `active_hours_timezone`（实际生效时区）与 `active_hours_active`（此刻是否在窗口内，未设为 `null`）。

OpenAI 另支持 `PATCH {"max_sessions": 0..256 | null}`：数字钉住活跃对话窗口上限，0 = 不限；`null` 立即恢复跟随并继续随后续全局保存更新。窗口闲置保留沿用 5 分钟，不是 Claude 席位或 sticky TTL。新增对话受上限约束，已存在的对话可复用窗口；借用其它账号执行不重复占用该对话的归属窗口。

列表/详情的 OpenAI 行返回 `max_concurrency`、`max_rpm`、`max_sessions`，对应来源标记 `concurrency_override`、`rpm_override`、`max_sessions_override`；`scheduling_inherited` 给出清除覆盖后的值。`inflight` / `rpm` 来自 OpenAI 执行运行态，`session_active` / `session_max` 来自对话窗口；`session_slots`、Claude `quota_policy` / `quota_inherited` 为 `null`。

`openai_quota_policy` 是 OpenAI 的独立生效视图：5 个额度字段、`concurrency_override` / `rpm_override` / `sessions_override`、`reason` 和 `restricted_until`（毫秒或 `null`）。`availability` 使用相同实时策略，不套用 Claude 闸线；缺失用量不伪造百分比，未知本地软闸重置时间保持 `null`。此字段在 Claude 行为 `null`。

Claude PATCH `max_sessions` 返回 400 `claude_max_sessions_forbidden`；OpenAI PATCH `session_slots` / `quota_override` 分别返回 400 `gpt_session_slots_forbidden` / `gpt_quota_override_forbidden`。非法新限额返回 400 `invalid_scheduling_value`。混合字段先校验，再写入，拒绝的字段不会使同一请求中的其它限额部分生效。

`POST /vms/create` 指定 `platform: "openai"`，省略并发/RPM/会话上限即跟随已保存的 OpenAI 全局值；显式值钉住本槽。OpenAI 凭证导入/重导入保留既有覆盖和权重，未覆盖字段采用当前 OpenAI 全局值；不新增跨平台切换入口。

### Docker 槽可选 CPU 上限

`POST /vms/create`（`runtime_type: "docker"`）可在 `machine` 与 `memory` 同级显式传 `docker_cpus`：`0` 或省略表示不限 CPU（与升级前一致）；`0.01`–`16` 为 CPU 时间硬上限（如 `0.5` 表示最多占用半颗宿主机 CPU 的时间，非独占核）。字符串、非有限数、越界或 KVM 创建携带该字段返回 400 `invalid_machine`。仅当请求体显式带上时才写入 `machine.docker_cpus`；不会把 KVM 的 `machine.vcpus` 隐式转成 Docker 上限。配额在**容器创建或 recreate**（含 `POST /vms/:id/reset`、带 recreate 的 start/reload、看门狗/恢复路径上的重建）时落到本地 `--cpus` 或集群 Engine `HostConfig.NanoCpus`；对已存在容器的普通 start、kernel 重启或控制面重启**不会**在线改限额，且无 `PATCH` 改配额入口。列表/详情回显已保存的 `machine.docker_cpus`。若落盘值损坏或越界，`POST /vms/:id/reload`、恢复/重建相关路径会在触达容器前先拒绝并返回 `invalid_machine`。

`GET /vms/:id` 的 `kernel.rust_health` 来自 wrap `/internal/health`：`reachable`（进程在且 `ready_slots>=1`）、`process_up`、`provider`（cli-hop 为 `local_cli`）、`ready_slots`、`cli_pid`、`worker_version`。Go hop 没有 slot 字段。`reachable=false` 且 `process_up=true` 表示 kernel 在、CLI 槽未就绪。

### 虚拟机代理字段

| 字段 | 说明 |
|------|------|
| `proxy_configured` | 是否已绑定 SOCKS5 |
| `can_import_credential` | 绑定且代理非 fail/dead 才允许换票 |
| `proxy.status` / `enabled` / `latency_ms` / `last_error` / `last_probe_at` / `has_auth` | 健康快照；**不返回**带账密的 `proxy.url` |

`proxy_pool`：`{ total, free, bound, ok, dead, probing, disconnect_on_error }`。

## 数据库运行态（仅 admin）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/database/metrics` | `{ sampled_at, database, usage_cache }`；SQLite/WAL 只读快照与官方用量缓存实例统计 |

`database` 只执行 `SELECT 1`、只读 PRAGMA、migration 摘要和文件 stat；不返回数据库路径。单项失败为 `null`，文件明确不存在时大小为 `0`，探针失败只令 `database.ok = false`。当前 `node:sqlite` 不提供 SQLite 页缓存 hit/miss，不得从这些字段推算。

`usage_cache.hit_rate = (success_hits + error_hits) / requests`；`reuse_rate` 再加 `singleflight_joins`。零请求时均为 `null`。`error_hits` 是负缓存命中，不代表业务成功；累计计数随进程或缓存实例重建归零。

该端点只做观测；禁止 SQL 控制台、表浏览、配置修改、checkpoint、VACUUM、`PRAGMA optimize`、完整性检查及业务大表全表计数。

## 版本 / 更新（仅 admin）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/version` | 当前 `VERSION`、GitHub 最新 Release、是否可更新、一键命令、比当前新的 changelog。GitHub 失败时 `source_error` 有值，不 5xx |
| GET | `/changelog` | 本地 `CHANGELOG.md` 解析结果 `{ current, entries }` |
| POST | `/update` | `{ confirm?: true, version?: "vX.Y.Z" }`。`confirm` 缺省只返回命令。`confirm: true` 且已挂 `docker.sock` 时 202 拉起宿主机升级助手；否则 `409 host_upgrade_required`，`data.command` 是同一条 curl。升级会重建控制面，请求可能中断 |

一键脚本：`curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade`。保留 `.env` / `vms/` / `data/`。不要 `docker rm` 槽。

## 模型策略

| 方法 | 路径 |
|------|------|
| GET | `/model-policy` → `{ policy, models, effective }` |
| PUT | `/model-policy` |
| POST | `/model-policy/reset` |
| POST | `/model-policy/sync-worker` | 经一个 Claude OAuth 槽拉 Anthropic `/v1/models`（最多合并 3 个号的目录）并入矩阵。返回 `added` 和 `catalog_sync`。无可用槽 400 `no_claude_slot` |
| POST | `/model-policy/sync-codex` | 经 GPT OAuth 槽 SOCKS 拉 ChatGPT 模型目录并入矩阵。票过期时用 refresh_token 换一次新 access，写入 `codex-credentials.json`。无 Codex 槽 400 `no_codex_slot`。 |

上游目录启动 5 秒后和每 6 小时自动同步一次，结果写在 settings `model_catalog_sync`。已有条目的编辑一律保留。新 Claude id 只在 `worker_only` 下直接对外，其他模式加入后默认关闭；新 GPT id 一律默认关闭，等管理员打开。models.dev 只提供新条目的显示名。

`catalog_mode`：`policy_only`（默认，控制台 #/models 即目录）/ `worker_intersect_policy` / `worker_only`。矩阵行可改 `betas.pass_context_1m`、thinking 策略、`max_tokens_cap`。

## 计费（仅 admin）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/pricing` | `{ models, models_dev, overrides, unpriced, policy, catalog_sync }`。`models[]` 每行有 `effective`、`source`（`override` / `models.dev` / `builtin`）、`mode_sources`、`builtin`、`models_dev`、`override`、`diff`、`in_policy` |
| PUT | `/pricing/overrides` | `{ key, price }`。`key` 形如 `anthropic/<id>`、`openai/*`、`*/<id>`。`price` 必须有 `input` / `output` / `cache_read`；`cache_5m` / `cache_1h` 可省（Claude 按 1.25× / 2× input 补）；可带 `tiers[{above,...}]`、`modes.{fast,flex,priority}`。`price: null` 删除。字段不全 400 `invalid_price` |
| POST | `/pricing/sync` | 立即拉 `https://models.dev/api.json`，失败保留上一份快照 |
| POST | `/pricing/reprice` | `{ since, until }`（ISO）。按当前有效价重写该时段的官方费用列，并给 `unpriced` 行补价。不改 `actual_cost` / `rate_multiplier` / key 已扣额度。返回 `{ rows, changed, still_unpriced, delta_usd }` |

价格优先级：覆盖 `provider/model` > `provider/*` > `*/model` > models.dev > 内置快照。models.dev 缺的模型和档位（fast / flex / priority、长上下文、web search 按次费）从内置快照补。models.dev 每 24 小时刷新，遇到未定价模型且上次拉取超过 6 小时会后台补拉。

## 路由 / 设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/routing` | sticky / pool / failover / Claude 并发与 `tiers` / OpenAI `codex.quota` / 额度 / logging / `compatibility` / `official_cc` / `health_probe` |

`PUT` 热更新。`tiers` 必须回传：该块是整体替换而非 patch，缺字段即置空。Claude 分档保存只传播到未手动覆盖的 Claude 槽。OpenAI `codex.quota` 按字段合并，不覆盖其它 Codex 协议/客户端配置，只更新跟随的 OpenAI 限额。

### OpenAI 传输与隐私

设置页的「调度 → OpenAI」和「槽位 → OpenAI」进入同一个 `#/settings/openai` 页面。GPT 协议、客户端准入、目录版本及全局配额集中在这里；Claude 配置仍在原页。保存使用现有 `PUT /api/panel/routing`。

| 字段 | 默认 | 生效范围 |
|------|------|----------|
| `websocket.enabled` | `true` | 全局推理 WS 总闸，不影响面板终端或集群连接 |
| `codex.websocket.enabled` | `true` | GPT 推理 WS 子闸；必须与总闸同时开启 |
| `codex.upstream_transport` | `prefer_websocket` | `prefer_websocket` 或 `http`；入站与上游传输不是同一段连接 |
| `codex.user_agent` | `codex_cli_rs/0.160.0 (linux x86_64)` | 上游客户端画像，不读取下游用户的系统信息 |
| `codex.catalog_client_version` | `auto` | 模型目录同步的客户端版本，与推理 UA 分开 |
| `codex.client_features.enabled` | `false` | 显式开启后上送槽位独立安装 UUID 与官方 `client_metadata`；不使用 VM/硬件指纹 |
| `codex.analytics.enabled` | `false` | 显式开启后独立上报运行环境 Analytics，不是推理成功的前提 |

任一 WS 闸关闭时，新 WS 握手被拒绝，HTTP/SSE 入口继续可用且上游强制 HTTP。传输、UA 与隐私选项通过每次内部 envelope 的 `options` 生效，不为修改这些设置而重启共享 kernel；已开始的请求保留其选定策略。

安装 UUID 存在槽位 `run/codex-installation-id`，不取 MAC、主机名、machine-id 或调用方安装 ID。每次 envelope 的 `options.installation_id` 使用该文件的 UUID，覆盖运行中 kernel 的旧启动身份；非法安装 ID 在拨号前拒绝，避免复用旧进程时重新上传 VM 指纹。关闭安装元数据时，不生成 `client_metadata`，并从调用方的 turn 元数据移除安装 ID；会话路由所需信息保留。

Analytics 按官方 [`codex_thread_initialized`](https://github.com/openai/codex/blob/main/codex-rs/analytics/src/events.rs) 的事件结构，向 `https://chatgpt.com/backend-api/codex/analytics-events/events` 单独 POST，使用所选账号鉴权并沿用该槽出口。包含真实 kernel 版本、kernel 所在宿主的系统/系统版本/架构、会话标识、模型和 Unix 秒级时间；不上传提示词、文件内容、仓库路径、主机名或 MAC。每进程每账号/会话去重（最多保留 4096 个键），队列最多 32 条，单次上传最多 10 秒，失败只记录状态、不重放推理、不重试上报。未启用时零 Analytics 请求。OTEL/Statsig 与 Sentry 反馈不随这个开关启用。官方发送实现见 [`analytics/src/client.rs`](https://github.com/openai/codex/blob/main/codex-rs/analytics/src/client.rs)。

### 通用路由选项

`failover.stream_idle_timeout_ms`（毫秒，30 秒–60 分钟，默认 180 秒）：上游流连续无事件即判超时；网关流路径、各槽 `kernel.json` 的 `idle_timeout_seconds` 与 job 看门狗共用。优先级：面板该字段 → 启动时写入 `cfg.limits.stream_idle_timeout_ms` → 控制面 `.env` 的 `KIN_STREAM_IDLE_TIMEOUT` → 180 秒。保存后热写各槽 `kernel.json`；运行中 kernel 在无任务时自动重启以读取新看门狗值。

`compatibility.persona_preset`（`official` / `official_full` / `zero` / `custom`）和 `compatibility.cache_ttl`（`5m` / `1h`）保存后投影到每个 Claude 槽的 `vms/<id>/run/kernel.json`：`persona_preset`、`system_layout`（`zero`→`zero`，其余→`identity`）、`default_cache_ttl`。响应 `kernel_persona.updated` 是本次字节有变化的槽数。`PATCH /vms/:id` 的 `timezone` / `timezone_follow_proxy` 另把 `timezone` 热写进该槽 `kernel.json`，`timezone_sync.kernel_hot` 表示文件有变化。容器 `TZ` 不在这次写入里。Codex 槽不写。

`compatibility.agent_standing`（字符串，≤2000）与四个按档布尔 map `agent_standing_presets` / `agent_standing_hide_presets` / `persona_env_presets` / `persona_hide_presets` 控制常驻约束、约束遮罩、Environment 和整档 usage 遮罩，不投影到 `kernel.json`，Node 每次请求热读。`GET /api/panel/persona/preview-vars?timezone=<IANA>` 返回 system提示词页预览用的真实模板常量（身份句、官方 agent 全文、按该时区渲染的 Environment），不含 billing；时区非法或缺省按 UTC。

`agent_standing_presets` 缺 map/key 默认关闭，只有显式 `true` 启用；`agent_standing` 内置文本保持不变。约束遮罩与 Environment 开关缺省仍为开启，整档遮罩仍回落既有模板/旧设置。保存显式开启的档位不改变其他缺省关闭的档位。

`persona_env_presets[当前档]=false` 同时关闭生成的 `env`、`env_timezone_only`、`env_official` 和槽位 `timezone` 模板变量；官方完整档的 Environment 不再固定开启。空的生成环境块直接省略，不保留 cache / 零宽占位。调用方或自定义模板字面提供的环境和时区原样使用；关闭时 native 不剥掉调用方 Environment，HTTP 不按所选槽位改写其时区。控制台开关、预览和 Node 出站使用同一按档规则。

### OpenAI 全局额度

```json
{"codex":{"quota":{"limit_5h":1,"limit_7d":1,"max_concurrency":2,"max_rpm":0,"max_sessions":0}}}
```

| 字段 | 默认 | 新值范围 / 单位 |
|------|------|-----------------|
| `limit_5h` / `limit_7d` | 1 | 数字 0.3–1；使用比例，控制台显示百分比 |
| `max_concurrency` | 2 | 整数 1–256；每账号在飞请求数 |
| `max_rpm` | 0 | 整数 0–1,000,000；0 = 不限 |
| `max_sessions` | 0 | 整数 0–256；0 = 不限 |

本地软闸在实际普通准入生效：用量达到闸线即排除账号。提高阈值或窗口有效重置后重新评估，不能清除上游硬限制、人工关闭或凭证问题；已在飞的流和对话窗口不被重建。两个窗口独立判断，一个重置不代表另一个解除。

Claude `routing.quota` 的 5h/7d 闸分三段（`critical_band` 默认 0.05，`gate_overshoot` 默认 0.05，范围 0–0.1）：

| 用量 `u`（相对档位/VM 覆盖的闸线 `limit`） | 状态 | 行为 |
|------|------|------|
| `u < limit − critical_band` | 正常 | 照常调度 |
| `limit − critical_band ≤ u < limit + gate_overshoot` | 临近闸线（`availability.key = drain`） | 已入座会话留在本 VM 继续；同账号一次只跑一个请求，第二个并发在本 VM 排队（不换 VM，超时 529）；新会话优先开到其他正常 VM，没有时才开在这里；用量已过闸线时不再开新席位 |
| `u ≥ limit + gate_overshoot` | 闸上（`quota_5h_safety` / `quota_7d_safety`，受限） | 让出席位换 VM |

上游 rejected / 100% / 429 冷却永远先于上表。闸线 0.95 + 默认超出量 0.05 = 1.0 时，闸上与上游满额重合。

临近闸线区另有大额冷请求保护（默认开）：`guard_large_cold`（bool）、`large_cold_uncached_tokens`（默认 100000）。比较的是边际缓存未命中的输入，不是输出上限：首轮 / 前缀变化 / 未确认缓存算整段 prompt，已确认热前缀只算最后一条 user。`max_tokens` 不计入（Claude Code 和缺省填充都是 128000，那是输出天花板，不是预计输出）。达到阈值时该账号本笔不接单，调度改选其他账号；全池都在临近闸线区则本地 HTTP 429 `quota_guard_request_too_large`，不打上游。临界区内成功结算后，下一次官方用量刷新前，下一笔同样大的未命中也不接。闸是尽力保护：缓存命中与最终输出无法精确预知，也不把美元换成官方百分比，更不会截短上下文。要拦住更小的冷写入，把 `large_cold_uncached_tokens` 调低，不要把输出上限加回去。


`codex.quota` 为 `null`、数组、未知字段、字符串数字或超范围值，返回 400 `invalid_openai_quota`，消息定位字段，校验失败前不落盘。新增限额不接受 OpenAI 并发 0；历史存储 0 仍按原有效值 2 执行和展示。

旧配置缺少自有 `codex.quota` 时，启动迁移先保存 OpenAI 槽的有效非默认值为覆盖，再原子保存规范化 routing；重启/中断续跑保持幂等。既有异常大对话上限保留为历史本槽值，不截断。升级前备份 routing 与 VM 记录；代码回退不自动恢复旧配置语义。不要用仓内默认配置覆盖部署上的 routing/VM/凭证数据。

控制台账号池、配额、粘性均采用摘要→配置弹窗：取消/Escape/外部关闭丢弃弹窗临时改动；“应用到草稿”只合并该弹窗的字段，“保存”才持久化全局设置。保存失败保留草稿。配额切换平台保留双方草稿；VM 调度弹窗直接 PATCH，本槽保存独立于全局保存。Sticky 开关/TTL/出站 session 由两个平台共享，Claude 席位与 OpenAI 对话窗口不共享容量。


## 蒸馏拦截

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/distill` | 协议入口蒸馏拦截。命中后返回 `error` 里配置的状态、code 和文案，不 hop 凭证 |

`PUT` 热更新 `src/config/distill-rules.json`。字段：`enabled`、`skip_official`（官方 Claude Code 放行普通针、指纹和结构）、`skip_zero`（`persona_preset/inject=zero` 放行这些）、`error.{status,type,code,message}`、`hard_needles[]`（收割包装：官方和 0 注入也拦；面板删掉即停，不会补回）、`needles[]`、`patterns[]`（附加正则，官方和 0 注入也拦）、`fingerprints[]`、`structure.{min_max_tokens,require_no_tools,require_single_turn,contest_pattern}`。`contest_pattern` 为空则不做赛题结构收割。思考预算是否算收割，用的是同一个 `min_max_tokens`，不是写死的 8192。确定性蒸馏短语在硬正则的 distill 类别里，不在这里补回。**不含**单独的 `Persistable response items`（普通 agent 信封）。仅 admin。

## 拒答缓存

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/refusal-guards` | 精确指纹，以及可选的用户正文近似（`similarity_enabled`，`similarity` 为 80/85/90/95，默认开、90）。命中 HTTP 400 `policy_blocked`，`code=refusal_guard`，不 hop。相似度只比用户正文。`device_block_enabled` 默认开：命中后永久封禁入站 device id。响应带 `devices` |
| DELETE | `/refusal-guards/:fingerprint` | 删除一条 64 位 hex 指纹 |
| DELETE | `/refusal-guards` | 须 `{ "confirm": true }` 清空 |
| DELETE | `/refusal-device-blocks` | `{ "device_id" }` 解封一条；`{ "confirm": true }` 清空。空 device、短于 8 字符的值不会入库 |

`PUT { enabled }` 写入 SQLite `settings.refusal_guard_enabled`。环境变量 `REFUSAL_GUARD=0` 仍强制关闭。与蒸馏拦截独立：0 注入跳过普通蒸馏针，本缓存仍生效。`count_tokens` 同样在 peek / worker hop 之前拦截。device 取入站 `metadata.user_id.device_id`，否则显式 `device_id` / `x-kin-device-id`，不用 IP、UA 或 API key。仅 admin。

## 决策模型与硬正则

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/jev-intercept` | 协议入口。顺序：蒸馏硬规则 → 去掉 reminder、按需展开 base64 后的硬正则 → 拒答缓存 → 决策模型。没配地址则跳过模型；模型失败默认放行。`fail_open: false` 时模型不可用则 403，不封设备 |

`PUT` 写入 SQLite `settings.jev_intercept`。字段：`enabled`（默认关）、`hard_regex_enabled`（默认开）、`openai_platform_enabled`（默认关）、`provider`（`jev` 默认、`laya`、`modernbert`）、`base_url`、`model`、`timeout_ms`（200–8000，默认 2000）、`patterns[]`、`rules`（`null` 与 `[]` 都用内置规则；关掉这一层用 `hard_regex_enabled: false`）、`api_key` 或 `api_keys`（最多 999 把）、`question_ids`（题库 id，缺省为全部）。省略密钥保持原值；`api_key: ""` 或 `api_keys: []` 清除。一行可以是裸 key（用 `base_url`），或 `https://host/v1/systemone <key>` 打到另一个 systemone。`401` / `429` / `529` 退役该 key，之后不再调度，再次保存密钥列表会重新启用。网络错误和其它 HTTP 状态只跳过这一跳的同一主机，不退役 key；失败放行的原因写在放行 keyword（`网络异常` 或 `上游 <status>`）。另有 `safety_instruction`（空则不加自定义题）、`safety_threshold`（0–1，默认 0.5）、`block_if_below`（默认开）、`fail_open`（默认开）、`dedup_sec`（0–3600，默认 60）、`max_state_chars`（256–64000，默认 16000）、`expand_base64`、`strip_reminders`（后两个默认开）。GET 不回密钥，回 `api_key_set`、`api_key_count`、`question_bank`、`providers`、`builtin_patterns`、`rules`、`rules_customized`、`openai_platform_enabled`。

三个后端走同一套 `/v1/systemone`。题库存在 `questions`：可增删改，缺省是内置六题（综合、色情、破限、逆向、渗透、网络攻击）。每题都是「是否安全」，高分表示安全，启用的题目一起问，任一题低于阈值就拦。`safety_instruction` 非空时再多问一题自定义要求。`POST /jev-intercept/models` 用地址和 Key（留空则用已存的第一把）请求 `{base}/v1/models`，失败回 502，不会把上游 401 当成面板登出。

内置正则覆盖 NSFW、蒸馏、破解、破限，面板删不掉。比较的是用户自己写下的正文，不含 user 轮里的 `tool_result` / `*_tool_result` / `function_call_output`；决策模型仍看 system。命中硬正则或模型返回 HTTP 403 `policy_blocked`，不 hop，不写入拒答缓存；device 封禁开启时封禁入站 device id。模型不可用且 `fail_open` 为 false 时同样 403，不封设备。上游 `content_policy` / `content_filter` / `cyber_policy` / `moderation_blocked` / `safety_violation` / `usage_policy` 同样入库。仅 admin。

账号范围（`account_platform_plans[]`、`account_ids[]`，都可为空）把关卡收窄到部分槽位。每一项是 `平台:套餐`，例如 `claude:max`、`gpt:plus`、`gpt:business`；`none` 是没标注套餐。Claude 的 Max/Pro 与虚拟机列表相同（usage 里有 Fable 就是 Max，盖过落盘的 Pro）。指定账号收槽位 id、邮箱或名称，和勾选取并集，全空 = 所有账号都进关卡。只选了 GPT 套餐时 Claude 仍全部进关卡；选了 Claude 套餐或指定账号后，Claude 在选中槽位后再判，没命中的放行。GPT 一旦有范围就只由范围决定，没有范围时仍看 `openai_platform_enabled`。`GET` / `PUT` 都回 `account_scope.account_platform_plan_options`（带当前槽位数）和槽位清单（每条有 `scope_key`）。旧的 `account_types` 不再参与判断；只写过 `account_plan_types`、还没有 `account_platform_plans` 的配置会收成对应的 GPT 套餐（`none` 同时包含两边的未标注）。


## 密钥 / 日志

| 方法 | 路径 |
|------|------|
| GET/POST | `/api-keys` |
| PATCH/DELETE | `/api-keys/:id` |
| GET | `/api-keys/:id/stats` |
| GET | `/request-logs` |
| GET | `/request-logs/stats` |
| GET | `/request-logs/:request_id` |
| GET | `/request-logs/:request_id/attempts` |

创建密钥只在响应里明文出现一次。存储为 HMAC 索引。`group_type` 为 `all`（默认，全局可调度）、`anthropic` 或 `openai`。后两个必须带 `allowed_vms`（该平台的 VM id，可多台）。`vm_pool_id` 绑定命名账号池：成员以池为准，不复制到密钥；`allowed_vms` 被清空。池停用、为空或不存在时请求返回 403 `vm_pool_unavailable`，不回落到全局池。改成员或解除绑定对下一次请求生效，包括已有粘性会话。一台槽只属于一个池。缺字段的旧密钥视为 `all`。`GET /api-keys/:id/stats` 是该密钥近 30 天用量：上海日桶、模型分布、VM 分布。不是 VM 的上游额度窗口。

attempts：每次选中的 VM/账号、错误域、cooldown、提交边界、终态。`normal` 摘要；`debug` 另存脱敏 body。`X-Request-ID` 回写。`X-Kin-Debug` / `X-Kin-Log` 可单请求覆盖。

### 账号池

| 方法 | 路径 |
|------|------|
| GET/POST | `/vm-pools` |
| PATCH/DELETE | `/vm-pools/:id` |

仅 admin。POST/PATCH 字段：`name`（1–40）、`enabled`、`vm_ids`（整表替换；省略则不动成员）。槽不存在 400 `vm_pool_vm_unknown`；槽已在别的池 409 `vm_in_other_pool`；重名 409 `vm_pool_name_taken`。仍有密钥绑定时 DELETE 409 `vm_pool_in_use`，不会把这些密钥放开成全局。

### 协议字段（对齐 Sub2API usage_logs）

| 字段 | 说明 |
|------|------|
| `cache_read_tokens` / `cache_creation_tokens` | 提示缓存读 / 写 |
| `cache_creation_5m_tokens` / `cache_creation_1h_tokens` | TTL 细分（无细分归 5m） |
| `requested_model` / `upstream_model` / `model_mismatch` | 三态；null = 上游未声明 |
| `first_token_ms` | 首个业务事件（worker 回传） |
| `stop_reason` | 流式来自 `message_delta` |
| 费用列 | 官方价 input/output/cache 5m·1h·read；上海日切 |

`GET /request-logs/stats` 另返回 `window`：SLA、错误率、429/503/529、QPS/TPS、耗时与 TTFT 分位、按模型 `avg_first_token_ms`、`error_collection`。`GET /dashboard.ops` 默认近 1 小时同一形状。

筛选：`status=error`、`error_class=` = auth / request / signature / rate_limit / quota / overloaded / unavailable / timeout / credential / proxy / upstream / other / distill / refusal。每行带 `error_class` / `error_label` / `error_owner`。5h/7d/限流计入 SLA 成功。号池容量 529（`pool_overloaded` / `pool_wait_queue_full` / `pool_queue_timeout`）不计入 SLA 失败；上游 529（`upstream_overloaded`）计入。

流式 usage 由 worker SSE 校验器合并后经 trailer 回传，终态 attempt 只记一次。

## API 上游 / Anthropic 控制台（仅 admin）

管理第三方 Anthropic/OpenAI 兼容 API 地址与密钥（供 `/v1/messages` 等推理在 category=`api` 的 managed 密钥上调度），以及 admin 专用 Anthropic 联调页。浏览器不直连上游；出站经控制面 `forwardApi`（可挂池内 SOCKS5）。

### API 上游 CRUD

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api-endpoints` | `{ items[], presets[] }`。`items` 为脱敏视图（key 掩码）；`presets` 为内置 kind 模板 |
| POST | `/api-endpoints` | 创建 endpoint。body 可带 `proxy_id`（池内代理 id）：写入每条 `api_key_entries[].proxy_id` 并解析为 `proxy_url`；忽略客户端自填的裸 `proxy_url` 时仍可通过 `proxy_id` 绑定 |
| PATCH | `/api-endpoints/:id` | 更新 endpoint 字段。可选 `key_id` + `api_key` 更新已有 key；可选 `proxy_id` 同时写该 key 的 `proxy_id`/`proxy_url`；无 `key_id` 时 `api_key` 会新增一条 key |
| DELETE | `/api-endpoints/:id` | 删除 endpoint |
| POST | `/api-endpoints/:id/keys` | `{ api_key, proxy_id?, … }` 增 key |
| PATCH | `/api-endpoints/:id/keys/:keyId` | 改单 key（含 `proxy_id`） |
| DELETE | `/api-endpoints/:id/keys/:keyId` | 删 key |
| POST | `/api-endpoints/fetch-models` | 未保存草稿拉模型：`kind` / `protocol` / `base_url` / `api_key` 等；`key_id` 从库加载已存 key（可不再输入明文）。`proxy_id` 优先于行内 `proxy_url`；body 显式带 `proxy_id`（含空串）时按 id 解析，否则用已存 key 的 `proxy_url` |
| POST | `/api-endpoints/:id/fetch-models` | 对已保存 endpoint 拉上游 `/v1/models`（可选 `key_id` 指定条目，`apply: false` 只返回不合并） |

列表/详情里每条 key 含 `proxy_id`（池 id，持久化）与 `proxy_url`（解析后的转发地址，不回显账密）。

### Anthropic 控制台

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/anthropic/messages` | admin 联调 `POST …/v1/messages`。成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message } }` |

**鉴权**：仅 `admin` 角色（含 master API key）；`user` / `super` 403。

**请求**（JSON，≤64 KiB）：

| 字段 | 说明 |
|------|------|
| `mode` | 省略或 `direct`：直连指定 key；`scheduled`：走 API 调度器（prefix/alias/优先级/轮询，同推理路径） |
| `model` | 模型 id 或 alias（scheduled 必填） |
| `message` / `prompt` | 用户正文（必填，≤16000 字符） |
| `max_tokens` | 1–8192，默认 256 |
| `api_key` / `base_url` / `auth_scheme` / `proxy_id` | direct 单 key；`proxy_id` 只认池内 id，忽略自填 `proxy_url` |
| `keys` | direct 多 key：`[{ label?, api_key?, key_id?, base_url?, auth_scheme?, proxy_id? }]`；`key_id` 加载已存上游 key（无需重打明文） |
| `key_index` | 只测 `keys` 中某一行的下标 |
| `headers` | 额外上游头（≤24 对；禁止 `\r\n` 注入） |

**响应 `data`**（单 key 或 scheduled）：`ok`、`status`、`text`（助手正文摘要）、`error`（上游失败文案）、`body`（上游 JSON）、`mode`、`auth_scheme`、`endpoint_id` / `endpoint_name`（scheduled）、`requested_model` / `upstream_model`、`proxy`（是否走代理）。**不回显**明文 API key。多 key 批量时另含 `items[]`（每行 `label` / `row` / 同上字段）及汇总 `text` / `error`。

**注意**：与 `POST /vms/:id/test-chat` 独立；不走 VM OAuth 入站。scheduled 无可用上游时 503/404（`api_pool_exhausted` / `model_not_found` 等）。

## 虚拟机测试

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/test-models` | 可测模型。`vm_id` 按槽位平台过滤：GPT/Codex 只返回 `gpt-*`/`codex-*`，Claude 槽不含 GPT。`platform=openai|anthropic` 无 `vm_id` 时同样过滤。GPT 槽 `refresh=1` 经该槽 SOCKS 拉 ChatGPT `/backend-api/models` 并入矩阵，401 不换票。回包带 `platform`、`protocol`（`openai.responses` / `anthropic.messages`）、`inbound_path`。 |

Claude 槽测试走官方 CC 入站（`/v1/messages`）。GPT/Codex 槽测试走 `/v1/responses`。

## 备份 / 代理

| 方法 | 路径 |
|------|------|
| GET/POST | `/backups` |
| GET/PUT | `/backups/config` |
| GET | `/backups/:id/download` |
| POST | `/backups/:id/restore` 须 `{ "confirm": true }` |
| GET | `/proxies` |
| POST | `/proxies/import` · `/proxies/probe` · `/proxies/geo` |
| GET/PUT | `/proxies/config` |
| PUT | `/proxies/:id` 改 host/port/账密 |
| POST | `/proxies/:id/enable` · `/disable` · `/bind` · `/unbind` · `/reveal` · `/geo` |
| DELETE | `/proxies/:id` |

恢复期间协议口 503。每个槽位必须绑定 SOCKS5。`PUT /proxies/config` 的 `disconnect_on_error`（默认 false）：运行时 SOCKS 错误立刻停该槽调度、回写失败并重建 worker；其它健康槽仍可 failover。

`PUT /proxies/config` 的 `follow_proxy_timezone`（默认 true）：绑定一条代理后，该槽采用出口节点的 IANA 时区（persona `# Environment`、指纹、容器 `TZ`）。操作者在创建时或 `PATCH /vms/:id` 手动指定过时区的槽不受影响。

`PUT /proxies/config` 的 `dns_primary` 保持字符串（默认 `auto`）：远程 SOCKS5 透明出口优先使用的 DNS 上游，可选 `auto`、`https://1.1.1.1/dns-query`、`https://8.8.8.8/dns-query`、`8.8.8.8:53`、`1.1.1.1:53`，或自定义 HTTPS DoH URL（如 `https://cloudflare-dns.com/dns-query`、`https://[2606:4700:4700::1111]/dns-query`）。URL 可包含路径、查询参数和 1–65535 的显式端口，主机须为有效域名或 IP literal；不允许 userinfo、fragment、空白、反斜杠或原始逗号（上游链用逗号分隔，参数中的逗号须编码为 `%2C`）。非法值返回 `invalid_dns_primary`，不改动原设置。所选上游排第一，其余内置上游按默认顺序排在其后作为自动 fallback；自定义 URL 后依次为 `https://1.1.1.1/dns-query`、`https://8.8.8.8/dns-query`、`8.8.8.8:53`、`1.1.1.1:53`，`auto` 直接用 kin-egress 内置顺序。DoH 经 SOCKS5 出口访问，域名由 SOCKS5 代理解析；`IP:53` 为经 SOCKS 转发的 DNS-over-TCP，出口到 DNS 服务器之间明文。变更后重载本机已绑定的 `kin-egress`，不重建槽位，响应 `egress` 数组报告各本机出口重载结果；集群节点出口在下次槽位启动 / 重载时读取新设置。本地直连出口不使用此设置。

`PUT /proxies/config` 的 `dns_disable_svcb_https` 为布尔值（默认 `false`），Web「代理 → 管理」显示「关闭 DNS type 64 / 65」开关。开启后向 SOCKS5 透明出口下发 DNS 覆写参数 `dns_empty_types: [64, 65]`：SVCB（64）和 HTTPS（65）查询返回 `NOERROR` 空答案，不访问上游；A、AAAA 等其它查询正常转发。关闭后移除覆写参数，恢复正常查询。非布尔值返回 `invalid_dns_disable_svcb_https`。保存后重载本机已绑定出口，`egress` 数组报告结果；集群出口在下次槽位启动 / 重载时生效，本地直连出口不使用此设置。

自定义 URL 必须以小写 `https://` 开头，百分号编码必须有效；域名大小写不受限制。设置会保留原 URL 字符串，不做隐式改写。

`GET /proxies` 和 `GET /proxies/config` 仅向管理员返回 `dns_primary`；租户响应省略该字段（自定义 URL 的路径 / 查询参数可能包含私有令牌），其它配置字段保持不变。

### 本地代理（每台 VPS 一条）

本地代理按机器拆分：控制面是 `px-local`，每个集群节点一条 `px-local-<节点 id>`（行上带 `node_id`；管理员另带 `node_name`，租户不返回节点名）。启用了本地代理（`px-local` 存在）后，接入节点时自动建立该节点的行，删除节点时清掉没有绑定的行；升级后首次启动会把仍挂在 `px-local` 上的节点槽迁到各自节点的行，并改写槽位记录里的 `proxy.id`，槽位所在机器的 docker 网络不变。

- **绑定**：`bind_limit` 按行计，即每台 VPS 各自计数。绑定、创建（`proxy_id`）、导入时传通用的 `px-local` 会落到槽位所在机器的那一行；把别的机器的本地代理绑给槽位返回 `local_proxy_node_mismatch`。自动分配只考虑槽位自己机器的本地代理。
- **探测**：`px-local` 仍视为直连成功；节点行按该节点的 SSH 链路判定，延迟为链路 RTT。链路不通只把该行标为 `fail`，不会禁用代理或停掉槽位调度（节点健康由集群负责）。
- **地理**：节点行经该节点本机出网查询，`px-local` 经控制面默认路由查询；节点槽的跟随时区读取它所在节点那一行的地理。

### `POST /proxies/geo` · `POST /proxies/:id/geo`

地理查询的 SOCKS5 目标域名统一由代理端解析（包括 `socks5://` 输入），避免依赖控制面的本地 DNS；IPv4 查询和 IPv6 两阶段探测使用相同策略。此规则仅作用于地理查询，不修改保存的代理 URI 或其它请求的 DNS 策略。HTTP(S) 代理和本地直连行为不变。

经该代理本身去查出口 IP 的国家 / 城市 / 时区（本地出口走宿主机默认路由）。主查询结果落在 `proxies.geo_*` 列，独立的 IPv6 公网出口探测落在 `proxies.geo_v6_*` 列；列表响应分别回显 `geo` 与 `geo_v6`。IPv6 探测先经仅 AAAA 的 IP 探针（默认 `https://ipv6.icanhazip.com`，可用 `KIN_PROXY_GEO_V6_IP_URL` 覆盖）确认出口为 IPv6，再查该地址的地理信息；探针若返回 IPv4 记 `geo_v6.error=geo_ipv6_got_ipv4`，无 IPv6 出口时记传输 / HTTP 错误，不会把 IPv4 结果写入 `geo_v6`。主查询成功后，已绑槽位在 `follow_proxy_timezone` 开启且未被手动钉住时会改用该时区；独立的 `geo_v6` 结果不覆盖它。

仅 IPv6 出口可能无法访问默认地理服务 `ip-api.com` 的 IPv4 接口。可在控制面 `.env` 设置 `KIN_PROXY_GEO_V6_LOOKUP_MODE=control-plane` 并重新创建控制面容器（直接运行时重启对应进程）：IPv6 IP 探针仍经所选代理访问（包括代理认证），只有确认 IPv6 后的地理元数据查询走控制面默认路由。此模式会向地理服务提交已确认的出口 IPv6；槽位业务流量的出口不受影响。默认值 `proxy` 保持两个阶段都经代理，IPv6 查询收到其它模式值时返回 `geo_ipv6_invalid_lookup_mode`。

启用 `control-plane` 后，主查询访问默认 `KIN_PROXY_GEO_URL` 发生传输错误时，也会尝试上述 IPv6 探测与元数据查询，成功结果写入 `geo`，因此主结果可能是 IPv6。HTTP / 服务商错误及自定义主查询 URL 不触发该回退。IPv6 元数据默认查询 `http://ip-api.com/json/{ip}?fields=...`；可用 `KIN_PROXY_GEO_V6_URL` 指定 URL，其中 `{ip}` 会替换为探针确认的地址（URL 编码）。响应必须包含相同的 IPv6（允许等价的缩写 / 展开形式）；返回 IPv4 记 `geo_ipv6_got_ipv4`，缺失或不匹配记 `geo_ipv6_ip_mismatch`，不会把控制面自身的 IP 当成代理出口。

响应 `{ proxy, geo, geo_v6, cached, timezones }`（单条）或 `{ total, results }`（批量，每项含 `geo_v6`）。错误：`404 proxy_not_found`、`502 geo_lookup_failed`（主查询失败时 HTTP 502；独立 IPv6 探测不可用时在 `geo_v6.error` 中体现，单条请求仍可能 HTTP 200）。`force: true` 忽略缓存重查。

### `PUT /proxies/:id`

可改 `host` / `port` / `username` / `password`，**按键是否存在**判定语义：不传该键 = 保持原值；传空串 = 清除（`username: ""` 会连带清掉密码）。合并后走 import 同一套 `socks5Record()` 校验。同时把该行的 `raw` 重写为 `host:port`，清掉导入时可能残留的明文密码。

另可改 `label`（面板上叫「代理名称」，trim 后最长 64 字，传空串清除，列表响应回显 `label`）。它只影响显示：**只改 `label`** 时不校验地址、不改 `raw`、不重载任何槽位，响应里 `workers` 恒为空数组。名称只存在池里：槽位接口的 `proxy.label` 和授权链接的 `proxy_hint`（`名称 · host:port`）都实时读池，不写进 `vms/<id>.json`。

代理凭据在系统里存三份（池 → `vms/<id>.json` → `worker.json`），所以本端点会对每个已绑槽位回写槽位文件并重载 worker（停调度 → reload → 恢复），reason 记为 `proxy_edit_worker_reload`。单个槽位重载失败不会让请求失败——池已经改了，回滚更乱；失败信息逐槽位放在响应里由运维决定是否重试。

响应 `{ proxy, workers: [{ vm_id, ok, error }] }`。错误：`404 proxy_not_found`、`400 invalid_proxy`、`400 no_editable_fields`、`400 invalid_label`、`400 label_too_long`、`400 password_without_username`（SOCKS5 没有只有密码的认证方式，`socks5Record()` 见用户名为空就丢弃密码，所以这个组合直接拒掉而不是静默存成「仍无账密」）。

**路由顺序**：该路由必须排在 `PUT /proxies/config` 之后（`[^/]+` 也会匹配 `config`，且两者方法相同）。实现里另加了 `(?!config$)` 负向前瞻，把这个顺序依赖写成显式约束。

### `POST /proxies/:id/reveal`

**唯一允许返回代理凭据的端点。** 响应 `{ ok, id, uri }`，`uri` 形如 `socks5://user:pass@host:port`（无账密时不带 `user:pass@`）。

只给拼好的 URI、不给分立的 username/password 字段——调用方唯一的正当用途是复制，拆开只会增加它被渲染到界面上的机会。调用方侧的对应约束：只允许写入剪贴板，不得渲染、不得存入前端状态、不得记日志。

形态对齐既有的 `POST /api-keys/:id/reveal`：POST 而非 GET（不进浏览器历史与缓存）、无请求体、无二次确认、不记审计（网关目前没有审计机制，为单个端点首创属于越界）。

与 `getProxyForVm()` 不同，本端点**不过滤** `enabled`/`status`——被禁用或已失效的代理恰恰是运维最需要读回来排查的。

> 除此之外，任何 `/api/panel/*` 响应都不得包含代理账密；`GET /proxies` 永不返回（`publicProxy()` 只吐 `has_auth` 布尔）。

sessionKey / 授权码导入必须走该槽 SOCKS5。

## 集群（SSH 节点，仅 admin；super 只读 `GET /cluster/nodes`）

控制面主动拨 SSH（出站 22），本机在 NAT 后也能接入；远端在 NAT 后时 `jump_node_id` 经已接入节点跳转。远端 Docker 走 SSH `direct-streamlocal` 转发 `/var/run/docker.sock`，dockerd 不开 TCP、远端不装 agent。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/cluster/nodes` | 节点 + `link`（`idle/connecting/ready/backoff/error`）+ `health`（SSH 往返延迟、Docker 可用性）+ `bridge` |
| GET | `/cluster/local` | 控制面自身链路：`control`（进程 / 容器 + `network_mode`、监听地址）、`nat`（直连就绪节点看到的 `$SSH_CLIENT` 作公网出口，与本机网卡比对得 `behind_nat`；同一节点回连面板端口得 `inbound`：`open/closed/loopback`）、`docker`（本机 daemon、槽容器数）。服务端缓存 30s，`?refresh=1` 强制重测。super 可读 |
| POST | `/cluster/nodes/probe` | `{ host, port, username, auth_type: key\|password, private_key?, passphrase?, password?, jump_node_id? }` → `{ host_key, docker, uname, existing_id }`，拨一次即断 |
| POST | `/cluster/nodes` | probe 同体 + `host_key_sha256`（必须，TOFU 固定）+ `host_key_alg`、`label` |
| GET / DELETE | `/cluster/nodes/:id` | 删除前不能有节点经它跳转；远端容器不动 |
| POST | `/cluster/nodes/:id/reconnect` | 清掉 `error` 与退避，立刻重连 |
| POST | `/cluster/nodes/:id/shell-ticket` | 30 秒一次性终端票据 |
| WS | `/cluster/nodes/:id/shell?ticket=&cols=&rows=` | 客户端发 `{"t":"d","d":"…"}` 输入、`{"t":"r","c":列,"r":行}` 改尺寸；服务端二进制帧为终端输出，文本帧 `{"t":"exit"\|"error"}` |
| GET | `/cluster/nodes/:id/docker/info` | 版本 / 系统 / 容器数 |
| POST / GET | `/cluster/nodes/:id/docker/install` | get.docker.com 安装并把登录用户加进 docker 组，完成后自动重连；非 root 需免密 sudo |
| GET / POST | `/cluster/nodes/:id/docker/containers` | 列表（含已停止）/ 创建并启动 `{ image, name?, ports?: ["8080:80[/udp]"], env?: ["K=v"], restart? }`，本地没有镜像先拉 |
| POST | `/cluster/nodes/:id/docker/containers/:cid/{start,stop,restart}` | |
| DELETE | `/cluster/nodes/:id/docker/containers/:cid` | 强删（含匿名卷） |
| GET | `/cluster/nodes/:id/docker/containers/:cid/logs?tail=` | `{ tty, lines: [{ stream, text }] }`，tail 1–5000 |

- 链路：keepalive 10s × 3；断开后 1s 起指数退避（±20% 抖动，封顶 60s）。**指纹不符 / 认证失败不自动重试**，停在 `error` 等人工重连。
- 凭证（私钥、口令、密码）存 `cluster_nodes`，设了 `VM2API_DB_SECRET` 即 AES-256-GCM 加密；任何响应都不回传。
- 本机 Docker 桥：每个节点在 `<data>/cluster/<id>/docker.sock`（0600）监听，`docker -H unix://…/docker.sock ps` 直接操作远端 daemon。数据目录所在文件系统不支持 unix socket（如 WSL `/mnt/*`）时设 `VM2API_CLUSTER_SOCKET_DIR`。

## 管理口（master）

常用：`GET/PUT /admin/routing`、`GET /admin/vms`、`POST /admin/vms/probe-all`、`GET /admin/usage/summary`、`GET /admin/vm/oauth`、`POST /admin/vm/oauth/refresh`、`GET/PUT/DELETE /admin/intercept/rules`。`POST /admin/models/refresh` 只读本地策略目录、回完整目录，不 hop 槽位；`GET /v1/models` 同样不 hop，但按密钥 `group_type` 过滤。`GET/POST /admin/vm/claude-code/*` 返回 410。
