# 面板 API

基址 `/api/panel`。需要**面板登录会话**或 Master `VM2API_API_KEY`。协议密钥不能调面板。信封 `{ ok, data }` / `{ ok: false, error }`。调用方应从 `data` 取业务体。

登录：`POST /api/panel/login` `{ username, password }` → token + Cookie `kin_panel_token`（7 天，HttpOnly）。`POST /api/panel/logout` 撤销。`GET /api/panel/me` → `{ user, role, views, capabilities, version }`。

`/admin/*` 仅 master / admin 角色。恢复备份期间协议口 503。

## RBAC

| 角色 | 页面 | 能力 |
|------|------|------|
| `user` | 虚拟机 / 代理池 / 密钥 / 计费 / 日志 | 只管自己的 VM、代理、key；自建配额 `vm_create_quota` 0–100；不能调度平台池 |
| `super` | 总览 / 集群 / 用量 / 日志 + 虚拟机 | 读 VM + 拨调度 / 清冷却；集群只读节点列表 |
| `admin` | 全部 | `*`。可管理用户 VM，但 admin/master **未 pin** 的 `/v1` 只打未分配平台池 |

环境变量 `VM2API_ADMIN_USER` / `VM2API_ADMIN_PASSWORD` 只在库里还没有同名用户时灌进第一个 admin；之后以 SQLite `users` 为准，面板「用户」页可增删改、改密码。密码 scrypt。不能删/停用最后一个 admin。

`vms/*.json` 的 `owner_user_id` / `origin`（`platform` \| `admin_assigned` \| `user_created`）是属主 SSOT。`PATCH /vms/:id/owner` 仅 admin。自建 VM 不能收回进平台池。

## 用户

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/users` | 列表（含 `vm_create_quota`） |
| POST | `/users` | `{ username, password, role, enabled, vm_create_quota? }` |
| PATCH | `/users/:id` | 改角色/密码/启用/配额；改密会撤销该用户其它会话 |
| DELETE | `/users/:id` | |
| PATCH | `/vms/:id/owner` | admin：`{ user_id }` 分配，`{ user_id: null }` 收回（仅 `admin_assigned`） |
| GET | `/billing` | 用户计费汇总。`from`/`until`/`group_by=vm|key`。user 隐式只看自己；admin 可 `user_id=` |


用户名 `^[a-zA-Z][a-zA-Z0-9._-]{1,31}$`，密码 8–128。`vm_create_quota` 整数 0–100，默认 0。

## 总览 / 槽位

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/dashboard` | 总览：健康、KPI、`proxy_pool`、`ops`（默认近 1h SLA/TTFT）、`billing` |
| GET | `/vms` | 列表（`has_token`、`cred_status`、`proxy_configured`、`can_import_credential`、`account_tier`、`schedule_level`、`schedule_level_mode`、`worker_credential`、Fable 轨；Claude 行 `seats_used` / `seats_max` / `seats_grace` / `queue_depth` / `conc_waiting`）；响应另带 `pool_queue: { global_queue_depth, queue_max }` |
| GET | `/pool/stream` | SSE `event: seats`，`{ seats: { [vmId]: { seats_used, seats_max, seats_grace, queue_depth, conc_waiting } }, global_queue_depth, queue_max, ts }`；缺席的 VM 表示空闲 |
| GET | `/vms/:id` | 详情 + 调度等级 + 代理健康 + `billing.today/window_5h/window_7d/by_model/usage_stats`（`usage_stats` = 近 30 个上海自然日的按日用量 + 模型 / 入站路径排名，日界同 `billing.today`） + `account.runtime_window` |
| PATCH | `/vms/:id` | 热改并发/RPM、OpenAI 会话上限、Claude 席位/配额、模型白名单、槽策略、Claude `schedule_level` 或 `timezone`（不重启槽）。`timezone` 为任意有效 IANA 名称，会钉住该槽（后续绑定不覆盖）；`timezone_follow_proxy: true` 重新跟随已绑代理的出口时区 |
| POST | `/vms/:id/probe` | 槽 SOCKS5 探官方 `/usage` + Fable（Pro 跳过 Fable） |
| POST | `/vms/:id/schedulable` | `{ schedulable }` 是否入池；不改容器 |
| POST | `/vms/:id/cooldown/clear` | 清账号/模型冷却、粘性钉和 `/usage` 429 旗标，重新入池 |
| POST | `/vms/:id/test-chat` | loopback `POST /v1/messages`，master 可钉槽；官方 CC 入站 + 4 块 system。默认 prompt `hello` |
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
| POST | `/wrap-cli/sync` | `{ ids?, restart? }` 铺到槽 `.kin`（cli-node ELF + **最新** kernel.bin + 包装器）。kernel 优先仓内二进制，不被旧母样本盖回。`restart` 默认 true，rust 槽 bounce kernel |
| POST | `/vms/:id/wrap-cli/promote` | 从该槽晋升 wrap 文件，不复制凭证/SOCKS。下次 sync 仍优先仓内最新 kernel |
| POST | `/vms/:id/wrap-cli/repair` | 单槽重装 kernel。`{ wrap, kernel }`；wrap 成功时 HTTP 200 |
| POST | `/vms/:id/start` · `/stop` | 容器生命周期。运行中容器除非显式 recreate，禁止 `docker rm -f` |
| POST | `/vms/:id/activate` | 标 active |
| POST | `/vms/:id/reset` | 销毁容器与家目录，再按原槽位重建（保留 ID/代理/种子；凭证清空） |
| POST | `/vms/:id/reset-fingerprint` | |
| POST | `/vms/:id/allocate-proxy` | 从池分配 SOCKS5 |
| POST | `/vms/:id/update-claude-code` | 410，`claude_cli_removed` |
| DELETE | `/vms/:id` | 不能删 active；只解绑本槽代理 |
| POST | `/vms/create` | 种子 VM + Claude Code home |
| POST | `/vms/import` | sessionKey 导入（必须已有 VM+代理） |
| GET | `/vms/fleet-status` | 全槽更新状态 |
| POST | `/vms/fleet-update` | 全槽 roll / 采集 |
| POST | `/vms/reconcile-fingerprints` | 用官方 `~/.claude.json` 对齐指纹 |
| POST | `/probe` | 全量额度探测 |
| GET/POST | `/health-probe` | 读/跑官方 hello 健康探测缓存 |
| GET | `/usage` | 用量汇总（含缓存 token、官方价；账号行 `credential_mode` = `oauth` / `setup-token` / `official-setup-token` / `apikey`） |
| GET | `/models` | 策略目录（不 hop worker） |
| GET | `/oauth` | 全槽脱敏 credential |

`cred_status`：`无凭证` / `可用` / `5h 警告` / `5h 限制` / `7d 警告` / `7d 限制` / `普通限制` / `不可用` / `被吊销` / `探测失败`。Fable 不可用 / 7d_oi / 家族冷却不抬账号级限制。等级：官方 `/usage` 有 Fable 模型或真实 7d_oi = Max；无 Fable 的 `plan_denied` = Pro。落盘 pro 不能盖掉 usage 里的 Fable。

`account.runtime_window`：`rate_limited_at` / `rate_limit_reset_at` / `overload_until` / `session_window_start|end|status`。

`schedule_level` 是当前有效调度等级，范围 1–10；`schedule_level_mode` 为 `manual` 或 `auto`。`PATCH {"schedule_level": 1..10}` 写入手动等级，`null` 或 `"auto"` 清除手动值。自动模式按 Claude 7D 重置剩余时间滚动分档：不足 24h 为 7，之后每 24h 降一级，144h 及以上或无有效重置时间为 1。Claude 同等级内按 `routing.pool.strategy`（`balanced` / `fill`）开新席位；`weight` 只用于 Codex 选槽，与调度等级无关。

### 平台独立的槽位限额

`max_concurrency` / `max_rpm` 传数字钉住本槽，传 `null` 清除覆盖并立即使用本平台全局值。Claude 跟随 `tiers`；OpenAI 跟随 `codex.quota`，不受 Claude 分档保存影响。

OpenAI 另支持 `PATCH {"max_sessions": 0..256 | null}`：数字钉住活跃对话窗口上限，0 = 不限；`null` 立即恢复跟随并继续随后续全局保存更新。窗口闲置保留沿用 5 分钟，不是 Claude 席位或 sticky TTL。新增对话受上限约束，已存在的对话可复用窗口；借用其它账号执行不重复占用该对话的归属窗口。

列表/详情的 OpenAI 行返回 `max_concurrency`、`max_rpm`、`max_sessions`，对应来源标记 `concurrency_override`、`rpm_override`、`max_sessions_override`；`scheduling_inherited` 给出清除覆盖后的值。`inflight` / `rpm` 来自 OpenAI 执行运行态，`session_active` / `session_max` 来自对话窗口；`session_slots`、Claude `quota_policy` / `quota_inherited` 为 `null`。

`openai_quota_policy` 是 OpenAI 的独立生效视图：5 个额度字段、`concurrency_override` / `rpm_override` / `sessions_override`、`reason` 和 `restricted_until`（毫秒或 `null`）。`availability` 使用相同实时策略，不套用 Claude 闸线；缺失用量不伪造百分比，未知本地软闸重置时间保持 `null`。此字段在 Claude 行为 `null`。

Claude PATCH `max_sessions` 返回 400 `claude_max_sessions_forbidden`；OpenAI PATCH `session_slots` / `quota_override` 分别返回 400 `gpt_session_slots_forbidden` / `gpt_quota_override_forbidden`。非法新限额返回 400 `invalid_scheduling_value`。混合字段先校验，再写入，拒绝的字段不会使同一请求中的其它限额部分生效。

`POST /vms/create` 指定 `platform: "openai"`，省略并发/RPM/会话上限即跟随已保存的 OpenAI 全局值；显式值钉住本槽。OpenAI 凭证导入/重导入保留既有覆盖和权重，未覆盖字段采用当前 OpenAI 全局值；不新增跨平台切换入口。


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
| POST | `/model-policy/sync-worker` | 只同步本地策略缓存，不 hop 烧票 |
| POST | `/model-policy/sync-codex` | 经 GPT OAuth 槽 SOCKS 拉 ChatGPT 模型目录并入矩阵。票过期时用 refresh_token 换一次新 access，写入 `codex-credentials.json`。无 Codex 槽 400 `no_codex_slot`。 |

`catalog_mode`：`policy_only`（默认，控制台 #/models 即目录）/ `worker_intersect_policy` / `worker_only`。矩阵行可改 `betas.pass_context_1m`、thinking 策略、`max_tokens_cap`。

## 路由 / 设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/routing` | sticky / pool / failover / Claude 并发与 `tiers` / OpenAI `codex.quota` / 额度 / logging / `compatibility` / `official_cc` / `health_probe` |

`PUT` 热更新。`tiers` 必须回传：该块是整体替换而非 patch，缺字段即置空。Claude 分档保存只传播到未手动覆盖的 Claude 槽。OpenAI `codex.quota` 按字段合并，不覆盖其它 Codex 协议/客户端配置，只更新跟随的 OpenAI 限额。

`compatibility.persona_preset`（`official` / `official_full` / `zero` / `custom`）和 `compatibility.cache_ttl`（`5m` / `1h`）保存后投影到每个 Claude 槽的 `vms/<id>/run/kernel.json`：`persona_preset`、`system_layout`（`zero`→`zero`，其余→`identity`）、`default_cache_ttl`。响应 `kernel_persona.updated` 是本次字节有变化的槽数。`PATCH /vms/:id` 的 `timezone` / `timezone_follow_proxy` 另把 `timezone` 热写进该槽 `kernel.json`，`timezone_sync.kernel_hot` 表示文件有变化。容器 `TZ` 不在这次写入里。Codex 槽不写。

`compatibility.agent_standing`（字符串，≤2000）与四个按档布尔 map `agent_standing_presets` / `agent_standing_hide_presets` / `persona_env_presets` / `persona_hide_presets` 控制常驻约束、约束遮罩、Environment 和整档 usage 遮罩，不投影到 `kernel.json`，Node 每次请求热读。`GET /api/panel/persona/preview-vars?timezone=<IANA>` 返回 system提示词页预览用的真实模板常量（身份句、官方 agent 全文、按该时区渲染的 Environment），不含 billing；时区非法或缺省按 UTC。

`agent_standing_presets` 缺 map/key 默认关闭，只有显式 `true` 启用；`agent_standing` 内置文本保持不变。约束遮罩与 Environment 开关缺省仍为开启，整档遮罩仍回落既有模板/旧设置。保存显式开启的档位不改变其他缺省关闭的档位。

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

`codex.quota` 为 `null`、数组、未知字段、字符串数字或超范围值，返回 400 `invalid_openai_quota`，消息定位字段，校验失败前不落盘。新增限额不接受 OpenAI 并发 0；历史存储 0 仍按原有效值 2 执行和展示。

旧配置缺少自有 `codex.quota` 时，启动迁移先保存 OpenAI 槽的有效非默认值为覆盖，再原子保存规范化 routing；重启/中断续跑保持幂等。既有异常大对话上限保留为历史本槽值，不截断。升级前备份 routing 与 VM 记录；代码回退不自动恢复旧配置语义。不要用仓内默认配置覆盖部署上的 routing/VM/凭证数据。

控制台账号池、配额、粘性均采用摘要→配置弹窗：取消/Escape/外部关闭丢弃弹窗临时改动；“应用到草稿”只合并该弹窗的字段，“保存”才持久化全局设置。保存失败保留草稿。配额切换平台保留双方草稿；VM 调度弹窗直接 PATCH，本槽保存独立于全局保存。Sticky 开关/TTL/出站 session 由两个平台共享，Claude 席位与 OpenAI 对话窗口不共享容量。


## 蒸馏拦截

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/distill` | 协议入口蒸馏拦截。命中后返回 `error` 里配置的状态和 code（默认 HTTP 403，`code=distill_blocked`，文案 `不允许蒸馏`），不 hop 凭证 |

`PUT` 热更新 `src/config/distill-rules.json`。字段：`enabled`、`skip_official`（官方 Claude Code 放行其它针）、`skip_zero`（`persona_preset/inject=zero` 放行其它针）、`error.{status,type,code,message}`、`needles[]`、`patterns[]`、`fingerprints[]`、`structure.{min_max_tokens,require_no_tools,require_single_turn}`。`patterns` 是正则，和 `Memory-stage-one extractor` / `MUST distill` / `MUST extract durable memory` 一样是硬拦截：官方、0 注入、面板删掉也会补回，命中即 403，不 hop。覆盖蒸馏（knowledge/model distillation，不含化学 distill）和提取思维链（extract/dump chain-of-thought、提取/蒸馏思维链）。**不含**单独的 `Persistable response items`（普通 agent 信封）。仅 admin。

## 拒答缓存

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/refusal-guards` | 精确指纹，以及可选的用户正文近似（`similarity_enabled`，`similarity` 为 80/85/90/95，默认开、90）。命中 HTTP 503，`code=refusal_guard`，不 hop。相似度只比用户正文。`device_block_enabled` 默认开：命中后永久封禁入站 device id。响应带 `devices` |
| DELETE | `/refusal-guards/:fingerprint` | 删除一条 64 位 hex 指纹 |
| DELETE | `/refusal-guards` | 须 `{ "confirm": true }` 清空 |
| DELETE | `/refusal-device-blocks` | `{ "device_id" }` 解封一条；`{ "confirm": true }` 清空。空 device、短于 8 字符的值不会入库 |

`PUT { enabled }` 写入 SQLite `settings.refusal_guard_enabled`。环境变量 `REFUSAL_GUARD=0` 仍强制关闭。与蒸馏拦截独立：0 注入跳过普通蒸馏针，本缓存仍生效。`count_tokens` 同样在 peek / worker hop 之前拦截。device 取入站 `metadata.user_id.device_id`，否则显式 `device_id` / `x-kin-device-id`，不用 IP、UA 或 API key。仅 admin。

## 决策模型与硬正则

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/jev-intercept` | 协议入口。顺序：蒸馏硬规则 → 去掉 reminder、按需展开 base64 后的硬正则 → 拒答缓存 → 决策模型。没配地址则跳过模型；模型失败默认放行 |

`PUT` 写入 SQLite `settings.jev_intercept`。字段：`enabled`（默认关）、`hard_regex_enabled`（默认开）、`provider`（`jev` 默认、`laya`、`modernbert`）、`base_url`、`model`、`timeout_ms`（200–8000，默认 2000）、`patterns[]`、`api_key` 或 `api_keys`（最多 8 把）、`question_ids`（题库 id，缺省为全部）。省略密钥保持原值；`api_key: ""` 或 `api_keys: []` 清除。另有 `safety_instruction`（空则不加自定义题）、`safety_threshold`（0–1，默认 0.5）、`block_if_below`（默认开）、`fail_open`（默认开）、`dedup_sec`（0–3600，默认 60）、`max_state_chars`（256–64000，默认 16000）、`expand_base64`、`strip_reminders`（后两个默认开）。GET 不回密钥，回 `api_key_set`、`api_key_count`、`question_bank`、`providers`、`builtin_patterns`。

三个后端走同一套 `/v1/systemone`。题库存在 `questions`：可增删改，缺省是内置六题（综合、色情、破限、逆向、渗透、网络攻击）。每题都是「是否安全」，高分表示安全，启用的题目一起问，任一题低于阈值就拦。`safety_instruction` 非空时再多问一题自定义要求。`POST /jev-intercept/models` 用地址和 Key（留空则用已存的第一把）请求 `{base}/v1/models`，失败回 502，不会把上游 401 当成面板登出。

内置正则覆盖 NSFW、蒸馏、破解、破限，面板删不掉。比较的是用户正文。命中硬正则或模型返回 HTTP 403 `policy_blocked`，不 hop；拒答守卫开启时写入拒答缓存，并在 device 封禁开启时封禁入站 device id。上游 `content_policy` / `content_filter` / `cyber_policy` / `moderation_blocked` / `safety_violation` / `usage_policy` 同样入库。仅 admin。


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

创建密钥只在响应里明文出现一次。存储为 HMAC 索引。`group_type` 为 `all`（默认，全局可调度）、`anthropic` 或 `openai`。后两个必须带 `allowed_vms`（该平台的 VM id，可多台）。缺字段的旧密钥视为 `all`。`GET /api-keys/:id/stats` 是该密钥近 30 天用量：上海日桶、模型分布、VM 分布。不是 VM 的上游额度窗口。

attempts：每次选中的 VM/账号、错误域、cooldown、提交边界、终态。`normal` 摘要；`debug` 另存脱敏 body。`X-Request-ID` 回写。`X-Kin-Debug` / `X-Kin-Log` 可单请求覆盖。

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

### `POST /proxies/geo` · `POST /proxies/:id/geo`

经该代理本身去查出口 IP 的国家 / 城市 / 时区（本地出口走宿主机默认路由）。IPv4 结果落在 `proxies.geo_*` 列，IPv6 公网出口落在 `proxies.geo_v6_*` 列；列表响应分别回显 `geo` 与 `geo_v6`。IPv6 探测先经仅 AAAA 的 IP 探针（默认 `https://ipv6.icanhazip.com`，可用 `KIN_PROXY_GEO_V6_IP_URL` 覆盖）确认出口为 IPv6，再查该地址的地理信息；探针若返回 IPv4 记 `geo_v6.error=geo_ipv6_got_ipv4`，无 IPv6 出口时记传输 / HTTP 错误，不会把 IPv4 结果写入 `geo_v6`。单条 IPv4 成功后，已绑槽位在 `follow_proxy_timezone` 开启且未被手动钉住时会改用该时区（仍跟随 IPv4 出口时区，不用 IPv6 覆盖）。

响应 `{ proxy, geo, geo_v6, cached, timezones }`（单条）或 `{ total, results }`（批量，每项含 `geo_v6`）。错误：`404 proxy_not_found`、`502 geo_lookup_failed`（IPv4 查询失败时 HTTP 502；IPv6 不可用时在 `geo_v6.error` 中体现，单条请求仍可能 HTTP 200）。`force: true` 忽略缓存重查。

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

常用：`GET/PUT /admin/routing`、`GET /admin/vms`、`POST /admin/vms/probe-all`、`GET /admin/usage/summary`、`GET /admin/vm/oauth`、`POST /admin/vm/oauth/refresh`、`GET/PUT/DELETE /admin/intercept/rules`。`POST /admin/models/refresh` 与 `GET /v1/models` 一样只读本地策略目录，不 hop 槽位。`GET/POST /admin/vm/claude-code/*` 返回 410。
