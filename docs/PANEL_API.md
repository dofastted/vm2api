# 面板 API

基址 `/api/panel`。需要**面板登录会话**或 Master `VM2API_API_KEY`。协议密钥不能调面板。信封 `{ ok, data }` / `{ ok: false, error }`。调用方应从 `data` 取业务体。

登录：`POST /api/panel/login` `{ username, password }` → token + Cookie `kin_panel_token`（7 天，HttpOnly）。`POST /api/panel/logout` 撤销。`GET /api/panel/me` → `{ user, role, views, capabilities, version }`。

`/admin/*` 仅 master / admin 角色。恢复备份期间协议口 503。

## RBAC

| 角色 | 页面 | 能力 |
|------|------|------|
| `user` | 虚拟机 / 代理池 / 密钥 / 计费 / 日志 | 只管自己的 VM、代理、key；自建配额 `vm_create_quota` 0–100；不能调度平台池 |
| `super` | 总览 / 集群 / 用量 / 日志 + 虚拟机 | 读 VM + 拨调度 / 清冷却 |
| `admin` | 全部（不含用户管理页） | `*`。admin/master **未 pin** 的 `/v1` 只打未分配平台池 |

开源仓 **没有用户管理**。登录只用环境变量 `VM2API_ADMIN_USER` / `VM2API_ADMIN_PASSWORD` 灌进去的第一个 admin。`GET/POST/PATCH/DELETE /users` 返回 `404 not_found`。

`vms/*.json` 的 `owner_user_id` / `origin`（`platform` \| `admin_assigned` \| `user_created`）是属主 SSOT。`PATCH /vms/:id/owner` 仅 admin。自建 VM 不能收回进平台池。

## 计费

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/billing` | 计费汇总。`from`/`until`/`group_by=vm|key` |

## 总览 / 槽位

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/dashboard` | 总览：健康、KPI、`proxy_pool`、`ops`（默认近 1h SLA/TTFT）、`billing` |
| GET | `/vms` | 列表（`has_token`、`cred_status`、`proxy_configured`、`can_import_credential`、`account_tier`、`schedule_level`、`schedule_level_mode`、`worker_credential`、Fable 轨） |
| GET | `/vms/:id` | 详情 + 调度等级 + 代理健康 + `billing.today/window_5h/window_7d/by_model` + `account.runtime_window` |
| PATCH | `/vms/:id` | 热改并发、模型白名单、槽策略、`schedule_level` 或 `timezone`（不重启槽）。`timezone` 为任意有效 IANA 名称，会钉住该槽（后续绑定不覆盖）；`timezone_follow_proxy: true` 重新跟随已绑代理的出口时区 |
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
| GET | `/usage` | 用量汇总（含缓存 token、官方价；账号行 `credential_mode` = `oauth` / `setup-token` / `apikey`） |
| GET | `/models` | 策略目录（不 hop worker） |
| GET | `/oauth` | 全槽脱敏 credential |

`cred_status`：`无凭证` / `可用` / `5h 警告` / `5h 限制` / `7d 警告` / `7d 限制` / `普通限制` / `不可用` / `被吊销` / `探测失败`。Fable 不可用 / 7d_oi / 家族冷却不抬账号级限制。等级：官方 `/usage` 有 Fable 模型或真实 7d_oi = Max；无 Fable 的 `plan_denied` = Pro。落盘 pro 不能盖掉 usage 里的 Fable。

`account.runtime_window`：`rate_limited_at` / `rate_limit_reset_at` / `overload_until` / `session_window_start|end|status`。

`schedule_level` 是当前有效调度等级，范围 1–10；`schedule_level_mode` 为 `manual` 或 `auto`。`PATCH {"schedule_level": 1..10}` 写入手动等级，`null` 或 `"auto"` 清除手动值。自动模式按 Claude 7D 重置剩余时间滚动分档：不足 24h 为 7，之后每 24h 降一级，144h 及以上或无有效重置时间为 1。`weight` 仍是同等级候选的平滑 WRR 比例，与调度等级无关。

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
| GET/PUT | `/routing` | sticky / pool / failover / 并发 / `tiers` / 额度 / logging / `compatibility` / `official_cc` / `health_probe` |

`PUT` 热更新。`tiers` 必须回传：`PUT` 是整体替换而非 patch，缺字段即置空。保存时按 Pro/Max 把未手动 override 的槽并发写回去。

`compatibility.persona_preset`（`official` / `official_full` / `zero` / `custom`）和 `compatibility.cache_ttl`（`5m` / `1h`）保存后投影到每个 Claude 槽的 `vms/<id>/run/kernel.json`：`persona_preset`、`system_layout`（`zero`→`zero`，其余→`identity`）、`default_cache_ttl`。响应 `kernel_persona.updated` 是本次字节有变化的槽数。`PATCH /vms/:id` 的 `timezone` / `timezone_follow_proxy` 另把 `timezone` 热写进该槽 `kernel.json`，`timezone_sync.kernel_hot` 表示文件有变化。容器 `TZ` 不在这次写入里。Codex 槽不写。

## 蒸馏拦截

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/distill` | 协议入口蒸馏拦截。命中后返回 `error` 里配置的状态和 code（默认 HTTP 403，`code=distill_blocked`，文案 `不允许蒸馏`），不 hop 凭证 |

`PUT` 热更新 `src/config/distill-rules.json`。字段：`enabled`、`skip_official`（官方 Claude Code 放行其它针）、`skip_zero`（`persona_preset/inject=zero` 放行其它针）、`error.{status,type,code,message}`、`needles[]`、`patterns[]`、`fingerprints[]`、`structure.{min_max_tokens,require_no_tools,require_single_turn}`。`patterns` 是正则，和 `Memory-stage-one extractor` / `MUST distill` / `MUST extract durable memory` 一样是硬拦截：官方、0 注入、面板删掉也会补回，命中即 403，不 hop。覆盖蒸馏（knowledge/model distillation，不含化学 distill）和提取思维链（extract/dump chain-of-thought、提取/蒸馏思维链）。**不含**单独的 `Persistable response items`（普通 agent 信封）。仅 admin。

## 拒答缓存

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/refusal-guards` | 仅缓存 `stop_reason=refusal` / refusal 块 / `finalState=content_filter`。命中后 HTTP 500，`code=refusal_guard`，不 hop。wrap `Usage Policy` 文案和信封 JSON 不会入缓存 |
| DELETE | `/refusal-guards/:fingerprint` | 删除一条 64 位 hex 指纹 |
| DELETE | `/refusal-guards` | 须 `{ "confirm": true }` 清空 |

`PUT { enabled }` 写入 SQLite `settings.refusal_guard_enabled`。环境变量 `REFUSAL_GUARD=0` 仍强制关闭。与蒸馏拦截独立：0 注入跳过普通蒸馏针，本缓存仍生效。`count_tokens` 同样在 peek / worker hop 之前拦截。仅 admin。


## 密钥 / 日志

| 方法 | 路径 |
|------|------|
| GET/POST | `/api-keys` |
| PATCH/DELETE | `/api-keys/:id` |
| GET | `/request-logs` |
| GET | `/request-logs/stats` |
| GET | `/request-logs/:request_id` |
| GET | `/request-logs/:request_id/attempts` |

创建密钥只在响应里明文出现一次。存储为 HMAC 索引。

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

`GET /request-logs/stats` 另返回 `window`：SLA、错误率、429/503、QPS/TPS、耗时与 TTFT 分位、按模型 `avg_first_token_ms`、`error_collection`。`GET /dashboard.ops` 默认近 1 小时同一形状。

筛选：`status=error`、`error_class=` = auth / request / signature / rate_limit / quota / overloaded / timeout / credential / proxy / upstream / other。每行带 `error_class` / `error_label` / `error_owner`。5h/7d/限流计入 SLA 成功。

流式 usage 由 worker SSE 校验器合并后经 trailer 回传，终态 attempt 只记一次。

## 压测 / 探针

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/test-models` | 可测模型。`vm_id` 按槽位平台过滤：GPT/Codex 只返回 `gpt-*`/`codex-*`，Claude 槽不含 GPT。`platform=openai|anthropic` 无 `vm_id` 时同样过滤。GPT 槽 `refresh=1` 经该槽 SOCKS 拉 ChatGPT `/backend-api/models` 并入矩阵，401 不换票。回包带 `platform`、`protocol`（`openai.responses` / `anthropic.messages`）、`inbound_path`。 |
| POST/GET | `/concurrent-test` | 研报压测；默认并发 10、2 轮、Opus5/Sonnet5/Fable5、预算 32000。走 `/v1` |
| GET | `/concurrent-tests` · `/concurrent-test-reports` | 历史与落盘报告（`data/loadtests/reports/`） |
| GET | `/probe-test/catalog` | 能力 / 答题用例 |
| POST/GET | `/probe-test` · `/probe-tests` | 与研报互斥 |

Claude 槽测试与能力探针走官方 CC 入站（`/v1/messages`）。GPT/Codex 槽测试走 `/v1/responses`。研报保持第三方 UA。

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

`PUT /proxies/config` 的 `dns_upstream` 是所有远程 SOCKS5 透明出口共用的 DNS 上游；支持 `https://1.1.1.1/dns-query`（默认）、`https://dns.google/dns-query`、`8.8.8.8:53`、`1.1.1.1:53`。选择 DoH 使用 HTTPS，经 SOCKS 转发；选择 `IP:53` 使用普通 DNS-over-TCP，经 SOCKS 转发，但出口至 DNS 服务器之间为明文。保存后重载已绑定的 `kin-egress`，不重建槽位；响应中的 `egress` 数组报告各出口重载结果。若更新镜像，请用面板选择并保存上游，勿依赖手改容器可写层的配置。

### `POST /proxies/geo` · `POST /proxies/:id/geo`

经该代理本身去查出口 IP 的国家 / 城市 / 时区（本地出口走宿主机默认路由）。结果落在 `proxies.geo_*` 列，列表响应的 `geo` 字段回显。单条成功后，已绑槽位在 `follow_proxy_timezone` 开启且未被手动钉住时会改用该时区。

响应 `{ proxy, geo, cached, timezones }`（单条）或 `{ total, results }`（批量）。错误：`404 proxy_not_found`、`502 geo_lookup_failed`。`force: true` 忽略缓存重查。

### `PUT /proxies/:id`

可改 `host` / `port` / `username` / `password`，**按键是否存在**判定语义：不传该键 = 保持原值；传空串 = 清除（`username: ""` 会连带清掉密码）。合并后走 import 同一套 `socks5Record()` 校验。同时把该行的 `raw` 重写为 `host:port`，清掉导入时可能残留的明文密码。

代理凭据在系统里存三份（池 → `vms/<id>.json` → `worker.json`），所以本端点会对每个已绑槽位回写槽位文件并重载 worker（停调度 → reload → 恢复），reason 记为 `proxy_edit_worker_reload`。单个槽位重载失败不会让请求失败——池已经改了，回滚更乱；失败信息逐槽位放在响应里由运维决定是否重试。

响应 `{ proxy, workers: [{ vm_id, ok, error }] }`。错误：`404 proxy_not_found`、`400 invalid_proxy`、`400 no_editable_fields`、`400 password_without_username`（SOCKS5 没有只有密码的认证方式，`socks5Record()` 见用户名为空就丢弃密码，所以这个组合直接拒掉而不是静默存成「仍无账密」）。

**路由顺序**：该路由必须排在 `PUT /proxies/config` 之后（`[^/]+` 也会匹配 `config`，且两者方法相同）。实现里另加了 `(?!config$)` 负向前瞻，把这个顺序依赖写成显式约束。

### `POST /proxies/:id/reveal`

**唯一允许返回代理凭据的端点。** 响应 `{ ok, id, uri }`，`uri` 形如 `socks5://user:pass@host:port`（无账密时不带 `user:pass@`）。

只给拼好的 URI、不给分立的 username/password 字段——调用方唯一的正当用途是复制，拆开只会增加它被渲染到界面上的机会。调用方侧的对应约束：只允许写入剪贴板，不得渲染、不得存入前端状态、不得记日志。

形态对齐既有的 `POST /api-keys/:id/reveal`：POST 而非 GET（不进浏览器历史与缓存）、无请求体、无二次确认、不记审计（网关目前没有审计机制，为单个端点首创属于越界）。

与 `getProxyForVm()` 不同，本端点**不过滤** `enabled`/`status`——被禁用或已失效的代理恰恰是运维最需要读回来排查的。

> 除此之外，任何 `/api/panel/*` 响应都不得包含代理账密；`GET /proxies` 永不返回（`publicProxy()` 只吐 `has_auth` 布尔）。

sessionKey / 授权码导入必须走该槽 SOCKS5。

## 管理口（master）

常用：`GET/PUT /admin/routing`、`GET /admin/vms`、`POST /admin/vms/probe-all`、`GET /admin/usage/summary`、`GET /admin/vm/oauth`、`POST /admin/vm/oauth/refresh`、`GET/PUT/DELETE /admin/intercept/rules`。`POST /admin/models/refresh` 与 `GET /v1/models` 一样只读本地策略目录，不 hop 槽位。`GET/POST /admin/vm/claude-code/*` 返回 410。
