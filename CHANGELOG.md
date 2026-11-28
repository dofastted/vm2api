# Changelog

## 1.4.249 — 2026-11-28 · `/system` 系统提示词页面重构为 Anthropic / Google 品牌口径

- **`/system` 页面简化重构与按需 JSON 预览（#2051）**：
  - `web/src/features/system/**` 与 `web/src/styles/index.css`：顶部品牌切换仅区分 **Anthropic** 与 **Google**，面板可见文案中不再出现内部内核代号；保存提示改为「已保存 · Anthropic/Google · …」，Google 零注入模式文案由「0提示词」改为「0注入」
  - 新增 `sliding-tabs.tsx`、`raw-json-panel.tsx`、`raw-json.ts`、`google-prompt.ts`：出站 JSON 仅在用户点击「加载 JSON 原始内容」时惰性构造，0注入模式下禁用；`cragGeminiPersonaFromCompat` 等 Google 提示词辅助函数迁入 `google-prompt.ts`
  - 仅前端改动：后端接口与 `craggemini_persona_preset` / `craggemini_system_prompt` 等字段名保持不变
- 部署说明：本次改动零数据库迁移、零后端运行时变更，仅前端静态资源；升级无需额外操作。

## 1.4.248 — 2026-11-28 · 面板「席位」统一更名为「执行位」

- **面板文案：`session_slots`「席位」统一更名为「执行位」（#2043，拆自 #1970）**：
  - `web/src/features/vm/{list-page,vm-detail-card,vm-list-table,vm-rack,vm-rack-blade,vm-scheduling}.tsx` 与 `web/src/features/settings/pool-pane.tsx` 中面板可见的「席位 / 席位上限 / 席位占用 / 席位与流量」改为「执行位」口径，并澄清「物理执行位」与「根会话（主会话）数」的说明；仅文案变更，不改任何接口字段与调度行为
- 测试对齐（#2050）：`web/src/features/vm/vm-list-table.test.tsx` 的 403 文案断言对齐 `gemini-account-status` 现行「Google 403：地区或账号受限」，修复任何改动 `web/` 的 PR 在 `ci / web tests and build` 被基线断言卡住的问题；纯测试改动，无用户可见变化
- 部署说明：本次改动零数据库迁移、零后端运行时变更，仅前端静态资源与文案；升级无需额外操作。

## 1.4.247 — 2026-11-28 · API 端点默认 `body_policy` 切为 `caller` 并修复 `/#/api` 开关即时持久化

- **API 端点 `body_policy` 默认透传调用方原始正文并修复 `/#/api` 开关持久化（#2045）**：
  - 后端 `src/lib/admin/api-endpoints.mjs`（`BODY_POLICIES` 顺位调整为 `['caller', 'persona']`）与 `src/lib/db/repos/api-endpoints-repo.mjs`（`rowEp` / `_epValues` 缺省回退）全链路将默认 `body_policy` 由 `'persona'` 切为 `'caller'`（透传调用方原始请求体，不额外注入项目 persona/system；`'persona'` 保留为显式可选）；新增 SQLite 迁移 `src/lib/db/migrations/073_api_endpoint_body_policy_default.sql` 与 PostgreSQL 迁移 `src/lib/db/pg/pg-migrations/010_api_endpoint_body_policy_default.sql`，在线幂等设置列默认值（PG `SET DEFAULT 'caller'`）并将既有 `'persona'` 行自动回填为 `'caller'`（保留 `CHECK` 约束）。
  - 前端 `web/src/features/anthropic/{index.tsx,endpoint-save.ts}` 与 `web/src/types/panel-api-endpoints.ts` 将新建草稿与 `asBodyPolicy` 默认切为 `'caller'`；已保存端点在 `/#/api` 切换「转发调用方原始正文」开关时即时下发单字段 `PATCH /api/panel/api-endpoints/:id`（`{ body_policy }`），同步更新本地 `stored.bodyPolicy` 与 React Query 缓存（`patchCachedApiEndpoint`），失败时自动回滚并提示，且与完整保存回调保持一致；补齐 `test/unit/{anthropic-console,api-endpoints,database,scheduler-m0-migrations}.test.mjs` 与 `web/src/features/anthropic/endpoint-save.test.ts`。
- 部署说明：本次改动新增 **SQLite 迁移 `073`** 与 **PostgreSQL 迁移 `010`**（在线幂等，启动控制面时自动执行），升级后会将数据库 `api_endpoints` 表中既有 `body_policy = 'persona'` 的端点行自动回填为 `'caller'`（如需项目协议注入，升级后可在 `/#/api` 手动切回 `'persona'`）；零 `deploy/payload.json`、`docker/`、`scripts/gemini-host.py`、`protofront` 或 Rust `kin-scheduler` 变更。

## 1.4.246 — 2026-11-28 · KVM 共享 Store CRAG 原子同步与回滚自愈、账号预热爬坡引擎（opt-in / M3 / PG 18）与 CRAG `3.1.26`/`3.1.27` 热修载荷钉选

- **KVM `crag-debian13` 共享 Store CRAG 版本同步与回滚自愈（#2040）**：
  - `src/lib/vm/wrap-cli-runtime.mjs` 新增 `syncSharedStoreCrag()`、`resolveSharedStoreCragCurrentDir()` 与 `sharedStoreCragWouldChange()`：先经 `verifyCragV2Tree()` 严格验签，再写入不可变版本目录 `store/crag/versions/<version>`（同版本重构建使用 `<version>-<sha8>`，不覆写运行中 KVM 正在 `mmap` 的旧二进制）并原子切换 `current`/`previous` 相对软链，接入 `materializeCragV2()` 与 `inspectKernelChanges()`。
  - `src/lib/vm/vm-runtime.mjs` 在 `buildKvmRunArgs()`、`cragCustomOsDockerMountArgs()` 及 `startVmRuntimeAdmitted()` `preserveCrag` 路径自动同步/补齐共享 store CRAG；`src/lib/vm/{kernel-install,crag-license}.mjs` 与 `src/lib/admin/kernel-catalog.mjs` 在 `restoreCragRollback()` 原子回切 `store/crag/current` 并为 `crag-debian13` 槽位透传 `allowUnbundledStore` / `sharedClaudeStoreRoot`；`src/lib/oauth/claude-auth-login.mjs` 解析真实版本目录避免传软链触发 `crag_v2_symlink`；新增 `test/unit/shared-store-crag-sync.test.mjs`。
- **账号预热爬坡引擎落地与 M3 / PG 18 全链路对齐（#1970）**：
  - 新增 `src/lib/pool/{account-warmup,warmup-monitor}.mjs` 与 `test/unit/{account-warmup,warmup-monitor}.test.mjs`，接入 `src/lib/admin/{panel-api,panel-routes,routing-runtime}.mjs`、`src/lib/oauth/import-commit.mjs`、`src/lib/pool/account-quota.mjs` 与 `src/server.mjs`：默认 `enabled: false`（opt-in），支持新导入/换绑账号自动启动预热并在稳定达标后自动毕业，保留人工覆写优先（operator-wins）生命周期。
  - 端到端对齐 M3 Rust `kin-scheduler` 与 PostgreSQL 18：启动与毕业均触发 `schedulerRuntime.syncConfigNow()` 同步 `max_rpm`，毕业经 `inheritVmScheduling(id, { rpm: true })` 恢复分档/默认限流并清除 `rpm_override=0`；日志查询改用 ISO-8601 字符串比较（兼容 PG 18）并记录结构化告警；基于 `scheduler_pools`/`scheduler_pool_members` 并在无自定义 Claude 池时覆盖默认虚拟池；统一 `withVmLock(vmPath)` 完整路径锁并接入 `stopLeaderJobs()` 与备份恢复/配置热更新生命周期。
- **CRAG `3.1.26` / `3.1.27` 热修载荷重新钉选（#2042，Fixes #2017）**：
  - `deploy/payload.json` 与 `src/lib/admin/kernel-catalog.mjs`（`CRAG_PINNED_RELEASES`）同步包含 CRAG V4 `tool_use` `handoff_complete` 热修的重传签名载荷资产大小、SHA256 与版本说明：`payload-2026.11.28-crag-3.1.27`（`crag-v2` `aa9c9c6d…`、`crag-v2.payload.enc` `c9ffa0d1…`、`manifest.json` `6b8ad1e8…`、`crag-v2-licensed-amd64.tar.gz` `168930962`/`31d94d34…`）与 `payload-2026.11.28-crag-3.1.26`（`manifest.json` `e8a6cd7e…`、`crag-v2-licensed-amd64.tar.gz` `168863735`/`cad5fe5e…`；零密钥轮换，沿用生产公钥 `9dbb4bc2…` 与载荷密钥 `835451e2…`），并同步恢复 `v1.4.245` 因远端 prerelease 更新中断的 `amd64` 控制面镜像与多架构 `latest` 发布。
- 部署说明：本次改动零新增数据库迁移，零 `docker/`、`scripts/gemini-host.py`、`protofront` 或 Rust `kin-scheduler` 变更；`v1.4.246` 完整发布 `amd64` + `arm64` 多架构控制面镜像并更新 `latest` tag，升级后自动同步热修版 CRAG `3.1.27` 载荷（面板同时支持 `3.1.26` 热修版钉选/回滚）并经 `#2040` 原子更新 `crag-debian13` KVM 共享 store `store/crag/current`；账号预热默认关闭（`routing.warmup.enabled = false`），按需开启。

## 1.4.245 — 2026-11-28 · 统一 System Prompt `PromptSpec v1` 与 CRAG `3.1.27` 载荷钉选、严格官方 CC 校验、面板凭据 SSOT、多模型健康探测及 Gemini/KVM 多项加固

- **统一 System Prompt `PromptSpec v1`、载荷钉选与 CRAG 缓存/前缀修复（#2026、#2031、#2032）**：
  - **`PromptSpec v1` 跨仓统一与载荷钉选（#2026）**：新增 `src/lib/identity/system-prompt-spec.mjs`，重构 `src/lib/identity/{crs-persona,persona-template}.mjs`、`src/lib/protocol/{crag-print-prompt,crag-whitelist,handle-protocol,kernel-request,outbound-attempt,pool-prompt-policy}.mjs`、`src/lib/admin/{kernel-catalog,panel-api,routing-runtime,vm-test-chat}.mjs`、`src/lib/scheduler/scheduler-runtime.mjs`、`src/lib/transport/{go-worker-client,proto-front-client}.mjs`、`src/lib/vm/slot-engine.mjs`、`src/config/routing.json` 及前端 `web/src/features/{pools,settings,system,vm}/*`（移除旧 `web/src/features/system/crag-print-panel.tsx`），并更新 `docs/PROTOCOL.md` / `docs/PANEL_API.md`；`deploy/payload.json` 与 `deploy/arm64-cli.json` 同步钉选 `payload-2026.11.28-system-prompt`（`kin-kernel` 与 `cli-node`）及 `payload-2026.11.28-crag-3.1.27`（零密钥轮换）。
  - **CRAG V3 尾部带缓存系统消息角色稳定（#2031，Fixes #2007）**：`src/lib/protocol/crag-print-prompt.mjs` 在 `assistant` 后存在带 `cache_control` 的 `system` 且后续为普通 `user` 时按 `flush()` 保持跨轮角色稳定，避免前缀缓存失效，保留 `tool_result` 续传与 CRAG V4 旁路。
  - **旧版 CRAG V4 4-block 缓存预算滚动兜底（#2032，Fixes #2016）**：`src/lib/protocol/crag-whitelist.mjs` 与 `src/lib/protocol/crag-print-prompt.mjs` 对 CRAG `3.1.27+`（`prompt_spec_v1`）保持零预砍、完整保留 4 个调用方断点，仅对未升级的旧版 CRAG `<= 3.1.26`（`!prompt_spec_v1` + `official_full`）预留 2 个模板断点，保障滚动升级窗口不触发 `Found 6` 400。
- **严格官方 Claude Code 校验闭环与多模型健康缓存探测（#2036、#2035）**：
  - **严格官方 Claude Code 校验与绕过收口（#2036）**：新增 `src/lib/identity/official-cc-verifier.mjs` 及 Go `protofront/internal/detect/official_cc.go`（同步 `protofront/internal/detect/detect.go`、`src/lib/identity/{claude-code-only,crs-headers,crs-persona}.mjs`、`src/lib/pool/api-protocol.mjs`、`src/lib/protocol/{anthropic-policy,handle-protocol,outbound-attempt,third-party-system,user-count-tokens,warmup-intercept}.mjs`、`src/lib/admin/health-probe.mjs`、`src/lib/transport/go-worker-client.mjs` 与 `web/src/features/settings/protocol-pane.tsx`），统一 Node 与 `protofront` 双侧官方信封校验并在直连 Tier 2e 辅助分支强制校验锚定官方 system 前缀。
  - **多模型健康缓存探测（#2035）**：`src/lib/admin/{health-probe,routing-runtime,panel-routes}.mjs`、`src/lib/protocol/handle-protocol.mjs`、`src/server.mjs`、`src/config/routing.json` 与 `web/src/features/settings/{health-pane.tsx,queries.ts}` 新增 Anthropic / OpenAI / Google 三平台独立多模型健康探测调度、按规范模型键隔离的缓存快照与面板设置，并接入 `stopLeaderJobs()` 生命周期管理。
- **面板凭据单一真源（SSOT）、ARM64 CC 引导防护与 KVM SMBIOS 转义（#2028、#2033、#2037）**：
  - **面板凭据 SSOT 与单向只读槽位投影（#2028）**：`src/lib/oauth/{oauth-credentials,official-cc-bootstrap}.mjs`、`src/lib/transport/{slot-oauth,go-worker-client,rust-kernel-supervisor}.mjs`、`src/lib/admin/{panel-api,panel-routes}.mjs`、`src/lib/cluster/{remote-fs,remote-slot-files}.mjs`、`src/lib/pool/pool-scheduler.mjs`、`src/lib/vm/slot-host.mjs`、`docker/kin-kvm/guest/kin-slot-agent`、`worker/internal/oauthcmd/oauthcmd.go` 与 `docs/OAUTH.md` 将凭据单一真源收口至控制面并单向只读投影至槽位；宿主侧加固 `test_endpoints`/URL 覆写仅由 `KIN_WORKER_TEST_ENDPOINTS=1` 门控并经 `lstat`+`O_NOFOLLOW` 校验 `worker.json`，新增 `assertSafeSlotCredentialPaths` 拒绝 `.claude`/`credentials.json` 符号链接穿越（保留 `.credentials.json` 相对软链契约）。
  - **ARM64 官方 CC 引导防护（#2033）**：`src/lib/oauth/official-cc-bootstrap.mjs` 与 `src/lib/vm/wrap-cli-runtime.mjs` 补齐跨架构仿真检测、core dump 抑制与清晰退出码错误透传。
  - **KVM SMBIOS 逗号转义与历史自愈（#2037）**：`src/lib/identity/kvm-fingerprint-uuid.mjs` 在 `joinSmbios` 中将 `,` 转义为 `,,`，并通过 `coalesceBrokenCommaParts` 幂等自愈历史未转义字段。
- **Gemini 沙箱 CA 挂载、`gemini-4-neon` `xhigh` 与 Schema / 局部 502 隔离（#2029、#2030、#2034）**：
  - **Gemini bwrap 沙箱 CA 证书只读挂载（#2029）**：`scripts/gemini-host.py` 在 `Agy.start` 与 `CragDaemonShard._start` 联网沙箱中以 `--ro-bind-try` 只读挂载各发行版公开 CA 证书信任库（排除私钥目录），并补齐 `test/unit/gemini-sandbox-apparmor.py`。
  - **`gemini-4-neon` 保留 `xhigh` `thinkingLevel`（#2030，Fixes #1975）**：`src/lib/gemini/model-catalog.mjs` 与 `src/lib/protocol/gemini-convert.mjs` 放行 `gemini-4-neon` 的 `xhigh` 思考档位，其余模型维持 clamp 至 `high`。
  - **剥离非 RE2 工具 Schema 正则与局部 `bridge_disconnected` 502 隔离（#2034，Fixes #1985）**：`src/lib/protocol/gemini-convert.mjs` 新增 `isRe2CompatibleRegex` 过滤不兼容 RE2 的 Schema `pattern` 约束（保留同名属性字段）；`src/lib/gemini/{direct-client,scheduler}.mjs` 将无 `upstream_status` 的局部 `bridge_disconnected` 502 隔离为单请求最多尝试 2 槽且不标永久不可调度，真实上游 502 维持原判定。
- 部署说明：本次改动零新增数据库迁移；`deploy/payload.json` 与 `deploy/arm64-cli.json` 已升级至 `payload-2026.11.28-system-prompt`（`kin-kernel` / `cli-node`）与 `payload-2026.11.28-crag-3.1.27`（零密钥轮换），升级控制面后将同步更新槽位内核 / `wrap-cli`（滚动窗口内未升级的旧版 CRAG `<= 3.1.26` 槽位受 `#2032` 兜底兼容）；`protofront` Go 网关（`#2036`）由控制面 Docker 镜像现编（裸机部署需同步重编），`worker/internal/oauthcmd`（`#2028`）向后兼容现役 `bin/kin-worker`；因涉及 `docker/kin-kvm/guest/kin-slot-agent`（`#2028`），合入 `main` 后将自动触发 `guest-images` 工作流刷新 `kin-kvm-*` 镜像；Gemini 宿主机需同步 `scripts/gemini-host.py`（`#2029`）并重启 `vm2api-gemini` 与 `vm2api`。

## 1.4.244 — 2026-11-28 · Codex 软限与临时停车状态接入 Rust 调度准入、存量 KVM 9p 挂载自动升级 `cache=none` 与跨类定时测试同步提示修正

- **Codex 软限与临时停车状态接入 Rust `kin-scheduler` 准入（#2009，Refs #1874）**：
  - `scheduler/crates/scheduler-proto/src/{config,ipc,lib,serde_patch}.rs` 新增 `CodexQuotaPolicy`、`ConfigSnapshot.codex_quota`、`BackendNodeConfig.temp_unschedulable_{until_ms,reason}` 与 `serde_patch::double_option`（并为 `NodeTelemetryUpdate` 的 3 个 `double_option` 字段补齐 `skip_serializing_if = "Option::is_none"`，防止局部遥测序列化为 JSON `null` 误清空停车状态）。
  - `scheduler/crates/scheduler-core/src/{admission,node_state}.rs` 与 `src/lib/scheduler/scheduler-runtime.mjs` 将 `routing.codex.quota` 软限接入 Rust `codex_vm` 准入（Claude 槽维持既有 95% 门禁）；`temp_unschedulable_*` 经配置快照（冷启动 fail-closed）与实时遥测同步，清除态显式发送 `temp_unschedulable_until_ms: 0` / `reason: null` 并置 `temp_park_live_authoritative` 避免回落旧快照；补齐 `scheduler/crates/scheduler-core/tests/admission_codex_quota_tests.rs`、`test/unit/scheduler-codex-quota-snapshot.test.mjs` 及 `scheduler-proto`/`scheduler-core`/`scheduler-daemon` 回归测试。
- **存量 legacy KVM 槽位 `kin-guest-setup` 9p 挂载自动升级 `cache=none`（#2018，Refs #1877）**：
  - `docker/kin-kvm/guest/kin-crag-apparmor` 新增 `upgrade_guest_9p_cache`，在每次内核启动前幂等改写 `#1924` 前存量 KVM 盘内 `/usr/local/sbin/kin-guest-setup` 的 `kinhome`（`/home/kincli`）与 `kinclaude`（`/home/kincli/.claude`）两行 9p 挂载参数，由 `mmap` 原子升级为 `none`（保留 `0755` 权限，下次槽位 stop/start 或 recover 生效，缓解 v9fs getattr writeback 僵尸进程）；缺失文件返回 `no-guest-setup`，符号链接或手工编辑/重复行返回 `operator-managed` 且零写盘，不影响 `crag-debian13` custom-erofs 槽位；`test/unit/kvm-crag-apparmor.test.mjs` 补充覆盖单测。
- **定时测试「同步到全部槽」确认框异类槽文案修正（#2008，Refs #1874）**：
  - `web/src/features/vm/vm-test-schedule.tsx` 更新「同步到全部槽？」`AlertDialog` 说明文案，如实告知另一类槽（Claude/Codex 不同）保留自己的模型与 Prompt，但仍同步开关、时间及本表单显式提供的运行模式与自动续热，与 `src/lib/admin/vm-test-schedule.mjs` 及 `docs/PANEL_API.md` 一致。
- 部署说明：本次改动零新增数据库迁移，零 `deploy/payload.json`、Gemini 宿主脚本或 `bin/` / `share/wrap-cli` 载荷变更；预期 **`SLOT_SYNC=skip`**，无需重启 `vm2api-gemini`。Rust `kin-scheduler` 由 `Dockerfile`（amd64）与 `deploy/Dockerfile.arm64-control`（arm64）从源码现编并经容器入口自动同步（不随 `deploy/payload.json` 或 GitHub Release 附件分发），**裸机 Node / `systemd` 宿主机重启前须先执行 `npm run build:scheduler`（需 Rust / Cargo 1.86+）** 编译安装新版 `bin/kin-scheduler`。控制面更新并重启后，`src/lib/vm/kvm-crag-apparmor.mjs` 会在下次 legacy KVM 槽启动内核前自动下发新版 `docker/kin-kvm/guest/kin-crag-apparmor` 改写旧盘脚本，存量 legacy KVM 槽待下次 stop/start 或 recover 即生效；因涉及 `docker/kin-kvm/**`，合入 `main` 后将自动触发 `guest-images` 工作流同步刷新 `kin-kvm-*` 镜像。

## 1.4.243 — 2026-11-28 · 修复 CRAG 商城直充刷新与 CRAGGemini 购买、订单台账/认领、身份迁移/重建、续费自愈及双产品订阅工作台

- **CRAG 商城代理双产品参数化与直充立即生效修复（#2022）**：
  - `src/lib/crag-shop/shop-supplier.mjs` 支持按 `pathPrefix` 参数化商城上游路由（支持 Claude CRAG 根路径与 CRAGGemini `/gemini` 路径前缀）；`src/lib/crag-shop/routes.mjs` 参数化 `ownerPrefix`、`catalogCacheKey`、`orderPathPattern`、`deviceEnabled` 并导出 `createGeminiCragShopHandler`，新增 `/api/panel/gemini/crag-shop/{catalog,orders,orders/:id,orders/:id/refresh,orders/:id/cancel}` 完整代理路由，与 Claude CRAG 目录缓存、过期轮询及激活轮询严格隔离。
  - 修复 `syncDirectCredit()` 在订单支付后直接入账时仅调只读 `status()` 未触发远端权威刷新导致页面不立即显示新额度的问题，改为调用 `subscription.status({ sync: true })` 主动同步。
  - `src/lib/admin/panel-routes.mjs`、`src/lib/admin/panel-acl.mjs` 与 `src/server.mjs` 补齐 Gemini 商城权限映射、路由挂载与 Leader 定时轮询。
- **CRAGGemini 宿主订阅订单台账、认领、迁移、身份重建与 CSRF 安全加固（#2022）**：
  - `src/lib/gemini/subscription.mjs` 修复 `migrate` 请求体携带多余 `host_id` 触发权威端 `#[serde(deny_unknown_fields)]` 拒绝的问题；新增 `purchaseDeviceId`、`orders()`、`claimByOrder()`（遇到 `host_id_collision` 自动触发一次身份重建并重领）、`migrate()`、`rebuildIdentity()`、`renewalProof()`、`redeemRenewal()` 与 `callAuthorityWithRecovery()` 结构化错误透传（含 `details: { recovery, authority_request_id }`）。
  - `src/lib/gemini/routes.mjs` 新增 `GET /api/panel/gemini/crag-subscription/orders`、`POST .../claim-by-order`、`POST .../migrate`、`POST .../rebuild-identity`，并将非 master 调用的 `sameOriginPost` CSRF 校验收口为无条件强制执行（不再依赖 `publicBaseUrl` 是否配置）。
- **前端双产品 CRAG 订阅与购买/兑换工作台（#2022）**：
  - `web/src/features/crag/crag-shop.tsx` 与 `web/src/routes/_authenticated/crag-subscription.tsx` 新增 `Claude CRAG` / `CRAGGemini` 双产品切换（支持 `?product=craggemini` 深链）、`GeminiHostSummary`、`GeminiHostOverview`、`GeminiSubscriptionView` 及主览回退展示；`web/src/features/import/gemini-environments.tsx` 增加直达购买 CRAGGemini 订阅入口。
  - `web/src/features/crag/{crag-commerce,crag-cloud-orders,gemini-redeem-dialog}.tsx` 与 `web/src/features/import/gemini-environments-queries.ts` 补齐 `GeminiHostStatus`、按产品隔离的查询键、自定义报价端点、CRAGGemini 云端订单认领与主机身份冲突一键重建交互。
- 部署说明：本次改动仅涉及控制面（`src/`）与前端（`web/src/`），零数据库迁移，零 `deploy/payload.json`、Rust `kin-scheduler`、Gemini 宿主脚本或 `bin/` / `share/wrap-cli` 变更。预期 **`SLOT_SYNC=skip`**，无需重启既有 Claude/Codex 槽位或 `vm2api-gemini`，更新并重启 `vm2api` 一次即可生效；如需启用 CRAGGemini 在线购买，需在商城侧部署支持 `CRAG_SHOP_PATH_PREFIX=/gemini` 与 `CRAG_SHOP_PRODUCT=craggemini` 的 `crag-shop` 实例并将 `/gemini/shop/*` 路由至该实例。

## 1.4.242 — 2026-11-28 · WU-3 物理机深度去虚拟化、每槽随机用户名与实时时区同步、钉死版 Linux `6.12.118-1` `prctl()` 写一次自定义内核轨与新版 `kin-computer` / `crag-debian13` 1.1.0 载荷钉选

- **WU-3 Phase A — 物理机去虚拟化、每槽随机 Linux 用户名与实时时区/预设同步（#2015）**：
  - **身份单一真源与老槽零破坏兼容**：新增 `src/lib/vm/slot-identity.mjs` 统一收口 `slotUser`/`slotHome`/`slotClaudeDir`/`slotGuestUidGid`（新建 KVM `custom-erofs` 槽 `1000:1000`，存量 `kincli` 老槽维持 `999:987` 与 `/home/kincli` 不变）及 `detectHostCpuVendor`；`workstation-fingerprint.mjs` 与 `slot-computer.mjs` 为新槽分配防碰撞随机用户名、生成剥离 `kincli` 的过滤只读 `runtime-etc/{passwd,group}`，并保护已有 `hostname`/`device_id` 的存量老槽绝不被 `rememberComputer` 篡改。
  - **定制 Debian 13 只读身份覆盖与实时热切时区**：`docker/kin-os/debian-13/Dockerfile` 与 `scripts/build-custom-debian13-os.sh` 将 `/etc/{os-release,localtime,timezone}` 及 `/usr/lib/os-release` 实体化为 `0644` 常规文件并写入镜像门控标签 `org.vm2api.regular-etc-targets=1`；`kin-guest-init` 落地 8 步无 `eval` `boot.env` 启动序列、`tmpfs /home` + 过滤 RO `/etc/{passwd,group,shadow}` 与 `dmesg_restrict=1`；`kin-slot-agent` 新增鉴权 RPC `sync_preset_tz` 以 `pwrite`+尾部 `ftruncate` 保 inode 原地刷新 `TZif` 并联动 `10-slot-preset.json`；`kin-guest-exec` 降权时清除 root `MAIL` 并从 `/etc/passwd` 反查 `USER/LOGNAME/HOME`。
  - **全链路随机用户参数化与 KVM 去虚拟化**：覆盖本地 Docker/KVM（`vm-runtime`/`slot-host`/`slot-shell`/`slot-engine`/`rust-kernel-supervisor`）、OAuth/Bootstrap/PTY（对齐 KVM `custom-erofs` Guest UID）与远端集群（按目标节点真实 UID:GID 动态渲染 `runtime-etc/{passwd,group}`）；`load-hw-plan.sh` 与 `kin-kvm-entry` 强制宿主同厂 CPUID 锁（`kvm=off,-hypervisor,-vmx/-svm` 含跨厂保护与非导出环境变量透传）、ACPI OEM 表注入、离线 `state.ext4` `boot.env`/`etc-override` 同步与 `/proc/cmdline` `kin.*` 剥离，引入 `KIN_KVM_KERNEL_TRACK=official|custom` 双轨契约（默认 `official`、远端节点锁定 `official`）。
- **WU-3 Phase B — 钉死版 Linux `6.12.118-1` `prctl()` 写一次内核轨与零 `kin` cmdline（#2019）**：
  - 新增 `patches/kernel-6.12/0001-uts-prctl-write-once.patch`（针对 Debian `linux-source-6.12=6.12.118-1` 的 `--fuzz=0` 4 文件补丁）：实现 `PR_KIN_SET_UTS_ONCE (0x564d3201)`（322B `struct kin_uts_override`，限定 `CAP_SYS_ADMIN` + `GLOBAL_ROOT_UID` + `init_uts_ns` + `init_pid_ns`，校验先于封锁后以 `atomic_cmpxchg` 永久封锁并清零尾字节），保持 `/proc/sys/kernel/{osrelease,version}` `0444` 且五处内核版本读取面 100% 字节一致。
  - 新增可复现内核构建脚本 `scripts/build-custom-debian13-kernel.sh`（内置全部 KVM/EROFS/EXT4/VirtIO/VSOCK/Overlay/nftables 驱动与 EROFS 模块版本解耦、禁用 `CONFIG_FW_CFG_SYSFS`、启用 `CONFIG_SECURITY_DMESG_RESTRICT=y`、`initrd.img-custom` 通过 `conf.d/99-kin-init` 默认引导 `kin-guest-init`）；`kin-kvm-entry` 在 `custom` 轨省略 `-append` 中的 `init=` 实现 `/proc/cmdline` 零 `kin` 字样；`scripts/fetch-payload.mjs` 与 `.github/workflows/guest-images.yml` 接入可选 `custom_kernel` 资产校验拉取与镜像构建。
- **钉选新版 `kin-computer`（38 档案）与 `crag-debian13` 1.1.0 载荷**：
  - `deploy/payload.json` 的 `release` 升级至 `payload-2026.11.28-kin-computer-2`（仅更新 `bin/kin-computer`，其余二进制与 `CRAG 3.1.26` / `CRAGGemini 0.5.4` 载荷及密钥零变更）；`crag_debian13_release` 升级至 `payload-2026.11.28-crag-debian13-1.1.0`（含新版常规 `/etc` EROFS 与可选 `custom_kernel` `vmlinuz-custom`/`initrd.img-custom`）。
- 部署说明：本次改动零新增数据库迁移、零前端或 Rust `kin-scheduler` 变更；`kin-kernel`/`cli-node`/`wrap-cli` 与 `CRAG 3.1.26`/`CRAGGemini 0.5.4` 字节均未变，既有 `wrap`/Codex/老 `kincli` 槽位预期 **`SLOT_SYNC=skip`**，无需重启既有槽位。如需在 `crag-debian13` 槽位启用新版 38 档案与随机用户名，需同步 `bin/kin-computer`、拉取最新 `kin-os-debian:13-baked`/`kin-kvm-debian:13` 镜像，并在 KVM 宿主机执行 `node scripts/fetch-payload.mjs --crag-debian13` 落盘 `share/os/crag-debian13/`（含 `vmlinuz-custom`/`initrd.img-custom`）；默认走 `KIN_KVM_KERNEL_TRACK=official`，按需设 `KIN_KVM_KERNEL_TRACK=custom` 启用定制 6.12 内核并支持秒级切回 `official`。

## 1.4.241 — 2026-11-28 · 修复 CRAG V4 与号池第三方客户端 Claude Code 格式转换（含 SQLite `072`/PG `009` 迁移与 `kin-scheduler` 默认策略）、Gemini OAuth/RT 导入格式（Format 1 & 2）与多客户端回退、`UMask=0077` 目录权限自愈、直连模型拉取、代理绑定透传及 CRAGGemini `0.5.4` `GRPC_PROXY` 载荷钉选

- **修复 CRAG V4 与 M1b/M3 号池第三方客户端 Claude Code 格式转换（#2011）**：
  - **号池提示词默认策略按提供商收口与存量幂等修复（RC-1）**：将非锁定提供商（`anthropic`/`mixed`/`api`）号池的 `system_prompt_mode` 默认值由 `'passthrough'` 收口为 `'inherit_global'`（`openai`/`google` 继续锁定 `'passthrough'`），同步覆盖 `src/lib/db/repos/scheduler-pools-repo.mjs`、`src/lib/admin/scheduler-pools-routes.mjs`、`src/lib/scheduler/scheduler-runtime.mjs`、Rust `kin-scheduler`（`scheduler-proto`/`scheduler-core`）及前端 `web/src/features/pools/{pool-rules,api}.ts`；新增纯幂等迁移 `src/lib/db/migrations/072_scheduler_pool_prompt_default.sql`（SQLite）与 `src/lib/db/pg/pg-migrations/009_scheduler_pool_prompt_default.sql`（PostgreSQL，不触碰已应用的 `071`/`008`），仅修复未手工修改的 `config_version = 1` 历史 `vm_pools` Anthropic 回填行，保留手动编辑与显式 `'passthrough'` 号池。
  - **CRAG V4/V3 官方模板占位剥离与 `append` 模式修复（RC-2）**：`src/lib/protocol/crag-print-prompt.mjs` 在 `headless_claude_bridge_v1` 的 `official_full`/`official`/`inherit_global`/`append` 路径（及旧版 V3 `official`/`append` 路径，保持 `zero_inject` fail-closed）剥离单行 `CRS_OFFICIAL_CLI_SYSTEM` 占位块，确保 CRAG V4 `wire.rs` 正常前置 `tui_system_template`，并移除 `append` 模式下阻断 `crag_persona_preset = 'official_full'` 的 `!providerCompat` 门禁。
  - **CRAG V4 第三方工具名改写与 JSON/SSE 还原（RC-3）**：`src/lib/protocol/handle-protocol.mjs` 对 `headless_claude_bridge_v1` 启用非官方工具名 `mcp__*` 改写（保持官方 CC 工具名与旧版 V3 行为不变）；`src/lib/protocol/anthropic-policy.mjs` 的 `restoreToolNamesInSSELine` 经 SSOT `restoreToolNameBlock` 完整还原 SSE 与非流式 JSON 中的 `tool_use`、`tool_search_tool_result.tool_references` 与 `tool_result.content[].tool_reference`。
  - **全局策略解析、跨池回退搬迁、自定义模板与重试头收口（RC-4）**：修复 `resolveGlobalPromptPolicy()` 与 Rust `InheritGlobal` 解析（绝不静默退化为 `Passthrough`）；按每次尝试惰性重算第三方 `system` 搬迁以兼容跨池回退（CRAG、`cli-hop`、HTTP OAuth）；自定义 CRAG `persona_templates` 的 `caller_system` 块搬迁至 `messages[0]`（`<system-reminder>`）避免泄漏至 `crag_prompt.blocks`；`crag_env` 门禁按 `effectiveCliPersona` 收口（`zero_inject`/`passthrough` 不注入）；非透传 CRAG V4 重试（`repaired`）剥离客户端原始 `anthropic-beta` 与伪造 `user-agent`。
- **Gemini 宿主机 `UMask=0077` 权限自愈、多客户端 RT 导入与直连模型拉取（#2010）**：
  - 修复 `scripts/gemini-host.py` 在 `UMask=0077` 下将新建槽位/导入配置目录创建为 `0700` 的问题：在 `create` 与 `_write_imported_profile` 后显式 `.chmod(0o711)`，并在启动加载、`operation_account`、`refresh_account`、`pull_models` 与 `Agy.start` 路径自动自愈既有 `0700` 目录；始终写入 `cache/onboarding.json`（`0600`、slot `uid:gid`）并同步至 headless/daemon 分片，新建槽位同步回填 `call_models` 与 `project_id`。
  - `scripts/gemini_host_account.py` 补齐第 3 套内置 `agy` OAuth 客户端（`antigravity_enterprise`）并支持 `oauth_client_key` 优先、遇到 `invalid_grant` 时跨客户端自动回退、常规 `oauth`/`oauth-models` 刷新透传 `oauth_clients`，并移除僵尸 access-only 降级。
  - `pull_models` 改为直连 Google OAuth `fetchAvailableModels`（`POST daily-cloudcode-pa...` 载荷 `{}` + 回退端点），直接持久化 `call_models` 并返回真实非 502 错误码；`bind_proxy` 保留 `_runtime_proxies`，`CragDaemonShard` 跟踪 `egress_options` 且不破坏 CRAGGemini `#[serde(deny_unknown_fields)]` 约束。
- **Gemini 控制面与面板导入、代理绑定及模型错误透传（#2010）**：
  - `src/lib/gemini/oauth-import.mjs`、`src/lib/gemini/routes.mjs` 与前端 `web/src/features/import/{gemini-account-import.ts,gemini-environments.tsx}` 全面支持 Format 1（裸数组 `[{ email, refresh_token }]`）与 Format 2（`{ schema_version: 2, accounts: [{ email, refresh_token, oauth_client_key, is_gcp_tos, project_id }] }`），支持多账号单选与一键批量导入。
  - `PUT /api/panel/gemini/environments/:id/proxy` 经 `proxyEgressOptionsFor` 透传 `egress_options`；前端 `isGeminiProxy` 与后端 `proxyFor` SSOT 对齐并更新 `SOCKS5 / HTTP` 代理文案；`POST .../models` 维持 `HOST_ERRORS` 安全白名单同时精确映射未编码 `401`/`403`/`429` 并投影 `call_models` / `models`。
- **CRAGGemini `0.5.4` 延续签名载荷钉选（#2010，`dofastted/antigravity-cli-proxy#24`）**：
  - `deploy/payload.json` 的 `geminiDefaultLinuxAmd64` 升级至 `payload-2026.11.28-gemini-0.5.4`（零密钥轮换，沿用现役 `issuer_public_key_id=f9572077…` / `payload_key_id=d2470877…`），在 `LocalProxyBridge` 导出 `GRPC_PROXY`/`grpc_proxy` 并修复 IPv6/SOCKS5/HTTP 代理转发边界。
- 部署说明：本次改动新增幂等数据库迁移 SQLite `072_scheduler_pool_prompt_default.sql` / PostgreSQL `009_scheduler_pool_prompt_default.sql`（在线自动执行，仅修复未手工修改的历史 `vm_pools` Anthropic 回填行）并更新了 Docker 镜像内置的 Rust `kin-scheduler`（裸机 Node/`systemd` 宿主机重启前需执行 `npm run build:scheduler`）；`release`、`crag_release`、`crag_debian13_release` 与 `bin/` / `share/wrap-cli` 相对 `1.4.240` 未变，预期 **`SLOT_SYNC=skip`**，无需重启既有 Claude/Codex 槽位，重启 `vm2api` 一次即可生效。Gemini 宿主机需同步 `scripts/gemini-host.py`、`scripts/gemini_host_account.py` 与 `scripts/gemini-host-egress.sh`，切换至 CRAGGemini `0.5.4` 载荷后重启 `vm2api-gemini` 与 `vm2api`（既有 `0700` 环境目录会在重启/操作时自动自愈为 `0711`）。

## 1.4.240 — 2026-11-28 · CRAG V4 3.1.26 与 `crag-debian13` 定制系统/KVM EROFS 底座、导入流程接入与槽位占用提示、新版 `kin-computer` 载荷钉选及 M3 调度器 V4 能力投影

- **CRAG V4 `3.1.26` 延续签名载荷与协议桥接增强（#2004，`dofastted/crag#37`）**：
  - `deploy/payload.json` 的 `crag_release` 升级至 `payload-2026.11.28-crag-3.1.26`（零密钥轮换，沿用现役 `issuer_public_key_id=9dbb4bc2…` / `payload_key_id=835451e2…`，支持 `headless_claude_bridge_v1`、`pr_set_dumpable_v1`、`vsock_transport_v1`、`count_tokens_v1`、`prompt_replace_empty`），并同步注册至 `src/lib/admin/kernel-catalog.mjs`（CRAGGemini 维持 `payload-2026.11.27-gemini-0.5.3`）。
  - 合入 `opt2a-bridge` 严格透传（`crag_strict_passthrough`）、官方响应头/错误体透传、面板自定义系统模板直接替换、动态官方 `claude` 版本校验桥接与 `/v1/messages/count_tokens` 直通 `kernel.sock` 能力；对齐 M1b/M3 号池提示词策略回退（`zero_inject` / `override` / `passthrough`），确保 `headless_bridge` 回退至直控池时使用未搬迁的 `preRelocateBody`。
- **`crag-debian13` 定制 Debian 13 底座、KVM `custom-erofs` 代理/OAuth 闭环与新版 `kin-computer` 载荷钉选（#2004）**：
  - 新增 `docker/kin-os/debian-13/`（`kin-os-debian:13-baked`，统一 glibc 2.41、只读 `/opt/kin/store` 与 `managed-settings.json` 基线）、`docker/kin-kvm/` `custom-erofs` 直启 + vsock + `kin-slot-agent`（零 systemd/AppArmor 依赖，覆盖代理、OAuth、CRAG 订阅与 `restart_crag`）、原子 A/B 更新模块 `src/lib/vm/claude-store-updater.mjs` 与底座构建/脱敏校验脚本 `scripts/{build-custom-debian13-os.sh,verify-os-image-secrets.mjs}`。
  - 更新 `.github/workflows/guest-images.yml` 自动发布 `ghcr.io/${owner}/kin-os-debian:13-baked` 与 `ghcr.io/${owner}/kin-kvm-debian:13`（`SKIP_CLOUD_IMAGE=1`）。
  - `deploy/payload.json` 钉选新版 32 品牌 DMI/SMBIOS 单文件载荷 `release: payload-2026.11.28-kin-computer`（`bin/kin-computer`）与纯 `size+sha256` 明文底座载荷 `crag_debian13_release: payload-2026.11.28-crag-debian13-1.0.0`（`kin-kvm-debian-13.erofs`、`vmlinuz`、`initrd.img`）。
- **导入流程与建槽接入 `crag-debian13` 并明确提示「使用会占用 CRAG 槽位」（#2004）**：
  - 前端导入页「上线一台」（`web/src/features/import/onboard-flow.tsx`）、「导入 JSON 包」（`vm-package-card.tsx`）及新建槽位弹窗（`web/src/features/vm/{create-options.ts,create-vm-form.tsx}`）统一开放 `crag-debian13`，在系统选项、内联警示与右栏规格单中明确提示「使用会占用 CRAG 槽位」；选中时自动锁定 `dataplane='crag'`，OpenAI/Codex 或不支持 CRAG 的目标节点自动禁用并回落标准系统。
  - 后端 `POST /api/panel/vms/create` 与 `POST /api/panel/vms/package`（`src/lib/vm/vm-package.mjs`、`src/lib/admin/panel-routes.mjs`）统一规范化 `debian-13` → `crag-debian13`、拒绝 Codex 槽位、自动收口 `dataplane='crag'` + `v2`，并在 CRAG 授权额度不足时走 `deferredCrag` 保持 `status='stopped'` 不阻断创建。
- **M3 Rust 调度器 V4 能力投影与 `#1995` 本地 KVM 原地扩容兼容（#2004）**：
  - `src/lib/scheduler/scheduler-runtime.mjs` 接入 V4 `effectiveSlotCount` 容量模型（未 pin 的 `POST /vms/create` 默认策略自动回落 V4 容量，冷启动无内存健康缓存时回退读取磁盘 staged `manifest.json`），并向 Rust 调度器 `NodeTelemetryUpdate.runtime_capabilities` 投射 CRAG V4 与 `crag-debian13` 能力键。
  - 验证 `#1995` 本地 KVM 原地内存扩容在 `crag-debian13` `custom-erofs` 下保持 15 项硬件身份零漂移与 vsock CID 租约稳定。
- 部署说明：本次改动零新增数据库迁移（沿用 `1.4.238` 的 SQLite `071` / PostgreSQL `008`）；`deploy/payload.json` 更新了 `release`（`payload-2026.11.28-kin-computer`，仅替换 `bin/kin-computer`，`kin-kernel`/`cli-node`/`wrap-cli` 字节未变）、`crag_release`（`payload-2026.11.28-crag-3.1.26`）与 `crag_debian13_release`（`payload-2026.11.28-crag-debian13-1.0.0`），CRAGGemini 维持 `0.5.3` 不变。既有 `wrap`/Codex 槽位预期 **`SLOT_SYNC=skip`**，无需重启既有槽位；升级 CRAG `3.1.26` 可执行 `crag-update` 或在面板内核管理拉取切换；使用 `crag-debian13` KVM `custom-erofs` 槽位需先运行 `node scripts/fetch-payload.mjs --crag-debian13` 落地 `share/os/crag-debian13/` 三件套并确保宿主机已加载 `kvm` 与 `vhost_vsock`。

## 1.4.239 — 2026-11-28 · 统一调度中心 M3 全面切换与蓝绿隔离/打包补齐、钉选 CRAGGemini 0.5.3 载荷及 Gemini 403/EMFILE 修复、Codex 续热闭环、本地 KVM 槽位原地扩容与风控 UI 优化

- **统一调度中心 M3 全面切换、蓝绿隔离与出站会话账本修复（#1994、#1998、#1999、#2000）**：
  - **全数据面与面板切入 Rust `kin-scheduler`（#1994）**：新增 `src/lib/scheduler/scheduler-runtime.mjs`，将 Claude（`pool-scheduler.mjs`、`failover-runner.mjs`、`handle-protocol.mjs`）、Codex（`codex-slot-pool.mjs`、`openai-account-selector.mjs`、`handle-codex.mjs`、`responses-ws.mjs`）、API 渠道（`api-scheduler.mjs`）、Gemini（`src/lib/gemini/{scheduler,routes}.mjs`）及面板号池接口（`scheduler-pools-routes.mjs`、`panel-routes.mjs`）统一收口至 Rust `kin-scheduler` 单一选点与并发租约；同步剥离公网数据面错误响应中的内部 `DecisionExplain` 诊断细节，并按鉴权范围隔离调度 `request_id`（忽略客户端伪造 `X-Request-Id`）。
  - **蓝绿 `kin-scheduler` 按颜色隔离与 M3 打包补齐（#1998）**：`deploy/bluegreen/compose.bluegreen.yml` 补齐 `KIN_BG_COLOR`、`KIN_SCHEDULER_BIN=/opt/vm2api/image-bin/kin-scheduler` 与按 `${BG_COLOR}` 隔离的 `KIN_SCHEDULER_{SOCK,TOKEN_FILE,CAP_FILE}`，避免 standby 实例启动时找不到二进制或解绑线上活跃 leader 的调度 UDS；`package.json` 新增原子安装脚本 `build:scheduler`，`.dockerignore` 排除 `scheduler/target`，`test/deploy/smoke_arm64_image.py` 增加 `kin-scheduler` AArch64 ELF 与 `bin/` 字节一致性校验，同步更新 `docs/BUILD.md`、`docs/DEPLOY.md` 并新增 `test/unit/bluegreen-scheduler-isolation.test.mjs`。
  - **修复 Claude OAuth 出站 `session_id` 账本回归与无状态原因码映射（#2000）**：`src/lib/pool/failover-runner.mjs` 恢复向 `applyAttempt` 传递 `stickyBound` 并持久化出站 `attemptMeta.sessionId` 账本（跳过借用跳与 `slot_busy` 容量溢出，保持 Rust `kin-scheduler` 为唯一入站选点与 `SessionGate`，零双脑分叉），修复 M3 切换后 Claude OAuth 多轮对话出站会话连续性与提示词缓存失效；`src/lib/pool/schedule-state.mjs` 补齐 `runtime_missing` 及 6 项无状态原因码（`invalid_request_schema`、`thinking_incompatible`、`pre_reset_generation`、`pre_reset_started_at`、`pre_reset_probed_at`、`missing_reset_timing`）映射。
  - **33 个 M3 单元测试修复与共享 Mock 收口（#1999、#2000）**：新增统一测试辅助 `test/helpers/mock-scheduler-runtime.mjs`，修复 9 个 Gemini 单元测试（#1999，含消除 `gemini-host.test.mjs` 超时挂起）与 24 个数据面单元测试（#2000，含重写 `pool-reservation-release-race.test.mjs` 对齐 M3 异步 `selectAndReserve`）。
- **钉选 CRAGGemini `0.5.3` 载荷、Gemini 上游 403 细粒度区分与 Unix 连接池防 `EMFILE`（#1997、#1968、#1969，`dofastted/antigravity-cli-proxy#23`）**：
  - **钉选 CRAGGemini `0.5.3` 签名载荷（#1997，`dofastted/antigravity-cli-proxy#23`）**：`deploy/payload.json` 的 `geminiDefaultLinuxAmd64.tag` 升级至 `payload-2026.11.27-gemini-0.5.3`（CRAG 沿用 `payload-2026.11.27-crag-3.1.25`，零密钥轮换）。`agy acp` 默认启用 `--dangerously-skip-permissions` 与 `session/request_permission` 自动批准；`libagy_bridge.so` 新增轻量 `CRAGGEMINI_ACP_HOOK_MODE=client_mcp_only` 剥离全部 `agy` 内置工具并避免大体积客户端 MCP 目录被 20k-token 截断，同时抑制原始内置 `tool_call` SSE 泄漏并修复冷启动 ACP worker 的 5s MCP 同步等待。
  - **Gemini 上游 403 `TOS_VIOLATION` 与地区限制细粒度区分（#1968）**：`scripts/gemini_host_{account,inference,native}.py` 与 `src/lib/gemini/{direct-client,routes,scheduler}.mjs` 按 CRAGGemini 返回的 `upstream_reason` 稳定排序解析（优先识别 `TOS_VIOLATION`），将服务条款违规归类为 `gemini_account_ineligible` 与地区受限区分，并同步对齐后端与前端（`web/src/lib/gemini-account-status.ts`）排查提示文案。
  - **Gemini Unix 控制连接池上限回收与 `EMFILE`/`ENFILE` 503 透传（#1969）**：`scripts/gemini-host.py` 与 `scripts/gemini_host_native.py` 为 `_UnixConnectionPool` 增加跨路径空闲回收与全局上限（128，按最旧优先淘汰），防止许可 CLI 异常泄漏 `kernel.sock` 文件描述符；将宿主机 `EMFILE`/`ENFILE` 映射为 `503 gemini_host_resource_exhausted`（许可状态返回 `host_resource_exhausted` 而非误报 `unconfigured`），经 `src/lib/gemini/{subscription,scheduler,routes}.mjs` 全链路透传至准入与调度层，前端（`web/src/features/import/gemini-environments.tsx`、`web/src/lib/{gemini-account-status,gemini-recovery}.ts`）按宿主资源耗尽展示并隐藏误导性的座席重绑操作。
- **Codex 续热终态校验、续热认领持久化与定时检测面板模式配置（#1993、#1972、#1971）**：
  - **Codex 续热严格判 Responses 终态（#1993）**：`src/lib/admin/vm-test-chat.mjs` 与 `vm-test-schedule.mjs` 为定时续热启用 `requireCodexTerminal`，要求 Responses 2xx 流必须收到完成态终结事件（非 `completed` 终态判为 `response_not_completed` 失败），面板手工测试保留原有 `ok` 语义。
  - **#1874 自动续热周期认领持久化与门禁收紧（#1972）**：`src/lib/admin/vm-test-preheat-window.mjs`、`vm-test-schedule.mjs` 与 `src/server.mjs` 按槽持久化 `vm_test_renew_claim` 防止停机/重载重复触发同一 5h/7d 续热窗口；跳过不再消耗认领、探测失败记 `probe_unavailable`、统一实时读取全局 `routingConfig.codex.quota` 软限并遵守 `isCodexSlotParked` 门禁，门禁跳过节流不再污染 `SettingsRepo`。
  - **定时检测表单支持续热模式与自动续热同步（#1971）**：`web/src/features/vm/vm-test-schedule.tsx` 与 `src/lib/admin/vm-test-schedule.mjs` 开放 `mode` 与 `auto_renew` 面板配置，贯通单槽 PUT、按 ID / 全量同步及全局默认模板保存回显，并同步更新 `docs/PANEL_API.md`。
- **控制面本地 KVM 槽位原地扩容与风控/日志 UI 打磨（#1995、#1974）**：
  - **控制面本地 KVM 槽位原地内存扩容（#1995）**：新增 `src/lib/vm/slot-resize-local.mjs` 并接入 `src/lib/cluster/slot-migration.mjs`、`src/lib/vm/vm-runtime.mjs` 与前端 `web/src/features/cluster/{machine-detail,migrate-slot-dialog}.tsx`，支持无 `node_id` 的本地 KVM 槽位（含 CRAG 槽位）通过 `target='local'` 原地升配内存：持锁、排空、停机、旧容器改名留底、按原精确基础镜像 ID 挂载既有 qcow overlay 启动新容器并校验身份环境变量（MAC、磁盘序列号、SMBIOS、主机名、machine-id、vCPU、磁盘）一致，失败自动回滚至留底容器；跨节点远端 CRAG 槽位继续禁迁。
  - **风控拦截面板与日志详情审查卡 UI/UX 优化（#1974）**：优化 `web/src/features/risk/{index,status-panel,question-bank,refusal-settings,hits,feed,blocks,risk-policy-form}.tsx` 与日志详情 `web/src/features/logs/log-detail/summary-tab.tsx` 的信息层级、题库/拒答设置交互与风控裁决对照展示。
- 部署说明：本次改动零新增数据库迁移（沿用 `1.4.238` 的 SQLite `071` / PostgreSQL `008`）；单容器 Docker 镜像（amd64 / arm64 与 `--from-source`）会自动构建并同步 `bin/kin-scheduler`。**蓝绿部署宿主机升级前必须同步更新 `deploy/bluegreen/compose.bluegreen.yml`**（确保包含 `KIN_BG_COLOR` 与按颜色隔离的 `KIN_SCHEDULER_*`），避免 standby 找不到二进制或解绑线上 leader 的调度 UDS；**裸机 Node / `systemd` 宿主机重启前必须先执行 `npm run build:scheduler`（需 Rust / Cargo 1.86+）编译安装 `bin/kin-scheduler`**（该二进制不随 `deploy/payload.json` 或 GitHub Release 附件分发，缺失时 `/health` 仍返回 `200` 但 M3 全数据面按 fail-closed 返回 `503`）。`release`（`payload-2026.11.26-kernel-advisor-iterations`）、`crag_release`（`payload-2026.11.27-crag-3.1.25`）及 `bin/` / `share/wrap-cli` 相对 `1.4.238` 未变，预期 **`SLOT_SYNC=skip`**，无需同步槽内 `wrap-cli` 或重启既有 Claude/Codex 槽位；Gemini 宿主机需同步 `scripts/gemini-host.py`（及同目录 `gemini_host_{account,inference,native}.py`）并切换至 CRAGGemini `0.5.3` 载荷后重启 `vm2api-gemini` 与 `vm2api`。

## 1.4.238 — 2026-11-27 · 统一调度中心基建（M0–M2 与 `/pools` 工作台）、`agy` CLI 自动补丁与系统巡检、钉选 CRAG 3.1.25 与 CRAGGemini 0.5.2 载荷及 Gemini 代理/OAuth 优化

- **统一调度中心 M0–M2 与独立 `/pools` 号池工作台（#1979、#1980、#1981、#1982、#1986）**：
  - **M0 增量数据模型与身份链（#1979）**：新增纯增量迁移 `src/lib/db/migrations/071_scheduler_center.sql`（SQLite）与 `src/lib/db/pg/pg-migrations/008_scheduler_center.sql`（PostgreSQL 对等），创建 `scheduler_pools`、`scheduler_pool_members`、`api_key_pool_bindings`、`scheduler_sticky_bindings`、`scheduler_node_penalties` 并为 `api_keys` 补充池绑定列；`src/lib/db/repos/scheduler-pools-repo.mjs` 提供启动期幂等回填；完善 `src/lib/identity/identity-rewrite.mjs` 官方身份链处理。
  - **M1a 调度前统一 JEV 预检门禁（#1980）**：新增 `src/lib/protocol/unified-pre-dispatch.mjs`，统一收口 Messages / Codex / Responses WS / Gemini / `count_tokens` 全部公网入口的调度前审查，净化阻断响应并对齐 Gemini 文本提取。
  - **M1b 号池 API、Key 绑定与池级提示词路由（#1986）**：新增 `src/lib/admin/scheduler-pools-routes.mjs` 与 `src/lib/protocol/pool-prompt-policy.mjs`，补齐号池 CRUD、成员/粘性/解释接口、API Key 池绑定范围校验（`src/lib/admin/key-scope.mjs`）及 `/v1/models` 池访问过滤。
  - **M1c 前端 `/pools` 工作台（#1981）**：新增 `web/src/features/pools/*` 与路由 `/pools`、`/pools/$poolId`（列表、成员、粘性、提示词、Key 绑定、调度解释），并同步对齐 `/keys`、`/system`、`/settings`、`/vm` 及面板 ACL。
  - **M2 Rust `kin-scheduler` 核心与 UDS 桥接（#1982）**：新增 `scheduler/` Rust 工作区（`scheduler-proto`、`scheduler-core`、`scheduler-daemon`）、Node UDS 客户端 `src/lib/transport/scheduler-client.mjs`、Docker/CI 构建集成及 SIGTERM 优雅退出连接清理。
- **钉选 CRAG `3.1.25` 延续载荷（#1983）**：
  - `deploy/payload.json` 的 `crag_release` 升级至 `payload-2026.11.27-crag-3.1.25`（支持 `prompt_replace_empty`），并在 `src/lib/admin/kernel-catalog.mjs` 注册 `3.1.25`。
- **Gemini 代理与 OAuth 默认项优化（#1984）**：
  - 更新 `scripts/gemini-host.py`、`scripts/gemini-maintenance.py`、`scripts/gemini_host_account.py`、`scripts/gemini-host-egress.sh` 及控制面/前端 Gemini 路由与操作逻辑，支持从已安装 `agy` 提取默认 OAuth 凭据回退与 `/etc/vm2api/gemini-oauth.env` 注入，并修复代理连通与 ACP 环境变量传递（`dofastted/antigravity-cli-proxy#21`）。
- **`agy` CLI 资格门禁自动补丁、系统自动巡检并钉选 CRAGGemini `0.5.2` 载荷（#1990，`dofastted/antigravity-cli-proxy#22`）**：
  - 新增纯标准库 PE/ELF 补丁工具 `scripts/gemini_agy_patch.py`，针对官方 Linux `agy 1.5.9`（`39816d49…` → `bca88dab…`）执行 `O_NOFOLLOW` 4 字节门禁补丁与补丁后 SHA-256 校验（失败自动回滚）。
  - 在 `scripts/fetch-default-gemini.py`、`scripts/gemini-maintenance.py`（原子 `renameat2` 事务，回滚不重打补丁）与 `deploy/install.sh` 的安装/修复/恢复/更新流程中自动为 `agy` 打补丁并执行 `status --require-patched` 复核。
  - `scripts/gemini-maintenance.py` 启动自动巡检并新增 `agy_patch` 检查项；`scripts/gemini-host.py` 动态上报已验证 `installed_agy_sha256()` / `agy_patch_status()`；`src/lib/gemini/payload.mjs` 仅放行单向精确升级；前端 CRAGGemini 内核行新增未打补丁告警与一键「修复补丁」操作。
  - `deploy/payload.json` 的 `geminiDefaultLinuxAmd64.tag` 升级至 `payload-2026.11.27-gemini-0.5.2`（`dofastted/antigravity-cli-proxy@v0.5.2`，`adapter/lib.rs` 同时兼容官方未补丁与资格补丁 `agy 1.5.9` 摘要，`manifest.json` 锁定补丁后摘要 `bca88dab…`，零密钥轮换）。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）、数据库纯增量迁移（SQLite `071` / PostgreSQL `008`，在线无重写）、`deploy/install.sh`、`deploy/payload.json`（CRAG `3.1.25`、CRAGGemini `0.5.2`）与 Gemini 宿主/维护脚本（新增 `scripts/gemini_agy_patch.py`）；`release`（`payload-2026.11.26-kernel-advisor-iterations`）与 `bin/` / `share/wrap-cli` 相对 `1.4.237` 未变，预期 **`SLOT_SYNC=skip`**，无需执行 `wrap-cli/sync` 或重启既有 Claude/Codex 槽位，重启 `vm2api` 一次即可自动完成迁移并生效；Gemini 宿主机需同步宿主/维护脚本（含 `gemini_agy_patch.py`）并切换 `0.5.2` 载荷（自动为 `agy` 打补丁并校验）后重启 `vm2api-gemini-maintenance` 与 `vm2api-gemini`。

## 1.4.237 — 2026-11-27 · craggemini---性能优化

- craggemini---性能优化

## 1.4.236 — 2026-11-27 · 过期且刷新失败的 Claude 槽自动移出调度、CRAG v2 槽位未回收子进程可选自动维护守卫

- **过期且刷新失败的 Claude 槽移出调度与实时凭证核验（#1947）**：
  - `src/lib/pool/availability.mjs` 新增 `isAccessExpiredEverywhere()` 与 `EXPIRED_CREDENTIAL_REFRESH_FAIL`：当所有可见过期时间（调用方传入、`workerCredential.expires_at`、`vm.claude.expires_at`、`vm.expires_at`，取最晚值）均已过期且记录了真正的 OAuth 刷新失败（`refresh_failed`、`oauth_refresh_failed`、`refresh_outcome_unknown`、`invalid_refresh_token`、`credential_required`）时，`isCredentialRefreshFailed()` 判为 `无效凭证`（`credential_refresh_failed`）并经 `vmHasSchedulableCredential()` 移出调度，避免无有效令牌的槽位持续启动 CLI 静默超时并误触发「内核故障」。
  - 明确排除未触达 OAuth 的前置配置与传输类错误（`proxy_required`、`config_failed`、`worker_upgrade_required`、`upstream_transport_error`），确保代理或配置修复后槽位仍可自动恢复调度。
  - `src/lib/pool/pool-scheduler.mjs` 的 `checkEligibility()` 与 `syncQuotaSchedule()` 合并传入 `knownHealth` / `state?.worker_status` / `account.worker_status` 实时凭证快照，防止 VM 记录残留过期时间戳与 `refresh_failed` 时误拒已刷出新票的健康槽。
- **CRAG v2 槽位未回收子进程可选自动维护守卫（#1950）**：
  - 新增默认关闭的 `routing.crag_zombie_guard`（`src/lib/vm/crag-zombie-guard.mjs`、`docs/crag-gateway-zombies.md`）：按间隔通过正常槽内执行路径只读扫描 `/proc`，统计父进程为 `--gateway-worker` 的僵尸子进程（防扫描脚本自身 argv 误计）；当计数达到阈值或内核故障且槽位空闲时，每轮至多通过 `withVmLock` + `recoverSlot` 重启一个槽位。
  - `nativeKernelBusy()` 计入 CRAG v2 `idle` 热复用进程（仅 `pids.length > idle` 或 `active_requests`/`continuations`/`queued`/`active`/`waiting`/`cleaning`/`recovering` 非空时判忙）；`recoverSlot()` 新增可选 `beforeStop`、`verifyAfter` 与 `clearUnschedulable: false`，在 `HOLD_MAINTENANCE` 与 `waitForSlotDrain` 之后复检目标、调度态与原生空闲，禁止后台守卫清除既有 `unschedulable`，并在释放维护持锁前完成出口指纹校验与僵尸复扫（单次瞬态 `null` 扫描自动重试一次）。
  - 校验失败时标记 `unschedulable`（新增 `maintenance_failed`「自动维护失败」原因码）并在 `routing.notify.enabled` 开启时发送告警通知；同步补齐 `src/lib/admin/routing-runtime.mjs` 与 `src/lib/admin/panel-routes.mjs` 的 `crag_zombie_guard` 配置热更新与回滚同步。
- 部署说明：本次改动仅涉及控制面（`src/lib/`、`src/server.mjs`）与文档（`docs/crag-gateway-zombies.md`），零前端改动、零数据库迁移；`deploy/payload.json`（`kin-kernel` `b2dbec57…`、`CRAG 3.1.24`、`CRAGGemini 0.4.14`）、Gemini 宿主/维护脚本与 `bin/` / `share/wrap-cli` 相对 `1.4.235` 均未变。预期 **`SLOT_SYNC=skip`**，无需执行 `wrap-cli/sync`、无需重启 `vm2api-gemini` 或任何既有 `kin-*` 槽位，重启 `vm2api` 一次即可生效。

## 1.4.235 — 2026-11-27 · JEV 降误封热修：豁免 Claude Code `auto_mode_classifier`、内置题库 v2.1 与置信度分层封禁

- **前置审查豁免 Claude Code `auto_mode_classifier` 旁路请求**：
  - `applyProtocolIntercept` 提前识别 `classifyClaudeRequestPurpose(inbound, { officialTraffic: official })`，对 `auto_mode_classifier` 旁路安全自检请求保留既有已封禁会话/设备拦阻，但跳过 `blocked_tool`、`system_prompt_rewrite`、硬正则、拒答缓存与 JEV 评审（标记 `by: 'classifier'` /「内置分类器豁免」），与后置 `refusalSessionBlockDecision` 保持一致，避免将审查模板误判并永久封死主编码会话。
- **内置题库升级至 v2.1 并自动无感迁移**：
  - `USAGE_POLICY_INSTRUCTION` 补充豁免 Claude Code 自动安全审查模板（`<transcript>`、`err on the side of blocking`、`<block>`）与本地测试账号/密码脚本；`NSFW_INSTRUCTION` 明确放行不含露骨性内容或性器官描写的日常情感安慰与普通恋爱拥抱对话。
  - 将 `1.4.234` v2 内置文案纳入 `LEGACY_BUILTIN_INSTRUCTIONS` / `LEGACY_SAFETY_INSTRUCTIONS`，未手改面板文案升级后自动刷新生效。
- **JEV 封禁置信度分层（拦截与三振封禁解耦）**：
  - 新增 `JEV_BAN_CONFIDENCE_FLOOR = 0.25` 与 `shouldEscalateJevBan()`：单题非 `nsfw` 处于中等区间（`0.25 <= score < threshold - 0.08`）时仅返回单次 `429`（`Retry-After: 60`、`error_details.ban_skipped = 'borderline_score'`），不再永久封禁会话或累加设备违规；高置信命中（`< 0.25`）、任意 `nsfw` 命中或多题同时命中仍执行原有「封会话 + `[10, 10, 0]` 三振设备封禁」。
- 部署说明：本次改动仅涉及控制面（`src/lib/protocol/`），零数据库迁移，无前端、`bin/` 或 `deploy/payload.json` 变更。预期 **`SLOT_SYNC=skip`**，重启 `vm2api` 一次即可生效。

## 1.4.234 — 2026-11-27 · JEV 题库 v2 与分级封禁/429 伪装闭环、上游 4xx 四分桶与风控日志诊断面板、CRAG 订阅异步并发探测、Codex 用量窗口巡检、按档透传 usage 与 CRAGGemini 维护行修复

- **JEV 内置题库 v2 与会话/设备分级封禁闭环（#1958）**：
  - 升级内置三题题库（`usage_policy` / `nsfw` / `abuse`）并对未手改面板文案自动无感迁移；长文本窗口（`>= 1024`）改为头 30% + 尾 70% 首尾保留（`sliceJevState`）；硬规则新增 `[MODE: UNRESTRICTED SANDBOX]` / `clr_all_context` 越狱检测；修复降级文案误报 `密钥失效`。
  - 默认阶梯改为 `[10, 10, 0]`（支持非递减校验）；JEV 命中同步按 `sha256(principal, 'session', rootSessionId)` 严格分租永久封禁根会话（含 Claude Code 子 Agent，避免跨租户会话 DoS）并推进设备分级计数；第 1/2 次触发及 10 分钟临时封禁期间向客户端返回伪装 `429` 负载与 `Retry-After`（后台日志保留 `policy_blocked` / `refusal_guard`），第 3 次永久封禁返回 `400`。
- **后置上游 4xx 四分桶、漏网 JEV 留证与风控/日志 UI 诊断（#1959）**：
  - `classifyUpstreamError()` 精准区分 `policy` / `third_party` / `protocol` / `auth_suspect`，并引入双轨防误杀机制（JEV 全题 `>= 0.85` 首次触发 `usage_policy` 仅记精确指纹，不污染全局 MinHash 或罚设备）；仅当放行后遭上游拒答或高危 401/403 时落盘 `jev_state` 与各题安全分（`jev_score_*`、`gate_miss`、`risk_bucket`）；JEV 默认决策超时提升至 `4000ms`。
  - 风控面板补齐根会话封禁管理、可读 `identity_value` 解封弹窗、服务端 `via` 筛选、「上游漏放 / 前置拦截率」指标卡与日志详情「风控与审核裁决」对照卡。
- **CRAG 订阅状态异步并发探测与前端维护行修复（#1949、#1948）**：
  - `assertCragSubscriptionTargetAsync` 与 `countEnabledSlots`（并发上限 8、单槽报错提前终止）将 `GET /api/panel/crag-subscription` 从串行同步阻塞改为非阻塞异步探测，消除多槽宿主事件循环长时间卡顿。
  - 修复前端 CRAGGemini 内核行在首次查询取消或后端超时后永久停在「正在读取宿主状态…」的问题（新增 15s 超时 `gemini_maintenance_timeout`、`pending+idle` 自动重读与重试按钮）。
- **Codex 用量窗口巡检与按档 usage 透传（#1951、#1946）**：
  - `usageProbeMonitor` 新增 `codexUnifiedForUsageProbe` 从 `vm.codex_usage` 合成窗口视图，使 Codex 槽在 5h/7d 窗口过期后同样触发一次性 `/usage` 刷新（仍复用既有 `usage_probe.enabled` 开关）。
  - 系统提示词配置新增按档默认关闭的 `usage_passthrough_presets`（「对外完整透传 usage」）开关，开启后不扣除网关注入的人设/环境/常驻约束 token。
- 部署说明：本次改动仅涉及控制面（`src/lib/`、`src/server.mjs`）与前端（`web/src/`），零数据库迁移；`deploy/payload.json`（`kin-kernel` `b2dbec57…`、`CRAG 3.1.24`、`CRAGGemini 0.4.14`）、Gemini 宿主/维护脚本与 `bin/` / `share/wrap-cli` 相对 `1.4.233` 均未变。预期 **`SLOT_SYNC=skip`**，无需执行 `wrap-cli/sync`、无需重启 `vm2api-gemini` 或任何既有 `kin-*` 槽位，重启 `vm2api` 一次即可生效。

## 1.4.233 — 2026-11-27 · 钉选 CRAG 3.1.24 与 CRAGGemini 0.4.14 签名载荷、Gemini 粘性调度与 429/502/503 容错、409 工具续接清理及宿主机 AppArmor/KVM 文档补齐

- **钉选 CRAG `3.1.24` 与 CRAGGemini `0.4.14` 签名载荷（#1954、#1952，`dofastted/crag#34`，`dofastted/antigravity-cli-proxy#19`）**：
  - **CRAG `3.1.24`**（`deploy/payload.json` 的 `crag_release` 指向 `payload-2026.11.27-crag-3.1.24`，`src/lib/admin/kernel-catalog.mjs` 追加 `3.1.24` 并保留 `3.1.23`）：修复工具续接回合被上游拒绝（含空 `content: []` `reasoning_extraction`）后，客户端追加新用户输入触发 `409 refused_continuation_conflict` 永久死锁的问题，允许不同后续提交创建隔离快照分支；控制面 `src/lib/core/errors.mjs` 同步将终态 409 冲突标记为不可重试。
  - **CRAGGemini `0.4.14`**（`deploy/payload.json` 的 `geminiDefaultLinuxAmd64.tag` 指向 `payload-2026.11.27-gemini-0.4.14`）：上游 503 时保持 `agy` 常驻不重启，支持 429 `restart_resume` 续传。
- **Gemini 粘性调度、429/502/503 容错与定期账号状态巡检（#1952）**：
  - 复用 `StickyRouter` 实现 Gemini 粘性路由：429 先在同账号执行一次 `restart_resume` 重试，二次 429 释放粘性并切换账号；503 故障转移不触发熔断或不可调度；502 支持 `unschedulable_on_502` 开关避免 502→503 循环；全池不可调度时返回 `429 gemini_pool_overloaded`；新增定期账号状态与配额巡检及面板展示。
- **Gemini 会话冲突与宿主机安全加固收口（#1940、#1943、#1944）**：
  - **工具续接 409 冲突清理（#1944）**：`gemini_session_conflict` 时除释放粘性绑定外，同步清理 `continuationCallIds` 对应的工具续接绑定；`!sessionConflictRetried` 与 `maxAccountSwitches > 0` 门禁确保同请求重试不再复用卡住的出站会话，且 `mas=0` 场景不重试；同步修正 `RUN_ERRORS` 文案。
  - **AppArmor 与维护守护进程对齐（#1940、#1943）**：维护守护进程目录同步安装 `gemini_host_apparmor.py`；收紧 bwrap `execvp` stderr 分类正则，补齐 license-align CI 与 Biome 检查。
- **KVM 升级文档更正（#1945）**：
  - 明确 `kin-guest-setup` 升级后需按流程重建 runner 容器以使 9p `cache=none` 等来宾脚本改动生效。
- 部署说明：本次改动涉及控制面（`src/lib/`、`src/server.mjs`）、前端（`web/src/`）、`deploy/install.sh`、`deploy/payload.json`（更新 `CRAG 3.1.24` 与 `CRAGGemini 0.4.14`，沿用 `kin-kernel` `b2dbec57…`）及 Gemini 宿主/维护脚本（`scripts/gemini-host.py`、`scripts/gemini_host_account.py`、`scripts/gemini_host_apparmor.py`、`scripts/gemini_host_native.py`）；无新增数据库迁移。因 `bin/kin-kernel` 与 `share/wrap-cli/cli-node` 字节未变，预期 **`SLOT_SYNC=skip`**（无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位）；需同步更新 Gemini 宿主/维护脚本并重启 `vm2api-gemini-maintenance`、`vm2api-gemini` 与 `vm2api`。

## 1.4.232 — 2026-11-26 · Gemini 多格式 RT 导入、Ubuntu 26.04 AppArmor 托管 bwrap、409 冲突重试、代理探测错峰、Codex 续热与配额窗口修复

- **Gemini 宿主机安全与可靠性修复（#1922、#1923、#1925、#1926、#1929、#1932、#1933、#1934、#1935、#1938）**：
  - **多格式 OAuth Refresh Token 导入与宿主机探针（#1938）**：支持裸 RT、Antigravity RT 导出数组、CPA / sub2api 导出格式归一化导入；OAuth 客户端配置通过宿主机环境变量（`KIN_GEMINI_OAUTH_*`）经标准输入 JSON 注入 `gemini_host_account.py`（零硬编码、未配置时 fail-closed 返回 `oauth_client_not_configured`）。
  - **Ubuntu 26.04 AppArmor 托管 bwrap 与打包对齐（#1929、#1932）**：新增 `scripts/gemini_host_apparmor.py` 与原子安装托管 bwrap 入口，`gemini-maintenance.py` 的 `RUNTIME_FILES` 补齐 helper 打包。
  - **bwrap 沙箱故障与许可错误解耦（#1926）**：`classify_craggemini_license_cli_error` 准确区分 `gemini_sandbox_unavailable` / `gemini_sandbox_apparmor_restricted`（HTTP 503），不再误报 `license_invalid`（403）。
  - **409 会话冲突恢复与工具 schema 清洗（#1923、#1933、#1925、#1934）**：`tool_continuation_aborted` 映射为 `gemini_session_conflict`（409），清空粘性绑定（含 `mas=0` 场景）后重试一次且不记单元熔断；`gemini-convert.mjs` 去重 `required`、规避桥接层字段冲突并修复多轮 `toolSummary` 回流。
  - **并发 SOCKS 探测错峰与 `proxy_ready` 对齐（#1922、#1935）**：远端 SOCKS 探测改为串行 400ms 错峰，`proxyFor` 与代理池一致仅在行 `dead` 时标记不可用，新建/改绑严格拒绝 `fail` 状态代理行。
- **Codex 与管理台修复（#1920、#1927、#1939）**：
  - 剔除配额视图中已过期的 rate-limit 窗口读数（#1920）；Codex 续热探针读取官方 5h reset 窗口并在面板保存时保留 `preheat` / `auto_renew` 与调度模式（#1927、#1939）。
- **KVM 9p 稳定性修复（#1924、#1937）**：
  - `kinhome`/`kinclaude` 9p 挂载改用 `cache=none` 避免 `.claude.json` 写回卡死，并补充既有来宾生效步骤文档。
- 部署说明：本次改动涉及控制面（`src/lib/`、`src/server.mjs`）、前端（`web/src/`）与 Gemini 宿主及维护脚本（`scripts/gemini-host.py`、`scripts/gemini_host_account.py`、`scripts/gemini_host_apparmor.py`、`scripts/gemini_host_native.py`、`scripts/gemini-maintenance.py`）；`deploy/payload.json` 延续 `1.4.231` 钉选（`kin-kernel` `b2dbec57…`、`CRAG 3.1.23`、`CRAGGemini 0.4.13`）。从 `1.4.228` 直升时在线执行 PG `007` 增量加列迁移，需同步更新 Gemini 宿主与维护脚本并重启 `vm2api`、`vm2api-gemini` 与 `vm2api-gemini-maintenance`；`SLOT_SYNC=skip` 时不重启既有 `kin-*` 槽位。

## 1.4.231 — 2026-11-26 · Advisor 顾问用量独立计费与双库持久化、确定性 400 熔断豁免/平台归因、钉选 CRAG 3.1.23 与新版 `kin-kernel` 载荷

- **Advisor 工具 `advisor_message` 独立计费、双库持久化与全链路清洗（#1928）**：
  - **独立计费与持久化**：`src/lib/admin/pricing.mjs` 新增 `advisorCostFromUsage`，解析 `usage.iterations` 中每条 `advisor_message`（含 `5m` / `1h` 缓存写入拆分）并按各自顾问模型单价计费累加进 `total_cost` / `actual_cost` 与 API Key 扣费（任一顾问模型缺价时 fail-closed 标记 `unpriced`）；`src/lib/protocol/openai-usage.mjs` 的 `mergeUsage` 防止后续空 `iterations: []` 覆盖已有明细；新增纯增列在线迁移 SQLite `070_usage_logs_advisor_billing.sql` 与 PostgreSQL `007_usage_logs_advisor_billing.sql`（`advisor_usage` / `advisor_cost`），贯通 `request-log.mjs` 与 `usage-logs-repo.mjs` 的 `backfillMissingCosts` / `repriceRange` 幂等重算。
  - **确定性请求 Schema 400 熔断豁免与平台归因**：`src/lib/pool/upstream-error-policy.mjs` 新增 `isDeterministicRequestSchema400`，对 Pydantic / schema 确定性 400（如 `Extra inputs are not permitted`、`Input tag '...' found using 'type' does not match`、`Field required`、`Input should be` 等）返回 `reason: 'invalid_request_schema'` 并停止重试，不再计入单元熔断；`src/lib/admin/error-class.mjs` 新增 `gateway_protocol`（`owner: 'platform'`），将网关/内核引发的 `advisor_*` 协议 400 归因至平台而非 `client`。
  - **Beta 补齐与残留 `input_schema` 剥离**：`src/lib/protocol/claude-code-betas.mjs` 将 `advisor-tool-2026-03-01` 触发条件扩展至 `advisor_*` 前缀与历史 `server_tool_use`（`name='advisor'`）；`src/lib/protocol/crag-whitelist.mjs` 与 `src/lib/protocol/kernel-request.mjs` 在 CRAG 与 `cli-node` 两条入口统一剥离 `advisor_*` 工具上误带的 `input_schema`（非法 `name` / 空 `model` 仍 fail-closed 拒收），同步更新 `docs/advisor.md`。
- **钉选 CRAG `3.1.23` 与新版 `kin-kernel` 签名载荷（#1928，`dofastted/crag#33`，`dofastted/kin-kernel#1`）**：
  - **CRAG `3.1.23`**（`deploy/payload.json` 的 `crag_release` 指向 `payload-2026.11.26-crag-3.1.23`，`src/lib/admin/kernel-catalog.mjs` 追加 `3.1.23` 并保留 `3.1.22`）：合并 `3.1.22` 的 `advisor_*` 多余 `input_schema` 剥离，并在 `NativeResponses::snapshot` 按增量/去重保留 `usage.iterations`（含 `advisor_message`），防重放重复计费。固定 `rust:1-bookworm` 容器构建（最高 `GLIBC_2.34`），沿用现役生产密钥（`9dbb4bc2…` / `835451e2…`）未轮换；`crag-v2-licensed-amd64.tar.gz` `171,335,938` B / `sha256 701a1d9e…`。
  - **`kin-kernel` 新二进制**（`deploy/payload.json` 的 `release` 指向 `payload-2026.11.26-kernel-advisor-iterations`）：`Usage` 增加 `iterations`、`StreamAssembler` 通过 `ContentBlock::Raw` 保留 `advisor_tool_result` 并在 `message_delta` / `merge_usage` 保留非空 `iterations`，`api.rs` 改为合并而非覆盖 `request.betas`。`rust:1.98-bookworm` 容器离线构建（最高 `GLIBC_2.34`），`bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 为 `13,258,640` B / `sha256 b2dbec57…`（其余 11 个非 CRAG asset 不变）。
- 部署说明：本次改动涉及控制面（`src/lib/`）、数据库纯增列在线迁移（SQLite `070` / PG `007`，蓝绿无重启校验通过）以及 **`deploy/payload.json` 的 `kin-kernel` 与 `CRAG 3.1.23` pin**；前端（`web/src/`）、CRAGGemini（`0.4.13`）与 Gemini 宿主脚本相对 `1.4.230` 均未变。因 Claude `cli-node` 内核与 `CRAG` 载荷均已更新，预期 **`SLOT_SYNC=required`**（升级控制面后按需同步 `wrap-cli/sync` 及更新 CRAG 槽位内核）；Codex / Gemini 槽位不受影响。

## 1.4.230 — 2026-11-26 · 内核不再为带 type 的工具合成 `input_schema`（advisor 全链路放行）、新增 advisor 处理说明

- **`kin-kernel` 新二进制：带显式非 `custom` `type` 的工具不再被补 `input_schema`（payload pin 变更）**：
  - 内核的 `is_server_tool_type` 原是手工维护的前缀白名单（`web_search_` / `web_fetch_` / `computer_` / `bash_` / `text_editor_` / `code_execution_` / `tool_search_`），`advisor_20260301` 不在其中；而 `ToolDefinition.input_schema` 带 `#[serde(default)]`，入站缺该字段时会在反序列化阶段被合成为 `{"type":"object","properties":{}}`，序列化时又写回出站 body，上游因此拒收：`tools.N.advisor_20260301.input_schema: Extra inputs are not permitted`。改为按结构判定（只有 `custom` 工具带 `input_schema`，有显式非 custom `type` 的工具其 schema 归上游），advisor 与未来新增的工具族一并覆盖，无需每次补前缀。
  - 产物：`bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 同步为 `13,235,464` / `sha256 020d0790…9913369`；`deploy/payload.json` 的 `release` 指向新 payload release `payload-2026.11.26-kernel-advisor-schema`（仅 `kin-kernel` 相对 `payload-2026.11.25-worker-oauth-guard` 变更，其余 11 个非 CRAG asset 原样重传）。容器内离线构建（`rust:1.98-bookworm`，rustc 1.98.1），最高 GLIBC 符号 `2.34` 与上一版基准一致，两次独立构建 sha256 逐字节相同。
- **CRAG 内核白名单放行 advisor 的 `defer_loading`（#1916）**：`ADVISOR_TOOL_KEYS` 此前齐备了 `max_uses` / `caching` 这些真实流量从不发送的可选项，却漏掉 Claude Code 实际携带的 `defer_loading`（真实形状为 `{type, name, model, defer_loading}`），`pickKeys` 将其静默丢弃；该键在同文件的 `CUSTOM_TOOL_KEYS` 中早已放行。由于 beta 推导运行在清洗后的 body 上（`go-worker-client.mjs` 的 `main` 源自 `prepareCragRequest` 输出），丢键同时导致 `advanced-tool-use-2025-11-20` 不被声明，调用方要求的延迟加载两端皆失。
- **新增 advisor 工具处理说明（#1917）**：`docs/advisor.md` 记录调用方真实请求形状、白名单三条 fail-closed 校验、cli-node 与 CRAG 两条路径各自的 beta 声明来源、`advisor_tool_result.content` 的三态 union，以及已修的键集遗漏形状；挂入 `docs/README.md` 索引。
- **回退 Codex keep-alive join（#1904）**：OpenAI 的 grant 模型不需要该机制。
- 部署说明：本次改动涉及控制面（`src/lib/protocol/`）与 **`deploy/payload.json` 的 `kin-kernel` pin**；前端（`web/src/`）、数据库迁移结构、CRAG（`3.1.21`）与 CRAGGemini（`0.4.13`）payload、Gemini 宿主脚本相对 `1.4.229` 均未变。因 Claude 槽内核二进制已更新，预期 **`SLOT_SYNC=required`**：升级后需执行 `wrap-cli/sync` 使既有 Claude 槽位取到新内核（集群槽会被重建）；Codex / Gemini 槽位不受影响。

## 1.4.229 — 2026-11-26 · 加固 PostgreSQL 一键安装/迁移脚本（#1905 安全门禁与本地 URL 识别）、PG 18 调优与同步桥可观测性

- **PostgreSQL 一键安装/迁移脚本安全门禁与本地地址识别加固（#1911）**：
  - `deploy/replace-db-to-pg.sh`：新增 `verify_pg_sync_rpc_safety()`，在停止控制面或执行 SQLite → PostgreSQL 迁移前，同时校验 systemd 与 Docker 模式下的 `src/lib/db/pg/pg-sync-db.mjs` 是否包含 `#1905` 的 `PG_SYNC_PROTOCOL_ERROR` 修复，阻断在未修复的旧版控制面（`<= 1.4.226`）上盲目切换至 PostgreSQL；`--status` 输出新增 `PG 同步桥` 安全状态项；为由脚本启动的 PostgreSQL 18 容器补齐 `checkpoint_completion_target=0.9`、`max_wal_size=1GB` 与 `idle_in_transaction_session_timeout=60000` 调优参数。
  - `deploy/install.sh`、`deploy/install-pg.sh`：新增 `url_points_to_local_host()`，修正 `need_local_pg()` 与 `need_local_redis()` 此前将已指向 `127.0.0.1` / `localhost` / `::1` 的 `DATABASE_URL` / `REDIS_URL` 误判为「外部托管服务」而跳过本地依赖启动/托管的边界问题；同步更新本地脚本缓存刷新锚点（`verify_pg_sync_rpc_safety`、`url_points_to_local_host`），确保升级后自动拉取最新安装与迁移脚本。
  - `docker-compose.yml`：为 PostgreSQL 18 服务对齐 `checkpoint_completion_target=0.9`、`max_wal_size=1GB` 与 `idle_in_transaction_session_timeout=60000`。
- **PostgreSQL 同步桥运行时可观测性与异常快失败（#1911）**：
  - `src/lib/db/pg/pg-sync-db.mjs`、`src/lib/db/pg/pg-sync-worker.mjs`：`poolStats()` 新增 `stale_dropped`（陈旧回包排空计数）与 `timeouts`（同步 RPC 超时计数）指标；worker 在 `shutdown` 或 `uncaughtException` 退出前向所有已挂载 `MessagePort` 的 `SharedArrayBuffer` 置位 `signal[1] = 1` 并广播 `Atomics.notify`，让正在等待的同步调用立即失败而不空等超时。
  - 回归测试：扩充 `test/deploy/test_install_pg.py` 与 `test/unit/pg-sync-db-rpc.test.mjs`，覆盖本地/远端 URL 识别、安全门禁拦截、PG 18 调优参数、过期回包/超时计数及 worker 异常退出快失败路径。
- 部署说明：本次改动涉及控制面（`src/lib/db/pg/`）与部署脚本/编排配置（`deploy/install.sh`、`deploy/install-pg.sh`、`deploy/replace-db-to-pg.sh`、`docker-compose.yml`）；前端（`web/src/`）、`deploy/payload.json`（CRAG `3.1.21` 与 CRAGGemini `0.4.13`）、数据库迁移结构、Gemini 宿主脚本与 `bin/` / `share/wrap-cli` 相对 `1.4.228` 均未变，预期 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 Claude/Codex/Gemini 槽位，重启 `vm2api` 一次即可生效。

## 1.4.228 — 2026-11-26 · 修复 Gemini 账号导入/授权后 `UNSUPPORTED_CLIENT` 误阻断与 CRAGGemini `CRAGR1` 兑换失败

- **修复 Gemini 客户端版本标识与 `UNSUPPORTED_CLIENT`（`gemini_client_unsupported`）误阻断（#1908）**：
  - `scripts/gemini_host_account.py`：升级 `loadCodeAssist` / `onboardUser` 元数据（补齐 `ideName: "antigravity"` 与 `ideVersion: "2.35.2"`）与 Antigravity User-Agent 梯队（`antigravity/hub/2.35.2 linux/amd64`、`antigravity/2.35.2 ... google-api-nodejs-client/10.3.0` + `X-Goog-Api-Client: gl-node/22.21.1`、`antigravity/1.5.18`），命中 `UNSUPPORTED_CLIENT` 或非 200 时自动回落至 `daily-cloudcode-pa.googleapis.com`；放行存在 `allowedTiers` 的账号自动 onboarding；当 `fetchAvailableModels` 成功返回可调用模型列表时清除误报的 `client_unsupported`。
  - `scripts/gemini_host_native.py`、`scripts/gemini-host.py`：将 `EligibilityDiagnostic` 捕获的 `gemini_client_unsupported` 标记为存活就绪会话的 advisory 诊断，不再抢先杀死能正常推理的 `agy` 常驻进程，回合成功时自动清除，仅在进程真实失败或退出时按终态诊断上报 `403 gemini_client_unsupported`（地区/身份核验阻断语义保持不变）。
- **修复 CRAGGemini `CRAGR1` 兑换码兑换链路与宿主机载荷/目录初始化（#1908）**：
  - `scripts/gemini-host.py`、`src/lib/gemini/subscription.mjs`：新增无参 `ensure-payload` 控制 socket 动作（复用 `ensure_payload()` 根验签边界），当宿主机处于 `install_on_create` 尚未物化 `share/gemini/current` 时，在 `redeem` / `sync` / `recover` / `upgrade` / `bind` 遇到 `gemini_subscription_package_unready` 自动物化已暂存的签名默认载荷后再执行兑换；容器环境下优先从 `/run/crag-host-machine-id` 派生宿主机标识，对齐 Claude CRAG 订阅。
  - `web/src/features/billing/crag-shop.tsx`、`web/src/features/import/gemini-environments.tsx`：将 `gemini_subscription_package_unready`、`gemini_subscription_authority_unavailable`、`gemini_subscription_sync_pending`、`license_unconfigured` 等错误码加入 `GEMINI_FALLBACK_DISPLAYABLE_ERRORS`，不再静默吞掉 Gemini 报错而误显 Claude 的「此码不可用于本机订阅或已失效」；补齐 `crag_subscription_host_identity_unavailable` 回落，并在已激活环境详情页保留「叠加/续费 CRAGGemini 订阅」入口。
  - `deploy/install.sh`：保护非 `/opt/vm2api` 宿主安装目录，防止 `.env` 中的容器路径 `KIN_DATA_DIR=/opt/vm2api/data` 误覆盖 `vm2api-gemini.service` 的 `--crag-host-dir`。
- 部署说明：本次改动涉及控制面（`src/lib/gemini/`）、前端（`web/src/`）、`deploy/install.sh` 与 Gemini 宿主脚本（`scripts/gemini-host.py`、`scripts/gemini_host_account.py`、`scripts/gemini_host_native.py`）；`deploy/payload.json`（CRAG `3.1.21` 与 CRAGGemini `0.4.13`）、数据库迁移结构与 `bin/` / `share/wrap-cli` 相对 `1.4.227` 均未变，预期 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 Claude/Codex 槽位，重启 `vm2api` 一次即可生效；Gemini 宿主机需执行 `install.sh prepare-gemini` 同步宿主脚本并重启 `vm2api-gemini`。

## 1.4.227 — 2026-11-26 · 修复 PostgreSQL 同步桥接层 `PgSyncDb` 在 `Atomics.wait` 虚假唤醒或超时后的永久 RPC 响应错位

- **修复 PostgreSQL 同步适配层（`PgSyncDb` + `pg-sync-worker`）RPC 协议永久错位导致的线上大面积 500 / 401 / 403（#1905）**：
  - 根因：`src/lib/db/pg/pg-sync-db.mjs` 原先使用 4 字节二值 `0/1` `SharedArrayBuffer` 信号，且读取 `receiveMessageOnPort(this._port)` 时未校验 `msg.id === id`、也未排空过期回包。当 `Atomics.wait(signal, 0, 0, timeout)` 发生合法的 spurious wakeup（`signal[0]` 仍为 `0`）时，兜底循环 `Atomics.wait(signal, 0, 1, 1)` 因预期值不等在 `<0.1ms` 内空转 500 次提前抛错；任意早退（虚假唤醒或 `PG_SYNC_TIMEOUT`）都会把 worker 迟到的回包滞留在 FIFO `MessagePort` 中，导致进程后续全部同步 DB 查询永久偏移 ≥1 个槽位（表现为 `rows.map is not a function`、正常 API Key 误判 `401` / `403 api_key_disabled`、重复 `INSERT` 撞 `accounts_pkey` 与大面积 `500`），只能重启恢复。
  - 修复：`src/lib/db/pg/pg-sync-worker.mjs` 将唤醒信号改为单调递增计数（`Atomics.add(signal, 0, 1)` + `Atomics.notify(signal, 0)`）并兜底捕获 `port.postMessage` 序列化异常；`src/lib/db/pg/pg-sync-db.mjs` 改为 8 字节 `SharedArrayBuffer`（分离回复计数与 worker 退出标志），请求前与等待循环中按 `msg.id < id` 排空陈旧回包、严格匹配 `msg.id === id`（遇到非法未来 id 闭失败报 `PG_SYNC_PROTOCOL_ERROR`），先读计数再读端口并按有界分片等待直至截止时间以免疫虚假唤醒与丢失唤醒；`BEGIN` 超时时异步补发 `rollback` 防止 worker 泄漏 `txClient`。
  - 回归测试：新增 `test/unit/pg-sync-db-rpc.test.mjs`，覆盖 spurious wakeup、`PG_SYNC_TIMEOUT` 后迟到回包排空与自动自愈、`BEGIN` 超时回滚清理及结构化错误透传。
- 部署说明：本次改动仅涉及控制面（`src/lib/db/pg/`）；前端（`web/src/`）、`deploy/payload.json`（CRAG `3.1.21` 与 CRAGGemini `0.4.13`）、数据库迁移结构、Gemini 宿主脚本与 `bin/` / `share/wrap-cli` 相对 `1.4.226` 均未变，预期 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 Claude/Codex/Gemini 槽位，重启 `vm2api` 一次即可生效。建议所有启用 `db_engine=postgres` 的生产实例立即升级至本版本。

## 1.4.226 — 2026-11-26 · `cache_control` 非法断点自动纠错与 `CRAG_CACHE_CONTROL` 恢复；CRAGGemini 安装/升级与 `UNSUPPORTED_CLIENT` 修复；Codex 凭证吊销升级为不可调度与工具 schema 兼容重试；集群槽位容器先起后删

- **`cache_control` 非法断点自动纠错与 `CRAG_CACHE_CONTROL` 零执行恢复（#1901）**：
  - `src/lib/protocol/cache-ttl.mjs` 收口为缓存纠错单一真值源，新增 `normalizeCacheControlObject` / `isCleanCacheControl` / `repairCacheBreakpointsInPlace` / `repairCacheBreakpoints`（合法体零拷贝直通），覆盖 `tools`、`system`、`crag_prompt.blocks`、`messages`（含递归嵌套 `tool_result.content`）与根级 `cache_control`：剥离 `thinking` / `redacted_thinking` 断点与非 `ephemeral` 畸形标记、规范非法 TTL、按需把嵌套 `tool_result.content` 断点提升至父级、超 4 点预算时按价值从低到高裁剪（`nested` → 历史旧消息 → `tools` → `system` → 最近 2 条活跃消息）、补齐省略 TTL 并修正 `5m`/省略 → `1h` 逆序。此前 #1731 / #1849 / #1881 的收敛对这些非规范断点直接 `400 invalid_cache_control` 拒单。
  - 合并 `normalizeCacheTtl` 与 `normalizeCacheTtlOrFallback`，`validateCacheBreakpoints` 复用 `collectCacheEntries` 保证校验与修复遍历顺序一致，`stripIllegalCacheControlFields` / `stripCacheScopeFields` 统一委托 `walkCacheNodes`。
  - `src/lib/protocol/{anthropic-policy,crag-whitelist,handle-protocol,outbound-attempt}.mjs`、`src/lib/pool/upstream-error-policy.mjs`、`src/lib/transport/go-worker-client.mjs` 与 `protofront/internal/{server,strip}`：预算统一计入 CRAG 边界，并让零上游执行、未提交的 `502 crag_policy_blocked`（`CRAG_CACHE_CONTROL`）可恢复而非直接阻断返回。
- **CRAG advisor 工具 `max_tokens` 与 advisor beta 声明（#1898）**：
  - `src/lib/protocol/crag-whitelist.mjs`：`ADVISOR_TOOL_KEYS` 补回 `max_tokens`。此前键集为 `['type','name','model','max_uses','caching','cache_control']`，`pickKeys` 直接丢弃该项，等于静默取消调用方对单次 advisor consultation（thinking + text）自身开销的上限；与本批次 `tool_use.extension`、`thinking.block_binding` 同一形状，白名单 advisor 分支此前零测试覆盖。新测试钉住全部文档化选项，并保留原有 fail-closed 行为（带 `input_schema`、name 不符、model 为空的 advisor 仍直接拒绝）。
  - `src/lib/protocol/outbound-attempt.mjs`：`prepareOutboundHeaders` 重建出站 `anthropic-beta` 时不再丢弃 advisor 的 beta —— `withRequestProtocolBetas` 从 body 重新推导时不认识该 beta（全仓零命中），为工具本身与重放结果显式声明。现代 CRAG print 的 beta 走 header，内核从 header 解析无需改动。
- **修复 CRAGGemini 最新载荷安装/升级与 `UNSUPPORTED_CLIENT` 误判（#1899）**：
  - `deploy/install.sh`：默认载荷缓存由硬编码 `defaults/0.3.0` 改为与 `gemini-maintenance.py` 一致的内容寻址 `defaults/<manifest_sha256>`，识别维护代理托管/CRAG 安装而不覆盖 `--public-key` / `--egress`，可用时传 `--reuse-agy`，升级陈旧默认安装时原子切换 `share/gemini/current` 并在重启失败时回滚。
  - `scripts/gemini-maintenance.py`：识别 `defaults/` 下（或钉选发行方哈希）的默认 CRAG 公钥，`install` / `repair` / `recover` 不再与 `409 manual_source_required` / `repair_release_unknown` 互锁；`scripts/fetch-default-gemini.py` 的 `prepare()` 支持 `--reuse-agy`，`download()` / `download_bounded()` 对瞬时网络/5xx 有界重试且不重试完整性失配。
  - `scripts/gemini_host_account.py`：`loadCodeAssist` / `onboardUser` 补齐 `platform: LINUX_AMD64`、`pluginType: GEMINI`，命中 `UNSUPPORTED_CLIENT` 时自动以备用 Antigravity User-Agent 重试，持续失败归类为 `client_unsupported` 而非笼统 `ineligible`；`scripts/gemini_host_native.py`、`scripts/gemini-host.py`、`src/lib/gemini/{routes,scheduler}.mjs` 与前端 `gemini-account-status.ts` / `gemini-recovery.ts` / `gemini-environments.tsx` 全链路透传 `client_unsupported` / `gemini_client_unsupported` 并指向「设置 → Gemini 维护」，同时防止陈旧探测结果重新污染已由实际推理证明可用的账号。
- **Codex 凭证吊销（grant death）升级为不可调度四态（#1900）**：
  - 现象：Codex 槽位的 401 `token_revoked` / `Encountered invalidated oauth token` 此前只换来 `codexFailureHold` 的 5 分钟进程内挂起（笼统 `oauth_401`），不落盘、不置不可调度，被吊销的槽每轮重新入选并持续打上游 401（生产上三个槽位约 11 小时每小时一次 401，面板仍显示健康）。
  - `src/lib/protocol/codex-models.mjs`：`refreshCodexAccessToken` 读取 401/403 响应正文并将上述措辞归类为 `oauth_revoked`（带 `revoked` 标记与 `description`），普通拒绝仍为 `refresh_rejected`。`src/lib/protocol/handle-codex.mjs` 新增 `isCodexGrantDead`（措辞对齐 Claude 池，**刻意不含 `invalid_grant`**，那是重放旧 refresh token 的典型轮换竞态误报），请求路径落盘停泊并将挂起升级为永久；`search` / `images` JSON 端点共用 `parkCodexGrantDeadIfHit`，`refreshSearchAccess` 经共享在途缓存传播 `grant-dead:` 判定以覆盖合成 401（access 过期、无正文）形态。
  - `src/lib/vm/codex-slot.mjs` 新增 `markCodexGrantDead`，复用权威变更入口 `applyUnschedulable`，幂等、不覆盖其他 unschedulable 判定（如 `organization_disabled`），并以 `_token_version` 闸门拒绝运维换票之后的迟到停泊；`src/lib/oauth/openai-quota.mjs` 的 `rotateIfNeeded` 将 `oauth_revoked` 视为结构性并停泊，面板文案区分「凭证已被吊销」与「刷新失败」。
  - 复活路径：`commitImportedCodexVm` 与面板 `oauth/refresh` 成功后调用 `clearOpenAIAccountHold`（此前仓内没有任何地方清除该永久内存挂起，重新授权的槽位要等进程重启才对调度器可见）；`src/lib/vm/vm-registry.mjs` 的 `summarizeCodexSlot` 不再把 `refresh_error` 硬编码为 null。
  - 同时纳入 Codex 槽位的定时凭证刷新（`src/lib/oauth/credential-refresh-monitor.mjs`、`src/server.mjs`），与既有刷新监控同一套调度。
- **Codex 工具 schema 编译失败兼容重试（#1879）**：`src/lib/protocol/codex-convert.mjs` 新增 `codexCompatibleFunctionTools()`，`handle-codex.mjs` 仅在收到 400 `invalid_json_schema` 且匹配 `Invalid schema for 'tools[N].parameters': Unsatisfiable schema:`、尚未向客户端输出、尝试预算允许时，于同一槽位与会话重试一次，只为省略 `strict` 的函数工具补 `strict: false`，保留工具顺序、名称、参数 schema 与显式 `strict`；兼容重试计入总尝试预算，上游再次拒绝即如实返回。实测一次含 57 个工具的请求由 400 变为 200 `response.completed`。
- **集群槽位容器先起新再删旧（#1884）**：`src/lib/cluster/remote-slot.mjs` 的 `startRemoteSlotAdmitted` 不再先 `removeContainer` 再重建。控制面升级会改变每个节点槽位的镜像 tag（内容寻址载荷哈希），随后的重建若在镜像构建/文件推送/`docker create`/`docker start` 任一步因链路饱和断开（典型为升级后 `warmNodeSlotImages` 的构建风暴），槽位会落得没有任何容器——泄漏的 `slot-runtime:` 维护挂起使其无法调度，且凭证在此期间停止刷新（生产已出现两次）。现改为把旧容器改名留底（`migrationBackupName` 控制在 Docker 63 字符限制内）、断开其网络以释放 endpoint、在真实名称下创建并启动新容器、确认起稳后再删除留底；任一步失败则回滚——删除半成品、改回原名、按快照恢复网络 endpoint、原先在运行的重新启动。新增回归 `test/unit/remote-slot-restart-loop.test.mjs`。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）、Go 协议前置（`protofront/`，运行期默认 `KIN_PROTO_FRONT=node`）、`deploy/install.sh` 与 Gemini 宿主/维护脚本（`scripts/gemini-host.py`、`scripts/gemini-maintenance.py`、`scripts/gemini_host_account.py`、`scripts/gemini_host_native.py`、`scripts/fetch-default-gemini.py`）；`deploy/payload.json`（CRAG `3.1.21` 与 CRAGGemini `0.4.13`）、数据库迁移结构与 `bin/` / `share/wrap-cli` 相对 `1.4.225` 均未变，预期 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 Claude/Codex 槽位，重启 `vm2api` 一次即可生效；Gemini 宿主机需执行 `install.sh prepare-gemini` 同步宿主与维护脚本后重启 `vm2api-gemini`，CRAGGemini 安装/升级与 `UNSUPPORTED_CLIENT` 修复才会生效。

## 1.4.225 — 2026-11-26 · 修复 Claude Code `response stream was malformed`（`response_headers` 子串误过滤与保活帧交错）；CRAG 内核白名单保留 `tool_use.extension`；恢复详情面完整邮箱展示与名称优先语义

- **修复下游 Claude Code `API Error: The response stream was malformed` 且网关零错误日志（#1888）**：
  - `src/lib/protocol/handle-protocol.mjs`：新增 `createResponseHeadersSseFilter()`，仅丢弃真正的 `response_headers` 控制帧（`event: response_headers` 或 JSON `type === "response_headers"`）。此前 `/response_headers/.test(line)` 会命中任何正文/思考/工具 JSON 中含该字面量的模型增量，而前导 `event: content_block_delta` 与尾随空行仍被写出，下游收到空 `data` 触发 `JSON.parse("")` → `SyntaxError`，网关侧却记录 `200 OK`。
  - `src/lib/protocol/stream-keepalive.mjs`：保活心跳在具名 SSE 帧（`event:` 到空行之间）写入中时让行（`inFrame` 守卫），避免切断 SSE 帧；在 `message_start` / `message_delta` / `endAttempt()` 时清理活动块状态，支持 `server_tool_use`，并阻止已关闭索引的增量重新装载 `blockIndex`，消除 `StreamMalformedEventError("closed")`。
  - `src/lib/transport/go-worker-client.mjs`：非 handoff SSE 读取改用 `StringDecoder("utf8")` + `decoder.end()`，修复跨 TCP 分块的多字节字符被 `chunk.toString("utf8")` 截断损坏。
  - 新增回归 `test/unit/stream-keepalive.test.mjs`、`test/unit/stream-queue-keepalive.test.mjs`。
- **恢复管理面详情页完整邮箱与名称优先标题语义（#1880，修 #1819 回归）**：
  - `web/src/lib/vm-kind.ts`、`web/src/components/platform-chip.tsx`：`slotDisplayTitle` / `SlotIdentity` 恢复「自定义名称优先 → 邮箱 → id」，不再让脱敏邮箱顶掉自定义名称（此前破坏详情页标题、各弹窗标题、集群表与 key 弹窗的既有命名工作流）。
  - `web/src/features/vm/vm-detail-card.tsx`、`detail-status-board.tsx`、`detail-account-tab.tsx`、`vm-row-detail.tsx`、`web/src/features/import/gemini-environments.tsx`：详情卡「邮箱」、状态板、账号 tab「ChatGPT 账号」、行展开详情与 Gemini 环境详情直出完整邮箱（admin-only 控制台的账号审阅、换邮箱核对与风控判读主键）；列表/网格/选择器维持 `formatSlotEmail` 脱敏 + 悬停 title 全文，防偷窥口径不变。
  - `web/src/features/vm/vm-stats-dialog.tsx`、`web/src/features/keys/key-limits-dialog.tsx`：修正悬停 title 不再挂脱敏字符串。
- **修复 CRAG 零信任白名单丢弃 `tool_use.extension` 致已发工具重放在逐跳净化时失效（#1893）**：
  - `src/lib/protocol/crag-whitelist.mjs`：`BLOCK_KEYS_BY_TYPE.tool_use` 键集补回 `extension`。#1731 的零信任白名单按类型键集重建每个内容块，`tool_use` 键集遗漏该键，`pickKeys` 因此在 CRAG 路径上将其丢弃——`handle-protocol.mjs` 恢复的网关自有已发工具重放（含 `extension`）在随后的逐跳净化中被再次抹掉。该值由重放账本铸造并覆盖客户端回传内容，且 CRAG 续接哈希覆盖这些字节，必须原样透传（与 `thinking.block_binding` 同形，`cli-node` 侧 `kernel-request.mjs` 本就保留）。
  - `test/unit/outbound-log-envelope.test.mjs` 对齐 #1731 的出站信封断言语义，并将 `outbound-log-envelope` 纳入 `package.json` 的核心测试集。
- 部署说明：本次改动仅涉及控制面（`src/lib/protocol/`、`src/lib/transport/`）与前端（`web/src/`）；`deploy/payload.json`（CRAG `3.1.21` 与 CRAGGemini `0.4.13`）、数据库迁移结构、Gemini 宿主脚本与 `bin/` / `share/wrap-cli` 相对 `1.4.224` 均未变，预期 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 Claude/Codex/Gemini 槽位，重启 `vm2api` 一次即可生效。

## 1.4.224 — 2026-11-26 · 加固 CRAG 订阅/商城归属与直充续费链路、对齐 CRAGGemini 订阅同步；CRAG 槽位内核能力重派与计费增强；Gemini 回调会话与零令牌排空归并

- **CRAG 订阅与商城重构回归修复与归属安全加固（配套 `dofastted/crag#30` 与新版 `crag-shop`）**：
  - `src/lib/vm/crag-subscription.mjs`、`src/lib/admin/crag-subscription-routes.mjs` 及前端 `crag-device-identity.tsx`、`crag-host-subscription.tsx`、`crag-cloud-orders.tsx`、`crag-subscription-errors.ts`、`queries.ts`：整机迁移（`POST /api/panel/crag-subscription/migrate`）要求提供原宿主机下任一历史订单号或原 `CRAGR1` 兑换码作为归属凭证并在迁入时立即绑定目标宿主机随机凭据；首次直充拉取 `CRAGH2` 权益后立即通过 `/recover` 替换临时占位凭据；修正云端历史订单面板有效兑换券计数（兼容 `active` 布尔字段）与续费后动态有效期展示（优先 `grant_expires_at`）。
  - `src/lib/admin/crag-shop.mjs`：修复已完成直充订单在 `POST /apply` 与 `POST /apply-renewal` 时因跳过远端状态检查误调 `/claim` 失败的问题，对直充订单执行 `/claim` 返回明确 `409 shop_direct_credit_no_voucher` 并自动同步宿主机权益。
  - `src/lib/gemini/subscription.mjs`：对齐 `crag-auth-gemini` 订阅链路，支持无本地凭据的直充/迁移宿主机首次 `status({ sync: true })` 自动拉取 `CRAGH2` 权益并立即绑定本地随机凭据，同时在凭据失配时借助本地已签名权益自动执行 `/recover` 恢复。
- **CRAG 协议预检、号池故障隔离与按模型 Advisor 计费增强**：
  - 支持 `crag_drop_foreign_thinking` 的 `foreign_only` 状态（#1887），允许 `tool_addition` / `tool_removal` 块通过内核预检、计入嵌套 `tool_result` 缓存断点并在内核白名单中保留 `thinking.block_binding`；当槽位因内核能力拒绝时自动重派一次、对重复不透明 CRAG 429 施加模型级冷却并将单会话 `stop-400` 熔断记账收口为单次；从 `usage.iterations` 上报按模型拆分的 Advisor 用量与费用（#1886）。
- **Gemini 回调日志与零令牌工具排空**：记录回调 `conversation_id`、为第三方请求提供 `session_id` 回退，并折叠零令牌工具排空帧（#1882）。
- 部署说明：本次改动仅涉及控制面（`src/`）与前端（`web/src/`）；`deploy/payload.json`（CRAG `3.1.21` 与 CRAGGemini `0.4.13`）、数据库迁移结构、Gemini 宿主脚本与 `bin/` / `share/wrap-cli` 相对 `1.4.223` 均未变，预期 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 Claude/Codex 槽位，重启 `vm2api` 一次即可生效（整机迁移归属校验与优惠券锁价续费需配套已部署的新版 `crag-auth` 与 `crag-shop`）。

## 1.4.223 — 2026-11-26 · 钉选 CRAGGemini 0.4.13（阻止 `agy` 20k MCP 工具截断）并收紧线协议工具名 55 字符上限

- **阻止 `agy 1.5.9` 20k Token 预算静默截断客户端/MCP 工具，并钉选 `CRAGGemini 0.4.13` 签名载荷**：
  - `deploy/payload.json` 将 `geminiDefaultLinuxAmd64` 升级至 `payload-2026.11.26-gemini-0.4.13`（对应 `dofastted/antigravity-cli-proxy#18` / `v0.4.13`，沿用现有 `crag-auth-gemini` 授权锚 `f9572077…` / `d2470877…`），通过 `Hook::CustomizationBudget` 解除 20,000-token `CustomizationTokenBudget` 截断、消除布尔 `additionalProperties` Schema 冗余描述、`defer_ack=1` + `POST /internal/mcp/listed` 延迟确认 `tools/list` 刷新竞争，并仅剥离内部 `crag`/`craggemini` 前缀以完整保留客户端 `mcp__<server>__<tool>` 声明（#1873）。
  - `src/lib/protocol/gemini-convert.mjs` 与 `test/unit/gemini-convert.test.mjs` 将出站 wire 工具名缩短策略统一收口为 55 字符上限（叠加 `mcp_crag_` 前缀后严格不超过 64 字符 `ValidateToolName` 限制）（#1873）。
- 部署说明：本次改动仅涉及控制面（`src/lib/protocol/gemini-convert.mjs`）与 `deploy/payload.json`（CRAGGemini 默认载荷由 `0.4.12` 升级至 `0.4.13`，CRAG 维持 `3.1.21`）；前端（`web/src/`）、数据库迁移结构、Gemini 宿主脚本与 `bin/` / `share/wrap-cli` 相对 `1.4.222` 均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；升级控制面并在 Gemini 宿主机切换 CRAGGemini `0.4.13` 载荷、重启 `vm2api` 与 `vm2api-gemini` 即可生效。

## 1.4.222 — 2026-11-26 · Gemini 定向 AppArmor userns 策略与沙箱探针；常规日志错误详情持久化、writeHead 响应头捕获与跨跳关联 ID

- **Gemini 定向 AppArmor userns 策略、真实沙箱探针与安全 OAuth 早退归因**：
  - `deploy/install.sh` 与 `scripts/gemini-maintenance.py` 仅在开启 `kernel.apparmor_restrict_unprivileged_userns=1` 的宿主机按条件生成并原子加载受管 `/etc/apparmor.d/vm2api-gemini`（`abi <abi/4.0>`、`flags=(unconfined)`、`userns,`），并将 `AppArmorProfile=vm2api-gemini` 与 `After/Requires=apparmor.service` 内联至 `/etc/systemd/system/vm2api-gemini.service`（保持零 drop-in 约定，缺依赖或存在人工自定义配置时闭失败）（#1868，修 #1847）。
  - `scripts/gemini-host.py`、`scripts/gemini-maintenance.py`、`src/lib/gemini/routes.mjs` 及前端设置/导入/账号状态页新增有界无网 `setpriv` + `bwrap` 沙箱探针与 `sandbox` 维护检查项（区分 `gemini_sandbox_apparmor_restricted` 与 `gemini_sandbox_unavailable`，正/负 TTL 缓存并支持诊断强制刷新）；OAuth 登录通过 `Agy.poll_exit_status()`（`waitid(..., WNOWAIT)`）区分真实 8 秒超时与子进程早退/沙箱拒绝且零 PTY 泄露（#1868）。
- **常规日志结构化错误详情持久化、`writeHead` 响应头捕获与跨跳关联 ID**：
  - 新增纯增量可空迁移 `src/lib/db/migrations/069_log_error_details_and_hop_correlation.sql`（SQLite）与 `src/lib/db/pg/pg-migrations/006_log_error_details_and_hop_correlation.sql`（PostgreSQL 对等），为 `usage_logs` 与 `request_attempts` 补充 `upstream_type`、`error_details` / `error_details_json`、`error_code`、`hop_request_id` 及 `provider_{run,turn,attempt,request}_id`；`src/lib/core/errors.mjs` 新增白名单标量脱敏器持久记录 `#1705` 续接标量与 410 `reason`，`handle-protocol.mjs` 不再让泛化 `upstream_error` 掩盖具体映射码（#1869，关联 #1845）。
  - `src/lib/admin/request-log.mjs` 完整包装 `res.writeHead` 各类签名并在脱敏前按线序合并 `res.getHeaders()` 与 `writeHead` 头，确保 debug 日志保留 `x-request-id` 与 `x-should-retry`；`go-worker-client.mjs`、`native-handoff.mjs`、`log-fields.mjs`、`failover-runner.mjs` 及前端日志详情页（`SummaryTab`、`LogicTraceTab`）全链路记录并展示单跳 `hop_request_id` 与内核 `providerResult` 关联 ID（内部 `x-gateway-request-id` 仅限 Unix socket 且不进 CRAG v2 透传白名单）（#1869）。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）、数据库增量迁移（SQLite `069` / PostgreSQL `006`，纯可空 `ADD COLUMN IF NOT EXISTS` 在线无重写）、`deploy/install.sh` 及 Gemini 宿主与维护脚本（`scripts/gemini-host.py`、`scripts/gemini-maintenance.py`）；`deploy/payload.json`（CRAG `3.1.21` 与 CRAGGemini `0.4.12`）及 `bin/` / `share/wrap-cli` 相对 `1.4.221` 未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；Gemini 宿主机同步脚本并刷新维护 bundle 后需重启 `vm2api-gemini` 与 `vm2api-gemini-maintenance` 一次以启用 `sandbox` 探针与 OAuth 早退归因。

## 1.4.221 — 2026-11-26 · 修复 Gemini `crag_subscription` 分片崩溃 503 循环；钉选 CRAG 3.1.21 与遥测上传核验；商城画布缓存持久化、日志思考后缀对齐与 PostgreSQL 备份预检加固

- **修复 Gemini `crag_subscription` 分片 `license_error` 导致的周期性 `503 gemini_native_worker_unavailable`**：
  - `scripts/gemini-host.py` 在 `payload_mode == "crag_subscription"` 时强制 `_use_sharded_daemon()` 返回 `False`（统一走单账号 `NativeSession` 进程池，与每环境独立 `/etc/machine-id` 设备绑定保持一致），并对齐 `daemon_status()` 的 `planned_shards` 计算（#1863）。
  - 新增 `_clear_shard_fault()`，移除 `_acquire_shard_for_account()` 启动即清零退避计数的缺陷（仅在健康检查或 `open_stream` 真正就绪后重置），恢复 `2s → 60s` 指数退避；在 `_stream_native_infer()` 中，当分片在发送 SSE 响应头之前崩溃且开启 `daemon_fault_isolation` 时透明隔离并同请求回落至单账号 `NativeSession`（#1863）。
- **CRAG 遥测上传核验并钉选 CRAG `3.1.21` 签名载荷**：`deploy/payload.json` 将 CRAG 载荷升级至 `payload-2026.11.26-crag-3.1.21`；扩展 `src/lib/transport/rust-kernel-client.mjs`、`src/lib/vm/slot-process-status.mjs`、`src/lib/admin/kernel-catalog.mjs` 与前端 `telemetry-pane.tsx` / `seed-policy-card.tsx` / `detail-page.tsx`，补齐 CRAG 遥测上传校验状态与文档说明（#1859）。
- **CRAG 商城商品画布缓存持久化、Gemini 日志模型名对齐与 PostgreSQL 备份预检对齐**：
  - `src/lib/admin/crag-shop.mjs`、`crag-shop-supplier.mjs` 与 `web/src/features/billing/crag-shop.tsx` 持久化商品目录画布缓存，支持摘要哈希跳过重复拉取与上游超时回退（#1862）。
  - `src/lib/protocol/log-fields.mjs`、`src/lib/db/repos/usage-logs-view.mjs` 与 `web/src/features/logs/log-display.ts` 将 Gemini 思考档位后缀与上游裸 `modelVersion` 视为同源匹配（#1860）。
  - `src/lib/admin/backup-service.mjs`、`panel-routes.mjs` 与 `web/src/features/settings/backup-pane.tsx` 对齐 PostgreSQL 备份预检、HTTP 状态码与界面展示（#1858）。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）、`deploy/payload.json`（CRAG 升级至 `3.1.21`，CRAGGemini 维持 `0.4.12`）与 `scripts/gemini-host.py`；数据库迁移结构与 `bin/` / `share/wrap-cli` 相对 `1.4.220` 未变，预期 `SLOT_SYNC=skip`；Gemini 宿主机同步 `scripts/gemini-host.py` 后重启 `vm2api-gemini` 即可彻底消除 `503 gemini_native_worker_unavailable`（`v1.4.211`～`v1.4.220` 旧版在升级前可通过将 `accounts_per_daemon` 设为 `1` 临时止血）。

## 1.4.220 — 2026-11-26 · 钉选 CRAGGemini 0.4.12 并恢复 agy 工具执行；修复 PostgreSQL `cooldown_until` 类型归一与一键切库脚本

- **恢复 CRAGGemini `agy` 客户端工具执行并钉选 `0.4.12` 签名载荷**：
  - `deploy/payload.json` 将 `geminiDefaultLinuxAmd64` 升级至 `payload-2026.11.26-gemini-0.4.12`（对应 `dofastted/antigravity-cli-proxy#16` / `v0.4.12`，沿用生产授权锚 `f9572077…` / `d2470877…` 与 `agy` `39816d49…`）（#1854）。
  - `scripts/gemini-host.py` 移除原生启动参数中的 `--mode plan`，避免 CRAGGemini 运行态锁死在计划模式；`src/lib/protocol/gemini-convert.mjs` 在工具转换链路剥离 `mcp_crag_*` / `mcp__crag__*` / `mcp_craggemini_*` / `mcp__craggemini__*` 内部前缀（#1854）。
- **PostgreSQL 迁移与运行时修复**：
  - `src/lib/gemini/scheduler.mjs`、`src/lib/db/repos/request-attempts-repo.mjs` 与 `scripts/migrate-sqlite-to-pg.mjs` 将 `request_attempts.cooldown_until` 统一归一化为整型 epoch 毫秒，避免 ISO 时间戳字符串触发 PostgreSQL `bigint` 写入/迁移异常（#1852）。
  - `deploy/replace-db-to-pg.sh` 的 `resolve_api_key()` 改为优先读取生效的 systemd `KIN_API_KEY` 而非陈旧 `.env` 中的 `VM2API_API_KEY`，并在 `cleanup_on_failure()` 回滚前先 `stop` 再 `start` `vm2api`，防止失败回退时进程继续持有已移除的 PostgreSQL 配置（#1855）。
- 部署说明：本次改动涉及控制面（`src/`）、`deploy/payload.json`（CRAGGemini 默认载荷由 `0.4.11` 升级至 `0.4.12`，CRAG 维持 `3.1.20`）、`scripts/gemini-host.py`、`scripts/migrate-sqlite-to-pg.mjs` 与 `deploy/replace-db-to-pg.sh`；前端（`web/src/`）、数据库迁移结构与 `bin/` / `share/wrap-cli` 相对 `1.4.219` 均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；Gemini 宿主机同步脚本、更新 `deploy/payload.json` 与维护 bundle 并切换 CRAGGemini `0.4.12` 载荷后，重启 `vm2api-gemini` 与 `vm2api-gemini-maintenance` 一次即可生效。

## 1.4.219 — 2026-11-25 · 修复 Gemini bwrap 直连目录穿越与熔断错误归因；Go 协议前置 sidecar 与官方透传开关；Gemini 代理选择器展示 IP/出口 IP/地区

- **修复 Gemini `bwrap` 直连目录穿越权限与熔断错误归因回归（消除全模型 503）**：
  - `scripts/gemini-host.py` 修复 `/run/vm2api-gemini/d`（`direct_root`）`0750` 权限阻断非特权 `bwrap` worker（`--clear-groups`）穿越挂载及 `<short_name>` 启动前非 `0700` 触发 `craggemini` `Config::validate()` 失败的问题：启动时创建/自愈 `direct_root` 为 `0711`（`root:gateway_gid`，仅穿越不可列举）、worker 启动前以 `0700`（`uid:uid`）创建 `native_dir`，待 worker 就绪后在 `_expose_direct_socket()` 将 `native_dir` 切换为 `0710`（`uid:gateway_gid`）并将 `kernel.sock` 设为 `0660`（`uid:gateway_gid`）（#1848）。
  - `scripts/gemini_host_native.py`、`src/lib/gemini/direct-client.mjs`、`src/lib/gemini/scheduler.mjs` 与 `src/lib/gemini/routes.mjs` 将内核 `account_circuit_open` 与全部候选账号被 `unitCircuit` 熔断的场景统一归因为 `503 gemini_native_worker_unavailable`（`gemini_operation_busy` 严格保留给队列满/并发饱和），并将公网 503 池并发文案（「当前可用 Gemini 账号并发繁忙，请稍后重试」）与面板 409 单环境锁文案分离（#1848）。
- **Go 无状态协议前置 sidecar、Web Settings 官方请求体透传开关与 130 用例离线基线**：
  - 新增纯 Go 标准库协议前置 sidecar（`protofront/` → `bin/kin-proto-front`）与 `src/lib/transport/proto-front-client.mjs`，实现星形 IR 与 4+1 入站协议双向编解码、Web Settings + 官方请求体双闸门透传校验、面向 CRAG/CRAGGemini/Codex 的防撞车剥离与畸形 JSON Schema `fail_closed_schema` 400 拦截，并通过 `KIN_PROTO_FRONT=node|shadow|go` 控制灰度切流（默认保持 `node` 不启动 sidecar，零行为变更、可即时回退）（#1849）。
  - `src/lib/protocol/codex-route.mjs` 新增 `codex.official_passthrough`（默认 `true`）、`src/lib/gemini/routing-config.mjs` 新增 `gemini.official_passthrough`（默认 `true`），前端在 `web/src/features/settings/openai-pane.tsx` 与 `gemini-config-pane.tsx` 暴露对应「官方 Codex/Gemini 请求体透传」开关；新增 `scripts/protocol-baseline/` 130 用例离线基线并将 `protofront` 接入 CI 与 `scripts/check-gofmt.mjs`（#1849）。
- **Gemini 代理选择器与详情页展示代理地址、出口 IP 与地区**：`web/src/features/import/gemini-operations.ts` 扩展 `GeminiProxy` 公开字段并新增 `geminiProxyAddress()` / `geminiProxyOptionLabel()`（安全处理 IPv6 方括号、区分中转域名与实测 `geo.ip`），同步应用于 `gemini-environments.tsx`（导入下拉与详情「绑定代理」）及 `gemini-proxy-panel.tsx`（重绑下拉与已绑卡片新增「代理地址」/「出口 IP」行）（#1843）。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）、Gemini 宿主脚本（`scripts/gemini-host.py`、`scripts/gemini_host_native.py`）以及默认关闭的 Go 协议前置源码（`protofront/`，运行期默认 `KIN_PROTO_FRONT=node`）；`deploy/payload.json`（CRAG `3.1.20` 与 CRAGGemini `0.4.11`）、`scripts/gemini-maintenance.py`、数据库迁移结构与 `bin/` / `share/wrap-cli` 相对 `1.4.218` 均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；Gemini 宿主机同步 `scripts/gemini-host.py` 与 `scripts/gemini_host_native.py` 后需重启 `vm2api-gemini` 一次以启用 `bwrap` 直连目录两阶段权限修复。

## 1.4.218 — 2026-11-25 · CRAG 订阅宿主机直充/锁价续费/整机迁移与云端订单；PostgreSQL 运行时、备份与一键迁移加固；CRAG v2 续跑 transcript 迁至来宾 tmpfs

- **CRAG 订阅极简重构（`host_id` 直充、锁价续费、云端历史订单与整机零冷却迁移）**：
  - `src/lib/vm/crag-subscription.mjs` 与 `src/lib/admin/crag-subscription-routes.mjs` 在 `GET /api/panel/crag-subscription` 暴露完整 64 位十六进制 `host_id`，允许无本地凭据时零 Bearer 调用并在 `status()` 自动拉取已直充或升级的 `CRAGH2` 权益；新增 `GET /api/panel/crag-subscription/orders` 与 `POST /api/panel/crag-subscription/migrate`（支持 64-hex `host_id` 或设备 UUID，零冷却整机迁移）。
  - `src/lib/admin/crag-shop.mjs` 与 `src/lib/admin/crag-shop-supplier.mjs` 在创建标准/设备订单时自动注入当前宿主机 `host_id` 实现支付完成后直充激活，并支持 `sku: "renewal"` + `renew_order_id` 一键锁价续费（不再依赖旧版 `CRAGRP1` `renewalProof`，商品涨价或下架后仍锁定原实付金额）。
  - 前端新增 `web/src/features/billing/crag-cloud-orders.tsx`（`CragCloudOrdersPanel`），并扩展 `crag-shop.tsx`、`crag-device-identity.tsx`、`crag-host-subscription.tsx`、`crag-subscription-errors.ts` 与 `queries.ts`，展示可复制完整 `host_id`、有效/总计兑换券数、云端历史订单、一键锁价续费与整机/单笔迁移（保留 `#1826` 身份冲突重建能力）（#1842，配套 `dofastted/crag#28`）。
- **PostgreSQL 运行时、备份恢复、流式迁移预检与 systemd 一键脚本端到端加固**：
  - 运行时与可观测性：`src/lib/db/database.mjs` 新增 `withSavepoint()` 并接入 `write-behind.mjs`、`request-log.mjs`、`legacy-import.mjs` 隔离 PG 事务内单条 SQL 异常（防 `25P02` 污染批次）；`pg-sync-db.mjs` 在 worker `error`/`exit` 时唤醒 `Atomics.wait` 并施加有界 RPC 超时；`usage-logs-repo.mjs` / `usage-logs-view.mjs` 统一不区分大小写检索（`LOWER(col) LIKE ?`）并经 `settings.usage_logs_db_created_at` 保留历史覆盖起点；`cache-client.mjs` 在 Redis 不可达时回退 PG `LISTEN/NOTIFY`；`dashboard-aggregator.mjs` 对齐 `IGNORED_ERROR_CODES` 并在咨询锁下清理 24 小时前 outbox；`database-metrics.mjs` 暴露 `pg_top_tables` 与 `pg_dashboard_watermark`（#1841）。
  - 备份与恢复：`backup-core.mjs` 通过 `PGPASSWORD` 传递凭据而非命令行 URI、`dumpPgLogicalNdjsonGz()` 按外键拓扑序经服务端 `NO SCROLL CURSOR` 流式导出、`restorePgSnapshotJob()` 以 `readline` 流式恢复并加 `lock_timeout = '30s'`；`backup-service.mjs` 回收 `pg_dump`/`pg_restore` 子进程并识别 `.pgdump` / `.pg.ndjson.gz` 孤儿归档（#1841）。
  - 迁移器与部署脚本：`scripts/migrate-sqlite-to-pg.mjs` 新增零停机 `--preflight` 预检、默认拒绝静默丢表/丢列（需显式 `--allow-partial-schema`）、安全对齐种子表、大表字节级进度及 `--verify` 序列与订单/VM 校验；`deploy/install-pg.sh`、`deploy/replace-db-to-pg.sh`、`deploy/install.sh` 与 `docs/POSTGRES_MIGRATION.md` 支持 systemd `vm2api.service` 优先检测、`systemctl show` 读取真实 drop-in 端口/环境、`0600` `.env.postgres` 凭据隔离及 Phase 0 零停机预检（#1841）。
- **CRAG v2 续跑 transcript 目录同步迁至来宾 tmpfs 避免 9p 写回卡死**：`docker/kin-kvm/guest/kin-crag-apparmor` 抽象 `isolate_tmpfs` / `release_tmpfs`，在 `#1741` `/run/kin/work` 之外新增受管 drop-in `46-vm2api-crag-transcripts.conf`，在内核启动前防符号链接跟随并将 `/home/kincli/.claude/projects` 挂载为来宾 tmpfs（`mode=0700,uid/gid=kincli,size=512m,nosuid,nodev`），失败时自动退回原 9p 目录，离开 CRAG v2 时清理受管 drop-in 且保留管理员自定义文件（#1838）。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）、PostgreSQL 迁移/安装脚本（`deploy/install*.sh`、`deploy/replace-db-to-pg.sh`、`scripts/migrate-sqlite-to-pg.mjs`）及 KVM guest 侧脚本（`docker/kin-kvm/guest/kin-crag-apparmor`）；`deploy/payload.json`（CRAG `3.1.20` 与 CRAGGemini `0.4.11`）、Gemini 宿主脚本、SQLite 迁移结构与 `bin/` / `share/wrap-cli` 相对 `1.4.217` 均未变，常规升级预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位（KVM CRAG v2 槽位下次重启启用 `46-vm2api-crag-transcripts.conf`；CRAG 订阅直充/锁价续费/整机迁移需配合 `crag-auth` `dofastted/crag#28` 生效）。

## 1.4.217 — 2026-11-25 · Codex `token_revoked` 自动摘牌；探活组织禁用直挂四态；主动查询静置窗边界修复；无凭证运行槽与额度条交互校准

- **Codex 槽位 OpenAI `token_revoked` 凭证吊销与 Claude 同口径自动摘牌**：将 OpenAI 401 吊销文案（`token_revoked` / `invalidated oauth token`）统一纳入错误分类（`classifyOAuth401` / `GRANT_DEAD`）、`FailoverRunner` 刷新恢复、`credential-refresh-monitor`、`oauth-credentials`（`refreshErrorCodeOf` 写盘归一为 `oauth_revoked`）、调度资格门、transport 致命判定、`usage-probe-monitor`（跳过死凭证探活）、`panel-api` 遗留清理与前端 `web/src/lib/vm-status.ts` 状态模型，避免死号持续占座雪崩；中流（`terminalState: incomplete`）吊销维持 `oauth_unconfirmed` 保守语义，历史 `refresh_error: "token_revoked"` 旧值同步判死（#1814）。
- **官方 `/usage` 探活识别组织禁用并直接挂起槽位**：`src/lib/pool/upstream-error-policy.mjs` 导出共享检测器 `isOrganizationDisabledText` 与 `isOrganizationDisabledUsageResult`（覆盖 `400`/`401`/`403` 及对象/字符串形态）；`panel-api.mjs` 探活在裸 401 致命分支之前识别组织禁用并直接 `markUnschedulable('organization_disabled')`（重读 `vm.json` 同步刷新可用性），仅操作员手动恢复；`account-quota.mjs` 不再对组织禁用打 `rate_limited` 退避并保留原始错误文案；`usage-probe-monitor.mjs` 跳过已挂起的 `organization_disabled` 槽位避免持续消耗 403 并覆写挂起时间（#1822）。
- **主动用量查询保留近期无 Header 推理的静置保护**：`src/lib/pool/account-quota.mjs` 的 `5h`/`7d` 与 `7d_oi` 主动对账路径改用 `maxTimestamp(existingSampleMs, latestActivityAtMs)`，避免近期仅更新 `last_used_at` 而未带新额度 Header 的推理被普通主动查询绕过 5 分钟静置窗，显式 `force_reconcile` 行为保持不变（#1836，关联 #1776、#1820）。
- **前端无凭证运行槽状态与额度条展示校准**：`web/src/lib/vm-status.ts` 的 `vmRunning()` 仅按实际运行态判定（`running`/`ok`/`active`，缺省 `status` 时才结合 `has_token` 兜底），修复无凭证但仍在运行的槽位在面板误显为「停止」且无法关机/改编号的死锁（#1824）；`web/src/features/vm/vm-list-table.tsx` 移除额度进度条内易被误读为用量游标的竖直时间刻线，保留悬停 `title` 时间进度提示（#1810）。
- 部署说明：本次改动仅涉及控制面（`src/`）与前端（`web/src/`）；`deploy/payload.json`（CRAG `3.1.20` 与 CRAGGemini `0.4.11`）、Gemini 宿主脚本、数据库迁移结构与 `bin/` / `share/wrap-cli` 相对 `1.4.216` 均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位（若从 `1.4.215` 直接跨版升级至 `1.4.217`，需一并按 `1.4.216` 说明同步 Gemini 宿主脚本并切换 CRAGGemini `0.4.11` 载荷）。

## 1.4.216 — 2026-11-25 · 钉选 CRAGGemini 0.4.11 与 1-hop 直连数据面；设置页全量巡检校准；CPA/sub2api 导入、主动用量对账、CRAG 冲突重建与槽位邮箱脱敏统一

- **CRAGGemini `0.4.11` 签名载荷升级、429 恢复增强、分片订阅守卫与 1-hop 直连数据面**：
  - `deploy/payload.json` 将 `geminiDefaultLinuxAmd64` 升级至 `payload-2026.11.25-gemini-0.4.11`（Debian 12 离线构建 `<= GLIBC_2.34`，沿用既有生产授权锚 `f9572077…` / `d2470877…` 与 `agy` `39816d49…`），交付 `dofastted/antigravity-cli-proxy#13` 与 `#14`（`gemini-4-carbon-high` 推理强度、默认 `agy` 详略度、原生四协议 API、`agy 1.5.9` 非 200 错误体捕获、槽位池恢复与按账号 `LicenseGate` 隔离）（#1832）。
  - 优化 `src/lib/gemini/routes.mjs`、`prompt-normalizer.mjs`、`scheduler.mjs` 与 `src/lib/protocol/{gemini-convert,handle-protocol}.mjs`，按 `(target, upstreamModel)` 缓存出站载荷与归一化结果、文件指纹化缓存许可与短时目录；结构化区分 Google 429 `QUOTA_EXHAUSTED`（含 `quotaResetDelay` / `retryDelay`）与无原因 `gemini_content_rejected`（内容拒绝不冷却/不切号，短 RPM 有界重试）；`scripts/gemini-host.py`、`scripts/gemini_host_native.py` 与 `scripts/gemini-maintenance.py` 在 `crag_subscription` 模式下启用 `CragDaemonShard`、按账号落盘 `crag-license`（`0600`）实时同步激活/吊销状态，暴露 `/run/vm2api-gemini/d/<short>/kernel.sock` 并新增 `POST /infer-target`；新增 `src/lib/gemini/direct-client.mjs` 实现热态 OAuth 回合 Node → CRAGGemini Unix Socket 1-hop 直连流式推理与连接池 `/cancel`，异常时透明闭失败回退至 `POST /infer`（#1829）。
- **Gemini 账号导入新增支持 CPA 与 sub2api 格式**：扩展前端本地解析与多账号选择器（`web/src/features/import/gemini-account-import.ts`、`gemini-environments.tsx`，单文件上限 2 MiB）与后端归一化（`src/lib/gemini/oauth-import.mjs`、`routes.mjs`），在原有 Antigravity Tools 导出之外支持 CLIProxyAPI（`type: "antigravity"` / `"gemini"`）与 sub2api（多账号包/单账号 JSON、OAuth 与 API Key、混合平台过滤），始终仅提交最小凭据且不上传/转发 `refresh_token`，同步更新 `docs/gemini-host.md`（#1821）；补齐 `test/unit/gemini-host.test.mjs` 对 `#1806` 默认调度字段的断言基线（#1833）。
- **设置页与运维控件全量巡检校准（Batch 1 & Batch 2）**：
  - 路由、调度、协议与脱敏语义校准：新增 `web/src/features/settings/routing-draft.ts`，移除保存「设置 → 协议」时的静默 `inheritProtocolOnSlots()` 副作用并保留未暴露 `compatibility` 字段；按变更区块触发归一化、缓存失效与保存提示，`SaveBar` 跨非路由标签持续可见，13 张摘要卡「待保存」角标按自身字段切片计算；校准会话绑定文案、移除死滑块 `pool.seat_grace_ms`、对齐 `FailoverRunner` / `PoolPane` 默认值与 `<Link>` 导航；启停与策略替换统一调用 `ensureRedaction` 并在禁用/替换时回收旧 `kin-redact` 子进程，`PUT /api/panel/routing` 在 `400` 阶段严格校验脱敏规则上限、`exhaustion_guard_new_session <= exhaustion_guard_stop`、`codex.catalog_client_version` 与日志保留/容量参数，`GET /api/panel/routing` 返回生效 `max_body_bytes` / `max_body_mib`，修复 `eagerToolStreamingEnabled` 默认极性（#1831）。
  - 顶栏权限、槽位面板与运维控制对齐：`ProfileDropdown` 与 `CommandMenu` 按面板视图权限过滤并完成 `ConfigDrawer` 中文化；优化 `OfficialCcSettingsPane`、`HealthPane`、`TelemetryPane`（拆离即时槽位与延后全局策略卡片、修复单位切换改写草稿）与 `Socks5Pane`；`notify.mjs` / `notify-pane.tsx` 补齐邮件（SMTP）渠道编辑与测试并规范化 `/cc#/cluster` 链接；`backup-pane.tsx` 替换原始配置块为本地化自动备份卡片并校验恢复/下载可用性；`GET /api/panel/version?refresh=1` 支持强制刷新且失败不续期 5 分钟缓存；`gemini-install-pane.tsx` 补全 `gemini_maintenance_*` 中文说明与提交不确定态区分（#1830）。
- **主动用量查询受控校准陈旧 Header 与强制对账**：`AccountQuota.ingestOAuthUsage` / `createActiveUsageQuery` 保持被动探测 `shouldCopyOfficialToExtra()` 守卫不变，仅在主动查询 `200 OK` 且字段完整时按窗口独立校验单调性、空闲态、`#1758` `reset_boundaries` 与 5 分钟静置窗，安全回校准陈旧 `5h`/`7d`/`7d_oi` Header 并清理过期冷却；对齐 `quota-tiers.mjs` `isNearLimit()`；`POST /api/panel/vms/:id/usage/query` 支持 `{ force_reconcile: true }` 并返回对账/保留窗口与剩余静置时间，前端展示保留反馈与二次确认强制对账弹窗（#1820，关联 #1776）。
- **CRAG 宿主身份冲突自动重建与手动重建路由**：`src/lib/vm/crag-subscription.mjs` 在 `host_id_collision` 时通过 `rebuildDeviceIdentity({ reason: 'host_id_collision' })` 优先切换无冲突硬件源、全部冲突时生成全新 128-bit 身份并立即签发配对凭据，`redeem()` / `claimByOrder()` 自动重建并重试一次；新增 `POST /api/panel/crag-subscription/rebuild-identity` 并在订阅页与宿主订阅提示中提供一键重建按钮（#1826）。
- **全槽位邮箱脱敏展示统一收口**：在 `web/src/lib/vm-kind.ts` 新增唯一事实来源辅助函数 `formatSlotEmail` / `slotRawEmail` / `slotDisplayTitle`（保留前 5 字符加省略号 + `@` + 域名前 5 字符，悬浮 `title` 保留完整邮箱），统一应用于 Claude / Codex / Gemini 机架卡、槽位表、行展开详情、详情页、密钥弹窗、集群机器详情与 Gemini 环境页，并在 `src/lib/vm/vm-registry.mjs` 保留顶层 `vm.email` 回退（#1819）。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）、`deploy/payload.json`（CRAGGemini 默认载荷由 `0.4.10` 升级至 `0.4.11`，CRAG 维持 `3.1.20`）以及 Gemini 宿主脚本（`scripts/gemini-host.py`、`scripts/gemini_host_native.py`、`scripts/gemini-maintenance.py`）；数据库迁移结构与 `bin/` / `share/wrap-cli` 均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；Gemini 宿主机同步脚本并切换 `0.4.11` 加密载荷后需重启 `vm2api-gemini` 与 `vm2api-gemini-maintenance` 生效。

## 1.4.215 — 2026-11-25 · CRAGGemini 席位许可语义/同步恢复/换签对齐；`gemini-4-carbon-high` 思考强度与多协议对齐

- **CRAGGemini 席位许可语义、同步恢复与载荷密钥换签全链路对齐**：
  - `src/lib/gemini/subscription.mjs` 与 `src/server.mjs` 新增 `hasSyncPending()`、`recover()`、`refreshExpiredEntitlement()` 及启动/后台 15s 恢复循环，并通过 `withLock` 串行化同步避免竞态；`verifyCragGeminiSlotPermit()` 对载荷密钥漂移抛出 `license_payload_key_mismatch`，`bindEnvironment()` 在 `payload_key_conflict` / `host_binding_conflict` 时自动带 `reissue: true` 重试换签；导出唯一事实来源 `RECOVERABLE_GEMINI_SEAT_CODES`（`license_required` / `license_binding_mismatch` / `license_expired` / `license_payload_key_mismatch`）供 `src/lib/gemini/scheduler.mjs` 复用自愈；`src/lib/gemini/routes.mjs` 新增 `POST /api/panel/gemini/crag-subscription/sync` 与 `GET ?sync=1` 并在拉取库存前自动恢复残留 `sync-pending`（#1825）。
  - `scripts/gemini-host.py` 与 `scripts/gemini_host_native.py` 不再将 `craggemini` 非零退出一律塌缩为 `license_invalid`，改为解析结构化 JSON/stderr 精确归因，识别 `sync-pending` 返回 `gemini_subscription_sync_pending`（HTTP 503），并在 `license_status()` 中比对 `CRAGS1`/`CRAGL1` 与 `manifest.json` 的 `payload.key_id`（向下兼容 `0.4.10` 二进制）（#1825）。
  - `web/src/lib/gemini-account-status.ts` 与 `web/src/features/import/gemini-environments.tsx` 区分「宿主订阅同步中」与「未激活」、提供「继续同步订阅」操作按钮，补齐 `license_payload_key_mismatch` / `gemini_subscription_sync_pending` 文案，并将失效席位按钮与指引统一为「重新绑定 CRAG 席位」（#1825）。
- **Gemini `gemini-4-carbon-high` 思考强度传播、`agy` 默认详略度与多协议对齐**：完善 `src/lib/gemini/model-catalog.mjs`、`src/lib/protocol/gemini-convert.mjs`、`src/lib/protocol/gemini-model-policy.mjs`、`src/lib/gemini/routes.mjs` 与 `scripts/gemini-host.py`，补齐 OpenAI Chat `reasoning_content` / `extra_body.google.thinkingConfig`、OpenAI Responses `configuration_update` / `reasoning.encrypted_content` 往返及 Anthropic 会话中段 `output_config.effort` / `redacted_thinking` 签名透传（#1823）。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）与 Gemini 宿主脚本（`scripts/gemini-host.py`、`scripts/gemini_host_native.py`）；`deploy/payload.json`（CRAG `3.1.20` 与 CRAGGemini `0.4.10`）、数据库迁移结构与 `bin/` / `share/wrap-cli` 均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；Gemini 宿主机同步脚本后需重启 `vm2api-gemini` 生效。

## 1.4.214 — 2026-11-25 · 钉选 CRAG 3.1.20 与 CRAGGemini 0.4.10；多 CLI 429 触发词归一化与 410/429 透传；Gemini 串行每小时健康缓存

- **CRAG 3.1.20 与 CRAGGemini 0.4.10 签名载荷全线升级**：
  - `deploy/payload.json` 与 `src/lib/admin/kernel-catalog.mjs` 升级 CRAG 至 `3.1.20`（`payload-2026.11.25-crag-3.1.20`，对应 `dofastted/crag@v3.1.20` PR `#26`），修复孤儿 transcript JSONL 回收（#1726）、首字节前 401 续跑可重试与 410 结构化 `details.reason`（#1215）及 `GET /api/oauth/usage` 转发（#1311），沿用生产授权锚（`9dbb4bc2…` / `835451e2…`）；同步在 `src/lib/core/errors.mjs` 对 `410 Gone` 按白名单透传 `details.reason`（`waiting_expired` / `handoff_expired` / `receipt_expired` / `cancelled`）（#1816）。
  - `deploy/payload.json` 升级 CRAGGemini 默认载荷至 `0.4.10`（`payload-2026.11.25-gemini-0.4.10`，对应 `dofastted/antigravity-cli-proxy@v0.4.10` PR `#12`），修复 MCP 冷启动同步等待、支持 OpenAI Responses `namespace` 工具（#1805）并捕获透传上游 429 `Retry-After`（#1769），沿用既有 CRAGGemini 授权锚（`f9572077…` / `d2470877…`）；同步更新 `scripts/gemini_host_native.py` 与 `scripts/gemini-host.py` 透传有界 `retry_after_ms` / `Retry-After` 至 `scheduler.mjs`（#1816）。
- **CRAGGemini 多 CLI 上游 429 触发文本归一化补全**：`src/lib/gemini/prompt-normalizer.mjs` 新增带代码围栏保护的幂等规则，覆盖二分定位的 4 项触发词——Claude Code `2.1.332` `<pasted_content>` 警告、官方 `pi`、`omp`（含 Hashline `UNSEEN. Re-read first.`）与 Codex CLI `0.171.0`，同步扩展 `detectCliFamily` 与 `LEADING_CLI_IDENTITY_RE`（#1816）。
- **Gemini 串行每小时健康探测缓存与设置页控制**：`src/lib/admin/health-probe.mjs` 扩展支持 `gemini-*` 模型（默认探测间隔 `3600s`、缓存 TTL `5400s`），跨全部入站协议（Google 原生、OpenAI Chat/Responses、Anthropic Messages 流式与非流式）与 CRAGGemini/API 通道直接命中缓存，全网关 Claude/OpenAI/Gemini 探测统一走单串行队列（`concurrency = 1`）；前端 **设置 → 探测 → 健康缓存**（`web/src/features/settings/health-pane.tsx`）新增 Gemini 开关、间隔、TTL、探测模型、快照展示与立即探测按钮（#1815）。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）、`deploy/payload.json`（CRAG `3.1.20` 与 CRAGGemini `0.4.10`）以及 Gemini 宿主脚本（`scripts/gemini-host.py`、`scripts/gemini_host_native.py`）；`bin/kin-kernel`、`share/wrap-cli` 与数据库迁移未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；Gemini 宿主机同步脚本并切换 `0.4.10` 加密载荷后需重启 `vm2api-gemini` 生效，CRAG `3.1.20` 经面板内核页或 `install.sh` 升级生效。

## 1.4.213 — 2026-11-25 · Google/Gemini 独立模型策略、`medium` 默认思考强度与模型/计费定价页接入

- **Google / Gemini 独立模型策略与 `medium` 默认思考强度**：新增 `src/lib/protocol/gemini-model-policy.mjs`（持久化键 `gemini_model_policy`），严格作用于 `gemini-*` 系列与 Gemini 槽位，缺省为所有 Gemini 模型启用 `default_effort: 'medium'`；新增 `GET/PUT/POST /api/panel/model-policy?platform=google`、`POST /api/panel/model-policy/sync-gemini` 与 `catalog-monitor` 定时同步（融合实时 Gemini 槽位、Gemini API 端点与 `models.dev` Google 目录）；在全部入站协议（`gemini`、`openai-chat`、`openai-responses`、`anthropic`）省略思考强度时自动注入默认 `medium`（显式指定强度或关闭思考时保持原样，且不破坏 CRAGGemini SHM 最小载荷约束），支持无后缀 Gemini 模型在 Antigravity 槽位解析到 `-medium` 档位，并在 `scheduler.catalog()` / `scheduler.stream()` 执行启停策略开关（#1811）。
- **模型页与计费页接入 Google 模型定价**：将 Google Gemini 模型接入 `pricing-view`、模型页 Google 供应商标签与「同步 Google」流程，并在计费页新增 Google 定价表与 `google/*` 价格覆写弹窗（#1811）。
- 部署说明：本次改动涉及控制面（`src/`）与前端（`web/src/`）；`deploy/payload.json` 载荷钉选（CRAG `3.1.18`、CRAGGemini `0.4.9`、最新 `kin-worker`）、`scripts/gemini-host.py`、数据库迁移结构与 `bin/` / `share/wrap-cli` 均未变，预期 `SLOT_SYNC=skip`，无需重启 `vm2api-gemini` 或既有 Claude/Codex 槽位。

## 1.4.212 — 2026-11-25 · Gemini 槽位面板控制与视图全面对齐；`/crag-subscription` 自动识别 CRAGGemini `CRAGR1` 兑换码

- **Gemini 槽位面板控制与视图与 Claude/GPT 槽位全面对齐**：新增 `src/lib/gemini/slot-prefs.mjs`（基于 `SettingsRepo` `gemini_slot_prefs` 持久化 `schedulable`、`schedule_level` P1–P10 与 `display_name`，无需数据库迁移）并接入 `createGeminiScheduler` 调度与熔断/冷却清理；扩展 `GET /api/panel/gemini` 返回用量、费用、健康度、在途请求、调度与限制状态，新增 `/health`、`/stats`、`POST /schedulable`、`PATCH /prefs`、`POST /recover`、`PATCH /owner` 接口；前端补齐 Gemini 主题样式、`CRAGAnti` 标识、`VmTable` / `VmRowDetail` / `VmBlade` / `VmUnit` / `FleetPulse` / `VmStatsDialog` / `VmActionMenu` 及详情弹窗内联调度与基础配置表单（#1806）。
- **订阅页主兑换框自动识别 CRAGGemini `CRAGR1` 兑换码**：`web/src/features/billing/crag-shop.tsx` 在 `/crag-subscription` 主输入框提交 `CRAGR1.<43>` 时，优先尝试 Claude CRAG 兑换；仅在 Claude 返回 `redeem_unavailable` 或 `crag_subscription_host_package_unready`（未消耗任何额度）时自动回落至 `/api/panel/gemini/crag-subscription/redeem`，成功即激活 CRAGGemini 宿主订阅并刷新 Gemini 环境库存，明确冲突/载荷错误准确透出，双侧账本保持完全隔离（#1807）。
- 部署说明：本次改动涉及控制面（`src/`）与前端（`web/src/`）；`deploy/payload.json` 载荷钉选（CRAG `3.1.18`、CRAGGemini `0.4.9`、最新 `kin-worker`）、`scripts/gemini-host.py`、数据库迁移结构与 `bin/` / `share/wrap-cli` 均未变，预期 `SLOT_SYNC=skip`，无需重启 `vm2api-gemini` 或既有 Claude/Codex 槽位。

## 1.4.211 — 2026-11-25 · 载荷全线对齐最新构建（CRAG 3.1.18 与最新 `kin-worker`）

- **CRAG 签名载荷升级至 `3.1.18`**：`deploy/payload.json` 的 `crag_release` 升级至 `payload-2026.11.25-crag-3.1.18`（对应 `dofastted/crag@v3.1.18`），整合 PR `#24`（中断工具续接 30 秒冷却防抖、最多 2 次有界冷恢复与 409 结构化诊断元数据，配套 `vm2api` `#1705`）与 PR `#25`（3.1.17 非流式/合成 SSE `safeguard_results` 透传），沿用既有生产信任锚（`9dbb4bc2…` / `835451e2…`）与官方 Claude Code `2.1.321`；同步更新 `src/lib/admin/kernel-catalog.mjs` 的 `CRAG_PINNED_RELEASES`。
- **重编并钉选最新 Linux amd64 `kin-worker`**：`deploy/payload.json` 的 `release` 升级至 `payload-2026.11.25-worker-oauth-guard`，`bin/kin-worker` 更新为最新 `worker/` 源码编译产物（包含 `90b8c1210` 代理回退、`fbb7cc8a0` `--attempt-guard` 节点侧刷新防重放日志、`f51d809b0` `guard-probe` 自愈探针与 `730414a57` 凭证去 `email`）；其余槽位与辅助载荷（`cli-node 2.1.321`、`kin-oauth-auth` Chrome 133 TLS、`kin-kernel`、`kin-egress`、`kin-codex-kernel`、`kin-computer`、`kin-slot-gate` 与 `CRAGGemini 0.4.9`）均为最新指向。
- 部署说明：本版仅更新 `deploy/payload.json`、`src/lib/admin/kernel-catalog.mjs` 与版本号（`VERSION` / `CHANGELOG.md`）；前端、数据库迁移与 `scripts/gemini-host.py` 未变。`bin/kin-worker` 字节变更，既有槽位需按维护窗口同步/重启后启用新版 `guard-probe` 与刷新防重放日志；CRAG `3.1.18` 经面板内核页或 `install.sh` 升级生效；`CRAGGemini 0.4.9`、`cli-node`、`kin-kernel` 与 `kin-oauth-auth` 字节未变。

## 1.4.210 — 2026-11-25 · Codex 借槽稳定出站会话；Gemini 诊断校验实际配置 egress 与保留核验链接；面板详情按需展示 Claude 官方侧额度差异

- **Codex 借用非 home 槽时在当前绑定代次内稳定 `outbound_session_id`**：修复 home 槽仍在池中且并发满、请求借用其他槽位时，因 `attemptStartedAt` 参与 `epoch` 导致每次借用都重铸 `outbound_session_id` / `prompt_cache_key` 并打散 prompt cache 的问题；`handleCodexProtocol` 仅在 live home 存在且选中非 home 槽时按 `(sessionKey, homeVm, homeSession, generation, borrowerVm)` 派生稳定材料，保持不迁移 home、跨借用槽隔离、迁移换代自动刷新以及 `passthrough` 行为不变（#1787，修 #1771）。
- **Gemini 维护诊断校验服务单元实际配置的 `--egress` 可执行文件**：修复 `scripts/gemini-maintenance.py` 的 `Maintenance.inspect()` 硬编码检查 `runtime/bin/kin-egress`，导致全新 `install.sh install` 部署后因单位配置为 `INSTALL_DIR/bin/kin-egress` 而必报 `gemini_maintenance_egress_invalid`（以及残留旧 `runtime` 副本掩盖已损坏配置路径）的问题；改为读取受管 unit 的规范化 `--egress` 路径并沿用原有 root 属主、不可写、哈希钉选与可执行校验（#1795，关联 #1770）。
- **已订阅 Gemini 账号保留安全 Google 核验链接并避免误告警**：`scripts/gemini_host_account.py` 在 `paidTier` / `currentTier` 非空时不改变原有非阻断 `parse_ineligibility` 语义，独立提取安全的 `VALIDATION_REQUIRED` 官方验证链接至 `account.validation_url`；`scripts/gemini-host.py` 在账号已通过真实推理验证（`inference_proven`）后的刷新中同步清除替代套餐的残留 `validation_url`（不误清 `location_unsupported` 等阻断）；前端将纯参考链接标记为 `advisory`，在机架/列表页不覆盖正常状态或挂黄标，在账号页与试聊页以中性样式提供验证入口（#1794，回应 #1766）。
- **面板详情按需展示 Claude 官方侧与保守合并两套额度存储**：`src/lib/admin/panel-api.mjs` 在账号与 VM 投影中增加白名单只读字段 `quota_observations`（不改调度准入、保守合并规则或触发额外上游请求，槽位换绑时隔离旧账号快照）；前端仅在详情面板、行展开详情与统计弹窗中当官方侧存储与当前展示值存在差异或官方窗口陈旧时渲染折叠对比，不影响机架主卡三行基线对齐，并明确标注官方侧为可变存储状态（#1792，回应 #1776）。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）与 Gemini 宿主脚本（`scripts/gemini-host.py`、`scripts/gemini_host_account.py`、`scripts/gemini-maintenance.py`）；`deploy/payload.json` 载荷钉选（CRAG `3.1.17`、CRAGGemini `0.4.9`）、数据库迁移结构与 `bin/` / `share/wrap-cli` 均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；Gemini 宿主机如需生效 `pinned_egress` 诊断与核验链接修复，需执行 `install.sh prepare-gemini` 同步宿主脚本。

## 1.4.209 — 2026-11-25 · CRAGGemini 多 CLI 提示词统一归一化；上游 400/403 纳入单元熔断；托管密钥直从面板限额；空 effort 默认回落与巡检对齐

- **CRAGGemini 多 CLI 提示词统一归一化管线**：新增 `src/lib/gemini/prompt-normalizer.mjs` 作为唯一事实来源，覆盖 15+ 主流编码 CLI（Claude Code、Codex CLI、OpenCode、Gemini CLI、Cursor、Cline、Roo Code、Kilo Code、Windsurf/Cascade、Aider、GitHub Copilot、Continue、Amp、Factory Droid、Hermes、OpenClaw、Oh-My-Pi）经四协议进入 CRAGGemini 通道的提示词清洗与去冲突；跨供应商计费行剥离与语义归一化统一保护 Markdown 代码围栏（`` ``` `` / `~~~`），范围扩展至 `contents` 内嵌系统封装与 `tools[].functionDeclarations[].description`，并在 `official_full` 模式采用成对标签匹配消除 `agy 1.5.9` 宿主标签冲突（不误伤 TypeScript 泛型）；`routes.mjs` 缺省执行归一化并上报脱敏 `hop_meta.prompt_normalization` 遥测，新增 `routing.compatibility.craggemini_prompt_normalization`（`auto` | `strict` | `off`）及 `panel-api.mjs` 校验，直连 Gemini API 密钥通道与普通用户文本保持原样（#1793）。
- **上游 400 与 403 失败纳入单元熔断计数**：Claude VM（`upstream-error-policy.mjs`、`failover-runner.mjs`）将上游 400（`invalid_request`、`credential_refresh_failed`、`organization_disabled` 及修复后仍 400）与上游 403（`permission_denied`、`proxy_or_edge_forbidden`、`fable_plan_denied`、`organization_disabled`）计入 `UnitCircuit` 连续失败次数（`invalid_request` 仍维持不切号直接返回 400，本地校验/能力拒绝、`license_*`、内容安全/AUP 与首次可修复 400 不计入）；Gemini 调度器（`scheduler.mjs`）将 `gemini_invalid_request`（400）及 `gemini_location_unsupported`、`gemini_account_verification_required`、`gemini_account_ineligible`（403）移出 `NON_CIRCUIT_FAILURES` 计入单账号熔断（半开探针命中时重开熔断）；同步面板熔断文案与 `docs/gemini-host.md` 为 `400/403/5xx`（#1796）。
- **托管密钥按面板并发/RPM 限额执行，不再被内置 60 网关令牌桶误拦**：`src/server.mjs` 的 `requireAuth()` 在托管密钥通过 `apiKeyStore.canAccept()` 后不再额外套用默认 `KIN_RATE_CAP=60` 网关令牌桶，避免面板配置无限制或高于 60 的并发/RPM 被静默截断；主环境密钥仅在显式配置 `KIN_RATE_CAP` 时启用令牌桶限流，同步更新 `config.mjs`、`security.mjs` 与 `docs/API.md`（#1790）。
- **空 `effort` 按省略处理并统一回落模型默认强度**：跨 Anthropic Messages、OpenAI Chat/Responses、Codex、Gemini、CRAG 白名单/打印提示词、API 渠道、协议 beta、分类器校验与请求日志，将空串、纯空白与 `null` 的 `effort` 统一视作省略；在边界剥离空的 `output_config.effort` 与 `crag_options.effort`，统一由 `resolveModelDefaultEffort` 按「面板 `default_effort` → 模型目录默认 → `high`」回落（`off` 仅剥离不注入）（#1791）。
- **文本与语义对齐巡检修复（run 3）**：SQLite → PostgreSQL 迁移脚本与 mock 种子库补齐 `gemini_environment_owners` 表；PostgreSQL 仪表盘聚合器改为在蓝绿激活阶段（`runAtActivation('background')`）启动并于 `onLeaderStop` 停止（清理 `kickoff` 定时器）；Responses WebSocket 握手与错误帧保留 `Retry-After` 头与 `error.details` 元数据；前端密钥管理弹窗保留 `category: 'all'` 与 `permission_tier: 'tenant'` 语义不再误降级或误拦保存；系统提示词页接入 `craggemini_system_prompt` 超长 `SaveBar` 拦截与分标签真实保存 Toast，后端复用 `CRAGGEMINI_PERSONA_PRESETS` / `CRAGGEMINI_SYSTEM_PROMPT_MAX` / `KEY_CATEGORIES` 常量；修正 Gemini 禁用态文案（`403 gemini_disabled`）、粘性 TTL 零值语义（不保留）、旧菜单名「设置 → Gemini 维护」与多处文档，并清理零引用的旧 `api-endpoints` 组件及 `withPgTransaction` / `publicModelId` 死代码（#1781）。
- 部署说明：本次改动涉及控制面（`src/`）、前端（`web/src/`）、迁移/校验脚本（`scripts/migrate-sqlite-to-pg.mjs`、`scripts/seed-mock-sqlite.mjs`、`scripts/verify-craggemini-sessions.mjs`）及 `deploy/install.sh` / 文档；`deploy/payload.json` 载荷钉选（CRAG `3.1.17`、CRAGGemini `0.4.9`）、`scripts/gemini-host.py` / `gemini-maintenance.py`、数据库迁移结构与 `bin/` / `share/wrap-cli` 均未变，预期 `SLOT_SYNC=skip`，无需重启 `vm2api-gemini` 或既有 Claude/Codex 槽位。

## 1.4.208 — 2026-11-25 · 修复 Claude Code 系统提示词中双用途安全工具括注触发 Google 上游 429 误判

- **修复 CRAGGemini 出站 `systemInstruction` 另一处 Claude Code 指纹触发 429**：对失败的真实 `claude-cli` 43KB 系统提示词逐段与逐句二分实测确认，除 `You are Claude Code` 横幅外，Google Antigravity 上游还会对 Claude Code 内置安全提示中的固定句式 `Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context` 直接返回 `429 RESOURCE_EXHAUSTED`（其余 80 个系统段落、37KB 对话内容与全部工具声明均返回 `200 OK`）。`src/lib/gemini/system-prompt.mjs` 在 `sanitizeCragGeminiSystemText()` 中将该括注归一化为 `Dual-use security tools require clear authorization context`，完整保留安全约束语义并消除 `claude-cli` 误触 429。
- 部署说明：本次改动仅涉及控制面 `src/lib/gemini/system-prompt.mjs` 与单测；前端、`scripts/gemini-host.py`、CRAG/CRAGGemini 载荷钉选、数据库结构与 `bin/` / `share/wrap-cli` 均未变，预期 `SLOT_SYNC=skip`，无需重启 `vm2api-gemini` 或既有 Claude/Codex 槽位。

## 1.4.207 — 2026-11-25 · 修复 CRAGGemini 入站第三方 CLI 系统身份横幅触发 Google 上游 429 误判

- **修复 CRAGGemini 出站 `systemInstruction` 第三方 CLI 身份横幅触发 429**：实测确认 Google Antigravity 上游对 `systemInstruction` 中大小写不敏感的 `You are Claude Code` / `You are OpenCode` 直接返回 `429 RESOURCE_EXHAUSTED`（即使账号配额 95–100% 且切号重试全部账号均失败）。`src/lib/gemini/system-prompt.mjs` 在 `applyCragGeminiPromptPolicy()` 中对 CRAGGemini 出站 `systemInstruction` 自动将冲突的第三方 CLI 身份声明归一化为 `You are a coding assistant`，保留其余全部指令不变，消除 `claude-cli` / OpenCode 请求误触 429。
- 部署说明：本次改动仅涉及控制面 `src/lib/gemini/system-prompt.mjs` 与单测；前端、CRAG/CRAGGemini 载荷钉选、数据库结构与 `bin/` / `share/wrap-cli` 均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位。

## 1.4.206 — 2026-11-25 · 修复 Gemini 429 跨账号切号与冷却隔离；`apply-policy` 热同步空闲回收与预热槽位

- **修复 Gemini 429（`RESOURCE_EXHAUSTED`）切号与冷却缺陷**：
  - `src/lib/gemini/scheduler.mjs` 与 `src/lib/gemini/routes.mjs` 修复首字节/内容输出前的 `start` / `meta` SSE 帧误置 `emittedOutput` 阻断跨账号切换的问题，仅在下游实际写出响应头或收到内容事件时才禁止切号；
  - `all_cooled_probe` 严格保留按最早冷却过期时间排序的探测顺序，避免被 `poolScheduler.reserveExternalCandidates()` / 字母序覆写并锁死在同一账号序列；同时在每次尝试开始时更新 `lastUsed`，确保失败场景下均衡轮转生效；
  - 被动 429 冷却收口至单模型维度（`modelCooldowns`），避免单个模型（如 `gemini-4-neon-xhigh`）限流误伤同账号下其它健康模型，同时保留主动 0% 配额组冷却；
  - `known(error)` 保留 `upstreamStatus`、`retryAfterMs`、`retryAfter`、`timing`、`usage`、`details`，并解析上游 429 响应的 `retry_after_ms` / `Retry-After` 指导冷却时长。
- **修复 `scripts/gemini-host.py` 策略热同步**：`NativeSession.apply_policy()` 与 `CragDaemonShard.apply_policy()` 在 `PUT /internal/v1/policy` 成功后同步调用 `POST /internal/v1/accounts/<id>/scale` 推送 `idle_ttl_secs` 与 `min_warm_slots`（`concurrency-set` 与 `sync_account` 同步携带 `min_warm_slots`），修改 `session_idle_ttl_secs` 等池参数立即对运行中账号生效，无需重启 `vm2api-gemini`。
- 部署说明：本次改动覆盖控制面 `src/lib/gemini/scheduler.mjs`、`src/lib/gemini/routes.mjs` 及 Gemini 宿主机脚本 `scripts/gemini-host.py`；前端、CRAG/CRAGGemini 载荷钉选、数据库结构与 `bin/` / `share/wrap-cli` 均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；需同步 `scripts/gemini-host.py` 到宿主机并重启 `vm2api-gemini` 与 `vm2api-gemini-maintenance`，再灰度/覆盖发布控制面 `v1.4.206`。

## 1.4.205 — 2026-11-25 · CRAGGemini 0.4.9 MCP 桥内部暴露名称收口为 `crag`（`mcp_crag_*`）

- **CRAGGemini 0.4.9 MCP 桥命名收口**：`deploy/payload.json` 的 `geminiDefaultLinuxAmd64` 升级至 `payload-2026.11.25-gemini-0.4.9`。MCP 桥服务名由 `craggemini` 统一收口为 `crag`，`agy` 内部工具暴露前缀统一为 `mcp_crag_<tool>`（不再携带详细 `gemini` 后缀）；写入 `mcp_config.json` 时自动清理旧版 `craggemini` 条目避免重复挂载，同时保留对历史前缀的兼容剥离。
- 部署说明：仅更新 `deploy/payload.json` 中 `geminiDefaultLinuxAmd64` 载荷钉选（`0.4.8 → 0.4.9`）与版本号，控制面代码、前端、CRAG 内核钉选（`3.1.17`）、数据库结构及 `bin/` / `share/wrap-cli` 字节均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；Gemini 宿主机同步 `0.4.9` 载荷后重启 `vm2api-gemini` 与 `vm2api-gemini-maintenance`。

## 1.4.204 — 2026-11-25 · CRAGGemini 0.4.8 Pool 模式每槽位 MCP 工具桥接；`control.sock` 并发队列扩容与 `IncompleteRead` 收口

- **CRAGGemini 0.4.8 修复客户端工具 MCP 桥接（消除 `502 gemini_tool_call_required`）**：`deploy/payload.json` 的 `geminiDefaultLinuxAmd64` 升级至 `payload-2026.11.25-gemini-0.4.8`。`craggemini` 加密引导程序通过共享同步模块 `mcp_stdio` 直接短路执行 `--internal-mcp`（消除对 `mcp-bridge.json` 误走 `vm_id="standalone"` 授权校验导致的 `license_binding_mismatch` 与重复 memfd 解密）；Pool 模式启动 `AgySlot` 前自动并发安全地写入 `mcp-bridge.json` 与 `<agy_home>/.gemini/config/mcp_config.json`，并通过 `CRAGGEMINI_SLOT_ID → X-Craggemini-Slot-Id` 将 `/internal/mcp/*` 路由至对应槽位独立的 `McpCoordinator`；提交 prompt 前同步等待 `agy` 完成 `tools/list` 刷新（含空工具回合清理），并修复多会话并发下的 `ToolContinuation` 挂起工具匹配（#1775）。
- **CRAGGemini 宿主并发队列与流式异常收口（消除 10 并发突发 `503 gemini_host_unavailable`）**：`scripts/gemini-host.py` 将 `ThreadingUnixStreamServer.request_queue_size` 由 Python 默认 5 提升至 128，并将主 accept 循环中的 `host.cleanup()` 节流至 `>= 0.25s`，防止高并发突发溢出内核连接队列；`_stream_native_infer` 与 `scripts/gemini_host_native.py` 补全捕获 `http.client.HTTPException`（如 `IncompleteRead`）并统一收口为 `502 gemini_inference_failed`（#1775）。
- 部署说明：本版涉及 CRAGGemini 宿主脚本（`scripts/gemini-host.py`、`scripts/gemini_host_native.py`）与 `deploy/payload.json` 中 `geminiDefaultLinuxAmd64` 载荷钉选（`0.4.7 → 0.4.8`）。控制面代码、前端、CRAG 内核钉选（`3.1.17`）、数据库结构及 `bin/` / `share/wrap-cli` 字节均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；Gemini 宿主机需同步宿主脚本并更新 `0.4.8` 载荷后重启 `vm2api-gemini` 与 `vm2api-gemini-maintenance`。

## 1.4.203 — 2026-11-25 · CRAGGemini 0.4.7 故障转移与宿主网络加固；省略 `cache_control.ttl` 按路由配置补齐；托管 Key 超限响应统一；Claude 重置后预重置配额头对账与 Codex 自定义时长窗口

- **非透传请求省略 `cache_control.ttl` 按 Web 路由配置补齐**：修复未声明 `ttl` 的 `cache_control` 被误作隐式 `5m`、在 CRAG V3 / HTTP hop 级联降级及未热读磁盘 `routing.json` 的问题；官方透传继续保留调用方省略的 TTL，补齐 `politeEphemeral` 类型校验与 `workerEnvelope` 对 `crag_options.cache_ttl` 的回退读取（#1772）。
- **托管 API Key 超限响应统一为 `402`/`429` 并附限额元数据与 `Retry-After`**：USD 总额度与滚动消费窗口超限统一返回 `402`，请求数 / RPM / 并发保持 `429`，在 `error.details` 与 `/v1/me/quota` 的 `blocked_by` 补充 `limit_type`、`current`、`limit`、`remaining`、`reset_at`、`retry_after` 与 `Retry-After` 响应头，同时保留旧 `error.type` 兼容、修正双配额及下调 RPM 边界，并在 Gemini 路由保持 `publicError()` 基础设施脱敏边界（#1765）。
- **Claude 确认配额重置后对账预重置头与单飞缓存隔离**：在 `AccountQuota` 持久化按账号/窗口的 `reset_boundaries` 与 `applied_reset_ops`，屏蔽重置前在途请求/探测/晚到 429 的旧高利用率与旧冷却覆盖；修补 `FailoverRunner` 预重置 429 跳过冷却、`usageCache` `clear()` 失效在途 flight 并按真实上游请求打标时序、以及重置后有效 `0%` 探测同步清理预重置 `rate_limit_reset_at`（#1758）。
- **Codex 配额窗口按实际时长分类并忽略 0 分钟记录**：按正向 `window_minutes` 归类 `5h` / `24h` / `7d` 等自定义时长窗口、过滤 `<= 0` 分钟异常记录，同步更新调度排序、本地闸线、`oauth-credentials.mjs` `isQuotaParkReason()` 及前端机架/配额/弹窗视图，并保持无 `window_minutes` 历史快照兼容（#1764）。
- **CRAGGemini 0.4.7 载荷升级、首字节前 502/504 故障转移与可观测性**：`deploy/payload.json` 钉选 `payload-2026.11.24-gemini-0.4.7`，补齐首字节前 502/504 跨账号切换、被动冷却账号回退与请求尝试记录（#1763）；修复 `scripts/fetch-default-gemini.py` 校验远程 manifest 时错误要求 `manifest.json` 自哈希导致远程拉取失败的问题（#1767）。
- **CRAGGemini 宿主网络中继与早期退出快失败**：`scripts/gemini-host-egress.sh` 与 `scripts/gemini-host.py` 改为宿主机 OUTPUT 中继转发 netns 出口流量并上报脱敏的认证失败阶段（中继句柄命名为 `egress_relay` 避免遮蔽 `Terminal.relay()`）（#1761）；`craggemini` 早期退出时以有界 stderr 排空与白名单分类（`invalid_config` / `license_error` / `bind_failed`）快速失败，零原始 stderr 泄露，并在 `read_exit_detail()` 中优先尊重注入的 `native_exit_reader`（#1760）。
- **CRAG v2 槽位工作目录迁至 guest tmpfs 避免 9p 写回卡死**：`docker/kin-kvm/guest/kin-crag-apparmor` 为 `kin-kernel.service` 安装受管 drop-in `45-vm2api-crag-work.conf`，启动前防符号链接跟随并以原子 `uid/gid` 选项将 guest tmpfs 挂载到 `/run/kin/work`（`mode=0700,size=256m,nosuid,nodev`），挂载失败自动退回原 9p 目录，离开 CRAG v2 时清理 drop-in，老 guest 镜像无需重建、下次 CRAG 启动即生效（#1741）。
- **蓝绿部署支持只加型 SQLite 迁移无停机放行**：新增 `deploy/bluegreen/migration-guard.mjs` 并接入 `bg-deploy.sh` 与 `docs/BLUEGREEN.md`，在确认新增 SQLite 迁移仅包含安全加表/加列/小表索引时保持零停机蓝绿切换；全路径闭失败校验已存在表、已有表 `CHECK`/`NOT NULL DEFAULT NULL`、缺失 DB 文件与升级引擎回退逻辑（#1762）。
- 部署说明：本版涉及控制面、前端、蓝绿部署脚本（`deploy/bluegreen/`）、CRAG guest 挂点脚本（`docker/kin-kvm/guest/kin-crag-apparmor`）、CRAGGemini 宿主脚本（`scripts/fetch-default-gemini.py`、`scripts/gemini-host-egress.sh`、`scripts/gemini-host.py`、`scripts/gemini_host_native.py`）与 `deploy/payload.json` 中 `geminiDefaultLinuxAmd64` 载荷钉选（`0.4.6 → 0.4.7`）。CRAG 内核钉选（`3.1.17`）、数据库结构及 `bin/` / `share/wrap-cli` 字节均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位；Gemini 宿主机需执行 `install.sh prepare-gemini` 同步宿主脚本与 `0.4.7` 载荷。

## 1.4.202 — 2026-11-24 · 强制函数调用未兑现时明确失败；上游 modelVersion 如实透出；`service_tier` 能力边界显式化

- **`mode=ANY` / 必需 `tool_choice` 却无函数调用时明确失败**：此前上游以 `STOP` 结束且零 `functionCall` 时,网关仍按成功回复返回 `200`,依赖函数回调交付消息的客户端表现为「模型有输出但没发消息」。现把强制工具意图经 `restoreContext.toolChoice` 传到能观察响应的调度层,在未兑现时返回 `502 gemini_tool_call_required`（已登记进 `FAILURES` 并归入不熔断集合,不会被当作瞬时故障在账号间反复重试）；`AUTO` 的纯文本成功与真实函数调用均不受影响（#1750,修 #1732）。
- **上游报告的 `modelVersion` 如实透出并标记错配**：区分「请求的」`requested_model`、「派发的」`dispatched_model` 与「回来的」`response_model`,客户端收到的 `modelVersion` 取上游真实值而非静默替换,同时在 `usage_logs` 写入 `model_mismatch`。流式、非流式与尾块错配三种路径一致,无错配时 `model_mismatch = 0`（#1747,修 #1728）。
- **`service_tier` 的能力边界显式化**：传入 `service_tier: "standard_only"` 而所选 CRAG 内核未声明 `request_service_tier` 能力（以及所有 `cli-node` 路径）时,预检阶段直接返回 `400 unsupported_capability`（`error.param = "service_tier"`,`error.details.execution_path` 标明 `crag` 或 `claude_vm`,`retryable: false`,零上游执行）,**不再静默移除或改写为 `auto`**；内核声明该能力后原样透传（#1752,回应 #1520）。
- **日志新增 `failed_only` 过滤**：覆盖「非 2xx」、「`final_state` 非 `verified`」与「带错误码」三类,因此能捞出已提交响应头后才失败的 `200` 流式请求;既有 `exclude_status_200` 行为不变（#1753,修 #1213）。
- **文档**：补充自托管载荷、公钥与兑换渠道的说明（#1745）。
- 部署说明：本版仅涉及控制面与前端（`src/lib`、`web/src`、`docs/`）。`deploy/payload.json` 的载荷钉选（CRAG `3.1.17`、CRAGGemini `0.4.6`）、`scripts/`、`bin/`、`share/wrap-cli` 与数据库结构均未变,预期 `SLOT_SYNC=skip`,无需重启既有槽位,也无需执行 `install.sh prepare-gemini`。

## 1.4.201 — 2026-11-24 · 热修：CRAGGemini 恢复剥离 `safetySettings`；未验签载荷不再挡住内核页的升级

- **热修：`target: 'antigravity'` 恢复剥离 `safetySettings`,不再返回 400**（revert `#1735`）：常见 Gemini SDK 与 GUI 客户端（Cherry Studio、Vercel AI SDK `@ai-sdk/google` 等）会给**每个**请求自动附上 5 条 `BLOCK_NONE` 的默认 `safetySettings`。`#1735` 对非空 `safetySettings` 一律以 `400 gemini_unsupported_turn` 拒绝,使这些客户端在 CRAGGemini OAuth 账号上开箱即坏。现恢复 `#1718` / `#1733` 的行为:CRAGGemini 通道干净剥离该字段并保留入站调试捕获,Gemini API key 通道照旧原样转发给上游（#1754）。
- **未验签的已装载荷不再让每个发布都显示“不兼容”**：在维护守护进程之外安装的 CRAGGemini 载荷身边没有验签资产（无 `manifest.sig`、`gemini-ed25519.pub`、`gemini-release.json`）,`cached_payload()` 因此返回空,`payload_status()` 让 `version` / `cli_version` 保持 `None`,`can_update()` 的 `installed is not None` 失败关闭,于是 `compatible` 恒为 `false`——`1.4.200` 新增的内核页 CRAGGemini 安装/更新/回滚在这类宿主上无法执行,而它是唯一带备份与回滚的升级路径。现从已装 manifest 自报的 `software_version` 读出版本,**仅供“不往低版本降”的序关系比较**；`state` 继续是 `unverified`、`issue` 原样保留,目标载荷仍做完整验签才会替换任何东西。CRAG manifest 无 `cli_version` 字段,仅当其自身 `sha256` 映射记录的 `agy` 正是本发布钉住的那个时才按钉住的 CLI 排序,否则 CLI 保持未知而不假定（#1746）。
- 部署说明：本版仅涉及控制面与 CRAGGemini 维护守护进程脚本（`scripts/gemini-maintenance.py`）。`deploy/payload.json` 的载荷钉选（CRAG `3.1.17`、CRAGGemini `0.4.6`）、数据库结构与 `bin/` / `share/wrap-cli` 字节均未变,预期 `SLOT_SYNC=skip`,无需重启既有 Claude/Codex 槽位。`scripts/` 不在 `remote-apply.sh` 应用范围内:本条修复位于维护守护进程中,需在宿主机执行 `install.sh prepare-gemini` 更新维护代理后才会生效,随后方可在内核页对 CRAGGemini 执行远程版本升级。

## 1.4.200 — 2026-11-24 · 内核页新增 CRAGGemini 安装、远程版本更新与回滚

- **内核管理页（`/wrap`）追加 CRAGGemini 内核安装与更新**：在“可用内核”区块新增宿主机级 `CRAGGemini` 行，展示当前载荷状态、版本、订阅与环境计数，支持选择官方远程发布或锁定版本执行安装、更新、锁定版本一键升级与回滚，实时展示维护作业阶段与中文错误说明；共享维护常量、阶段/错误映射与版本比较工具收敛至 `web/src/features/settings/gemini-maintenance.ts`，与设置页复用单一真值源（#1748）。
- **后端发布列表与锁定版本透出**：`GET /api/panel/kernels/releases` 新增校验完整的官方 `payload-YYYY.MM.DD-gemini-X.Y.Z` 发布列表（`craggemini`），`GET /api/panel/kernels` 追加 `deploy/payload.json` 的 `gemini_pin`（保持既有 Claude VM `kernels: ['cli-node', 'crag']` 不变），`src/lib/gemini/maintenance.mjs` 按需透传宿主机维护代理的 `supports_remote_releases` 能力标记（#1748）。
- **宿主机远程载荷拉取与空闲预热池静默**：`scripts/fetch-default-gemini.py` 与 `scripts/gemini-maintenance.py` 支持拉取并校验官方远程 CRAGGemini 发布（严格锚定宿主机 root-owned `deploy/payload.json` 的 Ed25519 公钥指纹，限制可信 GitHub HTTPS 域名与下载大小上限，并复用已校验 `agy`）；`scripts/gemini-host.py` 新增仅限 `uid == 0` 的 `/maintenance-quiesce`，升级前先回收空闲常驻预热池（有活跃推理/终端/认证时返回 `busy` 不打断），避免空闲常驻池触发 `409 gemini_maintenance_busy`（#1748）。
- 部署说明：本版涉及控制面、前端与 CRAGGemini 宿主脚本（`scripts/fetch-default-gemini.py`、`scripts/gemini-host.py`、`scripts/gemini-maintenance.py`）；`deploy/payload.json` 载荷钉选（CRAG `3.1.17`、CRAGGemini `0.4.6`）、数据库结构与 `bin/` / `share/wrap-cli` 字节均未变，预期 `SLOT_SYNC=skip`，无需重启既有 Claude/Codex 槽位。`scripts/` 不在 `remote-apply.sh` 应用范围内：仅更新控制面时内核页会自动识别旧版维护代理并降级为本地随包版本安装，需在宿主机执行 `install.sh prepare-gemini` 更新维护代理与宿主脚本后，远程版本拉取与空闲预热池静默能力才会生效。

## 1.4.199 — 2026-11-24 · CRAG 内核 pin 确认为 3.1.17

- **CRAG 内核 pin 保持 `payload-2026.11.24-crag-3.1.17`**：`deploy/payload.json` 与 `v1.4.197` 逐字节一致。开发过程中曾短暂改钉 `payload-2026.11.19-crag-3.1.7`（未发布的 `1.4.198`），经确认 `3.1.17` 才是预期下发的内核，已还原。
- **撤回未发布的 `1.4.198` 中「`v1.4.197` 不要部署」的说明**：该说明不成立。`v1.4.197` 的 CRAG pin 与本版相同，内容无问题；`1.4.198` 未打 tag、未发布。
- 其余内容与 `v1.4.197` 一致，详见下方该版条目。
- 部署说明：CRAGGemini 载荷钉 `payload-2026.11.24-gemini-0.4.6`，两个数据库迁移（SQLite `068`、PostgreSQL `005`）对存量部署为无操作，`bin/` 字节未变（预期 `SLOT_SYNC=skip`）。`share/crag/kernels/` 与 `share/gemini/` 均**不在** `remote-apply.sh` 的应用范围内：CRAG 内核随 `install.sh` / 面板内核管理生效，CRAGGemini 载荷与宿主脚本需执行 `install.sh prepare-gemini`。

## 1.4.197 — 2026-11-24 · CRAGGemini 0.4.6 与 CRAG 3.1.17 载荷升级；集成 API 与多层密钥归属隔离；PG 一键安装加固

- **CRAGGemini 通道精简与账号会话隔离，载荷钉到 0.4.6**：`deploy/payload.json` 的 `geminiDefaultLinuxAmd64` 由 `payload-2026.11.24-gemini-0.4.4` 升级到 `payload-2026.11.24-gemini-0.4.6`；精简 CRAGGemini 的 SHM 入站路径、隔离各账号会话，并新增 `scripts/verify-craggemini-sessions.mjs` 会话校验脚本（#1733）。
- **零信任协议白名单清洗与 CRAG 3.1.17**：`crag_release` 由 `payload-2026.11.23-crag-3.1.14` 升级到 `payload-2026.11.24-crag-3.1.17`，新增 `src/lib/protocol/crag-whitelist.mjs` 对出站协议做白名单清洗，并支持 2.1.330 的 Auto Mode（#1731）。
- **通用外部集成 API 与多层推理密钥权限隔离**：新增 `/api/integration/v1/*` 独立集成令牌体系（`sk-int-*`，仅落库 HMAC-SHA256 哈希），默认仅允许本机回环直连并按需放开 `allow_remote` + IP 白名单；推理密钥引入 `platform` / `tenant` / `resource` 三层权限与双向归属隔离，写侧跨归属域绑定返回 `403 scope_owner_mismatch`，运行时在 `ApiScheduler`、`api-protocol`、`handle-protocol`、`gemini/scheduler`、`gemini/routes` 与 `/v1/models`、`/v1beta/models` 统一过滤（#1730）。
- **PostgreSQL 一键安装加固与 SQLite 无缝迁移**：加固 PG 一键安装路径、依赖自动准备与由 SQLite 平滑迁移的流程（#1712）。
- **宿主不再向过旧载荷下发它拒绝的内核配置键**：`#1704` 起宿主会把九个调度 / SHM 键写进 `kernel.json`，但这些键只有 0.4.5 及以后的载荷接受，而当时钉住的仍是 0.4.4——于是 `v1.4.193`～`v1.4.196` 发布的宿主脚本会让自己钉住的载荷拒绝配置，worker 在桥接握手前退出并对外表现为 `gemini_native_bridge_timeout`。现按载荷版本下发：只有确实读出低于 0.4.5 的版本才不下发这些键，缺失或读不出版本时保持原行为，不静默降级；同时 `CragDaemonShard` 分片路径（`#1704` 新增、无旧形态）在过旧载荷上退回按账号的 `NativeSession`（#1734，修 #1729）。
- **CRAGGemini 无法应用的 `safetySettings` 改为明确报错**：`buildGeminiRequest` 的 antigravity 分支此前从不设置该字段，带值的安全策略被静默丢弃并按成功返回，调用方无从察觉。现以 `400 gemini_unsupported_turn` 拒绝并提示「省略该字段或改用 Gemini API key 环境」；空数组不要求任何配置，仍原样放行且不转发；直连 Gemini API 渠道照旧生效（#1735）。
- **请求日志的用量、缓存、思考强度、TPS 与调试捕获对齐**（#1727）；**Fable 额度错误与账号冷却解耦**：纯 Fable 额度等待不再误报 `529`，未知 429 不再扩大为账号硬冷却（#1722）。
- **修复 `dev` 上三条失败单测并加固 `Agy` / `NativeAgy` 清理路径**：`Agy.close()` 与 `NativeAgy` 的错误上报分支改用带默认值的属性读取，避免 `__init__` 中途失败时用 `AttributeError` 盖掉原始错误（#1736）。
- 部署说明：本版涉及控制面、**两个槽位载荷 pin**（CRAGGemini `0.4.4 → 0.4.6`、CRAG `3.1.14 → 3.1.17`）、宿主脚本（`scripts/gemini-host.py`、`scripts/docker-entrypoint.sh`、`scripts/panel-upgrade.sh`）与**两个数据库迁移**（SQLite `068_multi_tier_key_permissions.sql`、PostgreSQL `005_multi_tier_key_permissions.sql`）。两个迁移均为新增列 / 新增表：`api_endpoints.owner_user_id` 可空无默认，存量端点因此全部视为平台自建；`api_keys.permission_tier` 默认 `platform`，存量密钥落在该档后仍可访问平台自建资源，**对存量部署为无操作**。`bin/` 字节未变，预期 `SLOT_SYNC=skip`。`scripts/` 不在 `remote-apply.sh` 的应用范围内，宿主侧改动与 `0.4.6` 载荷需执行 `install.sh prepare-gemini` 才会生效（该步骤会重启 `vm2api-gemini.service`）；本版包含 #1734 的版本闸门后该步骤才是安全的——在此之前「新宿主脚本 + 0.4.4 载荷」会使 Gemini worker 无法启动。

## 1.4.196 — 2026-11-24 · 热修：CRAGGemini 性能配置改为初 / 中 / 高三档并移除 Web 底层协议术语

- **Web 设置页「Gemini」性能配置三档化与文案脱敏**：将原底层传输参数区块替换为「CRAGGemini 性能配置」**初 / 中 / 高**三档单选（均沿用后端既有 `gemini.shm` 配置链路，分别映射到 `2/8 MiB`、`4/16 MiB`（默认）、`16/64 MiB`，兼容既有历史数值回显），同步替换设置页副标题与守护进程实时状态卡中的底层协议与通道术语为「性能配置」「通道请求 / 校验异常」「通道入站 / 出站」。
- **受影响历史 Release 处置**：`v1.4.193`、`v1.4.194`、`v1.4.195` 三个控制面 Release 的 Web 页面包含旧版底层术语，已由本热修版 `v1.4.196` 替代并撤回上述三个 GitHub Release 条目。
- 部署说明：本版仅涉及 Web 前端（`web/src/features/settings/`），控制面 API、宿主脚本、`deploy/payload.json` 与 Claude/Codex 槽位内核字节均未变，预期 `SLOT_SYNC=skip`，无需重启既有槽位或重新执行 `prepare-gemini`。

## 1.4.195 — 2026-11-24 · CRAGGemini 请求字段剥离与调试日志捕获；独立 Go Chrome-TLS `kin-oauth-auth`

- **CRAGGemini 不受支持字段的剥离与调试体捕获**：`buildGeminiRequest` 在 `target: 'antigravity'` 下不再下发 CRAGGemini（`ALLOWED_BODY_KEYS`）与 Antigravity 拒绝的顶层 `safetySettings` / `cachedContent`，仅在直连 Gemini API 渠道且值非空时保留；宿主 `_extract_native_turn_body` 同步剥离 `safetySettings` / `cachedContent` / `conversationId` / `stream` 并把 `conversationId` 归一化为 `conversation_id`；公开处理器新增 `requestLog.tapResponse` 挂载与 debug 模式下的 `inbound_body` / `outbound_body`（含 `outbound_body_source` 区分 `craggemini` 与 `gemini_api`）捕获（#1718）。
- **`kin-oauth-auth` 改为独立 Go Chrome-TLS 构建**：`deploy/payload.json` 的槽位载荷钉住 `payload-2026.11.24-oauth-chrome-tls`，`bin/kin-oauth-auth` 由原先 47.4 MB 的打包产物替换为 11.6 MB 的独立 Go 二进制（#1717）。
- 部署说明：本版涉及控制面、宿主脚本（`scripts/gemini-host.py`）与 `bin/kin-oauth-auth`。**`kin-oauth-auth` 是 OAuth 换票组件且本次为整体构建链路替换**，`verify-live.py` 的门禁不覆盖真实换票，上线后请单独验证一次 OAuth 授权流程。Claude/Codex 槽位内核与 `wrap-cli` 字节未变，预期 `SLOT_SYNC=skip`；`scripts/` 不在 `remote-apply.sh` 的应用范围内，宿主侧的剥离逻辑需执行 `install.sh prepare-gemini` 才会生效（该步骤会重启 `vm2api-gemini.service`）。

## 1.4.194 — 2026-11-24 · CRAGGemini 请求净化与 Antigravity-Manager 对齐；空 `safetySettings` 不再误判为不支持

- **CRAGGemini 请求净化与 Antigravity-Manager 转换对齐**：修复客户端（Claude Code、OpenAI Chat/Responses、Gemini）向 `target: 'antigravity'` 发送 Unix 路径、斜杠前缀词、ANSI/控制字符、计费头或空占位轮次时返回的 `400 unsupported_turn`；`src/lib/protocol/gemini-convert.mjs` 现剥离 ANSI 转义与非法 `Cc` 控制字符（保留 `\n`/`\r`/`\t`）并归一化孤立代理项，对 `contents` 与 `functionResponse.response` 中空白前缀的 `/` 以 `U+200B` 转义（`systemInstruction` 与 `functionCall.args` 的字面路径保持原样），增强计费头剥离（代码块保护 + `cc_version=`/`cch=`）、过滤空与占位轮次、支持 Anthropic `role: 'system'`、跳过 `server_tool_use`/`web_search_tool_result`、补全空 `tool_result`；净化后的单轮请求可进入具备 `multi_turn` 的现代 CRAGGemini 槽位，旧版受限 `native_tui` 槽位保持 fail-closed（#1708）。
- **空 `safetySettings` / `cachedContent` 不再被判为需要 `generation_config`**：`classifyGeminiCapabilities` 原先对这两项用存在判定，而 `safetySettings: []` 解析后是空数组、`[] != null` 为真，于是一个**未配置任何内容**的空值会把 `plainText` 置空，使调度器对原生传输本可服务的纯文本请求返回 400 `gemini_unsupported_turn`；现改为与相邻 `generationConfig` 一致的非空判定。同时 `classifyGeminiCapabilities` 新增返回 `unsupportedFields`，调度器的 400 消息会点名具体字段（如 `unsupported in this request: safetySettings`），此前调用方只能自行二分 payload 才能定位（#1709，修复 #1703）。
- 部署说明：本版仅涉及控制面（`src/lib/protocol/gemini-convert.mjs`、`src/lib/gemini/scheduler.mjs`、`src/lib/gemini/system-prompt.mjs`、`src/lib/gemini/routes.mjs`），不含宿主脚本与载荷变更；`deploy/payload.json` 的 `0.4.4` 钉住沿用前版，Claude/Codex 槽位内核与 `wrap-cli` 字节未变，预期 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位。

## 1.4.193 — 2026-11-24 · Gemini 调度配置与分片 CRAGGemini 守护进程；部分续写 409 诊断字段透传

- **Gemini 调度配置页与 SSOT 路由模式**：设置 → 调度新增 `Gemini` 独立入口（`gemini-config`），提供调度策略、并发、分片守护进程、性能配置与故障熔断配置，原设置 → 运维 → `Gemini 维护` 及既有深链保持不变；新增 `src/lib/gemini/routing-config.mjs` 作为 Gemini 路由单一事实来源（`enabled`、5 个协议开关、`pool`、`sticky`、`failover`、`shm`），含严格校验、`routing.json` 持久化与 `PUT /api/panel/routing` 的实时 `apply-policy` 下发；调度器支持 `balanced` / `fill` / `round_robin` 策略、会话粘滞 TTL 绑定与可配置的账号切换上限和冷却；新增管理员专用 `GET /api/panel/gemini/daemon-status` 与 `POST /api/panel/gemini/daemon-action`（#1704）。
- **分片 CRAGGemini 守护进程与高性能通道控制**：`scripts/gemini-host.py` 新增 `CragDaemonShard`，单个 `craggemini` 进程可托管至多 `accounts_per_daemon`（默认 `50`）个 OAuth `agy` 账号，保持按账号的代理与目录隔离及独立数据通道（置 `1` 退化为严格按账号隔离）；新增 `runtime-policy.json` 持久化、`PUT /internal/v1/policy` 与 `POST /internal/v1/accounts/{id}/lifecycle` 实时下发，以及分片故障域隔离与自动回退 `NativeSession`（#1704）。
- **部分续写 409 透传安全诊断字段**：`partial_provider_output_nonretryable` 的 409 现按白名单透传 `prior_reason`、`interrupted_at`、`retry_after_sec`、`recovery_attempts`、`max_recoveries`、`recovery_exhausted`，未知字段与嵌套对象一律丢弃，`retryable: false` 保持不变以继续关闭 SDK 自动重试；其他 409 判定不变（#1705）。
- 部署说明：本版涉及控制面、前端与 CRAGGemini 宿主脚本（`scripts/gemini-host.py`、`scripts/gemini_host_native.py`）。`deploy/payload.json` 的 `0.4.4` 载荷钉住与上一版一致，未再变更；Claude/Codex 槽位内核与 `wrap-cli` 字节未变，`remote-apply.sh` 报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位。**分片守护进程与高性能通道能力位于宿主脚本内**，宿主侧需执行 `install.sh prepare-gemini` 才会生效（该步骤会重启 `vm2api-gemini.service`）；仅覆盖控制面时面板可见新配置页，但分片调度仍按既有 `NativeSession` 路径运行。

## 1.4.192 — 2026-11-24 · PostgreSQL 与多级缓存支持；CRAGGemini 系统提示词控制与 `0.4.4` 载荷；集群遥测与代理池重启宽限窗修复

- **PostgreSQL 数据库引擎与多级缓存支持**：扩展数据库层支持 PostgreSQL（兼容既有 SQLite 单文件与隔离单测），新增 `src/lib/db/pg/` 连接池管理、Advisory Lock 并发安全迁移（`001`–`004`）、SQL 方言兼容层与仪表盘预聚合器；新增 `src/lib/cache/` L1 LRU + Singleflight + 可选 L2 Redis 缓存与跨实例实时失效（Redis 异常自动 Fail-Open 降级 L1）；重构在线备份/恢复至独立 Worker（支持 `pg_dump` 与流式 `.pg.ndjson.gz` 防死锁批量恢复）；配套流式迁移工具 `scripts/migrate-sqlite-to-pg.mjs`、生产一键切流与 `--rollback` 脚本 `deploy/replace-db-to-pg.sh`（`deploy/install.sh` 升级时检测到已有 `data/kin.db` 自动保持 `VM2API_DB_DRIVER=sqlite` 防误切空库），以及 Web 数据库与缓存监控面板（#1699）。
- **CRAGGemini 系统提示词控制与 `0.4.4` 载荷钉住**：系统提示词页面新增 `CRAGGemini (Antigravity)` 标签页，支持 `official_full`（官方提示词）与 `zero`（0 提示词替换）两种模式及可选全局系统提示词（`compatibility.craggemini_persona_preset` / `craggemini_system_prompt`）；控制面与宿主（`scripts/gemini-host.py`、`scripts/gemini_host_native.py`）透传 `system_prompt_mode`（向下兼容旧版 worker）；`deploy/payload.json` 钉住签名载荷 `payload-2026.11.24-gemini-0.4.4`（`craggemini` 0.4.4 + `libagy_bridge.so`）（#1700）。
- **CRAGGemini 后台重认证检查锁并发与日志修复**：`_schedule_reauth_check_locked` 后台线程不再持全局 `host.lock` 执行网络 I/O，`refresh_account` 自身为忙碌判定与尾部状态变更（`env` 更新、`save()`、`stop_native_session`、`_schedule_warm_locked`）及 `pull_models` 写盘取锁，并在环境于探测期间被删除时跳过回写；将 `except BaseException: pass` 改为捕获 `Exception` 并向 `stderr` 输出脱敏错误日志，不吞 `KeyboardInterrupt` / `SystemExit`（#1695，修复 #1674）。
- **代理池 boot 探活宽限窗（按失败形状收窄）**：新增 `boot_grace_min`（默认 10 分钟，0 关闭），重启宽限窗内仅对超时类探活失败（`timeout`、`egress_timeout`、`egress_dns_timeout`、`egress_tls_timeout`）钳制 `consecutive_failures` 于 `max_failures - 1`，避免升级重启风暴瞬态超时连坐摘除整个号池；`connection_refused` 等明确拒绝保持原有 `dead` 与级联禁用判定（#1698，替代 #1640）。
- **集群 Docker CRAG 遥测修复与测试缝隙清理**：补齐指纹目录 `0755`/`0644` 权限归一化、`writeKernelConfig` 为集群 Docker CRAG 槽位输出 `dmi_dir: '/etc/kin-dmi'`、CRAG 重装保留原生遥测设置、上游 `reason`/`upstream_message` 透传以及旧集群容器缺失挂载时的维护态重建路径（复用 `slot-computer-files.mjs` 单一挂载来源）（#1636，修复 #1592）；移除 `fleet-update.mjs` 与 `slot-process-status.mjs` 中依赖测试替身判定的分支，确保每次 CRAG 重启前无条件写入内核配置并可观测验证（#1696）。
- 部署说明：本版涉及控制面（含 `Dockerfile` 新增 `postgresql-client` 及 `pg`/`ioredis` 依赖）、前端、CRAGGemini 宿主脚本（`scripts/gemini-host.py`、`scripts/gemini_host_native.py`）与 `geminiDefaultLinuxAmd64`（`0.4.4`）加密载荷；Claude/Codex 槽位内核与 `wrap-cli` 字节未变，`remote-apply.sh` 报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位。存量 SQLite 宿主执行 `install.sh upgrade` 会自动保持 `VM2API_DB_DRIVER=sqlite`，待需要时再执行 `sudo bash deploy/replace-db-to-pg.sh` 平滑迁移。

## 1.4.191 — 2026-11-24 · Gemini 原生 `/v1beta` + `/v1` 端口与 Gemini API 多协议渠道；不合格原生会话快速失败；Gemini 槽位状态紧凑化

- Gemini 公开端口补齐：新增 `/v1/models/:model:(generateContent|streamGenerateContent)` 稳定路径与单模型查询 `GET /v1beta/models/:model`、`GET /v1/models/:model`；`/v1/models*` 允许 `?key=` 鉴权，CORS 放行 `x-goog-api-key`、`x-goog-api-client`；`category=api` 密钥访问 `/v1beta/models*` 与 `/v1/models/:model:*` 时分流至 API 渠道，不再误落本地 CRAGGemini host socket（#1690）。
- API 渠道新增 `gemini` 协议（默认 `https://generativelanguage.googleapis.com` + `x-goog-api-key`，兼容 `Bearer` / `x-api-key`）：拉取模型优先原生 `/v1beta/models`（支持 `nextPageToken`），遇反代 HTML/404/405 回退 `/v1/models`；探测优先 `/v1beta/models/:model:generateContent` 并拦截 HTML 200 误判；复用 `gemini-convert.mjs` 打通原生 Gemini、OpenAI Chat、OpenAI Responses 与 Anthropic Messages 四协议入站转发；面板 API 渠道页、端点编辑抽屉与密钥弹窗同步支持（#1690）。
- CRAGGemini 不合格原生会话快速失败：`open_worker_stream()` 在启动轮询与等待响应头期间监听 `EligibilityDiagnostic`，`VALIDATION_REQUIRED` / `UNSUPPORTED_REGION` 等不合格会话直接返回 HTTP 403 并取消在途 worker 回合，不再阻塞到 `first_byte_timeout_ms`（90s）；账号存在阻断性 `account.eligibility` 或锁存的 `native_diagnostic` 时跳过常驻预热并上报 `runtime_ready=false`，避免僵尸 `bwrap + craggemini + agy` 槽位；`refresh_account()` 在资格变化或清除时回收失效 `NativeSession` 并在合格后重新预热，完成 Google 验证后无需重启 `vm2api-gemini.service`；`gemini-host-resident.py` 接入原生测试驱动，确保在 CI 中实际执行（#1688）。
- 面板：CRAGGemini 槽位代理改用标准 `ProxyChip` 渲染（#1689）；Gemini 槽位状态在 VM 表格内压缩为单行（保持 38px 行高）、机架卡片固定两行，完整证据移至悬停提示；资格提示在资格判定早于最近一次成功宿主推理时不再显示过期黄色警告，且仅当两个时间戳都可解析时才隐藏，缺失 `checked_at` 的 `verification_required` 账号仍显示警告与验证链接（#1691、#1692）。
- 部署说明：本版涉及控制面、前端与 CRAGGemini 宿主脚本（`scripts/gemini-host.py`、`scripts/gemini_host_native.py`，部署于 `/usr/local/lib/vm2api-gemini/scripts/`）；`deploy/payload.json`、Claude/Codex 槽位内核与 `wrap-cli` 字节未变，`remote-apply.sh` 报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位。

## 1.4.190 — 2026-11-24 · 修复 CRAGGemini 兑换码授权中心默认指向 `/gemini`；thinking 块去重与流中断诊断增强

- 修复 CRAGGemini 宿主兑换码无法兑换并误报「无法连接 CRAGGemini 授权中心，请稍后重试。」的缺陷：`src/lib/gemini/subscription.mjs` 原默认 `DEFAULT_AUTHORITY` 误指向 Claude `crag-v2` 授权根 `https://www.vm2api.org` 而非 `https://www.vm2api.org/gemini`，导致未显式设置 `KIN_CRAG_GEMINI_AUTHORITY_URL` 的宿主收到 `409 issuer_mismatch`；同时 `AUTHORITY_ERRORS`、`routes.mjs`（`HOST_ERRORS`）与前端 `gemini-redeem-dialog.tsx` 遗漏登记 `issuer_mismatch`、`payload_key_unknown` 等终态错误码，将其静默折叠为 `502 gemini_subscription_authority_unavailable` 并残留 `sync-pending`。现默认指向 `https://www.vm2api.org/gemini`，并完整透传 `issuer_mismatch`、`payload_key_unknown`、`payload_key_conflict`、`renewal_unavailable`、`host_transfer_cooldown`、`request_conflict`、`invalid_request` 与 `not_found`（#1684）。
- 修复 Anthropic 协议层重复 `thinking` 块去重与实时交接（native handoff）在 `max_tokens` 或流中截断下的处理逻辑，并在 `onRetryableTruncation` 回调记录原始上游错误类型、错误码与消息，避免确定性截断与瞬态掉线在日志中难以区分（#1681）。
- 对齐 `test/e2e/api-keys.e2e.test.mjs` 的 Gemini 密钥隔离断言至非共享 OpenAI 路径 `/v1/completions`，与共享路径准入语义保持一致（#1685）。
- 部署说明：本版仅涉及控制面与前端（`deploy/payload.json`、槽位内核与 `wrap-cli` 字节未变，`remote-apply.sh` 报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位）。尚未升级至 `v1.4.190` 的存量 `v1.4.184`–`v1.4.189` 宿主机，也可临时配置环境变量 `KIN_CRAG_GEMINI_AUTHORITY_URL=https://www.vm2api.org/gemini` 并重启控制面立即恢复 CRAGGemini 兑换码使用。

## 1.4.189 — 2026-11-24 · Antigravity 模型分流（`ag-` 前缀）、配额组冷却故障转移与 Gemini 计费日志；默认载荷自动派生与审计对齐

- Antigravity 模型按厂商分流并追加 `ag-` 前缀，统一接入 `all` / `gemini` 密钥路由与前端分组展示：新增 `src/lib/gemini/model-catalog.mjs` 作为唯一真值源，配合 `scripts/gemini_host_account.py` 采集 `fetchAvailableModels` 的 `modelProvider` 写入 `account.model_catalog`；Google Gemini 模型保持 `gemini-*`，Anthropic / OpenAI 第三方衍生模型以 `ag-` 前缀对外暴露（如 `ag-claude-sonnet-4-6-high`、`ag-gpt-oss-120b-medium`），下发上游时自动剥离前缀、响应回显公开模型 ID；`all` 密钥仅对 `gemini-*` 与 `ag-*` 分流至 Antigravity（不劫持原生 `claude-*` / `gpt-*`），`anthropic` / `openai` 密钥保持严格隔离；面板详情与测试下拉框同步按 Google Gemini / Anthropic（`ag-` 前缀）/ OpenAI 第三方分组展示（#1678）。
- Gemini 调度器新增按配额组独立 429 冷却与首包前自动故障转移：`src/lib/gemini/scheduler.mjs` 维护 `(accountId, quotaGroup)`（`gemini` / `gemini-argon-wtu` / `3p`）、`(accountId, model)` 与账号级冷却表，并结合 `account.quotas` / `account.quota_groups` 主动跳过已耗尽或受限账号；`3p`（Claude 等）触发 429 时仅冷却该账号的 `3p` 池，不影响同账号 `gemini` 池调度；首包输出前遇到 429、`gemini_account_verification_required`、`gemini_location_unsupported`、`gemini_operation_busy`、`gemini_proxy_error` 等错误自动切换至下一健康账号（#1678）。
- Gemini 接入官方参考定价与逐回合请求日志计费：`src/lib/admin/builtin-rates.mjs` 与 `src/lib/admin/price-catalog.mjs` 新增 `google` 平台费率表与 `models.dev` 解析，并支持剥离 `ag-` 前缀及思考强度后缀（`-low/-medium/-high/-xhigh`）使 `ag-claude-*` / `ag-gpt-*` 自动复用官方费率；`createGeminiPublicHandler`、`src/server.mjs` 与 `handle-protocol.mjs` 贯通 `requestLog` 单次落库（无重复写入），控制面在接入日志后向面板上报 `billing_ready: true`（#1678）。
- Gemini 上游错误处置指引与测试默认值优化：补齐 `gemini_account_verification_required`、`gemini_location_unsupported`、`gemini_oauth_required`、`gemini_quota_exhausted`、`gemini_proxy_error` 等上游错误的处理建议与可一键打开/复制的 `https://accounts.google.com/` 验证链接 UI；测试对话默认提示词改为 `hello`、默认模型优先选择 `Gemini 4 neon`（#1676）；修复控制面遗漏注册 `gemini_authorization_unavailable` 导致授权启动失败被错误折叠为「未检测到可用的 Gemini 宿主机服务」的问题（#1675）。
- 修复 `scripts/fetch-default-gemini.py` 硬编码 `VERSION = "0.3.0"` 与 `deploy/payload.json` 载荷版本漂移导致 `prepare-gemini` 及维护代理 `stage_pinned()` 拒绝合法清单的缺陷：改为直接从 `deploy/payload.json` 读取并校验 release tag 后反推版本，不再维护重复常量（#1680，修复 #1677）。
- 审计对齐修复：控制面蓝绿交接时将 `warmGemini` 周期定时器改为注册到 `onLeaderStop` 而非等待 `server.close`；补齐 `batch_group` 路由配置持久化与面板透出；`vm-package` 补齐 Claude 家族会话上限字段导入导出；移除废弃的 `gemini-test-chat.tsx` 并对齐 Gemini 错误提示与运维入口文案（#1679）。
- 部署说明：本版涉及控制面、前端与 CRAGGemini 宿主脚本（`/usr/local/lib/vm2api-gemini/scripts/`）；`deploy/payload.json` 载荷钉选（`craggemini 0.4.3`）、Claude/Codex 槽位内核与 `wrap-cli` 字节均未变，`remote-apply.sh` 报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位。

## 1.4.188 — 2026-11-24 · CRAGGemini 0.4.3 原生多轮/视觉/联网与 OAuth 换票风控加固；蓝绿部署、内核槽位租约与批量组调度

- 升级锁定 `deploy/payload.json` 的 `geminiDefaultLinuxAmd64` 至 [`payload-2026.11.23-gemini-0.4.3`](https://github.com/dofastted/vm2api/releases/tag/payload-2026.11.23-gemini-0.4.3)（`craggemini 0.4.3`，Debian 12 构建，最高符号要求 `GLIBC_2.34`）：包含 `0.4.2` 的 `memfd` 守卫派生修复与池就绪度修正（#1663），并进一步将媒体临时目录迁入 `/work/.craggemini-media/<req>` 配合只读白名单打通图片识别（多模态 `inlineData` / `image_url`）、原生多轮会话记忆与内部 `search_web`/`read_file` 工具事件过滤，完整支持联网搜索与 4 协议透传（#1667）。
- CRAGGemini OAuth 换票与设备指纹真实化加固及凭证健康对齐：修复 `Login.finished()` 误以 `.config/antigravity` 在 T+0ms `SIGKILL` 正在初始化的 `agy` 的缺陷，改为等待完整稳定期（`3s–6s`）并先发 `SIGTERM` 优雅落盘；`Headless` 拉取模型继承已授权 profile 的 `installation_id` 与 `cache/default_project_id.txt`；每个环境按 ID 确定性派生独立 `bwrap --hostname ws-<8hex>`；`scripts/gemini_host_account.py` 升级至官方最新 `antigravity/hub/2.34.0` User-Agent、模型与配额探测切至 `daily-cloudcode-pa.googleapis.com`、解析并严格校验透出 Google `ineligibleTiers`（`eligibility` 与 `https://accounts.google.com/` `validation_url`）；新增 `_profile_credential_health` 脱敏凭证健康视图与未就绪会话指数退避，消除 `invalid_grant` 槽位每 32 秒空转重启（#1667）。
- 修复存量已授权 OAuth 环境停留在「尚未拉取模型，不能调度」与缺失套餐信息的问题：`scripts/gemini-host.py` 的 `warm` 流程为缺少模型或套餐的已授权 OAuth 环境自动调度后台 `_post_auth_provision`（带冷却限流）；`src/lib/gemini/routes.mjs` 的 `warmGeminiEnvironments` 在 `models_discovered !== true` 时不再提前跳过预热（#1663）。
- 蓝绿部署与控制面平滑交接：新增 `deploy/bluegreen/` 部署套件、`docs/BLUEGREEN.md` 与控制面 `handover` 切换链路，支持 standby 预热校验、重叠期负载统计、后台备份与订阅文件安全切换（#1601）。
- 调度池内核槽位租约与批量组调度：新增 `kernel-lease` 按 CRAG 内核实时容量准入请求（#1639）；新增 `batch-group` 为无会话 API 批量流量提供粘性弹性成员集调度（#1635）；修复 CRAG 测试夹具文件显式 `0644` 权限（#1668）。
- 部署说明：本版涉及控制面、CRAGGemini 宿主脚本（`/usr/local/lib/vm2api-gemini/scripts/`）与 `geminiDefaultLinuxAmd64`（`0.4.3`）加密载荷；Claude/Codex 槽位内核与 `wrap-cli` 字节未变，`remote-apply.sh` 报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位。

## 1.4.187 — 2026-11-24 · 热修：恢复宿主身份以存储值为准，并自动回收 1.4.186 误退役的身份

- 热修 1.4.186 导致在用宿主鉴权失败（`license_crag_host_usage_unverified` / HTTP 403，「暂时无法核对宿主机 CRAG 运行额度」）。1.4.186 将采样硬件视为唯一真值，存储的 `host_id` 一旦与采样值不符即被整套退役；对采样值已漂移的宿主，这相当于把已付费的身份换成授权端从未签发过的新身份，`status` 随即返回 404、拿不到任何权益，槽位准入全部失败。生产日志确认 4 台宿主落入此状态（新 `host_id` 在账本中不存在）。
- 恢复 `deviceIdentity()` 以存储身份为准、且不做值比较：宿主已针对该身份付费，重新生成的 machine-id、重建的容器或更换的网卡都不应使其变成陌生人。碰撞问题仍在零代价处解决——`candidateRaws` 依唯一性排序，**首次**安装改从 MAC 或 SMBIOS UUID 派生，不再落到云镜像共享的 `machine-id`；已相撞的宿主仍由显式 `rebuildDeviceIdentity({ reason })` 修复，而非让每台宿主的身份各自漂移。
- 受损宿主自愈：`deviceIdentity()` 在准入时回收 1.4.186 留下的 `*.legacy` 身份文件（`host_id`、`credential`、`device_uuid`、`entitlement.code`、`redeem.json` 等整套移回），无需任何运维操作。无条件回收是安全的，理由唯一——被换上的新身份在授权端没有记录，不可能完成过兑换，这正是故障本身的症状。显式重建改用 `.retired` 后缀并先清除 `.legacy`，以免有意的重建在下次准入时被自愈撤销。
- 保留 1.4.186 的两个 fallback 源：`dmi`（SMBIOS 每实例 UUID）排在 `machine-id` 之前，`cpu` 垫底且不唯一（同机型读数相同），仅用于让既无合格网卡也无 SMBIOS UUID 的宿主拿到身份而非直接被拒；`rebuildDeviceIdentity()` 复用同一条链，故不再因缺少合格网卡而拒绝重建。
- 部署说明：本版仅涉及控制面 `src/lib/vm/crag-subscription.mjs`，槽位内核与 `wrap-cli` 字节未变，`remote-apply.sh` 报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位。受影响宿主在升级后的首次槽位准入时自动恢复。

## 1.4.186 — 2026-11-23 · 宿主身份改以采样设备为唯一真值，修复克隆镜像 host_id 相撞导致的永久 403

- 修复从同一云镜像克隆的宿主互撞 `host_id` 后、后注册者永久 403 的缺陷：云镜像普遍不重置 `/etc/machine-id`，由它派生的 `host_id` 在多台实例上相同，而 `deviceIdentity()` 原先原样返回已存储的 `host_id`，使相撞的值被钉在宿主自己的文件里、升级也不会自愈。现在采样到的设备是唯一真值，`credential()` 在存储值与派生值不符时整套退役旧身份——`host_id`、`credential`、`device_uuid`、`entitlement.code` 与 `redeem.json` 一并移为 `*.legacy`，避免新身份继承旧权益或半完成的兑换，且退役值不再参与任何鉴权（#1664）。
- 身份来源按唯一性重排为 `mac → dmi → machine-id/mount → cpu`：新增 `dmi`（SMBIOS 每实例 UUID）排在 `machine-id` 之前——后者正是相撞的来源，置于其后将永远不被取用；新增 `cpu` 兜底并在代码中明示其**不唯一**（同机型读数相同），仅用于让既无合格网卡、也无 SMBIOS UUID 的宿主拿到身份而非直接被拒。`rebuildDeviceIdentity()` 改为复用同一条链，顺带解除其原本「无合格网卡即无法重建」的限制；`readStoredUuid` / `backfillUuid` 移除，可读 UUID 与 `host_id` 同源计算、天然自洽（#1664）。
- 行为变更与迁移提示：宿主身份此后随采样来源变动，更换网卡或重建容器会使其成为新宿主，须用订单号迁移订阅（crag 的 claim-by-order）。这是本次有意接受的取舍，也是来源按唯一性而非稳定性排序的原因。放量前建议先扩大券的订单号登记覆盖面——订单号是该场景唯一的自助恢复通道，未登记的宿主只能人工逐台处理。
- 部署说明：本版仅涉及控制面 `src/lib/vm/crag-subscription.mjs`，槽位内核与 `wrap-cli` 字节未变，`remote-apply.sh` 报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位。

## 1.4.185 — 2026-11-23 · CRAGGemini 常驻内核池（0.4.1）与 OAuth 自动席位/模型初始化；池超时熔断分级保持

- CRAGGemini 推理内核与 `agy` 进程全面常驻化：宿主 `scripts/gemini-host.py` 将 `max_concurrency >= 1` 统一走 `pool_mode`（移除 `openvt` 单轮拉起/拆毁），移除 180 秒空闲杀进程、模型切换杀进程与单次健康探测失误即撕毁会话逻辑；新增引用计数 `SlotNetworkLease` 管理 `vm2agy<slot>` 与 `kin-egress` 生命周期，面板 `test-chat` 改为通过 `ResidentTestChatRun` 复用常驻 `NativeSession`，新增 `warm` RPC 与非阻塞后台自愈，以及控制面 `src/server.mjs` 启动 + 每 30 秒 `warmGeminiEnvironments` 巡检预热（#1658）。
- `deploy/payload.json` 的 `geminiDefaultLinuxAmd64` 升级锁定至 [`payload-2026.11.23-gemini-0.4.1`](https://github.com/dofastted/vm2api/releases/tag/payload-2026.11.23-gemini-0.4.1)（`craggemini 0.4.1`，支持常驻 `agy` 槽位池、`graceful_cancel_v1` 原地优雅取消、池模式实时热切模型与 Arena 蓝绿轮转，沿用既有 `crag-auth-gemini` 公钥信任锚 `f6e3ef3a50fd…`）。
- CRAGGemini 自动完成席位绑定、OAuth 模型/套餐初始化与 1 小时令牌自动续期：`src/lib/gemini/subscription.mjs` 与 `routes.mjs` / `scheduler.mjs` 自动为已授权 OAuth 环境绑定可用席位；`scripts/gemini_host_account.py` 统一使用 `User-Agent: antigravity/1.15.8 linux/amd64`、自动执行 `onboardUser` 与临期 OAuth token 刷新；`scripts/gemini-host.py` 在授权完成后自动拉取模型列表与账号套餐（#1656）。
- 调度池静默超时熔断改进：同一槽位 2 小时内重复触发连续 3 次首字节超时熔断时，不再被下一次健康探测立即清零，按 15/30/60 分钟阶梯保持隔离并在有效成功后重置记录（#1654）；`[vm-circuit]` 日志的 `trip N in 2h` 改为严格统计并裁剪 2 小时窗口内计数（#1657）。
- 部署说明：本版涉及控制面、CRAGGemini 宿主脚本（`/usr/local/lib/vm2api-gemini/scripts/`）与 `geminiDefaultLinuxAmd64`（`0.4.1`）加密载荷；Claude/Codex 槽位内核与 `wrap-cli` 字节未变，`remote-apply.sh` 报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有 `kin-*` 槽位。

## 1.4.184 — 2026-11-23 · CRAGGemini 兑换码与画布兑换预览，锁定加密 0.4.0 载荷；VM 并发/子代理限流与凭证脱敏

- CRAGGemini 补齐兑换码套餐、叠加明细与画布兑换预览：`src/lib/admin/crag-shop-supplier.mjs` 透传可选 `product` / `stackable` 套餐元数据；`src/lib/gemini/subscription.mjs` 支持带路径前缀的授权源 URL（如 `/gemini`）并透出叠加后的 `quota_grants` 明细；前端商城、画布预览页（`/crag-preview`）与兑换弹窗新增 `CRAGGemini 1个月兑换码 · 10 槽（¥100，¥10/槽，可叠加）` 套餐卡片与只读兑换码输入预览区（#1651）。
- `deploy/payload.json` 的 `geminiDefaultLinuxAmd64` 升级锁定至 [`payload-2026.11.23-gemini-0.4.0`](https://github.com/dofastted/vm2api/releases/tag/payload-2026.11.23-gemini-0.4.0)（`craggemini 0.4.0`，含多进程池、SHM Ring v2、`memfd` 通道、内置 MCP 桥接与原生工具能力），沿用既有 `crag-auth-gemini` 公钥信任锚（`f6e3ef3a50fd…`），不破坏存量主机绑定。
- 调度池支持按 VM 限制主会话数（`n`）与单会话子代理数（`m`），并在面板池策略与槽位席位流中同步展示（#1627）。
- VM Anthropic 凭证持久化与同步移除 `email` 字段，降低槽内元数据暴露（#1649）。
- 部署说明：本版仅涉及控制面、前端与 `geminiDefaultLinuxAmd64`（`0.4.0`）载荷，Claude/Codex 槽位内核与 `wrap-cli` 字节未变，`remote-apply.sh` 报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync` 或重启既有槽位。

## 1.4.183 — 2026-11-23 · CRAGGemini 系列：运行时信任根、宿主崩溃与多并发池绑定；自适应 thinking 预算不再越过 max_tokens

- CRAGGemini 的授权信任根不再自证。此前 `readCragGeminiPackageAuthority` 在没有独立锚点时会回落去读载荷目录自带的 `crag-license-public.pem`——等于让载荷为自己的密钥作证。现在无独立 PEM 或 64 位十六进制 SHA-256 pin 时直接 fail closed（`gemini_payload_invalid_signature`）；文件读取改用 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 并校验是常规文件与大小上界（`O_NONBLOCK` 让 FIFO 也能非阻塞打开，随后 `isFile()` 为假而被拒）；新增 `KIN_GEMINI_PUBLIC_KEY_FILE` 供运维轮换授权密钥而无需重新构建 vm2api，未配置时回落到 `deploy/payload.json` 里 git 跟踪的 SHA-256 pin（#1628）。
- **这条的部署前提不在代码里，值得单独记。** `deploy/payload.json` 原先不在 overlay 的打包清单内，而 `remote-apply.sh` 是逐条显式拷贝，所以线上那份冻结在初装时刻（实测 11-18），而 gemini 的 pin 是 1.4.180（11-23）才加进去的——那个键在线上根本不存在。于是 fail closed 会让每一次订阅读取都退化成 409 `gemini_subscription_package_unready`。pin 的值本来是对的（`deploy/payload.json` 与线上实装 PEM 的 sha256 逐字相同，均为 `f6e3ef3a50fd…`），坏的只是投递，所以修法落在部署侧：overlay 带上 `deploy/payload.json`，apply 时安装并备份，rollback 时恢复。**这个修法在 gitignore 的本地 skill 脚本里、不随仓库留痕**，换机器或重建 skill 目录会丢，表现为 CRAGGemini 订阅静默 409；要让它不可丢需把「overlay 必须发布 `deploy/payload.json`」写进 `docs/DEPLOY.md`，本版未做（#1628）。
- CRAGGemini 宿主的 `/infer` 不再因未捕获异常崩掉 socket handler。`native_module()` / `invocation_module()` 每次调用都 `spec.loader.exec_module()`，于是每次都产生**新的模块对象**，`except native_module().NativeFailure` 与 `NativeSession.open_stream()` 内部抛出的实例所属的类不是同一个类对象，捕获永远不匹配——异常穿出去导致响应被丢（503 `gemini_host_unavailable`）且跳过 `EligibilityDiagnostic` 轮询。改为按文件身份 `(dev, ino, size, ctime_ns, mtime_ns)` 缓存受信模块，且 `check_root_owned()` 仍在缓存检查**之前**执行（缓存命中时照样重验 root 属主，没有把信任校验一起缓存掉），并在 `_stream_native_infer()` 里先捕获模块引用再 `except`（#1637）。
- Google 账号的验证与不合格诊断打通到面板。原先 `EligibilityDiagnostic` 只匹配地域性不合格，丢掉 `server_oauth.go` 的 `Account ineligible: … Verify your account to continue.`，运维只看到笼统的 `gemini_inference_failed`；现在新增 `gemini_account_verification_required` 与 `gemini_account_ineligible` 的有界分类，贯穿宿主脚本、`gemini/routes.mjs`、`gemini/scheduler.mjs`（HTTP 403、不计入熔断）与前端状态投影（#1637）。
- 支持 Google 原生 Gemini API key 凭据：`x-goog-api-key` 头与 `/v1beta/models*?key=` 查询串。`?key=` 的提取严格限定在 `/v1beta/models` 路径（取 `?` 前的 pathname 后要求精确等于或以 `/v1beta/models/` 开头），两条路都拒绝 `kin-panel-` 令牌，并在 `security.mjs` / `request-log.mjs` 补了头与查询串脱敏（#1637）。
- 请求日志的 `path` 兜底剥掉查询串。`start()` 里取值是 `pathName || req.url || ''`，而 `_appendJsonl` 会把 summary 直接 `JSON.stringify` 写进 `data/request-logs/*.jsonl`，`redactSecrets` 在本仓库只作用于 body 与 error message、没有一处作用于 URL 字段。这条兜底当前不可达（三个调用点都传 `pathName`，它来自 `server.mjs` 的 `const p = url.pathname`，不含查询串），**但上一条让它变得有害**：将来任何新调用点漏传 `pathName`，带真 key 的原始 URL 就会原样落盘。剥整个查询串而不是脱敏 `key=` 单个参数名，对将来其他查询串凭据同样成立且热路径零正则开销（#1642）。
- CRAGGemini 接入多并发池绑定、代理校准与可复制授权链接（#1645）。
- `--crag-host-dir` 的默认路径对齐 `KIN_DATA_DIR`：服务模板与维护脚本原先硬编码 `@INSTALL_DIR@/src/data/crag-gemini-subscription/public`，而 Docker 与原生部署按 `KIN_DATA_DIR` 把宿主权益存在 `@INSTALL_DIR@/data/...`（#1637）。
- 自适应 thinking 回退时生成的预算不再越过 `max_tokens`。`on_adaptive: 'convert_to_enabled'` 的模型（如 `claude-haiku-4-5`）在调用方未给 `budget_tokens` 时，上游拒掉 adaptive 后的修复会注入静态 `thinking_fallback_budget`（4096）而无视 `max_tokens`，于是 `max_tokens <= 4096` 的重试必然 400 `thinking.budget_tokens must be less than max_tokens`。现在平台生成的预算被钳到 `min(fallback, max(1024, floor(max_tokens/2)))`，在 `max_tokens > 1024` 的全区间恒满足 `1024 <= budget < max_tokens`；`max_tokens <= 1024` 时没有任何合法预算存在，改为直接返回结构化 400 `thinking_incompatible` 而不是伪造一个非法值，并且不再发出注定失败的第二跳、不冷却账号。显式的调用方 `budget_tokens` 与首跳 `cli-hop` 透传不受影响（#1631）。
- 注意 `1025..2047` 这一段：`floor(max_tokens/2)` 落在 1024 以下被钳到 1024，所以输出余量最少只有 1 个 token。合法性没问题，但 PR 描述里「with output headroom」这半句在这一段不成立——1024 是 API 的 thinking 下限，这一段里任何合法预算都只能是 1024，能服务优于直接拒（#1631）。
- CRAG 的拉取与安装按**槽位运行时架构**判定，不再用宿主的 `process.arch`，混合架构机器上不会再拉错架构的内核（#1634）。
- 超大入站图片在抵达上游之前被拦下（#1643）。
- 审计对齐一批：桌面保活、混合架构 CRAG 更新、Codex 刷新冷却与遥测文档（#1641）。
- 部署说明：本版仅涉及控制面、前端与宿主脚本，`deploy/payload.json` 的内容、`bin/`、`share/wrap-cli` 与 `worker/` 自 `v1.4.182` 起字节未变，`remote-apply.sh` 会报 `SLOT_SYNC=skip`，无需执行 `wrap-cli/sync`，也无需重启槽位。本版新增一项：overlay 现在会把 `deploy/payload.json` 安装到 `/opt/vm2api/deploy/payload.json`（并备份到 `$BAK/deploy/`），这是上面 CRAGGemini 信任根生效的前提。

## 1.4.182 — 2026-11-23 · claude→responses 不再丢工具循环，槽位桌面 Mac 键盘与剪贴板直通，账号/桌面页签状态保活

- claude→responses 转换不再丢掉多轮工具循环。旧实现只读 `message.content` 的字符串形态，`tool_calls` 一次都没被引用，`role=tool` 的消息又落进 `role = 'user'` 分支把 `tool_call_id` 一并丢掉，于是上游模型永远看不到工具输出、反复重发同一个调用，形成烧上游配额的死循环。改为复用 `chatMessageToItems`：assistant 的 `tool_calls` 变成 `function_call` 项，`role=tool` 变成 `function_call_output` 项。`call_id` 链路两端已逐一核对——`tool_use.id → toolCalls[].id → function_call.call_id` 与 `tool_result.tool_use_id → tool_call_id → function_call_output.call_id` 对得上，不会落到 `call_unknown` 兜底，循环因此能真正闭合（#1626）。
- 复用带来两处行为差异，都是改善而非回归：空内容消息现在被丢弃（旧实现会产出一条 `text: ''` 的空 item），只有 `tool_calls` 的 assistant 轮次不再附带空的 `output_text` 消息。system 的特殊映射（`role: 'developer'` + `input_text`）在新路径上保持不变。另外 `chatMessageToItems` 从内部函数变成导出，消费方从 1 个变成 2 个（`chatToCodexResponses` 与 `claudeToOpenAIResponsesRequest`），文档注释已标注这一点，避免后续为 Codex 调整 `call_id` 兜底或空内容丢弃时意外改动 anthropic→responses 这条路（#1626、#1630）。
- 槽位桌面补齐 Mac 键盘与剪贴板直通。Cmd 键映射、复制粘贴双向同步，粘贴改用内容比较而非时间窗去重，连按两次不再出现注入错位。中文等非 Latin-1 字符原先会被截成 `?`，现在经 `hasNonLatin1` 判定后走 keysym 逐字注入；超长文本降级到剪贴板通道并给出提示（#1621）。
- **粘贴仍有一个窄交错边界，是已知且作者明确接受的。** 触发需要 paste 事件迟于 80ms 的兜底定时器、**且**用户在这个窗口内又按了一次 Cmd+V：迟到的 paste 无法分辨自己属于哪一次 keydown，会消费下一次的定时器，同时 keydown 上的 `pasteFallbackAtRef = 0` 擦掉了「刚刚兜底注入过」的记忆，结果多注入一次。比修复前「任意两次快速粘贴必错位」窄了一个量级，且自愈于下一次正常 paste。彻底消除需要给 keydown 配序号让 paste 精确配对消费，权衡后认为不值得这份机械复杂度——将来真有人报「偶尔多贴一次」，线索在这里（#1621）。
- 账号与桌面页签的状态跨切换保活。radix Tabs 切换即卸载 `TabsContent`，原先会造成两个断点：账号页签生成的 OAuth 授权链接在切到桌面页签完成浏览器登录后丢失（而链接重生成即失效，授权被迫一次完成），以及 noVNC 连接随页签切换断开重连。两个 `TabsContent` 加 `forceMount` + `data-[state=inactive]:hidden` 后状态保活，授权可在两个页签间来回完成。配套把「Claude Code 授权」从全局 Dialog 改为账号页签内嵌面板——Dialog 是模态的，开着时根本点不到页签切换器，所以单靠保活达不到目的（#1623）。
- 保活带来一处副作用已同版收口：`forceMount` 让 `VmDesktopCard` 在任意详情页打开时就挂载（默认页签是 `overview`，`desktop` 仅对 admin 可见），而它的状态 query 没有闸门，`refetchInterval: open ? false : 15_000` 于是变成常开——从未打开过桌面的页面也会一直打 `/api/panel/vms/<id>/desktop`。改为由详情页传入页签是否选中，未选中时不轮询；首次取值保留，切到桌面页签时状态是现成的。noVNC 连接本身由 `open` 门控，仍需点开才建立，保活语义不变（#1630）。
- 槽位自定义名称在列表行、机架卡片、弹窗与详情页头部一致优先展示，悬停提示保留 VM id 作为出处，不会因为改了名就查不到真实标识（#1624）。
- 部署说明：本版仅涉及控制面与前端，`deploy/payload.json`、`bin/`、`share/wrap-cli` 与 `worker/` 自 `v1.4.181` 起字节未变，`remote-apply.sh` 会报 `SLOT_SYNC=skip`，升级后无需执行 `wrap-cli/sync`，也无需重启槽位。

## 1.4.181 — 2026-11-23 · CRAG 3.1.14 修复 MCP 续接误报 410，终态后不再发迟到取消，降级订阅仍报设备标识

- CRAG 内核升到 `3.1.14`（`payload-2026.11.23-crag-3.1.14`），解掉 MCP 续接误报 `410 MCP continuation is no longer available`。该版把 `tool-grants.idx` 的回调有效期与完整历史快照准入解耦，修复已认领批次过期后切支（Fork / AgentSummary / 追加文本）、256 条磁盘回执淘汰重发与工具参数规范化三类误报，并把工具发布与响应投递收敛为单锁原子临界区。面板内核目录新增 `3.1.14 MCP 续接恢复修复` 选项，旧版选择保留；授权身份（`9dbb4bc2…` / `835451e2…`）与官方 Claude Code `2.1.321` 沿用（#1613）。
- 单跳取消栅栏：收到 `message_stop` / `responsesTerminal` / `readAll` 终态交付后立即解除取消联动，避免下游客户端一拿到 `message_stop` 就断开连接时，迟到的 `/internal/v1/cancel` 撤销刚签发的工具批次——那正是上一条 410 的触发路径之一。`cancelOnAbort` 的全部作用就是 POST 一次 `/internal/v1/cancel`，不碰 socket，所以这条链在控制面侧是自洽的；新增测试数的是 cancel 请求的到达次数而非实现细节（#1613）。
- **这条栅栏同时解除了两样可分离的东西，值得记下来。** 描述里的缺陷只需要摘掉远端 cancel 回调，而 `hopSignal.disarm()` 还让内层 `AbortSignal` 永不 abort——而它正是传给 `workerRequest` 与 `inferenceCodec.decode` 的那个。于是终态之后的收尾（流式路径剩余 SSE 排空与 trailers、非流式路径的 `inferenceCodec.decode` 与 `restoreJsonValue`）在客户端断开时不再可取消，只能等 idle/timeout 自然结束。这一步大概是有意的：`cancelOnAbort` 上方的注释写着内核也会因 socket 掉线而感知，若如此则只摘远端回调不足以挡住撤销。但该判断依赖 CRAG 内核侧行为、不在本仓库，未经核实。另外两个 catch 的判据从 `signal?.aborted` 改为 `hopSignal.signal?.aborted`，所以终态之后再抛错不再归类成 `client_cancelled` 而走通用错误分支——按 `final_state` 统计取消率的地方会出现一个台阶（#1613）。
- CRAG 订阅降级到本地验签状态时仍然报告本机设备标识，不再因为授权侧不可达而让设备标识一起消失（#1604）。
- CRAG 商城记录供应商调用的失败，让结账故障可归因到具体一次上游调用而不是只看到一个笼统的失败（#1603）。
- 部署说明：本版换的是槽位 CRAG 内核载荷（crag-v2 由 `3.1.12` 升到 `3.1.14`，落在 `share/crag/kernels/v2/amd64/`），而 `bin/kin-kernel` 与 `share/wrap-cli` 的 pin 都没变。`remote-apply.sh` 的 `SLOT_SYNC` 只比较这两者，所以它会报 `SLOT_SYNC=skip`——**不要据此认为槽位已经在用 3.1.14**。新载荷会随 overlay 覆盖到盘上，但槽位何时加载它不在该脚本的检测范围内，需要部署者自行确认（必要时重启槽位），这一步本变更未做验证。

## 1.4.180 — 2026-11-23 · Gemini 多协议适配与 CRAG 加密 0.3.0 订阅，Codex 额度续航与 CRAG 激活收敛

- Gemini 宿主与网关接入独立多协议转换和原生流式推理桥，不改动既有 Claude / Codex 路径。新增 `src/lib/protocol/gemini-convert.mjs`，将 OpenAI Chat/Responses、Anthropic Messages 与原生 Gemini/Antigravity 载荷统一转换，支持工具调用、思考块 / `thoughtSignature` 往返与流式 SSE 封装；控制面与宿主之间新增 `/infer`、`/infer-cancel` 流式通道，对缺少 `stream_infer` 的旧版宿主夹具返回 HTTP 404 并平滑回落到既有 `/test-chat`（#1612）。
- `craggemini` 接入 CRAG 宿主机订阅与按环境席位绑定，并锁定签名加密 `0.3.0` 载荷。新增 `src/lib/gemini/subscription.mjs` 与面板路由 `/api/panel/gemini/crag-subscription/*`、`/api/panel/gemini/environments/:id/crag-license/*`，按规范 `crag-auth` `v3.1.13`（`--product craggemini`）协议完成宿主机订阅兑换、席位绑定与离线本地验签；`deploy/payload.json`（`geminiDefaultLinuxAmd64`）、`scripts/fetch-default-gemini.py`、`scripts/gemini-maintenance.py` 与 `deploy/install.sh` 统一指向 `payload-2026.11.23-gemini-0.3.0` 五件套（`craggemini`、`craggemini.payload.enc`、`libagy_bridge.so`、`crag-license-public.pem`、`manifest.json`），同时兼容旧版载荷夹具校验（#1612）。
- Codex 槽位在额度闸门处自动刷新已过期 credits 并在面板展示余额，默认 Codex 版本提升至 `codex_cli_rs/0.170.0`（#1608、#1606）。
- `x-kin-queue` 不等待队列策略对齐槽位预算与零跳计数，重复请求头处理与文档口径收紧；补齐近期协议、CRAG 与 Gemini 改动与存量行为的审计对齐（#1594、#1602、#1605）。
- CRAG 商城在遭遇 `auth_forbidden` 时停止无限激活重试循环，并向面板透出脱敏诊断信息（#1609）。
- CRAG 首帧前 SOCKS5/传输 502 与 `empty_response` 分类解耦，并收紧风控 `HARD_POLICY_RULES` 的词边界与上下文约束（#1610、#1611）。
- 部署说明：本版仅涉及控制面、前端与 Gemini 宿主及加密 `0.3.0` 载荷，槽位内核与 `wrap-cli` 字节未变，已部署机器升级后无需执行 `wrap-cli/sync`。

## 1.4.179 — 2026-11-22 · Arch KVM 槽不再卡在时间同步，KVM 容器 pids 跟随槽位容量，缓存断点自保 TTL 序

- Arch 云镜像建出来的 KVM 槽不再卡死在时间同步上。Arch 官方云镜像默认启用 `systemd-time-wait-sync.service`（`TimeoutStartSec=infinity`），而 `pacman-init.service` 把自己排在 `After=time-sync.target`、`Before=sshd.service cloud-final.service`；KVM 槽经 SOCKS5 出口（只过 TCP），UDP 的 NTP 123 永远完不成，于是 `sshd` 与 `cloud-final`（`runcmd` → `install-guest.sh` → `kin-kernel`）一个都起不来，新槽表现为 `guest ssh unavailable` / `Connection reset by peer` 并反复触发看门狗重启。现在 `docker/kin-kvm/guest/user-data` 里加一条 `bootcmd`，在 cloud-init 的 Network 阶段（早于 `cloud-final` / `runcmd`）把这个 unit mask 掉，用 `command -v systemctl` 守卫，所以没有这个 unit 的发行版（Ubuntu / Debian / Fedora）不受影响；`bootcmd` 是 per-always 模块，不受 user-data 里「instance-id 稳定所以 datasource 只跑一次」的影响，而 `mask` 本身幂等（#1595）。
- 这条**只解掉阻塞等待，时钟同步本身仍然不工作**：Arch 的 `systemd-timesyncd` 同样走 UDP 123，在 SOCKS5 出口下照样同步不上。mask 之后 guest 不再卡在 `time-sync.target`，时间来源退回宿主给的 kvm-clock / RTC，对 TLS 与凭据过期判断够准，但别把它理解成「修好了 Arch 槽的时间」。另外基础镜像与 `base.id` 都没动、不重建 overlay，所以存量槽的 seed ISO 里没有这条 `bootcmd`，只有新建的槽生效——线上已经卡死的 Arch 槽需要重建（#1595）。
- KVM 槽容器的 `--pids-limit` 跟随槽位容量，不再硬编码 256。Docker 槽一直经 `dockerSlotResourceArgs` 从 `slotCreationLimits(vm, routing).pids` 取值，而本机 KVM（`buildKvmRunArgs`）与集群 KVM（`kvmSlotContainerBody`）各自写死 `256` / `PidsLimit: 256`，于是一个 `machine.pids_limit` 或 plan 目标更高的 KVM 槽（例如按 8 并发会话定容、需要 640 pids 的 4 GiB Max 20x 槽）每次重建容器都会被悄悄打回 256。两处改为读 `slotCreationLimits`——该函数在两个文件里本来就已 import，`routing` 也已是形参，不引入新依赖（#1596）。
- 两点与这条相关但描述里没提的：**KVM 路径上 memory 还没跟上**。Docker 路径两项同源（`limits.memory` 与 `limits.pids`），KVM 的 memory 仍取 `slotMemory(vm, routing)`（recorded），所以本版之后 KVM 容器的 pids 抬到 plan 目标、memory 停在 recorded。这不会造成超售：`effectiveSlotCount` 走 `slotsForLimits` 的 `Math.min(byMemory, byPids)`，memory 那一侧仍把席位数钳住，多出来的只是用不上的 pids 余量。其次**下限不再是固定 256**：`slotCreationLimits` 的 pids 下界是 `recordedPidsLimit(vm)`，即 `vm.machine.pids_limit`，缺失时才回落 `LEGACY_PIDS_LIMIT = 256`，所以一个显式记了低于 256 的槽重建后会比本版之前更紧。这与 docker 路径一直以来的契约（「never below the recorded spec」）一致，且 KVM 容器里只有 qemu 和几个 helper（会话进程在 guest 内，不计入容器的 pid 命名空间），不改（#1596）。
- `applyCacheBreakpoints` 自己保证不产生 `1h`-after-`5m` 的线序，不再把这个不变量交给调用方。调用方送来不带 `ttl` 的 `cache_control: { type: "ephemeral" }`（在 Anthropic API 里是隐式 `5m`）时，`bodyCacheTtl(inbound)` 因为没有显式 `ttl` 返回 `null`，`highestInboundCacheTtl(inbound, '1h')` 于是回落到 `'1h'`；`injectToolsTailBreakpoint` 保留调用方 tools 上那个隐式 5m 不动，而 `injectSystemTailBreakpoint` 与 `applyMessageBreakpoints` 按 `target = '1h'` 盖章，产出的正是上游会拒的非法线序。现在函数末尾过一遍 `enforceCacheTtlOrder`。不带 `ttl` 的 marker 不会被盖上 fallback——`enforceCacheTtlOrder` 里 `if (target != null && ...)` 这个守卫让它保持 `ttl` 缺失、同时置 `short = true`，所以 tools 上的隐式 5m 会正确地把后面的 1h 压成 5m，自己仍是 `{type:'ephemeral'}`（#1597）。
- **这条不是在修一个正在发生的 400。** `applyCacheBreakpoints` 在 `src/` 下只有一个调用方（`anthropic-policy.mjs:532`），`prepareAnthropicRequest` 也只有一个（`outbound-attempt.mjs:495`），而紧随其后的 `outbound-attempt.mjs:505` 本来就无条件 `enforceCacheTtlOrder(cleaned, cacheTtl || DEFAULT_CACHE_TTL)`，中间没有提前 return，所以出站 body 在现有唯一生产路径上已经是序正确的。它的价值是契约自洽：该函数的文档契约里就包含这个不变量，将来新增调用方不必知道还得补一层外层 enforce。叠加调用没有代价——`enforceCacheTtlOrder` 是幂等钳位，第二遍 `changed=false` 原对象原样返回（#1597）。

## 1.4.178 — 2026-11-22 · 放出跨设备迁移入口，VM 账号状态与宿主推理证据分离

- 「从其他设备迁移」入口放出来了。签发侧的 `claim-by-order` 已部署到生产（crag#14，账本 schema 15→16、`voucher_orders` 建表、账本计数前后逐项一致），1.4.176 里挡着这个入口的那个理由不存在了。路由可达是用能区分两种 404 的办法验证的，而不是看它是否返回 404：格式非法的订单号返 400 `invalid_request`，说明请求走到了签发侧的 `validate_order_id`；而一条确实不存在的路由返 404 `not_found`，那是 `.fallback(not_found)`。迁移本体先在生产数据副本上演练过一次（生产机上独立 state-dir，不碰生产账本），行数逐项对齐、`integrity_check` 通过（#1589）。
- 注意与 1.4.176 的描述有一处不同：那里写的是「等那条路由部署完翻一个常量即可」，实际做法是把 `CLAIM_BY_ORDER_AVAILABLE` 连同它那段注释一起删掉，按钮回到加开关之前的无条件渲染。翻成 `true` 会留下一个恒真的三元（死代码），而那段注释讲的是一个已经过去的状态——留着会让下一个人以为它还有切换的意图，或者以为那条路由仍然可能不存在。要再关掉的话 revert 即可，不需要那个常量存在。「迁入不要求本机已有订阅」那条注释留在原处，它在恢复后依然成立；测试相应改回被它替换掉的断言，四个状态都 `toContain`——换机的常态是新机器还是空的，按订阅状态设门会把入口从最需要它的宿主机上藏掉（#1589）。

- VM 面板把授权、模型发现、候选条件和最近一次宿主推理分开展示，不再用绿色「已授权」加模型发现这类前置状态去暗示真实推理已经成功。没有回合证据的保持「待验证」而不是看着像可用；失败保留具体类别，不升级成「凭据失效」这种更重也更可能错的结论（`runtime_ready:false` 与缺少结算数据都不作为失败依据）；宿主侧成功单独分组，既不等同公共 API 端到端成功，也不混进普通槽的在池计数——Gemini 不再用通用在池比例表达实测可用性。卡片、机架、表格、汇总与筛选共享同一份状态投影，所以四处口径不会再各说一套。Claude / Codex 的原有行为未变（#1588）。
- 这段推理证据的外投是**两端各自白名单**，不是单点过滤。宿主只在内存保留各环境最近一次已执行回合，错误码取自一个固定的 frozenset（进程输出与异常细节不进清单）；控制面的 `lastInferenceView` 逐字段**重建**对象，只产出 `state` / `model` / `started_at` / `finished_at` / `error_code` 五项，每项都过校验（状态在集合内、`modelName()`、ISO 时间戳正则加 `Date.parse`、错误码必须命中白名单）。提示词、回复、令牌、私有 profile、回合句柄都不可能漏出，因为它们从不被拷贝——这种构造在上游新增字段时也不会失守。证据的有效性绑定环境授权、profile、配置更新时间、载荷版本与实际代理配置：换代理、重新授权、更新版本或服务重启后旧证据即失效；相同 `proxy_id` 下更换端点或凭据，由控制面比对代理配置的 sha256 摘要挡住（该摘要用于比对，不外投）。普通读取是纯查找，不发起也不刷新上游调用（#1588）。

## 1.4.177 — 2026-11-22 · Gemini 集中运维与故障恢复入口，费用总计行的口径区分

- Gemini 宿主的诊断与修复收进面板，不必再登服务器敲命令。新增一个宿主侧维护代理（`scripts/gemini-maintenance.py`，systemd 单元 `vm2api-gemini-maintenance`，走 `/run/vm2api-gemini-maintenance/control.sock`），面板「设置 → Gemini：诊断与维护」可提交 `diagnose` / `install` / `repair` / `recover` / `update_cli` / `update_native` / `rollback`，并展示宿主状态、受信签名版本清单与回滚目标。各处宿主不可用的提示改为指向这个入口（`GeminiMaintenanceLink`），取代原先那句「请在宿主检查 `systemctl status vm2api-gemini`」——让运维点进一个能读状态、能提交修复的界面，比让他照抄一条命令更有用。管理员拿到可点的链接，普通用户拿到「请联系管理员」的说明（#1574）。

- 维护入口是服务端强制的管理员专属，不只靠前端藏按钮。`authorizePanelRoute` 在 gemini 分派之前执行，而 `panel-acl.mjs` 里没有任何 gemini 条目：`isUserAllowed` 以 `return false` 收尾、`authorizePanelRoute` 以默认拒绝收尾，`super` 的放行是一张写死的 GET 清单且不含维护路由，所以 `user` 与 `super` 都命中不了放行分支。控制 socket 另有一层：它是 `root:<gid>` 且模式必须恰好 `0o660`，连接方经 `SO_PEERCRED` 校验，查组用 `SO_PEERGROUPS`（连接时捕获的凭据）而不是按用户名查——后者会放行调用方实际上并未获得的授权。锁文件要求 uid 0、模式恰好 `0o600` 且以 `O_NOFOLLOW` 打开，socket 建立前校验父目录属主、拒绝抢占已绑定的 socket、并用 dev/ino 比对检测替换（#1574）。

- 控制面与维护代理互不信任对方的输入。控制面把 `release_id` 收在 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/`、请求体只允许 `action` 与 `release_id` 两个键；代理侧独立复校键集合，且 `release_id` 只做精确相等比对，从不拼进路径或命令（整个代理没有 `shell=True`，只有一处 `subprocess.Popen`，`stdin`/`stderr` 为 `DEVNULL` 并带超时）。反向上，`snapshotView` 对宿主返回的每个字段做白名单校验、响应体上限 256KB、错误码收在 `/^gemini_[a-z0-9_]{1,80}$/`，宿主返回畸形数据只会变成 `protocol_error`，不会穿到前端（#1574）。

- 槽位费用表的总计行重新在可见文本里区分两种口径。`账号总计` 是账号全生命周期的真实总额，`保留日志合计` 只是尚未被裁剪的日志之和、是个下界；#1578 为缩短过长的标签把两者都压成 `总计`，把区分移进 `note`（渲染为 `title` 原生提示）。但 `title` 在触屏上永远不显示，承载它的 `<td>` 与 `<span>` 本就不可聚焦、键盘用户触发不了，屏幕阅读器对非交互元素的 `title` 播报也不一致——于是「这个数完不完整」在这些场景里消失，而在一张费用表里把下界标成「总计」会让人以为那就是花掉的全部。改为 `账号总计` / `日志合计`：两个标签都是 4 个字，最长的那个比改动前的 `保留日志合计`（6 字）还短，#1578 要解决的长度问题仍然解决；完整措辞留在 `note` 里作悬停补充，不再承载唯一的区分（#1578、#1584）。

- 已知未覆盖：新增的 `test/deploy/gemini-maintenance-*-smoke.py` 共 1442 行目前不在 CI 内。`test.yml` 的 discover 只用 `-p test_native_cli.py` 这一个模式，而这几个文件是连字符命名、也不是合法的 unittest 模块名，所以它们是对真实宿主手工执行的脚本，不构成门禁；`test/unit/gemini-maintenance.test.mjs` 的 204 行在 CI 内（#1574）。

## 1.4.176 — 2026-11-22 · CRAG 订单找回与跨机迁移，本机内核重探与 count_tokens 开关

- count_tokens 的两个入口可在面板开启。`94b6f728` 当初把公开的 `POST /v1/messages/count_tokens`（含 `/messages/count_tokens`）和面板按槽位的 `POST /api/panel/vms/:id/count-tokens` 都 stub 成 404，但实现本体一直完整保留——`handleUserCountTokens` 有 11 个测试直接驱动（oauth / setup-token / 跨平台 key / distill 拦截 / 拒答缓存 / 设备封禁），经槽位 Go worker 的 `countTokensViaWorker` 也在，所以这次只是把路由接回去，加一个 `routing.compatibility.count_tokens` 开关（面板「设置 → 协议 → 入站准入 → 开放 count_tokens 入口」）。**默认关**，关态行为与现在逐字一致：这是一个公开 API 面和一个面板路由，打开它应当是运维的明确决定，而不是某个 routing 文件因为缺字段而默认获得的能力；开关只接受 `true`，routing.json 里误写成字符串不会把端点打开。`/health` 与 `/v1/meta` 的 `features` 在开启时多一项 `count_tokens`，而启动时写出的 `config/gateway-v2.public.json` 保持静态清单——一个在 boot 产出的文件无法描述运行期可翻的开关，两种写法都会有一半时间是错的（#1394）。

- 按客户端拦截的开关（`blocked_clients`）改掉三处与现状不符的地方。它的检测不再读 `messages` 里 `role: 'system'/'developer'` 的轮次：闸门只要求**模型**是 Anthropic，而本网关也服务 OpenAI 形状打 Claude 模型的请求，在那条路上这些轮次是调用方自由书写的内容，读它会让一个只在 system 消息里写了「running inside OpenClaw」的用户吃 403——而该模块注释承诺的恰恰是「只提名字不会被拦」。改后不损失真实覆盖：这类客户端跑的是官方 CLI，请求一律是 Anthropic 形状、带真的 `system`。校验对未知客户端 id 改为忽略而非拒绝，与 `blockedClientsFromRouting` 的读法一致；此前一旦某个 id 被退役或改名，存量 `routing.json` 里留下的键会让**任何**协议设置保存都失败，只能手改文件恢复。模块注释与面板文案也随之更正：`78223cdf1` 之后第三方 system 搬移已按 `system` 内容判定，这类请求会被搬移后正常服务，不再因第三方应用判定被上游拒绝，所以打开开关等于在搬移之前主动放弃一条本来能成功的请求（#1394）。
- 去掉 GPT-6.2 Astra / Sol 凭公式推出的 Flex 档。官方价目表的 Flex 一节里没有任何 GPT-6.2 条目，并明确写着不会再给新模型加 Flex；较早的几个模型的 Flex 恰好是标准价的一半（`gpt-6-astra` 10/50/1 → 5/25/0.5，`gpt-6.1-sol` 2/10/0.1 → 1/5/0.05），所以按这个比例推出来的数看着合理，却是一份自称「官方价快照」的文件里凭空生成的价格，并且会让一条回显 flex 的 GPT-6.2 记录按标准价的一半结算。`selectBand` 本来就有正确答案——某档位没有公开价时它把该行报为未计价，而不是按猜测计费（#1560）。
- 本机槽在一次健康探测里「既不就绪、也不忙、也没有在途请求」时不再立刻判挂。这类失败在一个部署上一周 128 次（每天 14–26 次），而证据指向内核并没有挂：报错的请求多在同槽上一个请求结束后约 3 秒进来，128 次里 99 次当时槽上没有别的请求，来宾里的 kin-kernel 从未重启（`NRestarts=0`），看门狗也没有动作，中位 15 秒后同一个槽就成功了。现在本机槽在判挂之前每 250ms 重探一次，总时长最多 `routing.inference.kernel_down_reprobe_ms`（默认 2500，`0` 关闭，上限 10000）：期间就绪则放行，变忙则走原有的等空位逻辑，仍不行照旧返回 `kernel_unavailable`，并多记一行带首末两次健康快照的日志，以后能看清当时内核到底回了什么。集群槽不变——它们有自己的启动探测（#1548 的 3 秒下限）和重连逻辑。`normalizeInferenceConfig` 同时补上该键的保留，否则面板保存推理设置会把它连同显式的 `0` 一起丢掉（#1572）。
- 重探的每次健康探测被压进剩余窗口。循环条件只预留了 250ms 的探测间隔，而 `rustHealthTimeoutMs` 的下限是 800ms、上限是 30000ms，所以一次不受约束的探测会把总时长推出 `kernel_down_reprobe_ms`，也推出上面刚算好的槽位预算：`health_timeout_ms` 调到 8 秒时，一个被告知最多等 700ms 的请求实际等满 8.25 秒。收窄不会制造假故障——`workerHealth` 把超时报成 `{ ok: false, status: 0 }` 且不带 `healthy: false`，所以被削短的那次探测只会读成未就绪，既不命中立即返回 unhealthy 的分支，也不改变窗口耗尽后的最终判定（#1572）。
- 免登录（设备）订单在丢掉结账 Cookie 后可凭订单号找回。设备订单的 owner 是 `sha256(host_id:cookie_token)` 且不可逆，所以换浏览器或清 Cookie 之后订单既从列表消失、也无法交付——`apply` 同样按 owner 匹配，一笔已付款的订单就此永久卡死，而设备页从不展示券码，没有任何兜底。订单号是 `randomUUID`，由买家持有，并且**从不出站**（对外一律是 `deriveOrderReceipt` 的 HMAC），前端也只让买家手动输入、不进 URL，所以它就是这笔订单的凭据。面板订单报 404，与不存在的订单逐字一致，这条路由不能用来探测哪些订单号存在（#1569）。
- 找回不再比较 `device_host`，那道「第二因子」从来不成立。`deviceIdentity()` 取的是本安装自己的机器 id，所以该列对同一个数据库里的每笔设备订单都是同一个常量，比较它永远分不开两个匿名买家——真正区分买家的是 cookie token，而它已经在 owner 里了。比较唯一能触发的场景是网关自身身份变了，而那恰恰是最不该拒绝的时刻：身份一变，所有设备订单的 owner 摘要同时失配，找回成了唯一出路，于是带着旧 host 的那些行被永久 409，反倒是该列出现之前的 NULL 行还能救回来——闸门把「可找回」变成了「永久不可交付」，正是这条路由要防的那件事。它也不保护权益落点：`apply` 始终按当前 `hostId` 兑换。该列保留作溯源字段，找回时刷到当前机器；`shop_order_other_host` 这个错误码与相应前端文案一并移除。迁移 066 的注释仍写着更严格的规则且无法就地更正——`database.mjs` 按 SHA-256 校验已应用的迁移，改动文本会让所有跑过它的部署报校验失败，所以更正写在 `recoverDeviceOrder` 的注释里（#1569）。
- 已登录但会话早于 buyer 绑定时，CRAG 商城报 `shop_session_stale` 而不是 `shop_login_required`。`sessionBuyerOwner` 要求 `session.buyer?.id === record.id`，而旧会话根本不带 `buyer`，于是一个已经登录的用户被告知「请登录面板」——一句他正在照做的建议。id 比较本身没有放宽：`record` 按用户名查出，删号后重建的同名账号会拿到新 id，带着旧 id 的会话不能够到新账号的订单（#1569）。
- 订阅可凭商城订单号**跨机器**迁移，旧机器不必还活着。注意与上面那条「丢 Cookie 后找回」不同：那是同一台机器换了浏览器、把订单取回当前浏览器，这里是把订阅本体迁到新机器。此前换机要求旧机先释放券，而凭据链决定了那台机器一没就什么都不剩——明文券码是签发侧唯一能自行验证的凭据，它只存在于供应方，取回它需要只存在于某一台 vm2api 数据目录里的 receipt key，而免登录买家从来没见过券码。所以兑换时把订单号登记到签发侧（replay 路径也登记，这是存量补登记的入口），面板新增「从其他设备迁移」：输入购买时的订单号，券带着剩余时长迁来，不重新起算。入口不论本机当前状态都显示，包括完全没有订阅——换机的常态就是新机器是空的，按状态设门会把它从最需要它的宿主机上藏掉；也不要求先注销旧机。注销文案一并修正：它原本说「必须自己还留着券码」「只凭设备标识迁不走」，前半句已不成立，留着会让人去找一份他从来没有过的东西。签发侧对应 crag#14（#1580）。
- **本版暂不放出那个迁入入口**，它由 `crag-device-identity.tsx` 的 `CLAIM_BY_ORDER_AVAILABLE` 挡着。`claim-by-order` 是签发侧 crag#14 提供的路由，而那个 PR 既没合也没部署，生产跑的是它之前的版本，那条路由不存在。放出来的后果不是功能不可用而已，而是失败的样子在怪用户：crag 的 `http.rs` 把未匹配路由接到 `.fallback(not_found)`，该处理器走 `failure(AuthError::NotFound, scope)`，产出与正常错误完全一样的信封（`{ok:false,error:{code:"not_found"}}` 加 HTTP 404），于是 `authority()` 采纳错误码的三个条件同时成立（`ok:false`、`not_found` 在 `authorityErrors` 里、状态等于表中登记的 404），用户拿到的是「没有找到这个订单号对应的兑换券」——他会以为自己订单号抄错了，去反复核对一个根本没问题的数字。兑换本身不受影响：`HostRedeemRequest` 带 `deny_unknown_fields`，旧签发侧会把带 `order_id` 的 redeem 判成 400，而 `redeemAtAuthority` 去掉该字段重试即可成功，代价只是订单号没登记。实现、文案与测试全部保留，等那条路由部署完翻一个常量即可（#1580）。
- 登记订单号绝不阻断兑换，代价是 `invalid_request` 成为可识别的终局错误。签发侧 redeem 请求带 `deny_unknown_fields`，所以一个比签发侧新的实例会因 `order_id` 让每次兑换都失败；现在遇到「请求格式被拒」就降级重试一次、不带该字段。而这要求 `invalid_request` 不再降级成 `crag_subscription_authority_unavailable`（502）——那读起来是「结果未确认，请重试」，用户反复重试永远不会成功，正是 `host_transfer_cooldown` 当初掉进的同一个坑。只有它降级：502 保留原义，因为兑换可能真的已提交，在那里重试会把本该停在 `sync_pending` 的状态推成已完成。元数据字段叫 `shop_order_id` 而不是 `order_id`，后者已承载控制流——`recover()` 把带它的 intent 视为「只能经商城恢复」，复用会让恢复直接 return、设备订单卡在 `ready_to_apply`（#1580）。
- 免登录（设备）页可导出迁移凭据。此前设备页从不展示券码，但那让一个签发侧没登记过其订单号的免登录买家彻底没有迁移手段，而权益是他买的。导出仍需持有该订单的结账 Cookie、同源 POST 和按设备的限流，可达性不比「应用订单」更高，应用本身也仍然不携带券码；`crag-shop.mjs` 那条「Never expose the voucher」注释随之更新为实际成立的说法——错误通道不携带券码。另有一处为避免不可逆后果而加的拒绝：`claimByOrder` 在 `deploy/payload.json` 缺失时拒绝而不是继续，因为 `standardEnrollment` 在那种情况下返回 `{}` 而不抛错，而一次不带 `payload_key_id` 的 claim 会让签发侧把这张券记成无标签基线——它与同机其他同类券共享一个合并窗口，再也不能按订单号迁移，且用户看不见（#1580）。

## 1.4.175 — 2026-11-21 · CRAG 订阅：设备标识、凭据自助恢复与注销迁移

- CRAG 宿主标识改以网卡为基准。`machine-id` 并不唯一——云镜像普遍不在实例化时重置 `/etc/machine-id`，同镜像开出的多台机算出同一 `host_id`，第二台注册即被授权服务以 403 拒绝且终身如此；虚拟网卡 MAC 由 hypervisor 逐实例分配。筛选只排除组播位：排除「本地管理位」会废掉几乎所有 KVM 虚拟机的网卡（QEMU 的 `52:54:00` 前缀就带该位），而地址是否永久由 `addr_assign_type` 权威判定；最小 MAC 胜出，因为枚举顺序与接口命名都会变。已保存的标识不再因维护而漂移——此前重装系统、重建容器或换网卡都会抛 `host_identity_changed`，把付过费的机器卡死；来源仍须健全，缺失或被换成符号链接照旧报不可用，只容忍值变化。`host_id` 派生用的 32 位 hex 恰好是 UUID 载荷，所以同一标识可在面板展示、也可输入，协议格式一字未动（#1561）。
- 凭据失配（403 `auth_forbidden`）可自助恢复，不再只能由管理员登服务器敲 CLI。授权服务侧早有恢复能力但未开放通路，且其 `binding_id` 是旧凭据的派生物——正是丢掉的那个东西；现在改由客户端出示授权服务自己签过的 entitlement 作带内所有权证明。credential 文件**丢失**走的是另一条路（本地直接报不可用、请求不出网），因此两处都接了恢复。并发竞同一个 403 共享一次恢复，否则各自换凭据会轮流把对方踢掉；失败只重试一次。`host_id` 与另一台机器相同时恢复**必须**失败，否则两台会互相夺取订阅，此时面板明确给出成因而不是让订阅看着正常直到某次兑换莫名失败（#1561）。
- 订阅页列出每张兑换券各自的额度窗口，并讲清概况里的「到期」取的是最早到期那一段（届时席位下降、授权需重签），不是订阅终止。逐券明细未经签名，只在与已签名聚合精确对账时才采信，且不参与准入。兑换入口同时接受面板展示的设备 UUID 与原有的 64 位 host id（#1561）。
- 新增「注销本机订阅」：每张仍在有效期内的兑换券带着剩余时长被释放，在新机器上用原券码兑换即继承，换机既不损失已付时长也不白送时长。注销后本地签名权益随之清除，否则状态会继续报告一个已被删除的订阅。转移冷却期被拒时给出明确原因——此前它会退化成「结果未确认，请重试」，害运维反复重试一件没到期的事（#1561）。
- 对话在反复静默 CLI 超时后拒绝请求而不再重播，并让后续请求避开在该尺寸上静默的 VM，而不只是避开单个对话；同时不把 VM 的尺寸上限压到低于它刚被证明能服务的水平（#1555）。
- 槽位凭据刷新改为重试安全，依靠节点侧的尝试日志；停在旧 worker 上的槽位在其节点升级后可恢复，且只在能清除 park 的地方探测（#1539）。
- 集群 unix-socket 传输按用途与路径分键，exec bridge 不再泄漏并耗尽 SSH 会话，补上原因码、有界队列与真实健康判定（#1385）。
- 集群槽位的启动健康探测按部署位置放宽超时。探测与进程检查经 SSH 中继多一跳，原先按本地 docker exec 预算写死的 400ms/1500ms 在跨洋链路上经常在内核就绪前就整窗超时，随后被判定 `runtime_start_failed` 并停掉实际已经 ready 的容器；watchdog 的 stale-lift 又因容器已被停而永远探测不到健康内核，形成重建循环。现在集群槽（`node_id` 非空）的单次健康探测下限 3 秒，本地槽保持原值；`inference.health_timeout_ms` 也补进路由归一化白名单——此前该键有读取方却在保存时被剥掉，面板永远配不进去（#1548）。
- 控制台登录后跳转回原请求页面，而不是落到欢迎引导（#1356）。
- OpenAI Ultrafast 档位的计价与展示（#1560）；支持 Mythos 5.2，策略与计价对齐 Fable（#1558）。

## 1.4.174 — 2026-11-21 · Setup Token 不再伪造一年期票，授权链接保留 helper 身份

- Setup Token 换票不再请求 `31536000` 的有效期。授权链接导入走的就是 README 的普通换票流程，长效票是宿主用短效票本地派生的东西，面板没有理由铸造它；两条路现在都只申请完整 5 项 scope（身份链需要 `user:profile`）、都不发 `expires_in`，拿到的是上游给的短效票。能力名随之由 `setup-token-long-lived` 改为 `setup-token-short-lived`，profile 的 scope 仍锁定、不接受调用方覆盖（#1550、#1551）。
- 授权链接换票保留 helper 在 token 之后采集到的身份字段，修复链接导入丢失该身份的问题（#1549）。
- `deploy/payload.json` 指向重建后的短效 OAuth helper（#1551）。

## 1.4.173 — 2026-11-21 · 修复 Gemini OAuth 账号文件导入

- 将短期 OAuth 访问令牌传入隔离的账号探测进程，修复 Gemini 账号文件导入时宿主调用参数不匹配的问题（#1544）。

## 1.4.172 — 2026-11-21 · Gemini OAuth 共享调度与协议适配

- Gemini OAuth 宿主保留签名 CRAGGemini 原生 worker、隔离 HOME 和绑定 SOCKS5；在共享 PoolScheduler 上增加账号平衡、并发预留及 unit-circuit，并提供受限纯文本 Gemini、OpenAI Chat/Responses、Anthropic Messages 适配，客户端断连按中性取消处理（#1397、#1536）。
- 兼容性与调度修正：将 Anthropic 顶层自动缓存字段归一化为标准块（#1535），规范官方 CLI 请求中追加的第三方 system 内容（#1521），可选丢弃非本账号签发的 thinking（#1361），正确标记不可重播的 409 并更新强制工具选择说明（#1529），保护固定会话不向新账号溢出（#1383）。
- 新增额度窗口定时预热与到期续热（#1354）、1.5 GiB 槽位规格（#1389）、一次性活跃会话统计（#1390）和飞书群机器人通知（#1376）；OAuth 未就绪错误增加可操作原因（#1386）。
- Setup Token 使用完整 OAuth profile scope（#1530）；将 OAuth helper 的 scope/TTL 能力策略移入可验证契约并修正相应测试边界（#1528）。
- CRAG 已付款订单可恢复，增加明确的槽授权迁移入口（#1517）。
- 改进按改动源文件选择 Web 兄弟测试及手动全量测试修复（#1534、#1537），完善 PR 目标分支提示与发版时维护 changelog 的流程（#1527、#1522）。

## 1.4.171 — 2026-11-20 · CRAG 一键升级到锁定版本、CRAG 3.1.12 与面板文案续修

- wrap 内核页新增「升级到锁定版本」一键动作。此前升级 CRAG 只能登宿主跑 `scripts/update-crag.mjs`，而 version-switch 的 overlay 从不投递 `scripts/`，宿主上那份可能停在旧代次；面板侧也没有任何地方调用 `/api/panel/kernels/crag-update`，运维没有可走的路径。现在按钮先按 `deploy/payload.json` 的 `crag_release` 拉取锁定载荷，跳过 `payload_tag` 已等于该 pin 的槽位，其余复用既有确认框、任务进度与逐槽结果；全部已达标时直接告知并且不重启任何槽位。`GET /api/panel/kernels` 新增 `crag_pin`，与描述已缓存包的字段分开放，避免被读成「已安装版本」；拉取路由开始接受 `latest`，默认仍为最新版，手动两步流程行为不变（#1513）。
- 修正 CRAG 升级把「槽位尚未启动 core」判成「仍跑着旧 core」。v2 的 core 是懒启动的，刚重启的槽位合法地可能一个都没有，而最终校验要求恰好一个且匹配新 manifest，于是一次六槽升级以 `crag_running_core_mismatch` 整单失败，原地零改动重跑却全部通过——这个失败不携带任何可操作信息。现在跑着别的树的 core 仍立刻失败，一个都没有则在已装树通过哈希校验的前提下记为待定；该判定搬进随部署走的 `src/lib/vm/crag-core-check.mjs`，面板因此可以复用，健康闸门同时收敛为必须通过已认证的内部探测才采信 `runtime_variant` 与 `license_valid`（#1513）。
- 标准 CRAG 载荷升级至 `3.1.12`：原生 TUI 不再向 Datadog 发送日志镜像和错误批次，Anthropic 第一方遥测仍按原字段白名单过滤。授权身份、官方 Claude Code `2.1.321` 和其他组件载荷不变（#1387、#1508）。
- 重新绑定代理会清掉上一条绑定留下的 hold，面板也不再把它显示成「代理异常」。hold 的 tag 指向槽位已不再使用的出口时，没有任何自动路径会解除它，而照旧显示会把运维引去排查一个健康的出口（#1489、#1510）。
- 日志导出的「仅导出当前错误类」此前不可达：对话框解构了一个自己没有声明的 prop，唯一的调用方也从未传入，于是开关永远读到 `undefined`。补上 prop 声明并由页面传入已校验的筛选值（#1481）。
- 响应时间徽标不再把下降显示成上升。真实的 20% 下降此前渲染成 `+20%` 并带向上箭头，现在只反转配色、不反转数值（#1492）。
- 按窗口聚合账户用量改为单遍求和，不再为每个事件构造中间行对象；无上一轮会话的候选不再快照请求体；连续性诊断复用请求级摘要缓存而不是重复哈希；kin-egress 存活探测移出事件循环，不再按绑定代理数在每个 watchdog tick 上造成停顿（#1506、#1507、#1509、#1511）。
- 面板文案与语义续修，接上 1.4.170 的同一条线：空日志查询不再暗示采集缺失，零请求的密钥统计不再读成成功，重建槽位启动失败会给出警告，Wrap CLI 模板替换、远端内核修复、强制删除跳过远端清理、槽位名影响 ID、公网可达性为节点探测、软件 KVM 模拟与 KVM 不可用、代理时区数据缺失与无效、签名修复不再承诺最终 200、用户并发列为配置上限、零 VM 配额会阻断租户自助、导入改名与失败原因并列显示、重试跳数上限为零时显示为零（#1479、#1480、#1482—#1487、#1491、#1494、#1498—#1505）。
- 补上 CI 盲区里的测试并让隔离跑机支持多文件并发：路由覆盖守卫的正则、出口重启守卫、以及因文案改名而失效的面板断言；手动全量单测改为四 worker（#1493、#1512）。

## 1.4.170 — 2026-11-20 · 面板缺失语义修正、TOTP 两步验证与 CRAG 3.1.11

- 可选的 TOTP 两步验证登录。新增「账号安全」页，对任何已登录账号开放，不受角色视图限制（#1417）。
- Anthropic API 端点新增 body 策略：端点可以转发调用方的请求体，而不是套用人格；面板 API 控制台可以查看与切换（#1398）。
- 标准 CRAG 载荷升级至 `3.1.11`：修复慢 MCP 工具等待及已过期回调导致的对话恢复 410。未认领的迟到结果可凭完整匹配的历史恢复；已认领的过期批次不会因回执淘汰或 worker 重启再次推理。授权身份、官方 Claude Code 2.1.321 和其他组件载荷不变。
- 屏蔽 SVCB(64)/HTTPS(65) 的 DNS 覆写改为按单条代理生效。此前它只存在 `proxy_pool_config` 里，`configuredDnsEmptyTypes()` 读的是池级值，整个池只能一起开关；而 kin-egress 的 `dns_empty_types` 本来就是按 helper 下发的，per-VM helper 恰好只服务一条代理，这个开关本该长在代理行上。现在 `proxies` 表有自己的 `dns_disable_svcb_https` 列，`startProxyEgress` 与集群 per-VM 出口都从各自的代理取值，单条代理可以和池里其他代理不同。池设置里那个开关语义改为批量动作：写入全部非本地代理，并作为此后新增代理的初始值，不再是运行时的继承来源；保存后只重载被这次动作真正改变且已绑定的出口，不再把整池拉下来重载一遍。迁移 `064` 把原池级值写进每一条代理，升级后行为不变。共享出口模式下一个 helper 带多条上游、Go 侧 `DNSEmptyTypes` 又是 helper 级的，取交集：该节点全部成员代理都开启才下发覆写，这样界面显示「关」的代理绝不会被别人的选择连带屏蔽。本地直连行没有自己的 helper，拒绝该字段（`dns_disable_svcb_https_unsupported`）。
- 代理页的弹出层改掉工程口径文案，并补上确认步骤。池设置此前点一下就直接写库，没有确认也无从反悔，现在改为草稿提交：改动先留在本地并标「未保存」，底部常驻确认栏统一保存，带着未保存改动关抽屉会被拦住。批量开关这种一次改全部代理的动作单独走二次确认，并说明会影响多少条。抽屉窄屏不再 `95vw` 糊满整屏。文案按运维视角重写，例如「关闭 DNS type 64 / 65」改为「屏蔽 HTTP/3 与加密 SNI 探测」，技术细节降到说明行；单条代理的同一开关在「编辑」里，与「按域名连接」并列。
- 透传时保留上游的终态判定，停止对 410 续接做无效重试（#1413，refs #1215）。
- 当前代理可以解除上一条绑定留下的 hold（#1400）。
- 每次响应只读一份账户快照，消除按槽位放大的账户查询（#1415，refs #1043）；端点密钥状态不再附带用量聚合即可读取（#1409）。
- 移除未使用的 official 303 渲染器（#1399）。
- 页面分块加载失败不再显示成 500（#1404）。
- 面板不再把「缺失」显示成真实的零或已确认的空。统计总览、日志总览、密钥与槽位统计、错误汇总、风险放行原因、Docker 探测、响应时间等处，加载失败与数据缺失各有独立文案；零请求的统计窗口不再显示 100% 成功并带健康绿标（#1432、#1445、#1457、#1466、#1471、#1473、#1474、#1475、#1476、#1477、#1478）。
- 面板时间与窗口口径统一。「今日」明确标为北京时间，统计区间标为含当前时刻，日期预设标出浏览器时区，七天值统一称作额度窗口，五小时峰值说明为账户额度用量；QPS、平均 TPS、缓存率与各比率分别说明统计窗口和分母（#1411、#1412、#1414、#1416、#1418、#1420、#1422、#1424—#1426、#1429、#1430、#1434、#1435、#1440、#1463、#1464、#1467—#1469）。
- 日志筛选与导出的描述与实际行为对齐：非 2xx 的命名在快捷筛选与生效筛选上统一，单边日期筛选显示实际边界，仍在翻页扫描时明确说明，手动与自动翻页分开，被截断的导出不再称作完整，草稿筛选需要单独应用（#1433、#1447—#1449、#1451、#1453、#1456、#1459）。
- 图表与榜单在查询切换期间不再展示上一次的结果（#1441、#1442、#1452）；只保留单条序列的图表动作改名（#1458）。
- 请求健康改为按活跃时间槽计数与定位，中段健康带不再与 5% 重叠（#1437—#1439、#1454）。
- 面板口径与命名修正：账户合计与留存模型成本分开，滚动与自然日请求数分开，日志留存与请求日志分开，在线 VM 说明为按状态推导的运行中 VM，已配置的模型窗口与 1M 能力分开，以及计费留存窗口、API 渠道归属、虚拟机命名、实时会话计数与日志跳转等文案更正（#1401—#1403、#1405—#1408、#1410、#1444、#1446、#1455、#1460—#1462、#1470、#1472）。
- 补上 CI 盲区里的红测试：代理连接字段更新后重读存储行、用户路由的进程级数据库句柄、出口复用检查的完整配置 body、升级校验阶段的探测限速、切核用例的槽凭证、路由入参断言，以及两处因文案改名而失效的面板断言（#1419、#1421、#1427、#1428、#1431、#1436、#1450、#1465）。

## 1.4.169 — 2026-11-20 · 订阅操作不再拒绝全部槽位

- 订阅操作期间不再拒绝无关槽位。任何名册变更都会重新发布所有槽位授权共用的那一份主机 entitlement，准入因此分不清被操作的槽位和其他槽位，整个操作期间把本机 KVM 槽位全部拒掉；逐槽迁移于是表现为滚动 403（27 个槽位约 25 分钟，而全部槽位都跑 CRAG 时没有可回落的对象）。现在准入会等待该操作结束，再对已稳定的主机重跑同一套检查：`exclusive()` 只在 `restoreKvmBindings()` 把每个运行中的客户机重新投递之后才清状态，等待者醒来面对的是真正就绪的主机。等待时长受请求自身的槽位预算约束（15 秒上限、重试一次），超出预算的拒绝会标为可重试并带上 retry-after，前置网关可以重试或改选槽位，而不是把它读成授权失败。用 `AsyncLocalStorage` 标记独占工作体，从其中发起的嵌套准入仍然立即拒绝，不会等待自己所处的那个操作。按槽位加锁的方案已评估后否决：`publish(entitlementFile)` 在每条独占路径上都会走到，没有真正只影响单个槽位的操作（#1384，refs #1307）。
- 修正准入等待计时器被 `unref` 导致的挂起。事件循环空闲后 unref 的计时器不再触发，`settledWithin` 里的竞态会永久 pending 而不是超时；`finally` 里的 `clearTimeout` 本就负责清理，`unref` 没有带来任何好处（#1384）。
- OAuth 错误码守卫要求必须是字符串。`RegExp.test` 会先把参数转成字符串，`undefined` 与 `null` 变成 `"undefined"` / `"null"` 后都能匹配码的格式，于是守卫返回原值而不是兜底值。可达路径是 helper 自身的失败分支：OAuth helper 以 `{"ok":false}` 退出且没有 `error.code` 时，抛出的错误带着 `code: undefined`，面板看到一个没有错误码的失败，尝试记录里也是空 —— 而错误码正是判断授权为何失败的唯一线索。改为与仓库里另外四处码守卫一致，先判类型再跑正则（#1388）。

## 1.4.168 — 2026-11-20 · Gemini 宿主诊断与协议修复

- 管理员可在「订阅 CRAG」右上角兑换本机 CRAGGemini 签名载荷。只接受当前签名清单对应的授权码；载荷激活与 Google 授权、推理支持和 Claude CRAG 订阅独立。授权码在发行机用 `scripts/issue-gemini-release-code.mjs` 签发，同一签名清单在同一私有发行目录只生成一个；只有对应的 `.json` 校验配置装到宿主，明文码不入库（#1340）。
- Gemini 环境详情新增代理与测试诊断。「代理」可查看、测通或换绑 IPv4 SOCKS5，换绑会清除模型与账号快照但不删登录，授权、终端或测试运行时不得换绑；「测试」先拉取模型再发单条纯文本，提交返回 `run_id`，由 `GET`／`DELETE /test-chat/:run_id` 轮询或取消，结果只在宿主内存短暂保留。OAuth 走隔离的官方 `agy`，API Key 只列目录中声明支持 `generateContent` 的模型。请求只用当前账号及绑定代理，不切换账号、不回落直连；不计入 vm2api 密钥扣费，但可能消耗 Google 侧用量（#1374）。
- Gemini 宿主部署支持签名的 `0.3.0-rc.2`；配置安装源时，安装命令会先验证并落地载荷，再报告成功。已授权的 Google 账号可从详情页点「启动 Gemini」，打开走绑定代理的 Antigravity CLI 终端，不影响公共推理和计费。
- Gemini 终端仅在启动时识别 Google OAuth 菜单；会话中的同样文本不再断开终端或改写账号授权状态。
- 默认 CRAG 标准载荷升级到 `3.1.10`：修正原生 TUI 遥测的入口绑定，并补上供应商账号切换后工具结果的恢复。不自动重启现有槽位（#1371）。
- 上游拒收采样字段本身时，剥掉参数重试一次。此前这类 400 被归到 `invalid_request` 直接失败：中转或厂商模型压根不接受 `temperature`，或只在 thinking 下接受 `temperature=1`。现在归为 `sampling_repairable`，给一次不带采样参数的重试。repair 不改请求体——它跑在组装之前，删掉的字段会被 `ensureClaudeOAuthBodyDefaults` 补回——而是把 `dropSampling` 送到组装层，由 HTTP／cli-hop 与 CRAG print 两条出站路径各自落实。`temperature: 1` 作为真实 Claude Code 的行为仿真仍然保留，只在上游明确拒绝时才省略（#1370）。
- 修复 cookie 导入在浏览器段之后报 `upstream transport failed`。`kin-worker oauth session-code` 需要的是 `worker.json`（含 `vm_id`、`proxy_url`、`egress_mode`），桥接却传了 `kernel.json`——后者没有 `egress_mode`、`proxy_url` 又是空串，于是构造出一个拒绝所有连接的 client，拨号报 `slot proxy is required`，而错误分类只匹配 `proxy required`（少个 `is`），最终落到默认分支显示成传输失败。授权链接那条走浏览器，不受影响（#1375）。
- Responses WebSocket 上，`generate: false` 预热返回的 `response.id` 可在同一条连接上续接。此前完成分支把预热跳排除在连接回放缓存之外，下一跳必然 miss 并返回 `previous_response_not_found`，Codex 的 `thread/sample` 走这条路径时不显示后续提示词建议。缓存仍是连接内的，`store: false` 不变成持久化，跨连接引用该 ID 仍然拒绝（#1378）。
- 文档、CHANGELOG、源码注释与面板文案去掉第三方项目的归因，保留运行标识、导入路径、账号导出类型字符串和脱敏声明；迁移 SQL 一个字节未动，避免改变 migration checksum（#1377）。

## 1.4.167 — 2026-11-20 · 共享出口产物修正

- 修正 amd64 `kin-egress` 的锁定产物。`release.yml` 只在 ARM64 分支从 `worker/` 源码编 Go helper，amd64 的 helper 取自 `deploy/payload.json` 锁定的产物，因此 1.4.166 发出的是「控制面带共享出口、helper 还是改动之前的版本」这一组合：第一台 VM 折叠时 helper 在 `unsupported proxy scheme ""` 上崩溃循环。锁定改为 `payload-2026.11.20-shared-egress`，只换 `bin/kin-egress` 一项，其余 23 个文件重算后字节一致。判断主机上的产物是否够新：`strings -a /opt/vm2api/bin/kin-egress | grep -c 'no route for source'`，0 即为旧产物（#1369）。
- 默认 CRAG 标准载荷升级到 `3.1.9`：有请求排队且槽位耗尽时，等待工具结果的父会话可让出进程槽，子代理完成后仍可按已验证的历史续接。不自动重启现有槽位。
- 普通硬正则的关键词命中只拒绝本次请求，不再封设备或会话。此前文档里引用 `keygen` 这类子命令名就会把设备打进封禁阶梯，被拦请求还会留下永久的会话封禁行；与系统提示词改写规则（cd14409c）同理，真实越狱仍会被上游拒绝并进入拒答缓存。NSFW 类别证据确凿（显式内容而非歧义关键词），维持强制封禁，且面板关闭设备封禁开关也不放松。升级后请一并清理既有误封记录（`DELETE /api/panel/refusal-device-blocks`），该修复只拦截新的写入。
- 出站采样参数与思考模式对齐补齐两种 shape 并加值域校验。`between_tools` 是 effort `off` 时由控制面自己注入的思考模式，此前调用方的 `temperature` 原样送到上游而被 400；`requires_adaptive` 的模型即使请求体不带 `thinking` 也在思考，现在按模型 shape 锁定采样参数。非法值（`temperature: 2.5`、`top_k: -1`）就地纠正而不是透传（#1368）。

## 1.4.166 — 2026-11-20 · 并发请求内核修复与共享出口

- 重编 `wrap` / `cc` 的 Linux amd64 `kin-kernel`。共享 stdin 的 10 秒超时仅计算实际写入，避免并发请求等待写锁时误触发 CLI 重启；半写失败会关闭旧管道，防止下一条请求接到残缺帧后。
- 新增按槽位可选的「共享出口」：同一节点的多个槽位共用一个 `kin-egress` 与一张 `/20` 网桥，取代一槽一张网络一个 helper。路由表以槽位在网桥内的源地址为键，每条路由自带出口（dialer、DoH 客户端、首选上游、DNS 缓存），因此共享 helper 不等于共享出口身份。槽间互访由 `enable_icc=false` 与 FORWARD 链上的同网桥 DROP 双重拦住，两道屏障都以节点的 `bridge-nf-call-iptables` 为前提，缺失时不进入共享模式。集群侧的地址申领与路由发布在节点锁内完成，复用槽位已记录的地址前先核对该地址当前的持有者，避免把正在运行的槽改号（#1351）。
- master API key 可以兑换许可并绑定宿主订阅席位。该 key 是运营者自己的自动化、不经浏览器会话，同源校验对它不适用；安装、开机与在线兑换三个入口放开，绑定目标仍只有宿主订阅，面板会话与受管密钥的判定不变（#1360）。
- 点分 Claude 模型 id 统一规范化。此前是 `fable-5.1`、`fable-5.2`、`opus-5.5` 三个硬编码，每个新 x.y 版本都要手工补，`claude-sonnet-5.5` 与 `claude-haiku-5.5` 一直没补上——直连被判 `model_not_supported`，api 后端把点分 id 原样发给上游。改为在请求入口、目录写入、目录未就绪的透传和 api 调度回落四处统一改写，只处理 `claude-` id 里的 `数字.数字`，`gpt-` / `codex-` 与带日期的 id 不动（#1357）。
- 内核恢复预算耗尽的槽位在列表与卡片上直接显示「受限 · 内核故障」，不再伪装成「开 · 可用」。此前该故障只存在于内存表里，调度器跳过该槽而面板照常亮绿灯，只能逐台打开「检查连线」才能看到 `kernel_faulted`；现在面板三态判定与调度器看到同一台坏槽，watchdog 恢复后自动回到「开」，更强的死因（吊销、关机、调度关）仍保留自己的文案（#981）。
- Linux amd64 安装默认准备签名 CRAGGemini 和官方 Antigravity CLI，由管理员兑换激活。Gemini 的 `/vm` 详情可检测和切换代理、拉取模型、发起或取消单轮文本测试。OAuth 使用绑定代理和官方 CLI；公共推理与计费不变。

## 1.4.165 — 2026-11-20 · 集群 CRAG 更新与出口维护

- `crag-update` 由控制面逐槽更新本机和集群槽，不再在本机探测集群容器。运行槽确认无请求和工具续接后才重启；已停止的槽只更新签名包，断线恢复也不启动（#1348）。
- 出口维护命令支持清扫残留和统一重建；重建期间限制涉及的调度活动。集群槽按节点分配端口，避免多个槽占用同一对端口（#1345、#1346、#1347）。

## 1.4.164 — 2026-11-19 · 出口残留清扫与 CRAG 3.1.8

- 退役代理时清扫出口残留。此前删掉一个出口没有任何配套清理，留下的 docker 网络永久占着网段——本机 12 张 `kin-eg-*` 里 11 张已无容器附着，合计占掉 docker 默认池的六个 `/16` 和五个 `/20`，这是地址池耗尽与 VM 数量并列的第二成因。孤儿运行目录危害更直接：它持续占着一对监听端口，而端口只有 8000 个槽（实测 `px-test-b` 的网络早已不存在，仍占着 20218/20219）。清扫覆盖网络、运行目录、helper 容器、iptables 链、bridge 设备五类；后两类从实际规则集与链路列表读取而非从「网络已删」推断，因为网段分配器只读 docker 与宿主路由表，看不见一条游离的链或设备。扫描与执行分离，「孤儿」与「该删」也分离：单独清扫只碰孤儿，统一重建才动在用的；共享的 local bridge 永不判为残留。调用方注入存活的 proxy / VM id，所以该模块不依赖数据库，可以独立当巡检工具跑（#1339）。
- 活跃 Session 改为按调用方 `session_id` 聚合（为空时回落出站 id）。Claude Code 的旁路小请求（标题、话题判断等，只输出十几个 token 却复用主对话的缓存前缀）每次都在 `metadata.user_id` 里带新的出站 session_id，按出站 id 去重会把同一个对话拆成几十个「只有 1 次请求、缓存读取占 99%」的会话，活跃数虚高。列表 total、行数据与概览 `activeSessions` 现在口径一致，点击筛选仍同时匹配两列；Token 与成本统计不受影响（#1341）。
- 默认 CRAG 签名载荷改为 `payload-2026.11.20-crag-3.1.8`，修复账号变更后按 provider 账号范围的续接恢复。不自动切换运行中的槽位，3.1.7 及更早的载荷仍可在内核页选用，其余锁定载荷不变（#1342）。

## 1.4.163 — 2026-11-19 · 出口网段与端口显式分配

- 出口网络创建时显式传 `--subnet`，不再从 docker 的 `default-address-pools` 取。那个池只有约 31 个网段，而 SOCKS 出口下每个 VM 占一张网络，规模到 200+ 时出口网络就建不起来、VM 开不了机。网段取自 `100.64.0.0/10`（RFC 6598）按 /28 切分，每节点 262144 个；分配无状态且确定——索引由 id 派生，并探测跳过 docker 与宿主路由表已占的部分，所以 VM 重建会落回原网段，运维手工分出去的网段按既成事实读入，不需要数据迁移。显式传 `--subnet` 即绕开地址池，因此不必重启 dockerd，已存在的网络继续走原样未动的复用分支。
- 出口端口分配加入碰撞检测与避让。此前 `portsForProxy` 把代理哈希进 8000 个槽且不检测冲突、不重试，单机数百出口就会静默撞端口；现在优先复用 helper 已启动的那一对，否则探测跳过其他 helper 占用的。拆除路径改为读回已启动的端口而不是重算，否则会删错 iptables 规则。
- 修正 `gatewayFromSubnet`：原先取网段前三段拼 `.1`，对任何长于 /24 的前缀都会算出网段之外的地址（#1336）。

## 1.4.162 — 2026-11-20 · 宿主兑换的可重试与原因可辨

- 宿主订阅兑换失败时保留授权服务的请求 ID，便于区分线上 403；面板不显示兑换码、宿主凭据或上游原文。
- 宿主兑换响应丢失可用原码重试，不重复入账；上游明确拒绝与待同步分别提示，重试时遇到授权拒绝不会丢失待同步记录（#1333）。

## 1.4.161 — 2026-11-20 · 工具调用续接重放与失败原因保真

- Messages 续接请求恢复完整的工具调用：从已发出的公共 JSON 或完成的 SSE 回复里取回原始 `tool_use`，并把客户端自己生成的 ID 及其 `tool_result` 引用一并改回。只在同一认证会话的历史里存在唯一有序匹配时才重放；截断的流、歧义匹配、以及目标 ID 已在历史中出现过的情况一律不动（#1327）。
- 内核安装启动失败时保留内核侧的真实原因。此前容器起来了但内核没起来，也一律落成通用的 `kernel_start_failed` 提示；现在 `boot.rust` 上的 code、error 与 reason 会带进结果和槽位的 `kernel_operation.failure`，排查不必再去翻日志（#1330）。
- `verify-init-telemetry-sync` 的 `--live` 主密钥检查不再被静默跳过：该函数内部只认 `VERIFY_LIVE` 环境变量的旧守卫与新增的 `--live` 参数不一致。同时修正两处读取——含 `=`（base64 填充）的 `KIN_API_KEY` 不再被截断，`KIN_VERIFY_BASE` 按源站处理并由各检查自行拼接路径，不再被当成完整 URL（#1329）。

## 1.4.160 — 2026-11-19 · 控制面独占启动与出口故障隔离

- 宿主机和 Docker 控制面共用安装目录时，只允许一个启动，避免两者争抢 `kin-egress` 的 TCP/DNS 端口。Docker 从入口脚本到 Node 持续持锁，自动槽位同步仅由成功监听的实例执行。
- 单条宿主机 `kin-egress` 故障只限制依赖它的本机槽；其它出口、同代理的远端槽和本机 GPT 槽不受该 helper 故障影响。批量代理探测限并发；Docker 或监听检查不可用时不据此下发限制。
- 固定代理通过健康探测后，自动清除当前绑定槽上该代理留下的 `proxy_cooldown`，即便代理行早已显示健康。保留手动禁用、调度关、维护锁和确定性限制；不更换出口或回落直连（#1325）。
- 退役旧 telemetry sender 的判定补上 docker CLI 自身的传输错误。1.4.159 用「有数字退出码」作为「脚本真的跑过」的判据，但 docker CLI 在集群桥 socket 不存在或连接被重置时同样以 `exit 1` 退出，与脚本自判失败不可区分，这两种链路故障仍会被报成 `kernel_start_failed`。脚本改为先打印 `kin-retire:ran` 标记，只有「有数字退出码且 stdout 带标记」才算脚本自己的判定；放行时打 warn 日志便于事后追查。维护锁自愈同时收紧为只解除 watchdog 当时看到的那个 tag，期间若有新 cutover 换了 tag 不会被误解锁（#1324）。

## 1.4.159 — 2026-11-19 · 节点链路抖动不再误伤启动与调度

- 启动前退役旧 telemetry sender 时区分「脚本判定」与「传输失败」：数字退出码才算脚本真的跑过、sender 确实没停；没有退出码（链路抖动、超时、spawn 失败）先重试一次，仍无法验证就放行启动并标记 `legacy_telemetry_unverified`。此前控制面重启后的 SSH 抖动窗口会把健康槽报成 `kernel_start_failed`，而容器里根本没有 telemetry 进程。真正卡死的 sender 在链路恢复后的下一次启动仍会确定性失败。
- 内核健康的槽位上，`slot-runtime:` 维护锁超过 10 分钟未释放时由 watchdog 解除。控制面在 cutover 中途重启会把操作级维护锁永久留在槽 json 上，容器和内核之后完全健康，槽却一直「维护中」退出调度，此前只能手工改 json 救回。活体 cutover 全程把 watchdog 挡在外面，解锁只作用于 `slot-runtime:` 这个命名空间，内核安装、迁移和代理 hold 都不受影响（#1320）。

## 1.4.158 — 2026-11-19 · 用量窗口各记各的采样时间

- 5h 与 7d 的 Extra 窗口各自记录 `sampled_at`，只带 7d 头的响应不再让 5h 的旧数字看起来是刚读到的。官方 `/usage` 探测只在真的把读数抄进 Extra 时才刷新共享的 `sampled_at`。
- 过了 reset 的 Extra 窗口在每次写入时就存成过期（`stale_reason: reset_elapsed`），不再等定时 reconcile；新读数只带 status / reset 时也不会把上一窗口的 utilization 合并进来。
- 窗口档案在 Extra 的 reset 已过时改用官方读数，上一窗口收进 `prev`、新窗口进 `current`；官方那份是「窗口开始后没有网关流量」的残留 100% 时仍然跳过。调度门禁本身不变，过了 reset 的 Extra 一直按 0% 看待（#1312、#1317）。

## 1.4.157 — 2026-11-19 · 槽位伴生浏览器桌面与登录、启动稳定性

- Docker 槽可选开启伴生浏览器桌面：独立容器跑 Xvfb + fluxbox + Chromium + x11vnc，与槽容器共享网络命名空间，浏览器流量因此走槽位自己的出口（同一出口 IP、同一 DNS-over-TCP 重定向）。x11vnc 只监听容器私有 `/tmp` 下的 unix socket，面板经 Engine API 的非 TTY `docker exec socat` 透传 RFB，再由票据 WebSocket 交给 noVNC，不发布任何端口。仅管理员可用；GPT 槽、KVM 槽和 macOS 原生节点不支持。浏览器资料存在命名卷里，重置或删除槽位时一并清除（#1292）。
- 原生登录的凭证确认加 180 秒 deadline，覆盖 exit-code inspect、凭据读取与导入这三个都要过节点链路的步骤。链路挂死时面板给出超时提示并说明去槽位详情核对凭证，不再永远停在「等待确认」。授权链接复制改走 `copyText` 兜底，纯 HTTP 面板（没有 secure context，`navigator.clipboard` 不存在）不再复制失败（#1313）。
- 槽位内核启动前修复空的或无法解析的 `~/.claude/.claude.json`：从 CLI 自己写的最新一份可解析备份还原，保留 `userID` 与 `oauthAccount`。此前这个文件损坏会让 CLI 无限重启、内核切换一直挂住。文件健康、缺失、是符号链接或刚被写过时一律不动，没有可用备份时什么都不写（#1308）。
- 来宾 `kin-kernel` 不再因 start-limit-hit 停在 failed。许可还在投送时内核会快速退出，systemd 默认的 5 次 / 10 秒配上 `RestartSec=2` 会在约 8 秒后放弃，之后许可到位也不会把内核拉起来；单元加 `StartLimitIntervalSec=0`，按 `RestartSec` 一直重试（#1309）。
- 发往 CRAG 的请求移除 Claude Code 2.1.325+ 每轮都会带的 `diagnostics` 字段。CRAG 内置的 Claude Code 早于这个字段，带上会把整个请求以 400 `unsupported request field` 拒掉，而该字段只是请求可选的缓存诊断（#1306）。
- 锁定 `payload-2026.11.19-oauth-config` 的 `kin-oauth-auth` 与 `kin-worker`，其余锁定载荷不变（#1301）。

## 1.4.156 — 2026-11-19 · 已关闭订单收进折叠历史

- CRAG 订阅页的订单列表按状态分流：进行中的订单保留完整详情行，已取消和已过期的收进可展开的「已关闭订单」折叠区，并标明笔数。此前所有订单平铺同等高度，关闭很久的订单会一直压着买家正在等付款的那一笔。折叠区用原生 `details`，内容始终在 DOM 里，页面内搜索和读屏都能拿到。全部订单都已关闭时，空状态改为提示已关闭订单在下方，不再显示「还没有订阅订单」。
- 修正 1.4.155 放开取消条件后过时的面板文案：取消按钮由「取消预留订单」改为「取消订单」，确认框说明未支付订单会在核对商城状态后关闭、已支付不会被取消，并删掉「仅尚未发送至商城的预留订单可取消」这条已不成立的提示（#1304）。

## 1.4.155 — 2026-11-19 · 未支付订单自动过期与手动取消

- 已提交给商城但未支付的 CRAG 订单现在可以在面板取消。`reserved`（下单请求没拿到支付表单，买家从未收到支付链接）直接关闭，商城不可用时也能清理；`pending`（支付链接有效）先向商城复核，仍未支付才关闭，已支付的返回 `shop_order_paid` 并拒绝取消。此前只有未发给商城的订单可取消，导致失败的下单留下的订单永久堆积在历史里。
- 未支付的订单在下单 30 分钟后自动关闭：每分钟核对一条，`pending` 订单先向商城复核，迟到的付款会被回写为已支付并保留订单。关闭记录在新的 `closed_at` 列，不改写订单真实的派发与支付状态；商城协议本身没有过期或取消的概念，也没有取消端点，所以这个判定只能在本地做。

## 1.4.154 — 2026-11-19 · OAuth Cookie 桥接与 CRAG 3.1.7

- Cookie 导入改为在 `kin-worker` 内铸造 session code（经 Chrome-TLS 桥），普通 fetch 会被上游以 `missing_client_attestation` 拒绝。helper 新增可选输入 `worker_config_path`，guest 槽继续走 `KERNEL_CONFIG`；缺少新 `kin-worker` 时明确报错，不再静默降级（#1297）。
- Setup Token 粘贴码改为铸造一年期 `user:inference` 票据，与保留刷新票据的账号转换区分；换票后续按原生客户端链路（profile → eval → roles → first_token_date → eval → bootstrap），不再写 Grove。授权链接的 scope 同步收窄为 `user:inference`（#1297）。
- 内核载荷升级到 CRAG 3.1.7（标准签名包，授权与产品密钥不变），并更新 `kin-oauth-auth` 与 `kin-worker` 的锁定大小和 SHA-256；`kin-egress` 等其余锁定载荷不变（#1297）。
- 原生 handoff 的 realtime 在第一个可见工具字节之前提交当前槽，然后按到达顺序放出工具 start 和每一段 `input_json_delta`。`verified` 仍扣到 EOF。参数到 EOF 不是完整 JSON object 时返回错误，不补成成功 `tool_use`，已提交的流不换槽（#1296）。

## 1.4.153 — 2026-11-19 · CRAG 域名切换与回调兼容

- 后续版本的 CRAG 商城、设备激活和宿主订阅请求改指向 `https://www.vm2api.org`。源站继续同时接受 `crag.fkcodex.com`。
- 商城 checkout 回复的 `notify_url` 与 `return_url` 接受新旧两个源站域名，但两者必须同源；混用新旧域名的回复仍按无效回复拒绝。

## 1.4.152 — 2026-11-19 · 内核多版本缓存与调度状态修正

- 内核缓存可同时保留多个版本：每个版本（CRAG 按 `payload_tag`，cli-node 按 tag）留一份，最多 6 个，当前版本不会被清理。此前只留当前和上一份，想让不同槽位跑不同版本就得反复重新下载。新增 `GET /api/panel/kernels/cached?kernel=crag` 列出本机已缓存的版本，`POST /api/panel/kernels/select {kernel, tag}` 把安装用的当前版本切到已缓存的包，不重新下载；安装进行中拒绝切换。已安装的槽位各自持有内核副本，切换或清理缓存不影响运行中的槽位（#1269）。
- 管理员持有的托管 key 也可用 `x-kin-vm` 指定槽位，运维测试流量因此能在用量日志里带上用户；其他调用方的该请求头继续忽略。钉槽不放宽这把 key 能触达的范围，客户端闸门、归属和 key 作用域都不变（#1271）。
- 已记录的不可调度失败（凭据吊销、组织停用等）优先于运维的「调度关」显示，死槽不再伪装成等待重新开启的健康槽位；运维的关闭意图仍然保留（#1270）。
- 面板升级脚本的健康探针按速率限制节流，遇 HTTP 429 读取 `Retry-After` 退避重试，最多三次；需要等待超过 30 秒时直接报错而不是无限等待（#1275）。
- 「订阅 CRAG」页头和套餐预览画布都显示 Telegram 群入口，徽标链接到 https://t.me/vm2api。免登录购买页同样显示（#1280）。
- CRAG 3.1.7 签名载荷与其他锁定二进制载荷不变。

## 1.4.151 — 2026-11-19 · OAuth 换票与 CRAG 3.1.7

- Cookie 导入和粘贴授权码共用换票后的账号资料、角色及客户端初始化流程；后续资料读取失败不丢弃已换到的票据（`a1e77411`）。
- 锁定新版 `kin-oauth-auth` 到 `payload-2026.11.19-oauth-eval`，使控制面与槽内 helper 使用同一契约（#1286）。
- 内核页默认下载 CRAG 3.1.7 标准签名包，保留原授权。原生 TUI 固定使用 `cli` 入口，不自动替换已安装的内核（#1288）。

## 1.4.150 — 2026-11-19 · OAuth Setup Token 与原生 Claude 初始化

- Setup Token 粘贴码按原生 CLI 契约申请一年期 `user:inference`，与保留刷新票据的账号转换区分。授权来源拒绝、换票限流和出口拒绝显示不同提示（#1283）。
- 官方初始化只在原生 Claude Code 且磁盘凭据有效时运行；CRAG 补齐原生 CLI 实际读取的引导配置，保留已有槽位身份（#1283）。
- 更新 `kin-oauth-auth` 锁定载荷；CRAG 3.1.6 及其他附件保持不变，无需 `wrap-cli/sync`。

## 1.4.149 — 2026-11-19 · Claude 槽位 OAuth 读取修复

- 原子修复 Claude 槽位的 `.credentials.json` 相对软链接，继续读取面板保存的 `credentials.json`。本地 OAuth 凭据无法加载时，不向该槽位派发推理（#1278）。
- 拦截槽位返回的 `NO_ACCOUNT`，尚未输出且允许切槽时改用其他槽位；无可用槽位时返回通用 `503 pool_unavailable`。不重放已开始输出的请求（#1278）。
- CRAG 3.1.6 与其他锁定二进制载荷不变。

## 1.4.148 — 2026-11-19 · OAuth helper 载荷更新

- 更新 `kin-oauth-auth` 的锁定大小和 SHA-256，匹配已更新的 OAuth 载荷附件；Setup Token 首次授权使用 `https://claude.ai` 作为来源。保留 `1.4.147` 的 WARP 修复；CRAG 3.1.6 和其他二进制不变。
- GitHub Actions 缓存导出失败不再阻止镜像发布；载荷校验、镜像构建及推送仍须通过。

## 1.4.147 — 2026-11-19 · WARP 内核安装与 CRAG 回滚兼容

- WARP 一键安装在后台执行，面板按任务 ID 查询逐槽结果。连接短暂中断时只重试查询；无法确认当前槽结果时暂停后续槽位，不重复提交安装（#1272）。
- CRAG 升级回滚后，以认证和就绪状态验证按需进程池；健康空闲时不再因 `cli_pid=0` 被误判并再次停机（#1272）。
- 调度策略面板增加「临近重置优先」开关，可管理已有的周额度重置优先策略，不改变手动档位（#1264）。
- CRAG 3.1.6 签名载荷及其他二进制载荷不变。

## 1.4.146 — 2026-11-18 · Codex 请求兼容与遥测开关

- Codex Responses 请求保留指定工具和允许工具列表里的命名空间，移除上游不支持的顶层 `max_completion_tokens`，不修改工具参数 schema（#1266）。
- 保留 `response.incomplete` 及上游停止原因，不再用 token 用量判断流是否正常收尾。兼容接口将输出上限和内容过滤映射为对应的停止原因（#1266）。
- 遥测设置新增「新建槽默认开启」，默认关闭。打开并保存会同时开启现有 Claude 槽的遥测；关闭只影响后续新建槽。面板会报告策略下发失败的槽位（#1265）。
- CRAG 3.1.6 签名载荷及其他二进制载荷不变。

## 1.4.145 — 2026-11-18 · 槽位 OAuth helper 更新

- 更新 `kin-oauth-auth` 和控制面调用契约。普通授权码与 Cookie 导入使用 OAuth profile，`setup-token` 使用独立 profile；换票仍走槽位绑定的出口（#1259）。
- CI 对 OAuth 代码或锁定载荷变更运行真实二进制契约测试，验证 PKCE、回调 state、Cookie 导入和设置确认。CRAG 3.1.6 和其他载荷不变。

## 1.4.144 — 2026-11-18 · 出口热加载、DNS 缓存与调度策略

- 流已开始但上游无法正常收尾时，返回可重试的 `rate_limit_error`，日志保留真实截断原因（#1247）。
- `kin-egress` 限制在途 UDP DNS 查询；代理和 DNS 配置可通过 `SIGHUP` 热加载，已建立连接不受影响（#1247）。DNS 正缓存过期后可先回旧值并限量后台刷新；负缓存到期即重新查询，切换配置不会沿用上一份配置的缓存（#1248）。从旧版本升级时，首次替换出口 helper 可能短暂中断旧连接。
- Gemini 宿主控制接口与模型列表兼容 Python 3.8，保留原有路径和模型名处理行为（#1249）。
- 系统提示词改写规则不再把 Claude Code 自带 skill 的普通说明当作改写指令。命中只拦截本次请求，不强制封禁设备或会话，日志不记录命中前后的请求正文（#1251）。
- 新增 `routing.pool.reset_priority`，默认继续按周额度重置时间排序；关闭后自动档位统一为 1，手动档位仍优先（#1252）。
- CRAG 3.1.6 签名载荷与其他槽内核 / CLI 不变；无需 `wrap-cli/sync`。

## 1.4.143 — 2026-11-18 · CRAG 3.1.6 原生遥测

- CRAG 签名标准载荷更新至 3.1.6。沿用槽位遥测开关，默认关闭；可通过 `CRAG_NATIVE_TELEMETRY_ALLOWLIST` 限定官方 Claude Code 上传的事件与字段。不自动切换运行槽位。

## 1.4.142 — 2026-11-18 · 安装升级失败可恢复、本地排队 529 可区分

- 一键安装与升级在 `compose pull` 失败时还原 `.env` 的 `VM2API_IMAGE_TAG`。此前目标 tag 先写入 `.env` 再拉镜像，拉取失败直接退出，`.env` 指向一个不存在的镜像，下一次 `compose up` 起不来控制面。
- 托管 CRAG 内核的本地队列满或排队超时，仍按 529 `pool_overloaded` 返回，但 `error.details` 标明 `{source: "local_kernel_queue", reason}`，客户端和日志能把本机内核排队与上游过载区分开。
- 本版不改变上游计费策略。

## 1.4.141 — 2026-11-18 · CRAG 重装热修

- 修复 CRAG 内核重装必定失败：CRAG v2 进程池在 prewarm 关闭时按需拉起 Claude 进程，空闲健康时上报 `cli_pid: 0`，安装的就绪判定却要求常驻进程，于是内核已健康监听也判 `kernel_start_failed`。进程池模式下不再要求常驻进程。
- 槽位内存按 VM 上配置的席位数定档。此前只按账号档位查表（Pro 一律按 5 席定 2g），忽略面板里配的席位数，配 2 席的槽位在小内存宿主上被要求 2g 而触发 `host_memory_exhausted`。未单独配置时，档位表也不超过全局席位设置。
- 内核安装支持后台执行与强制取消：`POST /api/panel/kernels/install` 加 `background: true` 立即返回；`POST /api/panel/kernels/install/cancel` 强制取消单个 VM 的安装，立即释放同类内核的安装占用，已停机的槽位保持维护状态等待检查。内核页安装进度加「强制取消」按钮。此前安装请求经代理超时后服务端仍在跑，其他 VM 重装一直报「正在重装同类内核」。
- 本版不改变上游计费策略。

## 1.4.140 — 2026-11-18 · CRAG 订阅页收敛为两个数字

- CRAG 订阅与授权界面只展示两个数字：「使用中的槽位」和「充值可用槽位」，满了继续充值即可。此前同一个量在界面上有四个叫法（「剩余可用槽位」「剩余可绑定槽位」「订阅槽位额度」「宿主机应用锁额度」），其中两个还同屏相邻显示；「CRAG 运行数」「当前 VM 总数」「运行中的订阅槽」三个重复计数和「待回收绑定」一并移除，回收流程本身不变。订阅到期时间此前有数据但完全没显示，现在补上，到期前 7 天显示剩余天数。
- 「使用中的槽位」只统计**真正在运行调度**的 CRAG 内核，与额度强制逻辑同源（`runtime.host_running_vms`）；关闭调度的、没有有效凭证的都不计入。此前曾用「可用槽位」反推，那个数来自绑定与席位，与真正卡住请求的数不是一回事，照着它充值可能白充。切换 VM 内核到 CRAG 不受额度限制，可随意切换，只有真正要调度时才需要槽位凭证。
- 宿主订阅（按槽位计）与设备授权（按机器码）在界面上分开呈现，并说明设备注册码不占用订阅槽位；本槽授权里的「槽位 N」改称「绑定编号 N」，它是席位编号而不是额度。兑换失败文案按错误码归一到单一来源，三类冲突措辞可区分（订阅码已在其他宿主机兑换 / 设备码已绑定另一台设备 / 内核版本冲突），此前两处面板各写一份、同一个错误码措辞不一致。
- 开发与发布分工落到 CI：日常集成在 `dev`、发布从 `main`，`ci` 对两条分支的 PR 都跑；`release` 增加校验，tag 必须指向 `main` 上的提交，避免从旧基线打出发版 tag。清理 3 个一次性的 `oneshot-*-226` 工作流。
- 本版不改变上游计费策略，也不改变 CRAG 额度的强制规则。

## 1.4.139 — 2026-11-18 · 连续会话固定账号与 Antigravity 接入

- 延续的对话固定在它首次落到的账号上：`keep_session_home` 下 home 槽位忙时等待而不是溢出到别的账号，只有模型门禁挡住时才借用其他账号，并且保留会话 pin，门禁解除后回到原账号。
- 新增可选 `pool.fable_requires_max`，开启后 Fable 不落 Pro 账号，面板在非 Max 槽位显示「仅 Max」；该门禁先于按账号的 Fable 拒绝上报。需要 usage credits 的账号把 Fable 停放并在面板标注，failover 用尽时返回上游那个 usage-credits 429 而不是通用错误，限额查询的 Fable hop 也记录同一标记。
- 第三方客户端的 system prompt 搬进首条 user 消息（绑定 `claude_code_only`），避免触发上游的第三方限制；搬动时保留缓存标记，CRAG 的 system 投影一并重定位，合并前导指令前先规范化 system 文本块。
- 上游「Third-party apps now draw from your extra usage…」和「no third-party apps allowed」（HTTP 400/503）单独归类为 `third_party_client`：客户端收到 400 `invalid_request_error`，文案为中性说明，`details.upstream_message` 保留原文，请求日志 `error_code` 记为 `third_party_client`。主修复是 #1208（把第三方 system 搬进首条 user，避免触发）；这里只管漏网时的归类和兜底。不再报成 `refusal_guard`「usage policy」，不写拒答缓存、不封会话或设备（取代 #842 的缓存和 1.4.131 的会话封锁），不换号、不冷却槽位，请求日志归「请求格式」、不计 SLA 失败；历史上记成 `refusal_guard` 的同类行也按「请求格式」统计。
- 上游拒答会彻底结束调用方会话，但 auto-mode 分类器自己的拒答不触发结束；SSE 的拒答细节保留在分类器诊断里。
- 池内每个账号都回 429 时，返回上游那个 429，不再折成通用 502。
- 只含 thinking 的 `max_tokens` 响应返回 200，不再被 CRAG 判成空内容 502；realtime commit 之后该值能恢复。
- 接入 Gemini Antigravity：原生文本流适配器、面板展示共享额度与使用比例、宿主启动修复并把载荷故障与出口故障分开上报，导入页和 VM 页显示启动被阻塞的原因。
- 内核页默认拉取 CRAG `3.1.5` 标准签名包：普通请求与认证分类请求保留调用方的 system 文本块和缓存标记。沿用 `3.1.4` 的授权身份及官方 Claude Code `2.1.321`；旧版仍可选，本次不自动重装运行槽位。
- CRAG 买家订阅页按目录声明的 `presentation.layout` 排版，代理层透传该字段，`/crag-preview` 声明 `layout-1` 并消费布局草稿；`layout` 缺失按缺省排版处理，与 crag-auth 语义对齐。推荐角标回传改走父页真正读取的 edit 通道。
- OAuth 换票按使用点解析当前 VM 的代理出口，UA 跟随 `OFFICIAL_CLI_VERSION` 并统一 cli 入口，版本取 CRAG 原生入口锁定的那个；宿主与槽内 CLI 不再重复消费同一个 refresh token。
- 集群与槽位运维：节点不可达时可强制删除槽位，不再和「移除节点」互相卡死；旧来宾内核服务停机不再删除 `slot.env`，切 CRAG 时就地修复；出口以进程方式启停时清理容器方式遗留的 `kin-cp-egress`；槽位重新分配后清理过期的 VM 选择；引导流程未完成前已授权页面可访问。
- 发布流水线的 `vX.Y.Z` 与 `latest` 镜像 tag 只要 amd64 推成功就发布：ARM64 job 失败时降级为 amd64 单架构并留 warning，不再因为 ARM64 冒烟测试挂掉就整段跳过，导致这两个 tag 长期停在旧版本（v1.4.131~v1.4.138 就都没有裸 tag、`latest` 停在 v1.4.130）。ARM64 主机继续拉 `-arm64` 单架构 tag，一键脚本和面板不受影响。
- ARM64 发布门禁不再在 qemu 下执行 x86 CLI，只校验 ELF；该调用只服务 `docs/ARM64.md` 支持矩阵里未验证的 Codex / KVM / 远程 slot，本机 Docker 的 Claude slot 走原生 overlay 不受影响。
- 本版不改变上游计费策略。

## 1.4.138 — 2026-11-18 · OpenAI 模型目录 6.2 系列默认暴露

- 静态回退目录补齐 `gpt-6.2-astra` 与 `gpt-6.2-sol` 并默认启用，`GET /v1/models` 开箱即对外列出；两款在模型页同样默认可调度。
- 同步发现的新 ID 改为按回退目录决定默认开关：目录内的 ID 经账号 `/backend-api/codex/models` 确认后立即可调度，目录外的陌生 ID 仍默认关闭、等管理员启用。
- `gpt_model_policy` 新增 `seed_version`，对已同步过的实例一次性补齐新增代次。迁移只补该代次列出的 ID，不整体合并回退目录，避免复活上游已下线的旧型号；已存在的行保留上游 catalog 事实，只校正开关。升级后若不想暴露 6.2，在模型页关闭即永久生效。
- 目录客户端 `auto` 解析失败时的兜底版本跟随官方发布更新到 `0.169.0`，不再用过期版本向上游查询可见模型。内核出站身份与自定义 UA 不变。
- 6.2 两款尚无官方公布价目，内置价表不臆造，其用量按未计价处理。
- 沿用现有签名载荷，无需 `wrap-cli/sync` 或重装槽位；本版不改变上游计费策略。

## 1.4.137 — 2026-11-18 · Claude 入口工具历史兼容

- `/v1/messages` 转换混入的 Chat 工具调用及结果，保留原生内容块。`/v1/responses` 支持 Codex 动态工具声明，并在不跨消息和缓存边界时归并交错的并行工具历史；无法转换时返回具体字段错误。
- CRAG 面板复用已校验的入站结构，减少重复转换和冗余请求头（#1201）。
- 沿用现有签名载荷，无需 `wrap-cli/sync` 或重装槽位；本版不改变上游计费策略。

## 1.4.136 — 2026-11-17 · CRAG thinking 采样参数修复

- CRAG 在确定 thinking 模式后再校准采样参数：启用 thinking 或使用 adaptive 时将 `temperature` 设为 `1`，移除 `top_p` 和 `top_k`；关闭 thinking 时保留原值。修复最简 Messages 请求因采样参数不兼容返回 400 的问题。
- 沿用现有签名载荷；只需更新控制面，无需 `wrap-cli/sync` 或重装槽位。

## 1.4.135 — 2026-11-17 · Claude 托管工具与 CRAG 请求兼容

- Claude Messages、OpenAI Chat Completions 和 Responses 转发至 Claude 时保留受支持的托管工具定义；只无损转换根级工具 schema，无法转换时返回具体字段错误。
- CRAG 按运行时能力处理托管工具；`zero` 模式直接传递结构化 `system`。运行时不支持时在本地返回错误，不执行请求或轮换账号。
- 沿用签名载荷，无需 `wrap-cli/sync` 或重装槽位；本版不改变上游计费策略。

## 1.4.134 — 2026-11-17 · CRAG 订阅准入与开槽切核修复

- 解除 `sync-pending` 对整机有效宿主订阅和已购 CRAG 槽位的连坐失效，修复 4xx 拒绝或跨订单中断后遗留永久同步锁的问题，并在切换/兑换过程中不再无差别阻断运行中的 KVM 槽位。
- 无论通过何种购买方式或兑换路径获得订阅，本地订阅权益与运行额度均正常计算；纳入未发送订单取消、已登记 VM 计数及订阅页统一展示。
- 开槽、导入与切换推理内核到 CRAG 不再受前置单槽授权拦截；仅当运行中的宿主订阅 CRAG 槽位达到上限时阻止新增启动，且自动回收停机、已切回 cli-node 或已孤立的占位，不暂停已在运行的已购服务。
- 拆分设备码 `payload_key_conflict` 与 `license_redeem_conflict`，并在槽位未物化独立安装包时回落使用宿主共享包。
- 沿用现有签名载荷，不需要 `wrap-cli/sync` 或重装 CRAG 槽。控制面与面板需更新到本版。

## 1.4.133 — 2026-11-17 · CRAG 面板与 Responses 续轮

- 面板为原生 CRAG 规范化内嵌 `image_url`（含工具结果），保留内容顺序和缓存标记；无法保真的输入在面板返回 400。合规长历史由 4 次重建降为 1 次重建加 3 次校验复用。
- 删除 CRAG 槽、单槽或批量切回 cli-node、以及内核安装都会释放宿主订阅席位，避免已删除或已切走的槽继续占用名册。
- 面板可开关 CRAG 原生遥测：停机槽只发布设置；需要生效时先排空，再重启内核并恢复原调度。区分已生效和已验证上传。非 CRAG 槽的发送状态与日志展示不变。
- `/v1/responses` 转 Claude 时保留调用方工具的 `eager_input_streaming`，恢复消息级 `cache_control`，中途 developer 消息的缓存断点留在原位。
- 调度原因表补上 `license_crag_host_over_quota`（受限 · 宿主订阅满额）。
- 修复 KVM 来宾内核退出时误删 `/run/kin-guest/slot.env`、导致已校验的 CRAG 许可同步返回 403 的问题。已有来宾需更新 `kin-kernel.service` 并从原 seed 重新运行 `kin-guest-setup.service` 后再同步；无需重置虚拟机或重新签发许可。
- 沿用现有签名载荷，不需要 `wrap-cli/sync` 或重装 CRAG 槽。控制面与面板需更新到本版。

## 1.4.132 — 2026-11-17 · 已安装 CRAG 槽更新

- 宿主订阅满额时，正在运行的原 CRAG 槽仍可更新，不因运行额度拒绝。
- 候选安装失败后，只有旧版本重新启动并通过鉴权健康检查才恢复运行；未验证时保持停止并保留回滚包。
- 订阅状态暂时读不到时，在停槽前返回明确错误。沿用现有签名载荷，不需要 `wrap-cli/sync` 或重装槽位。

## 1.4.131 — 2026-11-17 · Codex 调用 Claude 协议修复

- `/v1/responses` 支持已获授权的 Claude 模型。控制面在派发给 CRAG 或 cli-node 前转换并校验结构化 Messages，按 `call_id` 配对工具历史，输出转换回 Responses JSON 或 SSE。无法转换的请求在本地报错，不把上游计费拒绝当作转换失败。
- CRAG 保留调用方工具名、系统提示分块与缓存断点，避免重复改写影响续轮。
- 纳入主线的 CRAG 订阅兼容与调度修复、风险审计系统提示改写开关、用量拒绝的会话级处理及官方客户端限制的明确报错。
- 载荷 [payload-2026.11.17-cli-node-321](https://github.com/dofastted/vm2api/releases/tag/payload-2026.11.17-cli-node-321) 将 cli-node 换为 2.1.321 UPX 5.0.2 `--best --lzma`（31005108 字节，`f6c3744dda01f756049360113607d2bd9a25911de0fdaf30fe9bb1a1918a6788`）；其余附件沿用现有固定载荷。仅当现有 cli-node 槽的程序摘要不一致时需要 `wrap-cli/sync`，无需重装 CRAG 槽。

## 1.4.130 — 2026-11-17 · Gemini 宿主账号与专用密钥

- 在 VM 列表和机架管理 Gemini 宿主账号，分开显示授权与运行状态。导入仍不创建 VM 或槽位。
- 新增 Gemini 专用 API Key，与 Claude、Codex 等调用范围隔离；Gemini 推理和计费仍未开放。

## 1.4.129 — 2026-11-17 · 会话粘性调度修复

- Claude 与 Codex 的有效会话绑定优先于调度等级和权重。调高其他 VM 的等级或权重不再迁移续轮；新会话及失去粘性后的重选仍按等级和选槽策略分配。
- Claude 已排队的续轮继续等待原 VM，保留出站会话身份。额度退水、不可调度及粘性等待超时仍按原规则处理。
- 纳入风险审计页面拆分（#1171）：前置拦截、Jev 分判定和运行状态分别展示。沿用现有签名载荷，不重装槽内核。

## 1.4.128 — 2026-11-17 · Gemini 授权启动修复

- 修复 Ubuntu 22.04 等宿主上的 Gemini Google 授权启动失败：使用兼容的 nftables 优先级，在 Docker 默认禁止转发时临时放行当前环境到绑定 SOCKS5 节点的连接，授权结束后清理规则，不开放直连。
- 纳入主线已合并的 CRAG 外部 thinking 签名错误修复（#1149）与集群 SSH 暂断时保留已有 VM 推理会话的修复（#1168）。
- 沿用现有签名载荷，不需要 `wrap-cli/sync` 或重装槽位；已启用 Gemini 的宿主需更新宿主脚本。Google 同意与换票仍需账号持有人完成，Gemini 对外推理及计费保持关闭。

## 1.4.127 — 2026-11-17 · Gemini 导入与宿主环境

- 「导入 → Gemini」支持 Google OAuth 授权码、回调链接及 Gemini API Key。可刷新上游返回的账号、项目、订阅、模型、配额和 Credits；API Key 模式只读取模型，不把未返回的数据显示为零。
- 「虚拟机」页独立展示 Gemini 宿主环境、出口节点、授权状态、载荷版本及可读数据。环境不创建 VM 或槽位，也不加入 VM 调度。
- 修复宿主服务必须先安装载荷才能监听的问题。启用服务后，首次创建环境自动验证并安装本机可信签名载荷；面板区分服务未连接、缺少安装源和验签失败。默认 Compose 配置接入宿主 socket。
- Gemini 预览仅支持 Linux amd64 宿主，需管理员启用服务并独立配置可信公钥及载荷来源；本版不附带 Gemini 二进制或签名包。真实 Google 换票、自动续票和推理未验收，对外推理和计费仍关闭。详见 [Gemini 宿主机安装说明](docs/gemini-host.md)。
- 本版也纳入已合并的本机 KVM 槽授权同步与许可保护修复（#1134）；沿用现有签名载荷，不自动更换已安装的槽内核。

## 1.4.126 — 2026-11-17 · API 渠道与调度修复

- 修复 API 页面模型目录持续触发重渲染的问题。
- API 渠道获取的模型按渠道写入 SQLite；刷新已保存渠道后重启仍可用。
- API 直连密钥可绑定指定渠道，列模型和推理均不切换到其他渠道。已有未绑定密钥仍按原协议范围调度。
- 限制单次请求的账号切换次数，遇到连续无配额证据的 429 时停止换号（#1165）；可选会话亲和优先，让已存在的会话继续使用原槽位（#1112）。
- 修复 KVM 官方 Claude Code 初装等前台命令被 runner 固定 8 秒超时提前截断、误报 `guest ssh unavailable` 的问题。前台命令遵循调用方时限，保留 SSH 建连超时与后台启动保护；启动超时保留退出码 `124`。需更新并部署 `kin-kvm` runner，单独升级控制面不生效。
- 修复使用 CRAG 宿主订阅的 Docker 槽在重装后因旧容器缺少授权挂载而无法启动的问题。启动已停止且缺少正确授权挂载的槽时重建容器，保留槽数据、设备身份和已有授权。
- CRAG 宿主订阅按同时运行的槽位准入；同一槽切换现行官方版本沿用已有许可，满额无需多占一槽。面板不再让用户选择重签或授权版；需要新绑定时由后端核验，旧密钥不自动迁移。
- Codex WebSocket 优先传输遵守槽位出口代理配置；握手重试与 HTTP 回退不绕过代理（#1091）。
- Rust kin-kernel 流式队列满时暂停读取 CLI 输出，继续按序发送；短时突发不再导致整轮输出中断（#968）。
- Claude 槽位的列表、机架、用量弹窗和详情页新增「主动查询」，管理员及槽位属主可手动刷新官方额度；复用槽位凭证及出口，不发送模型探测请求。同槽位并发查询合并，遵守官方 429 退避，失败明确报错。
- 集群节点连上后预建槽位镜像，镜像尚未就绪时不自动选择该节点（#1147）；前端按需加载终端和图表组件（#1125）。

## 1.4.125 — 2026-11-17 · 风险策略选项与 CRAG 3.1.4

- 风险审计可从现有账号池、API 渠道和模型目录搜索降级目标；封禁时长、安全分差和禁用工具支持预设与自定义。
- 裸 429 缺少配额证据时不按额度耗尽处理；改进 CRAG 摘要工具配对、托管内核信任检查和集群节点槽位接入。
- 出厂包与默认下载使用 [CRAG 3.1.4 标准版](https://github.com/dofastted/vm2api/releases/tag/payload-2026.11.17-crag-3.1.4)：原生保留内联工具变更及工具历史缓存断点，并过滤混合 assistant 历史中的空签名 thinking。保留既有标准版、旧授权下载与槽位安装，不自动升级或重启。

## 1.4.124 — 2026-11-17 · 风险审计与分级封禁

- 入站先执行硬规则、工具限制与拒答缓存，再将用户消息和附件交给 JEV 判定；支持按分组、路由或模型降级放行。
- 按设备与机器身份合并计次，违规会话单独封锁，设备默认依次封禁 10 分钟、24 小时和永久。未提供完整身份的第三方请求不累计设备封禁。
- 面板显示封禁原因和关联请求日志，单列上游 HTTP 400 并统计降级路由。控制面升级自动应用 SQLite 迁移 `059`，沿用现有签名载荷，无需 `wrap-cli/sync` 或重装槽位内核。

## 1.4.123 — 2026-11-17 · ARM64 部署修复

- ARM64 安装前检查 4K 页、宿主环境、binfmt_misc 与 init 系统；支持 OpenRC 持久恢复 x86 handler。控制面在宿主模拟失效时提示修复，不阻止面板启动。
- ARM64 镜像只保留运行 x86 载荷所需的库，构建时校验依赖。沿用 CRAG 3.1.3 Compact 修复版和旧授权下载选项。

## 1.4.122 — 2026-11-17 · CRAG 自动压缩修复

- 出厂包与默认下载使用 [CRAG 3.1.3 Compact 修复版](https://github.com/dofastted/vm2api/releases/tag/payload-2026.11.17-crag-3.1.3)，修复 `/compact` 的上下文传输。保留 3.1.3 原标准版与 3.1.2 旧授权兼容版，不自动重装已安装内核。
- 修复 [#1139](https://github.com/dofastted/vm2api/issues/1139)：CRAG 自动压缩遇到没有限流证据的 `429 rate_limit_error: Error` 时，停止本次请求的调度并返回原状态和错误，不换号、不冷却槽位、不标记额度耗尽。真实限流处理不变。

## 1.4.121 — 2026-11-17 · CRAG 设备购买与 VM 紧凑列表

- 登录页新增「免登录购买 CRAG 订阅」。服务端校验宿主机设备；同一浏览器可进入「查看订单」，支付交付后点「应用到本机」。旧订单入口及管理员续费、槽位绑定权限不变。
- VM 列表使用 38px 紧凑行，固定槽位和打开按钮，支持按表头排序。次要信息默认在悬停、聚焦或展开时显示，也可切换为常显。
- 列表顶部汇总在池、24h 成功率与请求数、7D 花费、席位和排队。支持按页面状态分组，两个显示开关记在浏览器；修复窄屏下健康列和槽位列溢出。
- 沿用 CRAG 3.1.3 标准签名载荷，不自动重装已安装内核。

## 1.4.120 — 2026-11-16 · CRAG 3.1.3 与订阅额度叠加

- 出厂包与标准下载升级到 [CRAG 3.1.3 标准版](https://github.com/dofastted/vm2api/releases/tag/payload-2026.11.16-crag-3.1.3)，保留 3.1.2 旧授权兼容版，不自动重装已安装的内核。
- 配合 CRAG Authority schema 12，每张宿主兑换码（含续费码）从核销时独立计时，未到期额度相加，到期只扣该笔。旧签名额度与到期日保留为一笔基线，不追溯历史兑换。
- Docker、KVM 与集群仍共用一个槽位池。控制面到期时刷新签名权益，订阅页只显示一个状态和剩余可绑定槽位数，订单从「订阅 CRAG → 查看订单」进入。

## 1.4.119 — 2026-11-16 · CRAG 订阅统一槽位额度

- 本机与集群的 Docker、KVM 槽位共享宿主兑换后的可用额度，不按 CRAG 版本分池。签发许可时仍校验目标槽位和载荷；同槽换签不重复扣额。
- 修复 KVM 来宾不能从共享文件系统读取 CRAG 许可的问题：启动和刷新时将已验证许可同步至来宾本地内存文件系统。
- 订阅面板只显示一个可用状态和剩余槽位数。沿用现有签名载荷，不自动重装已安装的 CRAG 内核。

## 1.4.118 — 2026-11-16 · Gemini 宿主机导入预览

- 管理员可在「导入 → Gemini」管理独立宿主机环境，不创建 VM 或槽位。默认不启用，仅支持原生 Linux amd64 和平台自有 IPv4 SOCKS5 出口。
- 宿主机服务与经发行签名验证的 Gemini 载荷必须单独安装；本版不附带反代二进制、官方 CLI 或凭据。详见 [Gemini 宿主机安装说明](docs/gemini-host.md)。
- 预览不开放 Gemini 对外推理或计费，不声明真实 Google OAuth 换票和刷新已验收。升级不需要 `wrap-cli/sync`，不更换现有内核。

## 1.4.117 — 2026-11-16 · VM 列表健康度与行展开

- VM 列表调度与优先级合成一列，第二行写受限 / 不可调度原因。
- 状态栏改为近 24h 请求成功率与 48 格错误率时间线；无请求不显示健康度，不探测。新增 `GET /api/panel/vms/:id/health`。
- 点行展开明细（请求健康、用量窗口节奏与预计用满、成本拆分），左侧按钮打开详情页；旧列顺序自动迁移。
- 宿主内存紧张 / 告急不再标到同机每个槽位，改在总览宿主列和集群机器表显示；调度准入不变。
- 沿用现有签名载荷，不需要 `wrap-cli/sync`，不重装槽位内核。

## 1.4.116 — 2026-11-16 · 旧槽位订阅兼容

- 修复本机和集群 Linux Docker 旧槽位因 ID 不以 `vm-` 开头而无法绑定 CRAG 订阅、购买激活或恢复订单的问题。保留原槽位 ID、签名包和套餐额度校验。
- 包含主线已合并的 CRAG 历史系统消息折叠修正（#1106）和新建槽位按套餐容量自动布局（#1105）。
- 沿用现有签名载荷，不需要 `wrap-cli/sync`，不重装槽位内核或更新 CRAG Auth。

## 1.4.115 — 2026-11-16 · CRAG 集群槽位订阅绑定

- 本机与集群 Linux Docker 槽可使用当前控制面宿主已激活的订阅和剩余槽位额度。绑定不要求槽位已运行或已切换到 CRAG，不自动启停；同槽重签不重复占用额度。
- 面板显示已用及剩余额度和具体绑定失败原因。本次不改变 KVM 或离线授权，也无需更新 CRAG 内核或鉴权服务。

## 1.4.114 — 2026-11-16 · CRAG 3.1.2 旧授权兼容版

- 内核页的 CRAG 版本选项加入「3.1.2 旧授权兼容版」（`payload-2026.11.16-crag-3.1.2-legacy`），替代 3.0.9 旧离线授权兼容版。该包沿用旧载荷密钥，接受仍有效的 `CRAGU1` 及为该密钥签发的设备许可，并支持可回收宿主名册 `CRAGH2`。
- 依赖旧离线授权的环境升级时须指定 `--crag-version payload-2026.11.16-crag-3.1.2-legacy`；省略时仍拉取最新标准包。

## 1.4.113 — 2026-11-16 · CRAG 重装使用订阅余量

- CRAG 重装不再被面板的旧包授权状态提前拦截。本机 Docker 槽可在确认后用已激活的宿主订阅为目标包申请许可：已有同槽订阅则重签，否则可使用剩余名额。未取得有效许可前不会停机。
- 维持 CRAG 3.1.2 标准包，不改变离线许可校验或 KVM／集群授权。升级控制面不需要 `wrap-cli/sync`，不自动重装槽内核。

## 1.4.112 — 2026-11-16 · CRAG 重装同槽重签

- 内核页分开显示已安装包与下载包的授权。已有有效宿主订阅的本机 Docker 槽，确认重装后可为目标包同槽重签，不额外占用名额；普通绑定不会触发重签。
- 重签许可通过签名、同槽和目标包检查后才停机，不放宽离线授权或 KVM／集群的授权规则。
- CRAG 标准包更新至 3.1.2，保留 3.0.9 旧离线授权兼容下载；面板标题显示应用更新提示。控制面升级不需要 `wrap-cli/sync`，也不会替换槽内已安装的内核。

## 1.4.111 — 2026-11-16 · CRAG 套餐编辑和运行配置

- 加入 CRAG 套餐 Canvas Studio，统一订阅购买卡片与预览样式，保留自动和手动激活流程。
- 面板可配置 CRAG v2 会话席位及预热，运行中的内核空闲后生效；安装和切核时初始化 Claude 配置，保留槽内已有自定义设置。
- 槽内换票使用实际安装的原生 Claude 版本；换票恢复后不会被旧的无可用槽探针结果拦住。按模型能力处理思考和强制工具选择。
- 旧镜像通过面板升级时补齐 CRAG 宿主身份只读挂载。继续使用 CRAG 3.1.1 标准包，不更换已安装的槽内核。

## 1.4.110 — 2026-11-16 · CRAG 订阅页与 3.1.1 标准包

- CRAG 订阅页归组购买和订单操作，区分仅领取兑换码、自动激活和手动激活。
- 本机订阅显示已激活且授权有效的本机 CRAG v2 槽位与到期时间，和运行名额分开统计。
- VM 列表的调度优先级改用适配浅色和深色主题的数字颜色，不再使用背景色块。
- CRAG 出厂包与标准下载选项升级至 [3.1.1 标准版](https://github.com/dofastted/vm2api/releases/tag/payload-2026.11.16-crag-3.1.1)，保留 3.0.9 旧离线授权兼容下载。不自动更换已安装的槽内核。

## 1.4.109 — 2026-11-16 · VM 调度优先级与 CRAG 3.1.0

- VM 列表、详情和调度配置统一显示「调度优先级」，Claude 和 OpenAI 槽均可选择自动或手动优先级。
- CRAG 出厂包与标准下载选项升级至 3.1.0；保留 3.0.9 旧离线授权兼容下载。控制面更新不需要全池 `wrap-cli/sync`，不更改运行中槽的内核。

## 1.4.108 — 2026-11-16

- 修复已知bug
- 优化虚拟机创建、登录与面板操作。

## 1.4.107 — 2026-11-16 · Claude 槽位调度与运行稳定性

- 新建槽位按机器内存和负载余量自动选节点（#1079）；宿主实际内存吃紧时限制新对话，保护已有会话（#1092）。
- 按套餐配置 Docker Claude 槽的容量、内存和进程数上限（#1083）；内核收敛槽数时不杀掉在途会话（#1082）。
- 探活确认健康后清除陈旧的 `runtime_start_failed` 锁（#1078）；原生 Claude 进程退出时换号，不触发账号熔断（#1081）。
- CRAG 重放时将历史 `role: system` 折入用户消息，避免长会话每轮重写缓存（#1093）。

## 1.4.106 — 2026-11-16 · 修复远端 Claude 槽读取旧凭据

- 凭据回拉和定时巡检修复远端 `.credentials.json`，使官方 CLI 和健康检查使用同一个节点凭据文件。链接替换是原子的；巡检不读取令牌、不发起换票、不重启槽。
- 修复位于 vm2api 控制面，不改变 CRAG 版本、授权、签名包或已选择的内核。使用历史 CRAG 包的部署也应更新控制面，单独重新下载内核不能修复凭据分裂。见 [OAuth 凭据生命周期](docs/OAUTH.md)。

## 1.4.105 — 2026-11-16 · CRAG 统一在线兑换

- CRAG [3.0.8 标准版](docs/releases/crag-native-v3.0.8.json)和 [3.0.8 旧离线授权兼容版](docs/releases/crag-native-v3.0.8-legacy.json)修复 Auto 分类请求携带 `metadata` 时返回 400（#1072），以及串行工具回调等待整批结果的互等；不新增终端 stdout 实时流。
- CRAG 在线激活统一接收设备码和宿主订阅码，由 Authority 判别类型；优先使用目标槽已安装的受信签名包及其实际载荷 ID，不按发布版本号或下载缓存的版本拒绝兑换。未装 CRAG 的 Wrap 槽可按待安装包申请设备授权；签名、设备绑定和载荷校验仍保留。
- 记录 [建单、实付、领码及绑定验收](docs/crag-payment-acceptance.md)，区分旧正式版的分步兑换与本版的统一入口（#1085）。
- 槽位 Docker 镜像准备改为异步，避免阻塞控制面事件循环（#1074）。

升级不需要全池 `wrap-cli/sync`，也不会自动重装已运行槽位的 CRAG 内核。

## 1.4.104 — 2026-11-15 · CRAG 套餐只读预览

- CRAG Auth 套餐编辑器可嵌入 `/#/crag-preview` 预览未发布草稿，查看固定套餐、自定义槽位与时长、库存及续费提示。预览只回传卡片选择，不请求面板 API，也不会发布套餐、下单或激活。

## 1.4.103 — 2026-11-15 · CRAG 套餐与激活入口

- 订阅页将自定义槽位数和时长单独展示，与固定套餐和续费分开。
- 订阅页顶部增加手动激活入口；管理员也可在下单前选择新订单的自动激活目标。不改变历史订单和续费的处理方式。

## 1.4.102 — 2026-11-15 · CRAG 联网兑换激活

- 本机 Linux Docker Claude 槽可用普通 CRAG 联网兑换码直接兑换并激活，无需手工复制机器码和注册码；同槽重试保留原授权期限。

## 1.4.101 — 2026-11-15 · CRAG 公开套餐修复

- CRAG 公开套餐查询无需登录；试点凭据不可用时仍显示公开目录，报价、下单和本人订单操作继续要求面板登录。

## 1.4.100 — 2026-11-15 · CRAG 订阅与 3.0.7 双载荷

- VM 详情的编号在关机后可改。列表和机架左侧首行改为平台徽标加编号；去掉「订阅 未知」；有租户时第三行显示「出租中」。类型列的等级和权重由浅到深配色，重置时间用剩余时间条。

- CRAG 买家页按发布顺序优先展示订阅套餐及说明，支持自定义购买范围、独立开关和历史订单；管理员可为新单明确选择自动激活目标，付款与激活状态分开展示，原有手动领码及续费流程保留。
- CRAG 本机 Linux Docker Claude 槽支持 H1 宿主权益与 S1 槽许可双重校验、设备解封和原子绑定；失效、降额或待同步时拒绝新请求，不回退或投影覆盖为旧 U1 授权，保留旧 U1/L1 激活。
- 增加 CRAG 订阅的面板买家订单 API：仅登录本人可查看、重试付款和显式领取兑换码，订单凭据保留在本机后端。
- 主侧栏新增「订阅 CRAG」，显示供应方发布的套餐、付款方式及本人订单，兼容带 `/epay/` 前缀的 EPay 收银台。
- CRAG 套餐目录支持手动刷新、每 25 秒和页面重新聚焦时刷新；收款关闭时可查看公开套餐，但不能创建订单。宿主订阅只支持联网兑换。
- 修复 CRAG 套餐在停售时无法选择的问题。套餐、应用锁额度和价格按行对齐；未开放收款时仍可切换套餐，但不能创建订单。
- 「订阅 CRAG」为管理员显示本机权益状态、到期时间、应用锁总额度与兑换就绪情况；本人订单分别显示建单、付款、发码进度，已发码订单附领码、联网兑换及槽位绑定指引。订单已发码不等于本机已兑换。
- CRAG 买家订单增加服务端核价、原订单恢复付款和管理员续费；续费证明及续费兑换码不交给浏览器。本机 Docker 宿主可在兼容包就绪后显式升级 H2，使用签名名单校验槽许可，并且仅在确认销毁后释放额度，支持安全重试。
- 订阅页支持自定义槽位和自然月、首批剩余名额与折扣码；实付以商户报价为准，库存和优惠次数仅在正式建单时预留。管理员可区分已启用、已占用及可用槽位，续费后刷新到期时间。
- 管理员下单时可明确选择已就绪的本机槽位。后台使用原订单收据确认发码，再为同一宿主和设备兑换及绑定，不要求浏览器保持开启；付款与激活状态分别显示。历史订单及未指定目标的订单仍按原流程手动恢复。自动处理超过 24 小时后可按原单重试；`VM2API_CRAG_SHOP_AUTO_ACTIVATION=0` 可停用自动处理。
- 订阅页管理员可对照本机 CRAG v2 已启用数、总槽数和签名额度；按槽位计数，不按模型调用次数。
- 升级时兼容此前买家订单分支已应用的数据库迁移，保留订单及激活状态，并补齐账号累计用量表。回滚到旧版本需使用升级前的数据库备份。
- 本机已预装可信 CRAG v2 包的未启动槽可作为首次购买的激活目标；已签名的宿主权益和槽许可仍是启动及请求准入条件。新订单会同时固定包载荷，切换包后不会换绑。升级前，请在原控制面、原设备及已核对的原包下处理旧版固定目标订单；若已升级，原订单与付款状态仍保留，但缺少载荷快照的订单会暂停自动激活，由运营核对原单和原目标，不重写指纹或重新收款。

- CRAG [3.0.7 标准版](docs/releases/crag-native-v3.0.7.json)和 [3.0.7 旧离线授权兼容版](docs/releases/crag-native-v3.0.7-legacy.json)均适配超限图片；多图保持顺序并在同一轮提交。两版各自沿用原授权策略。

## 1.4.099 — 2026-11-15 · CRAG 3.0.6 双载荷

- CRAG [3.0.6 默认版](docs/releases/crag-native-v3.0.6.json)和 [3.0.6 旧离线授权兼容版](docs/releases/crag-native-v3.0.6-legacy.json)均修复 `defer_loading`；兼容版不改变有效旧离线授权的到期日。
- 面板保留 `tool_choice` 指定的原生工具名，不再为原生工具误加客户端 MCP 前缀。

## 1.4.098 — 2026-11-15 · WARP 内核版本选择

- WARP 默认拉取最新，可分别下拉选择 cli-node 和 CRAG 历史版本。下载不影响运行中的槽；重装确认绑定已下载的版本，重启并通过健康检查后恢复原调度意图。
- 「内核」页可分别拉取 CRAG 3.0.5 新版与原始签名的旧离线授权兼容版。下载校验完整发行标签、归档摘要和签名；安装确认绑定已下载的发行标签，避免两个同名版本串包。

## 1.4.097 — 2026-11-15 · CRAG 购买订阅与 VM 账号信息

- 主侧栏新增「订阅 CRAG」，可查看和刷新套餐、跟踪本人订单、恢复付款及领取兑换码。供应方未开放收款时仍可浏览套餐，但不能创建订单；本版不恢复已撤回的购买沙箱。
- 管理员可在线兑换宿主订阅并绑定本机 Linux Docker Claude 槽。H1 宿主权益和 S1 槽许可分别校验。升级后旧面板会话需要重新登录才能访问本人订单。
- 恢复官方签名 CRAG 安装包拉取并保留完整验签；新建 VM 时按内核策略初始化原生 Claude 设置，KVM 预装不切换内核。（#1056）
- 面板可对声明 `crag_telemetry_apply_v1` 的运行内核应用并核验遥测启动策略；核验不代表事件上传成功。不支持该能力的内核不会显示已应用。（#1055）
- VM 面板显示账号身份与 OAuth 接入方式；累计用量归属账号，换号不继承上一账号的统计。

本版使用主线已更新的 [CRAG 3.0.5 签名包](docs/releases/crag-native-v3.0.5.json) 和官方 Claude Code 2.1.321。新版包轮换了授权密钥：旧 U1 不适用，旧 L1/S1 须由授权端重签后再重装；更新控制面不会自动完成授权迁移。本次发布不部署，不进行真实付款、槽位重启或切换。

## 1.4.096 — 2026-11-15 · VM 调度优先级修复

- Claude 和 Codex 的新分配、排队唤醒与换槽优先选择最高可用调度等级；该级无 VM 可承接才降级。设备与会话亲和、负载和 Codex 权重仅在同级内比较。
- 保留显式指定的 VM、仍在使用的席位、不可迁移的会话续接和既有准入限制。更新控制面即可启用，沿用现有二进制，不需同步或重装槽内内核。

## 1.4.095 — 2026-11-15 · Claude Code 授权终端

- Claude Code OAuth 默认通过专用弹窗授权：同一窗口提供 VM 原生终端、可复制链接和回调输入，凭证同步后才显示成功。运维终端会检查凭证链接并按需刷新临期 OAuth。

## 1.4.094 — 2026-11-15 · Claude Code 原生 OAuth

- 账号面板的 Claude Code OAuth 由 VM 内 CRAG 包自带的原生 CC 生成链接并处理授权码；保留现有页面及其他授权方式。
- 沿用已发布的 CRAG 3.0.5 签名二进制与 Claude Code 2.1.321。本版不重新构建或更换 CRAG 包；已使用 3.0.5 的槽不需要为这次 OAuth 变更重装内核。

## 1.4.093 — 2026-11-15 · CRAG 3.0.5 与启动错误分类修复

- CRAG 出厂包更新至 3.0.5，使用供应方发布的签名加密包；官方 Claude 及非 CRAG payload 固定项不变。
- 区分 CRAG native 启动失败、普通上游 5xx 与供应商过载（#1042）。本地启动失败保留原始错误，不换号、不冷却，不触发供应商过载熔断；不修改请求整流。

升级：现有 CRAG 槽需按受管流程同步并重载后才使用新内核；发布不会切换内核、启动已关机的槽或变更调度状态。

## 1.4.092 — 2026-11-15 · 集群 CRAG 切核与恢复修复

- CRAG 更新至 3.0.4。
- 已知 bug 修复。
- 修复集群 VM 一键切换 CRAG 在慢 SSH 链路上长时间无响应的问题：远端切核以异步任务提交，页面查询最终就绪结果，不再将长时间文件发布和容器重建绑在单次 HTTP 响应上；重复提交明确返回进行中，失败保留真实错误，重新打开页面可继续查看。
- 修复内核选择已保存但启动失败后，同一目标内核无法再次切换的问题。运行中且因 `runtime_start_failed` 不可调度的槽可重试相同选择，只有就绪成功才清除该运行时故障及请求熔断；保留人工调度关闭、其他限制和关机意图。
- 集群 SFTP 大文件改为有界并行分块写入，避免每 32 KiB 等待一次网络往返；失败先排空已提交的写入，再关闭句柄和清理临时文件，保留原文件、权限及防符号链接替换边界。

升级：更新控制面与前端即可启用异步一键切核及传输修复，无需为本次切核流程修复执行全池 `wrap-cli/sync`。本版同时包含主线已合入的 CRAG 3.0.4 出厂更新，运行中的内核仍须按受管流程同步后才会更新；关机槽不自动启动，人工关闭调度及其他限制保持不变。发布本身不代表已部署到生产环境。

## 1.4.091 — 2026-11-14 · OAuth 换票不再强制要求原生遥测

- 修复旧槽内核不支持原生遥测时，授权链接和 Cookie 换票卡在内核准备阶段、等待超时并重启槽的问题。换票前先只读探测能力；缺少能力或遥测未就绪时，由控制面的 `kin-oauth-auth` 经槽当前绑定的出口完成换票及 bootstrap，不因遥测缺失启动或重启槽。具备能力且遥测就绪的内核继续在槽内换票。
- 换票出口从槽的当前持久绑定读取，不复用过期会话或调用方传入的其他代理；未绑定或被禁止的出口仍拒绝，本地出口与集群节点出口沿用既有解析规则。
- 移除允许空凭据启动时的遥测强制条件，保留内核进程、健康状态与 CLI 存活检查，避免健康旧内核仅因缺少遥测而被重启。

升级：从 1.4.090 更新控制面并重启 Node 即可启用本次修复；前端源码和 pinned payload 不变，无需为此重编或替换内核、CLI、换票二进制，也无需全池 `wrap-cli/sync`。本次本地核心 241 项、定向 151 项测试通过，真实换票二进制配合本地 SOCKS/TLS fixture 验证两种入口；未使用真实账号换票，发布不等于生产部署。

## 1.4.090 — 2026-11-14 · CRAG 默认安装与工具续接修复

- 修复 CRAG 未进入一键默认安装路线：amd64 镜像首次启动自动校验并落地完整签名出厂包，安装/升级不再要求先手动拉取 CRAG；一键流程与 `crag-update` 默认获取供应仓最新正式版，显式 `--crag-version` 仍优先。保留发行公钥校验、槽位内核选择及跳过同步选项，下载失败不会提前报告安装完成；ARM64 明确跳过不支持的 CRAG 包。
- 配套签名加密 CRAG 更新至 2.8.18：修复客户端将相同历史文本在字符串与单个 `text` 块数组间转换时误报 `tool_result history mismatch`。沿用原发行公钥、产品密钥与官方 Claude 2.1.321，不放宽工具归属、历史内容、签名或防重放校验。
- 合并 #1028：本机及集群 KVM 在切到 CRAG 前先完成通用授权投影；单槽或批量投影失败时保留原内核、全局默认及既有调度意图。保留旧 KVM/QEMU 配置兼容和 guest 重启路径，不重建磁盘。
- 合并 #1029 的 KVM guest AppArmor userns 准备逻辑及 #1030 的未绑定代理探活修复，保留管理员安全策略，避免为无绑定代理分配多余 egress 网络。

升级：一键脚本默认获取最新正式版 CRAG，显式版本和跳过选项继续有效；不会因此切换现有槽位内核。运行中的 CRAG 槽需经受管排空、同步及重载切到修复包后才生效，停止的槽不自动开机；其他槽的 kernel/CLI payload 不变，无需全池 `wrap-cli/sync`。不包含独立开发内核或其 PR。

## 1.4.089 — 2026-11-14 · 代理协议切换与集群槽启动提速

- 修复集群 Docker 槽在面板 OAuth 换票时一直转圈：每次启动槽位（换票、恢复服务、看门狗）都会通过 SFTP 整个重传 `kin-worker` 和 `kin-egress`，慢链路节点上约需 90 秒，加上其他准备步骤超过前置代理 100 秒超时，浏览器拿不到结果，而服务端换票其实已经成功。现在先比对节点上已有文件的 SHA-256，内容一致就跳过，只在二进制有变化时重传。
- 代理页「添加代理」新增 SOCKS5 / HTTP 协议切换，未写 `scheme://` 前缀的行按所选协议导入，写了前缀的仍以前缀为准，可混填；导入接口新增 `default_scheme`，非法值返回 400。单个代理的编辑弹窗可在 SOCKS5 与 HTTP 间切换协议（主机、端口、账密不变），按连接变更重载已绑槽位的 worker；详情显示当前协议，本地代理不可改协议。同时修复从库加载的代理改协议后存盘被旧 `protocol` 列覆盖、重启回退原协议的问题。

升级：更新控制面即可。已有代理协议不变，旧数据仍按 SOCKS5；切换协议会重载该代理已绑槽位的 worker。集群节点的 `kin-worker` / `kin-egress` 在内容不变时不再重传，二进制有变化时照常同步。不改 payload 指针，不需要 `wrap-cli/sync`。本次仅合并与发布，不部署、不重启现有槽位。

## 1.4.088 — 2026-11-14 · KVM CRAG 切核与旧槽修复
- 修复 KVM 切换 CRAG 时仍被详情页、单槽策略和批量切核预检拒绝的问题；本机及集群 KVM 沿用 guest 内核重启路径，不因切核重建虚拟机或磁盘，保留人工调度关闭与既有维护限制。
- 放开 KVM 的 CRAG 授权查询和离线通用码激活，继续拒绝设备注册码及 macOS 原生槽；旧 KVM 在 `/wrap` 未记录 CRAG 安装版本时可直接「重装 CRAG」补齐运行包和配置。此修复不改变签名包、授权校验或跨节点迁移范围。
- 新建 Claude KVM 槽预装完整且经过校验的 CRAG 签名加密包和包内官方 Claude，保留当前内核选择，不自动激活授权；本机和集群安装准备拒绝缺失或损坏的 CRAG 包。
- 修复集群 Docker 槽切换到 CRAG 后总被判为启动失败并停止调度：supervisor 未把节点槽的 PID 1 入口 `/opt/kin-live/crag-kernel` 识别为内核，转而在容器内另起节点上并不存在的 `.kin/kin-kernel`，返回 `kernel_mount_missing`；「恢复服务」与看门狗复活走同一路径，同样无法恢复。现与本机槽一致，等待或重启 PID 1 内核，就绪后正常解除 `runtime_start_failed`。

升级：更新控制面后，可在 `/wrap` 对未记录 CRAG 安装版本的旧 KVM 槽执行「重装 CRAG」，补齐运行包、guest 内核入口和配置。沿用 CRAG 2.8.17 与官方 Claude 2.1.321 的既有签名交付物，不改 payload 指针或信任锚。本次仅合并与发布，不部署、不重启现有槽位；真实 KVM guest 启动尚未实测，发布不代表运行中的槽已更新。

## 1.4.087 — 2026-11-14 · 稳定控制面集成与缓存保真

- 保留调用方合法的缓存断点、未填写 TTL 的隐式 5m 和 1h→5m 混合顺序；缺省 TTL 只影响平台新增点，非法后续 1h 才降为 5m。同步钉住的 cli-node 缓存修复产物及配套 ARM64 重建输入，不回退最新云端 payload。（#1023）
- 修复 CRAG 前置协议清洗漏用模型 `max_tokens_cap`：保留上限内的显式调用预算，超限按既有模型策略裁剪，不新增或抬高缺省输出预算。
- 流式心跳和空文本/思考前缀不再提前锁死推理尝试；真正文本、工具调用或有效思考进度仍提交输出，输出后失败不重放。保留 `server_is_overloaded` 的原始错误身份及语义 503，沿用现有重试规则。
- 开启脱敏时传入已保存的完整路由限额，使 mask/restore 按配置的请求大小拒绝超限正文，不因初始化丢失 failover 配置而回落到更大的缺省限额。
- 集成云端已合入的 Pro/Fable 额度展示修复、智能选号的冷启动/流速库存/7d 重置评分修正，以及 Claude 限额按卡重置与 Fable/全量卡区分。（#1022、#1019、#1013）
- 修复集成历史产生的缺失测试导入与缓存断言残留；补充真实 handler/FailoverRunner/socket 的心跳重试与输出后禁止重放回归，以及 routing patch→真实脱敏 helper 的限额回归。日常 CI 与手动完整回归、ARM64 验证分开，发版不能只依据核心 CI。
- Native 继续复用已发布的 CRAG 2.8.17 完整签名加密包和官方 Claude 2.1.321，不重建 Native、不移动旧 tag，也不改变既有授权信任锚。

升级：使用 cli-node 的槽需另行按既有流程同步新 CLI（如 `wrap-cli/sync`）才能激活缓存修复；这会影响对应槽进程。已运行 CRAG 2.8.17 的槽不需因本版更换 Native；仍在 2.8.16 的槽须按 1.4.086 的配套内核说明另行安装激活。手工部署且启用脱敏时保留配套限额协议 helper，Docker 镜像按仓库构建。此轮仅 PR/合并/发布，沿用用户豁免的生产部署门禁；不执行同步、部署、重启、VM/内核安装或真实模型会话，发包不代表运行中槽已更新。

## 1.4.086 — 2026-11-14 · 原生交接与面板整流

- 面板通过 `native_handoff_v1` 能力协商单轮原生交接：使用真实 provider stop/usage，正常输出截断不再经过 CLI 多轮恢复后被报为输出上限 API 错误。原生错误与交付不完整分别保留，缺失或冲突的终态不伪装成功、不自动重放。
- 工具 ID/参数只在权威 `tool_use` 和完整响应验证后交付；refusal 中的客户端工具块由面板抑制，服务端工具记录保留。工具续接仍由内核原有租户、历史、期限和防重放机制管理，不另建面板工具账本，不将真实 410 改为成功。
- 配套发布 CRAG Native 2.8.17 签名加密包，出厂成员与完整归档均按大小和 SHA-256 钉住；保留生产信任锚、官方 Claude 2.1.321 与 1.4.085 的 HTTP 代理 helper 字节。原生 2.8.16 没有该能力，旧槽保留 legacy 路径。
- 新交接模式按调用方回合隔离官方进程，有额外启动开销，不作生产缓存/时延性能声明。发布分支只移植本次修复，不混入其它本地未发布的 TTL 归一化或 TUI 插队改动。

本次仅合并与发布，用户明确豁免生产部署门禁；未部署、未重启、未安装运行中内核、未发起真实模型会话。另行升级时须同时更新面板与受信 2.8.17 内核，排空请求和工具续接，按安装流程激活并核对实际运行摘要与能力；下载包和出厂文件不等于运行中槽已更新。

## 1.4.085 — 2026-11-13 · HTTP 代理出口

- 槽位透明出口支持 HTTP 代理：`kin-egress` 与 `kin-worker` 的 Dialer 接受 `http://`（无端口按 80），按 CONNECT 建隧道，带账密时发 `Proxy-Authorization: Basic`；2xx 成功，407 报认证失败，非 HTTP 响应报 `not an HTTP proxy`。响应头逐字节读到空行为止（上限 16 KiB），避免缓冲吞掉隧道里紧随的数据。`socks5://` 与 `socks5h://` 行为不变，`https://` 及其它协议仍拒绝。
- worker 配置的 `proxy_url` 允许 http scheme，http 不强制写端口；守卫信息由 `refusing SOCKS CONNECT` 改为 `refusing proxy CONNECT`（两种协议共用该路径）。
- 解除 1.4.084 的已知限制：HTTP 代理行现在可以绑定给槽位，绑定后出口不再启动失败。

已部署机升级：本版更新出厂文件 `kin-worker` 与 `kin-egress`（见 [deploy/payload.json](deploy/payload.json)），需随控制面一起更新 payload 并重启 Node。槽内已有选择/缓存仍需排空并经内核安装流程激活，仅换出厂文件不能证明运行中出口已更新。ARM64 原生 helper 由 release 工作流从源码编译，随本版一并生效。

## 1.4.084 — 2026-11-13 · HTTP 代理写入

- 代理池支持写入 HTTP 代理：可粘贴 `http://user:pass@host:port`，或在字段导入时传 `scheme`/`protocol: http`；按协议去重，编辑保留协议，复制地址输出 `http://`。探活走 HTTP CONNECT（Basic 认证，407 报认证错误，非 HTTP 端口报 `not_http_proxy`）。不带协议的 `host:port` 仍默认 SOCKS5；`https://` 及其它协议拒绝。
- 修复 Codex `server_is_overloaded` 在未提交响应前未进入同账号瞬时重试的问题；沿用现有预算，取消、响应已提交或非瞬时错误不重放。（#1004）
- 脱敏 helper 按每次请求的 `failover.max_request_mib` 限额完整读取正文，超限返回不可重试的 413，不再固定截断到 32 MiB；保留在途请求限额快照和热更新后的脱敏映射。更新时须同步重编 `kin-redact`，不支持新限额协议的旧 helper 会明确拒绝启动。（#994）
- 套餐徽章与 Jev 送审范围统一优先使用 profile 核实的套餐，保留套餐来源跨层传递；仅在缺少权威 profile 时使用 OAuth 订阅与 Max 速率档纠正导入默认 Pro，不再按 Fable 用量把 Pro 显示或送审为 Max。（#1008）
- 调度档与官方登录用量推断增加 Pro OAuth 速率档否决，禁止 Fable 用量把 Pro 误升成 Max；profile 仍优先，用量回写不再丢失已核实的 profile 来源。（#1010）
- 控制面启动保留槽 JSON 已有并发记录，仍初始化缺失值并同步账号准入；显式保存路由时才释放旧槽继承锁定，包括并发值恰好与档位相同的情况。（#1009）
- 节点槽后台推送失败后按 1s / 5s / 15s 加抖动限次重试，同槽后续写入仍串行，重试读取最新文件；SSH 指纹不符或认证失败立即停止，仍须操作员处理。（#998）

已知限制：槽位透明出口 `kin-egress` 仍只拨 SOCKS5，本版未改；HTTP 代理行可导入、探活，但绑到槽位后出口会启动失败，暂勿将 HTTP 代理绑定给槽位。

已部署机升级：更新控制面并重启 Node；`kin-redact` 按 #994 说明同步重编。不执行 `wrap-cli/sync`，不切换 CRAG 内核。

## 1.4.083 — 2026-11-13 · Haiku 小预算探针

- Haiku 4.5 无 system/tools/显式 thinking 的 1–64 token 单次短探针显式关闭思考；保留原请求预算、既有输出下限和调用方显式思考选择，不调整普通会话或全局输出上限。
- 面板连接测试与真实健康探针显式选择 thinking：允许关闭的模型发送 disabled，必须 adaptive 的模型保持 adaptive。
- 沿用现有 pinned payload 与 CRAG v2.8.16，不构建、发布或切换新内核。本版仅更新 Node 控制面的请求整流和配套控制台版本。

已部署机升级：只更新控制面并重启 Node；不执行 `wrap-cli/sync`，不改 CRAG 出厂包、下载指针或槽内运行进程。保留配置、凭据、设备授权、人工调度关与停止槽原状态。实际请求结果以部署后的原始 Haiku 探针验收为准。

## 1.4.082 — 2026-11-13

- 修复集群 KVM / Docker 槽更新 CRAG 配置时只切换 `claude_bin`、未补齐节点 `slot-bin` 的问题：先校验并同步完整 CRAG 签名包，再发布配置与 KVM guest 内核入口；包缺失或校验失败时保留节点原配置。
- CRAG 同步逐文件核对 SHA256，不再仅凭 `crag.digest` 跳过；自动补齐缺失或损坏文件，已匹配的二进制保持原位。覆盖配置发布顺序、缺包拒绝、摘要相同但文件缺失或损坏及重复同步回归。
- 沿用 v1.4.081 的 pinned payload 与 CRAG v2.8.16 签名加密包，本版不重新编译或签名内核。

升级：更新控制面后，通过内核页对受影响的集群 KVM 槽执行重装，按既有流程排空、安装、重启并恢复调度。保留账号、授权、设备身份、工作区和 KVM 磁盘；发布本身不代表已更新运行中的槽。

## 1.4.081 — 2026-11-13 · CRAG KVM 适配版

- 支持 Linux amd64 本机与集群 KVM 槽部署 CRAG V2，移除集群启动和内核同步入口的 KVM 限制。
- 发布内核配置时同步 guest 的内核入口，支持首次启动及 cli-node / CRAG 双向更换；内核页对所选 VM 执行安装或重装，排空、替换、重启并通过健康检查后恢复调度，保留手动关闭与凭据限制。
- 本机 `crag-update` 支持 KVM，进入 guest 校验运行中的 memfd 核心摘要；独立脚本仍不更新集群 CRAG 槽，集群请通过内核页选定目标重装。操作说明见 [CRAG KVM 部署与内核更换](docs/crag-kvm.md)。
- 沿用 v1.4.080 的完整 pinned payload 与供应仓 CRAG v2.8.16 签名加密包；本版是 vm2api 部署与生命周期适配，不重新编译或签名 CRAG，不包含 CRAG KVM 跨节点迁移支持。

升级：先更新控制面，保留 `routing.json`、`.env`、`vms/`、`data/`、账号、授权和 KVM 磁盘，再通过内核页对明确选择的 KVM 槽安装或重装。发布或升级控制面本身不代表已切换槽内运行内核。相关离线回归通过；真实硬件 KVM 启动尚未在本轮验收。

## 1.4.080 — 2026-11-13

- CRAG print 的官方 `agent_summary` 旁路在入核前将末条用户消息里继承的工具结果转换为只读上下文，保留正文、图片、错误标记与摘要指令，避免与父请求抢占同一工具续接而出现一条 200 伴随 `409 tool_result replayed`；正常工具续接与真实重复提交的报错行为不变。
- 沿用 v1.4.079 的已校验 pinned payload 与独立 CRAG v2.8.16 供应包；本版不重编或切换内核。

已部署机升级：更新控制面并重启 Node 即可，不必 `wrap-cli/sync`，不安装或重启槽内 CRAG。保留 `routing.json`、`.env`、`vms/`、`data/`、授权、凭据与操作员调度状态；真实重复提交仍由内核拒绝。

## 1.4.079 — 2026-11-13

- 修正 CRAG 版本语义：`crag_release` 使用供应仓独立版本 `v2.8.16`，不再跟随 vm2api 的 `v1.4.x` 应用版本。面板默认 CRAG 拉取始终查询 `dofastted/claude-code`，保留显式 CRAG tag。
- 修正服务器遗留的 CRAG `v1.4.076` 版本指针来源，CRAG 包版本与 vm2api 控制面版本彻底分离。
- 随 Release 携带现有最新正式 CRAG v2.8.16 的完整签名加密包 `crag-v2-licensed-amd64.tar.gz`（SHA256 `52f602bb0e1074dfd2685f69d045cc22590690a9c0cfc1b83ae133d943e4faad`），同步出厂目录并核验 22 项 pinned payload；原样复用供应包，不重新编译或签名，不宣称包含尚未构建的源码修复。
- 控制面更新无需 `wrap-cli/sync`；本次不安装或重启槽内 CRAG。需要切换运行内核时，另按排空与授权校验流程执行。

## 1.4.078 — 2026-11-13

- 同步 CRAG v2.8.16：TUI 正文输入改用会话专属 tmpfs 共享映射、Unix socket commit 和官方原生队列，保留安全页检测、MCP 工具续接、流式输出、取消、超时与 transcript 收件确认。固定绑定官方 Claude Code 2.1.321；未知构建失败关闭，不回退到 PTY 正文输入。
- 发布新的签名加密 `crag-v2-licensed-amd64.tar.gz`，沿用既有发行公钥、授权体系和官方 Claude 2.1.321。升级前仍需排空在途请求和工具续接，并核对运行中的 memfd core 摘要。

- 面板最终请求按实际目标内核分别收口：cli-node 不接收 CRAG 控制，原生 CRAG 不接收 wrap compact 控制；移除 body 内的 envelope 私有字段，预构造 Messages 请求也不能绕过。非法内容结构和清洗后空消息在写 socket 前返回 400，不重试、不执行上游。
- 工具续接冲突和过期保留内核原生 409 / 410，不再被统一映射成 400；保持历史、工具 ID、thinking 签名及防重放状态不变。PTY 粘贴渲染超时仍按原生编辑器故障处理，不声称前置字段清洗可消除此类超时。
- Claude Code OAuth 登录改用 CRAG 包内的官方原生 CC，与槽位推理内核分离；支持指定槽内原生可执行文件路径，票据绑定并复查最终程序，不回落 cli-node。仅补齐官方登录程序，不切换 / 激活 CRAG worker。
- 重构 OAuth 登录工作区：修复公共弹窗桌面最大宽度覆盖导致的狭窄终端，改为近全屏终端和底部链接 / 授权码操作区，适配移动宽度并显示真实程序路径。断连不清空待发授权码；已有凭证不误报成本次授权成功，凭证仍由面板导入与管理。

## 1.4.077 — 2026-11-12

- 同步 CRAG v2.8.15：移除普通 TUI 回合完成后的固定 1 秒等待，按 transcript 终态、tap 有序排空及原生流结束完成交付；下一轮粘贴等待实际空编辑器，不改变工具结果、超时、取消和单次 Enter 契约。
- 收益主要是收尾和后续串行等待，非消除冷启动或真实模型首字时间。完整签名加密包及版本化摘要随本版发布，发行公钥与官方 Claude Code 2.1.321 不变，其他 pinned kernel/helper 沿用前版字节。

已部署机升级：对 CRAG 槽逐个暂停调度并排空，安装后核对实际 memfd core 摘要；工具等待未结束不强制切换。网关版本与内核版本分别验证，保留授权、凭据、路由配置和人工调度状态。

## 1.4.076 — 2026-11-12

- 同步生产签名加密 CRAG v2.8.14：修复混合工具结果的 handoff 历史边界、自动压缩误消费主会话工具结果及 print 双流重复正文，并补齐隔离的 classifier request context。
- 内置官方 Claude Code 2.1.321 与发行公钥保持不变；只替换 CRAG bootstrap、加密 core 及对应清单，其余 pinned kernel/helper 保持原字节。完整 CRAG 原生回归 170 项通过，包含真实官方 Claude print/TUI。

已部署机升级：拉取 CRAG v2.8.14 后，对使用 CRAG 的槽逐个排空、安装并核对实际加载的 memfd core 摘要和能力；未排空的工具等待不能强制重启。停止槽不强启，其他内核不切换，保留现有授权、凭据和路由配置。

## 1.4.075 — 2026-11-12

- 修复 cli-node 切换 CRAG 时未排空请求、未暂停看门狗而导致的误熔断；PATCH、槽策略和数据面入口统一维护边界，双向切核检查内核就绪，启动失败不再返回成功。
- 恢复服务兼容 cli-node 常驻 CLI 与 CRAG 进程池：满载且无常驻 `cli_pid` 不再判为故障；授权异常停机前拒绝。切核 / 重装及完整恢复成功后清除请求熔断，失败保留原故障与不可调度状态，不改操作员调度开关。
- 切核、重装和恢复后清除该槽旧内核健康 / 能力缓存，避免首个请求仍按 CRAG 能力向 cli-node 发送专用字段，或反向漏发。
- 修复发布前完整单测环境：单测作业独立准备 pinned helper，脱敏用例使用 Node 原生测试运行器；清理过时身份文案与模型默认值断言，保留行为与权限边界验证。

已部署机升级：更新控制面并重启 Node 即可启用本次修复，无需 `wrap-cli/sync`、重建槽位或切换既有内核。受影响槽可显式执行「恢复服务」；授权、凭据、配额和人工调度关仍按原有门禁处理。沿用前版 pinned payload，不重新编译内核或 helper；保留 `routing.json`、`.env`、`vms/`、`data/` 和现有授权。

## 1.4.074 — 2026-11-12

- 更新生产签名加密 CRAG 至 v2.8.13（源码 `66f1623f`，包含工具续接修复 `bbb5ce98`），内置官方 Claude Code 2.1.321。完整交付且尚未认领结果的工具批次，在 Claude 等待进程退出或 MCP stdio 断开后可校验历史并交给新进程续接；明确取消、部分交付和已认领结果后的失败不自动恢复，不重跑客户端工具。
- 第三方请求的 Opus 5 / Sonnet 5 / Opus 4.7、4.8 不再误标为必须 adaptive thinking；强制 `tool_choice` 且省略 thinking 时，非官方清洗不补 adaptive thinking。真正要求 adaptive 的模型继续拒绝不兼容强制工具契约。
- 全量 pinned payload 固定到本发行；只更换 CRAG bootstrap、加密 core 及对应清单，其余 kernel/helper 和官方 Claude 保留前版已验证字节。

已部署机升级：先拉取 CRAG v2.8.13，再通过内核页对当前使用 CRAG 的目标槽逐个排空、安装并确认健康。仅更新出厂文件或缓存不等于替换运行中的 memfd core；停止槽不强启，其他内核不切换。该修复不消除容器 OOM，内存预算仍需匹配并发。保留 `routing.json`、`.env`、`vms/`、`data/` 和现有授权。

## 1.4.073 — 2026-11-12

- 修复 CRAG 按候选槽旧快照组包、导致 `crag_prompt` 等字段在发送时丢失的问题。按本次发送所用 worker 的健康能力分别启用 append、replace、模型指令和 `caller_cwd`；旧 worker 不接收未声明支持的字段。
- 从本轮原始 Anthropic 顶层 `system` 提取有效的 `<cwd>` 声明，只从 CRAG 提示词投影移除原声明，不删除同值历史。脱敏后仍有效的目录通过已认证的内部 envelope 传给原生内核，仅用于模型环境事实，不改变实际工作目录。
- 发布 CRAG 原生内核 `98807b69` 的签名加密包，内置官方 Claude Code 2.1.321。健康 worker 按 vm2api 的队列、超时和热会话保留设置执行；旧 worker 保留原逻辑。升级网关并切换目标槽的运行内核后才生效。

## 1.4.072 — 2026-11-12

- 管理端在非安全上下文（HTTP）下生成 Idempotency-Key 等 UUID 时不再依赖 `crypto.randomUUID`，限额重置确认框可正常打开（#970）。
- 升级时以槽位容器默认用户（而非 root）停止旧的 `kin-worker telemetry`，避免 `cap-drop ALL` 下 `legacy_telemetry_stop_failed`（#954）。
- 第三方出站工具名改写为 `mcp__` 时，同步改写历史 `tool_result` 内 `tool_reference.tool_name` 与 `tool_search_tool_result.tool_references[].tool_name`，修复工具搜索下一轮 400（#953）。
- 全量重新打包 Linux payload：重编 Claude wrap kernel / CLI、Codex kernel、OAuth / computer helper 和 Go worker / egress / slot gate，同步更新 ARM64 CLI 双重摘要。Codex 从相同提交复编，产物摘要不变。第三方 glibc、已签名 CRAG 包及兼容附件沿用校验过的上游字节。

## 1.4.071 — 2026-11-12

- 以云端最新主分支和最新正式版 `v1.4.070` 的完整合并结果发版，不用独立内核 Release 替代应用交付。应用版本、全量 payload 清单、完整附件和 amd64/arm64 控制面镜像统一到本版本；发布工作流上传全部 pinned 资产，不再只列九个 amd64 文件。
- 全量 payload 纳入 Codex kernel `0.1.2`，`fetch:payload` 不再恢复旧 `0.1.0`。包括 SSE 字节/CRLF 与跨 chunk UTF-8 解码、严格事件终态判定、20 MiB WebSocket 图像帧完整性及内部命名迁移；历史组件资产保持不变。来源与完整资产列表见 `docs/releases/v1.4.071-binaries.json`。
- Codex 客户端兼容 pin 为官方 `0.167.1`，补齐 Astra、6.1 Sol/Terra 和 5.6 家族回退目录，账号实时目录仍优先、新增型号默认关闭，不虚构 6.2 ID 或能力。修复 `ultra` 降级及 Completions 推理参数丢失，槽位测试、计划和日志同步支持。
- Codex Analytics 使用槽内采集的 OS、`VERSION_ID` 和架构，经每请求选项热传递，不读取控制面宿主环境。缺失时仅跳过上报，保留官方事件、账号鉴权和槽位出口，不上传硬件标识或正文，沿用已保存的隐私开关。
- 出站身份从已选 UA 构造 originator/version，调用方不能覆盖，正确解析 `Codex Desktop/...`。协议页 `cc_entrypoint` 在公共出站头和 worker envelope 实际生效，不再被槽位旧入口覆盖；保留版本 pin 和 inference-only 凭证边界。
- 保留 `v1.4.070` 的 Claude `2.1.321` 文件监看崩溃修复、匹配的 ARM64 CLI/源码双重 pin，以及 CRAG 集群发布签名清单的修复；其余已发布 kernel/helper、CRAG 包与签名权威不变。
- 请求执行许可由单个调度器同步授予；归还时先把许可交给通过实时准入的排队请求，再唤醒它。会话席位和粘性绑定不占用执行许可；取消、请求准备失败和故障转移按各次尝试归还自己的许可。
- 面板最多使用两个按需 worker 处理大包推理 JSON 编码与缓冲回包解码；小包和超预算任务留在原线程，成功 SSE 的提交与回调顺序不变。worker 失败仅回退编解码，不重发请求。
- 新建的 Claude Docker 槽和新装的 KVM guest 启动时按可用 CPU 设置 Tokio worker 数；不改变 CPU 配额、KVM vCPU 数或账号并发。Docker 兼容原启动命令，既有 KVM 磁盘不自动迁移。

已部署机升级：完整更新 Node 源码、前端、VERSION 与全部 pinned 出厂文件，再重启 Node。官方 Claude CLI 必须持久切换到本版包，并对明确选中的槽位排空、同步和重启 dataplane；只换出厂文件或临时替换 current 不等于激活。保留用户自定义内核、账号、授权、配置与运行数据，已停止槽不强启；远端槽需另行明确维护范围，不做无差别重建。不要覆盖 `routing.json`、`.env`、`vms/`、`data/`，不要 `docker rm` 槽。

验证边界：按要求不等待 GitHub CI；发布构建、附件校验和线上验收分别留证。ARM64 镜像冒烟不等同于原生 ARM 大并发验收，未通过调大既有 stdin 保护超时掩盖性能限制。

## 1.4.070 - 2026-11-11

- 更新 cli-node 2.1.321：文件监看事件未提供 filename 时，按完整配置失效处理，避免 undefined.toString() 导致 CLI 退出、槽位自动恢复耗尽。
- 同步固定 amd64 CLI 的大小、SHA256 与 ARM64 原生 CLI 的嵌入源码 SHA256，修复只更新二进制 pin 后 ARM64 构建失败的问题。
- 为 v1.4.057-v1.4.069 追加同一修复 CLI 及保持各版其他 payload 不变的升级清单；保留原 tag、附件和历史镜像，不破坏旧清单的完整性校验。用法见 docs/releases/cli321-watchfix/README.md。

升级后仍需通过面板排空并重启所选 Claude 槽位，确认运行中 CLI 已更换；仅更新出厂文件不等于已修复现有进程。本次不修改恢复次数，也不处理独立的 OOM 问题。

## 1.4.069 — 2026-11-11

- 修复集群 CRAG 包热替换漏传 `manifest.json` 的问题。更换加密 core/bootstrap 时同步发布对应签名清单，并将清单内容纳入节点 payload digest，防止旧清单与新密文混用导致 license 校验失败、VM 无法恢复调度。
- 沿用 2.1.321 UPX CLI 与签名加密 CRAG payload；ARM64 native CLI pin 指向同一精确二进制 SHA。

部署更新后通过内核页重启已选择 Claude/CRAG 的 VM，核实包成员与实际 memfd core。失败保持维护锁，恢复旧包并显式恢复运行/调度；不要手动跳过健康检查。

## 1.4.068 - 2026-11-11

- 修正 ARM64 原生 CLI 构建 pin，与 2.1.321 UPX payload 的精确 SHA 一致；发布 payload tag 使用标准 vm2api 版本格式，避免内核页拒绝非版本 tag。

## 1.4.067 — 2026-11-11

- 将 cli-node 交付更新为当前本地源码构建的 2.1.321，使用 UPX 5.0.2 压缩并验证；不再沿用旧下载缓存中的 CLI。
- pinned payload 首次包含完整的签名加密 CRAG native v2 出厂包及原版 Claude Code 2.1.321。bootstrap/core 在签名、加密前压缩，沿用现有发行权威和产品密钥；官方 Claude 文件保持原始字节。
- 全部 22 个 payload 路径固定到同一个新发行，其他 kernel/helper 保留已验证基线。构建来源、压缩参数和哈希见 `docs/releases/v1.4.067-binaries.json`。

已部署机升级：拉取新 payload，分别拉取 cli-node / CRAG 发行，并在内核页对所选 Claude VM 执行重启安装；仅更新出厂目录不能替换已有选中缓存或槽内副本。沿用 v1.4.066 的调度恢复流程，不覆盖账号、授权、配置及运行数据。

## 1.4.066 — 2026-11-11

- 内核页安装、重装和更新槽位改为完整重启：先暂停调度并等待在途请求结束，再停止、替换、启动并检查健康；成功后恢复运行状态与调度，保留操作前主动关闭调度的设置。
- 集群内核操作持久化执行意图。控制面重启或节点连接中断后，在节点就绪时有界恢复未完成操作；确定性失败保留错误，不自动重试或把未健康的槽重新放回调度。
- VM 页面切换内核增加持续进度、成功和失败反馈，阻止重复操作；完成或失败后刷新详情、VM 列表和仪表盘。运行中的 VM 明确提示重启结果，原已停止的 VM 保持停止并在下次启动生效。
- CRAG 配置与面板终端统一从槽位当前选中的内核解析原生 Claude 路径，不再使用固定路径或按路径字符串猜测运行方式。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。不必 `fetch:payload`，不必 `wrap-cli/sync`，本版不更换 pinned payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。不要 `docker rm` 槽。

## 1.4.065 — 2026-11-11

- 发布流程的 ARM64 镜像冒烟检查不再强制要求 `cc-node`（pinned payload 已不带它）。v1.4.062–v1.4.064 因此 `image-arm64` 失败、多架构镜像标签未更新，本版补齐。
- CRAG 官方请求不再在网关删 `messages` 里的系统块。原生 Claude Code 2.1.321 的 Environment 在 system 第四块里；客户端还会在工具结果后追加 MCP 说明和 idle 提示。这些块要原样进 CRAG。PR #6 从 system 和每条 message 读取调用方写过的 cwd、git、platform、shell、OS，没写的不拿宿主机填。指纹是否把工具结果后的新系统块算进续接，由 CRAG 自己决定，不靠删正文。

已部署机升级：更新 Node 控制面后重启。不必 `fetch:payload`，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。不要 `docker rm` 槽。

## 1.4.064 — 2026-11-11

- 修复指定 Claude 订阅档位或账号作为风控范围时，普通 Messages 请求返回 503：attempt 会话 ID 在范围审核之前初始化（#952）。
- 请求热路径读取 `routing.json` 改为只做一次 `stat`，内容不变时复用同一份只读解析结果；面板保存改为原子写并即时生效，SCP / 手工编辑仍会在下次读取时被发现（#929）。
- 集群槽位镜像准备时 `cc-node` 与本地 wrap 运行时一致为可选：缺失不报 `slot_payload_missing`，存在则校验并打包；`cli-node` 与 kin-kernel 仍为必填。

已部署机升级：更新 Node 控制面后重启。不必 `fetch:payload`，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。不要 `docker rm` 槽。

## 1.4.063 — 2026-11-11

- 导出 `cliPayloadPath`。v1.4.062 的集群镜像代码引用了它，但模块没有导出，控制面启动即退出。

已部署机升级：更新 Node 控制面后重启。不必 `fetch:payload`，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。不要 `docker rm` 槽。不要部署 v1.4.062。

## 1.4.062 — 2026-11-11

- CRAG v2 子进程连 OAuth token 主机（`platform.claude.com` / `console.anthropic.com` 的 443）时先写 `KIN-BLOCK`。kin-egress 在拨上游 SOCKS 之前关掉这条连接，刷新请求不出站。登录、`kin-oauth-auth` 和 `kin-worker oauth refresh` 不写标记，不受影响。随包发布的 `kin-egress` 仍是 `deploy/payload.json` 里钉住的那枚，这次不换二进制。
- Fable 不再要求 Max 订阅。Pro 和未标明等级的槽可以接 `claude-fable-*`；型号拒绝和允许列表仍生效。号池空了按原来的冷却或无可用账号返回，不再一律报 `fable_requires_max`。
- 集群节点可以只拉 CLI、不带可选 CRAG 包。拉完 CLI 后从工厂解析 cc-node，不再要求过时的 cc-node payload。
- CRAG 槽一律走原生 Claude。面板终端和 OAuth 跟随该槽当前选中的内核。工具续接保留公开思考块。
- 已停机的槽不再显示成「调度开」。Docker 内存上调改为异步，不再卡住面板请求。
- 签名二进制更新会核对每一份槽内副本。OAuth 订阅档只认 profile 证据，不再用模型是否调用成功来推断。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。cli-node、kernel、kin-egress 的 payload 哈希未变，不必 `fetch:payload`，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。不要 `docker rm` 槽。

## 1.4.061 — 2026-11-10

- 升级同步二进制时不再先删除正在使用的文件。cli-node、内核和 CRAG 都是改名覆盖；已经挂载的目录保持原 inode。旧的 `claude-code-*` 目录先留着，槽位切到新路径之前仍能执行。写入失败会把原来的目录内容放回去。

已部署机升级：更新 Node 控制面后重启。不必为了这次修复 `docker rm` 槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.060 — 2026-11-10

- Claude 订阅档从 OAuth 的订阅元数据和官方 `/api/oauth/profile` 识别，不再用 Fable 是否可用、用量窗口或旧调度档推断。面板保留 `subscription_type` 和 `rate_limit_tier`，有数据时显示 Max 5x/20x，没有就保持未识别。调度策略和 Codex 档不变。

已部署机升级：更新 Node 控制面后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。不要 `docker rm` 槽。

## 1.4.059 — 2026-11-10

- Codex 模型 `codex-auto-review` 默认改写成 `gpt-6-luna`。

已部署机升级：更新 Node 控制面后重启。这是默认 `routing.json`。已经部署的机器不要覆盖本机 `routing.json`；要这条别名就在本机配置里加同样的 `model_mappings`。

## 1.4.058 — 2026-11-10

- CRAG v2 默认官方 Claude 改为 2.1.321（2026-11-09）。包成员、槽内路径和安装校验都是 `claude-code-2.1.321/claude`。已经发出的 2.1.317 归档不改写。
- 面板和 cli-node 的默认出站版本改为 2.1.321。`cli` 用交互身份、`cc_turn_origin=human`、`cc_prompt_index=1`、`thinking.display=updates` 和 `thinking-display-updates` beta。`sdk-cli` 用 Agent SDK 身份、`cc_turn_origin=sdk`、`cc_prompt_index=0`、`thinking.display=omitted`，不加那条 beta。两边都带 `tool-provenance-2026-10-26`、`x-claude-code-sandy-plover: []`，Node 运行时 `v26.12.1`。目录加入 `claude-fable-5-2`（输入 $8 / 输出 $40 / 缓存读 $0.20，默认 effort medium）；短名 `fable` 指向它。
- CRAG v2 槽的 health 会带上凭证是否可用（不含密钥）。创建槽时写入的 API key 不再因为 worker 没回报 `credential` 被判成 `oauth_unconfirmed`，密钥可以选中这些 VM。
- 本机 Docker 切到 CRAG v2 时，只要宿主启用了 AppArmor 就带 `apparmor=unconfined` 并在缺它时重建容器。docker-default 会拒绝 `/proc/self` 的 uid_map 写入和 bind mount，guest identity 因此得到 `Permission denied (os error 13)`，而不是以前的 seccomp `os error 1`。
- 内核页可以在本机 Docker、集群槽和 KVM 上重装 cli-node 或 CRAG，完成后保持停用。macOS 原生节点仍然不行。拉取旁边的「更新全部槽位」把刚拉取的内核装到每一台 Claude 槽。集群字节写到 `slot-bin`，哈希相同的文件不重传，`crag-kernel` 只覆盖不先删。cli-node 的新容器命令改为 `/opt/kin-live/kin-kernel`。
- 集群部署更新和内核切换不再调用 `chmod -h` / `chown -h`。coreutils 8.32 之前和 BusyBox 会报 `chmod: invalid option -- 'h'` 并中断切换。私有目录改用 `find -P`，符号链接不跟随，匹配不到就失败。
- `crag_model` 只发给 health capabilities 含 `linux_tui_pty` 或 `model_directive` 的 worker。集群 hop / 旧内核会把该字段原样打到 Anthropic，得到 `crag_model: Extra inputs are not permitted` / `upstream_invalid_request`。没有这个能力时，部署、切换和出站都丢掉 `crag_model` 与 `crag_prompt`。
- 最终出站：cli-node 与 CRAG 都经 `kin_outbound_headers` 回传 fetch 前的真实请求头。CRAG 另带回请求体，只保留前 10000 token（CJK 一字一 token，ASCII 四字一 token），凭证在离开 CLI 前打码。没有回传体时，日志里的出站体仍是发给 worker 的信封。
- 集群 Docker 槽的 VM 面板可以在 cli-node 与 CRAG v2 之间切换。KVM 和 macOS 原生节点仍然不能切。切换会按该槽自己的内核重建容器，不再把未选择 CRAG 的集群槽写回 v2。
- 出站按 VM 实际启用的内核切换：只有运行中的 CRAG v2（health `runtime_variant`，否则槽位自己的 `dataplane` / `crag_kernel_version`，再否则该槽 `kernel.json`）走 print。`crag_model` 还要该 worker 的 capabilities 声明会在本地消化。全局 `routing.inference=crag` 不再把 wrap / cc / 未写内核的槽送上 print。cli-node 信封会丢掉调用方塞进来的 `crag_prompt`。

已部署机升级：更新 Node 控制面后重启。CRAG 要换成 2.1.321 时先在内核页拉取新包。不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。不要 `docker rm` 槽。

## 1.4.057 — 2026-11-10

- 集群 Linux Docker 槽切换 CRAG 时认本机已经激活的同一张离线码，不再因为没有本槽机器身份而停在未配置。内核页只拦截 KVM 和 macOS，不再把 Linux 集群槽的 CRAG 选项禁用。
- 面板终端的 `claude` 跟随本槽内核。切到 CRAG v2 后执行包内原生 `claude-code-2.1.317/claude`，不再启动 `cli-node`。
- #937：Anthropic Messages `type=image` + `source`（base64/url）在转 Codex Responses 时不再被静默丢弃，顺序与 OpenAI `image_url` 路径兼容。

已部署机升级：更新 Node 控制面后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。不要 `docker rm` 槽。

## 1.4.056 — 2026-11-09

- 集群 Linux Docker 槽可以激活并安装 CRAG v2。原生 Claude Code（`claude-code-2.1.317/claude`）随 CRAG 包一起推到节点，不再要求本机槽。KVM 和 macOS 原生节点仍然不行。

已部署机升级：更新 Node 控制面后重启。不必 `wrap-cli/sync`，不必换 payload。集群镜像要包含 CRAG 时，先在内核页拉取 CRAG 包。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。不要 `docker rm` 槽。

## 1.4.055 — 2026-11-09

- 集群节点不再对槽内可替换的 `run/crag-native-assets`、`run/work`、`run/crag-license` 做会跟随符号链接的 `chmod`/`chown`。链接只删链接本身，模式和属主用 `-h` 或已打开的目录 fd。
- 集群 Docker 槽的 VM 面板可以在 cli-node 与 CRAG v2 之间切换。KVM 和 macOS 原生节点仍然不能切。切换会按该槽自己的内核重建容器，不再把未选择 CRAG 的集群槽写回 v2。
- 集群槽位镜像同时烤入 kin-kernel 与已校验的 amd64 CRAG v2。已在跑、镜像本身不用换的旧容器，经 slot-bin 挂载补上同一棵树，不必为了补 CRAG 重建容器。
- 出站按 VM 实际启用的内核切换：只有运行中的 CRAG v2（health `runtime_variant`，否则槽位自己的 `dataplane` / `crag_kernel_version`，再否则该槽 `kernel.json`）走 print 和 `crag_model`。全局 `routing.inference=crag` 不再把 wrap / cc / 未写内核的槽送上 print。cli-node 信封会丢掉调用方塞进来的 `crag_prompt`。
- system提示词页分成两套：cli-node 原生内核仍用模板并投影 `kernel.json`；CRAG v2 print 另存 `compatibility.crag_persona_preset`。print worker 不读 `persona_preset` / `CLAUDE_CODE_SYSTEM_LAYOUT`。`official_full` 只 append 调用方尾巴，不重贴官方四块；`zero` 必须 `crag_prompt.mode=replace`，超过 64 KiB 返回 400。不使用 `--bare`、`--tools ""` 或 `--no-chrome`。thinking、temperature、betas 和 system 上的 cache_control 仍不转发。
- CRAG 离线通用码 `CRAGU1` 一次解锁内核：写入安装级授权并同步到每个本地槽和每台集群机器，Warp 上不再逐槽、逐机器重复激活。在线 `CRAGL1` 仍绑定单槽设备，且不会被通用码覆盖。正式状态为 `kind: offline`、`scope: kernel`。
- 清理：删除零引用死导出（cache-ttl / convert / model-policy / thinking / user-count-tokens / web-search / codex-route / codex-models）及 `copyBodyWithMessages`（REQ-CLEANUP-02 第一批 / DEC-0001）。
- 测试模型和内核说明按实际搭配显示：cli-node + wrap kernel、cc-node + wrap kernel、cc-node + CRAG kernel、CRAG v2 原生 worker。CRAG v2 不再标成 cli-hop。
- 修复集群槽位镜像准备：存在 wrap-cli 内核缓存包时，cc-node 回退到出厂 `share/wrap-cli/`，不再误报缺失。
- 内核页收敛为默认免费 cli-node 与注册码授权 CRAG：精简母本/旧 ELF/cc-node 入口，逐 VM 选择安装、就地激活/续期，全局确认明确范围，显示逐槽进度和停止结果。
- 新增两产品独立拉取与可信缓存发布：cli-node 只下载所需的一对二进制；CRAG 校验官方签名加密归档并固定原发行公钥，缺少授权附件时明确失败，不回退 legacy。缓存指针原子切换，损坏时拒绝使用。
- 新增显式范围重装并停用接口：授权/包校验先于停止，停止先于替换，保留身份与数据，关闭自动重启且不隐式开机；恢复流程只在完整成功时解除安装器自己的异常安全暂停。后续原生启动按需补齐窄 seccomp 策略，正确配置的容器不重建。
- 修复 VM 摘要丢失 `dataplane` / `crag_kernel_version`：详情、dashboard 与重装选择保留每槽固定值，不再把已启用 CRAG V2 的槽误判为全局默认 wrap。
- CRAG 在线设备绑定注册码：选择/使用前验证，支持签发 1个月/半年/1年；签名绑定 VM、machine-id 和独立设备密钥。新增机器码复制、激活/替换及绝对 UTC 到期提示；错误码不破坏现有有效授权，续期不隐式切内核；与通用离线码 `CRAGU1` 并存，互不替代。
- 原生 V2 仅接收签名加密包：校验 bootstrap ELF、密文、公钥与发布签名，不再接受旧明文 V2。内核独立校验授权，过期/错误设备/篡改为终态403，不触发OAuth刷新、账号冷却或Go回退；cli-node/wrap不受收费授权限制。
- 授权设备存储复用既有 Linux worker run 映射，普通重建保留授权，不将私钥写入 DrvFS。不可变包信任采用有界元数据缓存，避免每次请求重复哈希大型 Claude；注册码当前有效期仍逐次检查。
- CRAG V2 发布协议切换到原生 ELF（`runtime: native`、`entrypoint: crag-v2`）：验证实际架构、完整 SHA 成员与安全路径，原子物化并直接执行，不再复制 Node 或写出 `node_bin` / `crag_v2_root`。保留 legacy 版本选择和 Linux Docker 放置限制；真实 CLI 版本由 native worker 探测。
- native V2 生命周期探测、停止、切换回收和 idle reload 识别新进程名；动态 runnable 上限不再被误算为占用任务。配置写入本身不触发额外热重载，沿用显式空闲重启流程。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。从 1.4.053 升级会在启动时执行迁移 054（`api_keys.allowed_models`）。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。不要 `docker rm` 槽。

## 1.4.054 — 2026-11-09

- Key 级模型白名单 `api_keys.allowed_models`：模型映射前按客户端模型名判断，忽略 `[1m]` 后缀；空数组表示允许全部；面板可配置；迁移 `054_api_keys_allowed_models.sql`。[#913](https://github.com/dofastted/vm2api/pull/913)
- 槽位完整页可改创建时的自定义名称。VM 编号仍是创建时的编号，改名称不换编号、不重启槽。
- 性能（REQ-PERF-BODY-01 L1）：请求级写时复制壳与消息身份哈希 memo；`cache-prefix` / 配额风险估计 / 拦截在续聊时复用已确认会话的历史记录，仅对新增尾部做快照与全文抽取；同请求内多路径共享消息哈希。
- CRAG 支持离线通用注册码 `CRAGU1`：激活与存储不绑定本槽设备；面板/API 授权状态区分 `kind: 'online' | 'offline'`，与既有按 VM、machine-id 与设备密钥签名的在线码并存。激活失败不破坏已有效授权。
- 修复 native CRAG v2 槽启动与沙箱：启动前写入 `.claude.json` 完成 onboarding 与工作目录信任，避免 TUI 阻塞；保证 `/run/kin` 下 `work`/`crag-native-assets` 目录存在且归槽 UID；v2 树物化目录权限 `0755` 以便槽用户 exec。Docker 槽加 `--init`，避免内核在容器 PID 1 下握手失败；在 `unprivileged_userns_apparmor_policy=1` 时可选 `apparmor=unconfined`；`nativeSlotSandboxNeedsRecreate` 在 init/AppArmor 漂移时要求重建容器。
- 性能：`routing.json` 热路径统一经 `readFileVerifiedCached` / `readJsonParsedCached` 读盘并复用稳定内容的解析结果；`applyCrsUnofficialPersona` 单次调用只解析一次。同源字节在元数据未变时仍每次读盘校验，保持 scp/面板「下一请求生效」语义；逐调用方错误回落不变。 [#925](https://github.com/dofastted/vm2api/issues/925)（REQ-0925）
- Infrastructure: PR/main `ci` 对仅改 `README.md`、`CHANGELOG.md`、`docs/**`、`VERSION` 的变更走 docs-lite（format/syntax；跳过 unit/go/web、native 打包单测与 `arm64-native-cli`）；业务 PR 仍跑满门，且 `test:unit`、Go 与 web 并行以缩短墙钟（REQ-CI-1.4）。
- README：功能说明与快速开始对齐 1.4.053，新增 Telegram 开发者交流群（`@VM2API`）。

已部署机升级：更新 Node 控制面与 `web/dist`，并执行迁移 054（`api_keys.allowed_models`）后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.053 — 2026-11-08

- 修复 Codex `/v1/alpha/search`：1.4.049 接入脱敏时删掉了 `turnMetadata` 声明，选到可用账号后、请求发往上游前抛出 `ReferenceError`。关闭脱敏或补上 `x-codex-turn-metadata` 都绕不过。补回该头的读取。
- 面板官方登录改为执行 `claude auth login`，不再只打开空的 `claude`。登录框加大；终端在容器有尺寸后再 fit，避免打开时被压成一条。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.052 — 2026-11-07

- 决策模型关按地址管理多组 URL 和 Key，不再切换 Jev / Laya / ModernBERT。默认示例仍是 TypeSafe。每把 Key 显示最近状态；可一键测试可用性与判断基准，并检查地址是否提供剩余额度。官方 TypeSafe 没有余额接口时如实说明，不会为查余额去打 systemone。
- 用户页可查看和修改用户并发。整数 0–1000，`0` 为不限；不改原有的并发拦截。
- 托管 Key 可自助查询 `GET /v1/me/quota` 与 `GET /v1/me/usage`。`/v1/usage` 仍是上游账号窗口。
- 面板按角色拦住无权页面，头像菜单同步隐藏这些入口。直接打开网址不再进入管理员页。
- CLI 官方转发为两个系统缓存断点预留预算，避免合法的 4 个断点被补成 5 个后被上游拒绝。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.051 — 2026-11-07

- 租户统计页补上今日和历史用量明细：请求、失败、费用、总 Token、输入、输出、缓存写入（含 5 分钟和 1 小时）、缓存读取、命中率、平均响应、平均 TTFT。历史可切 7 天、30 天、本月。
- 租户可按自己的可用 VM 逐台看用量，没有请求的槽也列出。平台池槽只进合计，不显示名字。
- 租户虚拟机只可查看：侧栏去掉代理，重新授权、导入凭证和刷新凭证关闭，对应接口返回 403。开机、测试和查看统计保留。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.050 — 2026-11-06

- 设置新增「脱敏」页（`/settings/redaction`）。协议页不再放这组开关。可配凭据、个人信息类别、自定义词及是否忽略大小写、前缀或 RE2 规则、放行名单。默认关闭。
- 没有安装 `kin-redact` 时不能保存为开启，请求不会回落明文。本机 `bin/kin-redact` 存在时直接使用，不必另设环境变量。保留密钥格式、本地模型和按类型拦截仍不启用。

已部署机升级：更新 Node 控制面与 `web/dist`，并放入 `bin/kin-redact` 后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.049 — 2026-11-06

- 协议页新增内容脱敏，默认关闭。开启后，出站正文在内容变换之后、CCH 密封之前替换秘密、个人信息与自定义词，响应在回到客户端前还原。helper 缺失、规则无法编译，或签名 thinking 命中时拒绝发送，不回落明文。同一 block 同一字段上被拆开的标签可以还原。
- 控制面镜像带上 `kin-redact`，只监听本机 Unix socket。不更换 kernel、CLI 或 payload。

已部署机升级：拉取新的控制面镜像后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.048 — 2026-11-06

- #909：API 直连推理出站前剥离内部 persona 模板的非法缓存控制字段（如 scope），防止 Anthropic 官方上游返回 400（Extra inputs are not permitted）。
- #908：官方 API 端点自动接入完整官方协议模型目录，并在调度时动态匹配协议模型，无需手动逐一录入。
- #907：修复 API 直连密钥模型目录与协议调度绑定：
  - 生成/编辑 API 直连密钥（`category: 'api'`）时，分组选择 `anthropic` 或 `openai` 不再强制校验 VM，移除前端阻塞与后端 `key_vms_required` 限制；
  - `/v1/models` 与 `/models` 按密钥协议作用域过滤 API 端点模型，`anthropic` 密钥仅返回 Anthropic 端点模型，`openai` 密钥仅返回 OpenAI 端点模型；
  - `ApiScheduler.pick` 按请求密钥协议过滤候选端点，避免跨协议错误调度；
  - API 配置页保留已有端点模型状态，端点更新时同步携带最新模型。
- #904：graceful-shutdown drain 超时定时器去掉 `unref`，修复孤立单测在 event loop 提前结束时被误杀的 CI flake（#376/#904）。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。
## 1.4.047 — 2026-11-06

- #905：追加 OpenAI 最新图像模型 `gpt-image-2.6-flare`（上游默认）与 `gpt-image-2.6-sunburst`，接入 `/v1/models`、`/v1/images/*`、Responses `image_generation` 工具及 Chat/Responses 图像桥接，内置单价与用量计费同步更新。
- #902：集群页支持冷迁移 KVM 槽位并扩容内存，支持跨主机快速迁移。

已部署机升级：只更新 Node 控制面后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.046 — 2026-11-06

- #376：控制面平滑停机与排空（Graceful Draining）：收到 SIGTERM/SIGINT 时停止接入新请求，`/health` 与 `/healthz` 立即返回 503 `shutting_down` 通知上游反代/负载均衡安全摘流；等待在途长文本推理流自然排空（默认超时 25s，支持 `KIN_SHUTDOWN_DRAIN_TIMEOUT_MS`），避免升级或重启切断活跃会话导致客户端收到 `UND_ERR_SOCKET`。
- #852：推理槽位假死显式感知与连续超时熔断：
  - 诊断显式感知：槽位健康检查若发现存在异常闭合槽位时上报 `warn`（`kernel_degraded`），全部闭合时上报 `error`（`kernel_slots_closed`），彻底消除假死诊断盲区；
  - 看门狗全闭合重启：`rustKernelNeedsRestart` 识别 `ready_slots === 0 && closed_slots > 0` 触发重启，不再无限期当作 busy；
  - VM 级连续超时熔断：引入 `vmTimeoutTracker`，单台 VM 连续 3 次静默无首帧超时（504 / `worker_timeout`）立即标记 `kernelFaults` 熔断，阻止持续调度与级联超时。

已部署机升级：只更新 Node 控制面后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.045 — 2026-11-05

- #896：claude_code_only 完整替代 #892+#893：放行 CLI WebSearch/WebFetch 侧查询（缺 `claude-code-20250219` 的窄形状仍保留其余官方指纹检查）；Desktop Gateway 登录探针本地回 OK（零用量、不选账号）；中转准入不再仅凭计费行放行（须合法 `metadata.user_id` + 可识别的官方 Claude Code system）；拒 OMP 18.x（认出 `You are omp's trusted coding assistant`）。
- #900（取代 #899）：槽位 credential ensure 非致命失败（生产 400 + `credential_ensure_failed`）按席位故障换槽并冷却 10 分钟，不再误判为 `invalid_request`；fatal 升级（401 + oauth 码，仍带 `credential_ensure_failed`）继续走永久 `oauth_revoked`，不被 10 分钟冷却截断。
- `scripts/fetch-payload.mjs` 从 Release 下载 payload 资产遇瞬时失败时会重试（最多 4 次，递增退避），减轻 CI/本地构建偶发网络错误。

已部署机升级：只更新 Node 控制面后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.044 — 2026-11-05

- #890：修复本地转发代理的 lazy CONNECT 误判：SOCKS 成功但隧道没有应用层响应时不再标记健康。探测先要求经隧道完成 TLS 握手，TLS 不可用时回退到经隧道的 TCP DNS；延迟改为完整探测往返。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.043 — 2026-11-05

- #885：没写 `max_tokens` 时用模型目录的 `max_tokens_default`（例如 Haiku 5.5 为 100000，Sonnet 5 为 64000），不再一律填 128000。写了且低于 `compatibility.min_max_tokens.value` 时默认仍抬到该值；模式「不改」/ `preserve` / `unchanged` 或面板「不抬升」则不抬。未指定有效模式时兼容 `no_raise: true` / `raise: false`，显式模式优先。超过该模型 `max_tokens_cap` 仍会下调。`enabled` thinking 的 `budget_tokens` 不小于 `max_tokens` 时，仍用该配置值补 thinking 合法间隔。
- 修复健康探测页「不抬升」对 `preserve` / `unchanged`、模式空白和旧配置标志的显示，与后端模式优先级一致；补充 12 项实际组件渲染回归及后端优先级测试。
- 池调度：健康探针等异步路径中 RPM 窗口过期后 stale `availableAt` 会重新判定可准入，避免直接路径空等至超时。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.042 — 2026-11-05

- API 配置页统一到 `#/api`，旧 `#/anthropic` 自动跳转；提供 Anthropic / OpenAI 两套默认地址和认证，支持获取模型、连通性测试及保存。获取的模型由服务端合并，不覆盖已有模型别名。
- 渠道选择 `api` 的密钥按配置端点协议调用上游，不再误入 OAuth / Codex 槽位。OpenAI 原生 Responses 输入和推理设置保持不变，不注入 Claude persona；修复非流式回复转换。
- 共享 OpenAI API 凭证强制 `store: false`，拒绝上游对话、存储提示词、文件/向量库引用及 MCP 等账户资源工具；调用方需发送完整的无状态历史，可保留加密推理内容和普通函数工具，避免不同密钥跨读运营方账户资源。
- Anthropic API 端点新增独立的“风控前置审查”开关，默认关闭，旧端点迁移后也保持关闭。开启并保存后，推理请求先按风险审计中启用的规则和决策模型审查，再调用上游；不依赖 OAuth 账号范围，单请求只审查一次。本页连通性测试仍为直连诊断。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启，启动时自动迁移端点开关字段。不更换 CRAG / CLI payload，不必 `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.041 — 2026-11-05
- 新增可选 `compatibility.preserve_pruned_tool_results`：在槽位Claude推理中，按认证密钥和DSH会话隔离保存成功请求的有限工具原文；精确识别默认工具文本裁剪后恢复原始前缀，避免小幅历史裁剪造成整段缓存重写。真实编辑/压缩、失败/重试、并发歧义和内存/上下文预算不足时不恢复；缺省关闭，不改变客户端配置或API直连端点。

## 1.4.038 — 2026-11-04

- #882：放行 Sonnet 5.5 的 `thinking: {"type":"between_tools"}`，修复 Claude Code auto 模式分类器被本地 400 拒绝。分类器与普通 Messages 保留该模式及签名 thinking 历史；不支持的模型、`xhigh` / `max` effort 或额外 thinking 字段仍在分配账号前拒绝。
- #886：`kernel.json` 写出面板的 `compatibility.thinking_display`（缺省 `summarized`，显式 `passthrough` 才保留调用方 display）；没传 routing 时保留已写入的 `passthrough`。本版只补配置投影，不更换 CRAG / CLI payload。
- #878 / #883：本地转发代理的健康探测改为真实 SOCKS CONNECT，鉴权拒绝（`0xff`）或无法连接目标不再误算健康。
- #876：远端 kernel 的短暂健康探测超时不再立即将槽位置为故障，避免瞬时抖动中断可用槽。
- #869：集群页统一展示本机和节点的链路、槽位与机器余量；“还能放”按虚拟机内存和实测开销估算。
- #871：允许清空当前激活 VM 选择。
- #873：修复 `/v1/models` 已列出的 GPT Image 模型（`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2` 及快照）在 `/v1/chat/completions`、`/v1/responses` 上被 400 `model_not_supported` 拒绝、无法出图。现在这类请求走网关内置 Images 通道：最后一条 user 消息文本作 prompt，带图即 `/images/edits`，否则 `/images/generations`；Chat 回 Markdown 图片，Responses 回 `image_generation_call`，流式等待期间保活。模型开关、Free 槽排除与计费沿用 `/v1/images`。
- #874：第三方客户端入站不带 `ttl` 的缓存断点不再以隐式 5m 出站：与 #850 的官方 Claude Code 一样，渲染前按会话 TTL（请求头 → 入站显式值 → 协议页默认，缺省 1h）补齐。只有调用方显式写 `5m` 才发 5m；前面已有 5m 时补 5m，保持 1h 在 5m 前。官方透传打开时不经过这一步。依赖隐式 5m 的调用方需改为显式 `ttl: "5m"` 或带 `x-kin-cache-ttl: 5m`。
- #872：设备亲和把已有会话分到另一账号 / VM 时，实际拿到会话席位的请求会迁移跨账号 sticky 绑定并持久化新出站 session，同一入站对话不再逐请求变号。`slot_busy` 临时借用仍保留原绑定，晚到的结果不能覆盖新绑定。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.037 — 2026-11-03

- #866：协议改写按请求体补 `inline-tools-2026-09-15`：`messages` 里出现 `tool_addition.tool.type=tool_definition` 时写入 cli-hop 的 `betas` 和直连 `anthropic-beta`。没有该块不加。修复上游 400 `a tool_definition requires anthropic-beta: inline-tools-2026-09-15`。

已部署机升级：只更新 Node 控制面后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.036 — 2026-11-03

- #850：官方 Claude Code 在「官方 Claude Code 家族透传」关闭时被重写后，入站不带 `ttl` 的缓存断点不再以隐式 5m 出站。渲染前按会话已解析的 TTL（协议页全局值或入站显式值）补齐，调用方显式 `5m` / `1h` 保留，补齐结果仍满足 1h 在 5m 前、最多四点。cli-hop、HTTP hop 与 API 直连一致；透传打开时不经过这一步。
- 入站统一收成标准 Anthropic 结构再按槽位档重写，回到 1.4.00 的官方档标准（billing、身份、harness、guidance，调用方 system 接在后面）。官方家族识别本身不再跳过重写，只有协议页透传开关打开才保留官方家族入站 system、billing 与 UA；API 直连与 cli-hop / HTTP 走同一道门。修复 #843 → 1.4.033 → 1.4.034 来回改动后各路径判断不一致（cli-hop 已重写、前置层仍按“已识别即保留”处理，Claude Code 的无 TTL 断点被当成 5m 写入，会话超过 5 分钟即整段重写缓存）。
- 移除未文档化的 `x-kin-strict-passthrough` 请求头：调用方不能再用它跳过入站剥离与客户端指纹清洗。
- 修复 native cli-hop 最终请求未读取 `kernel.json.default_cache_ttl` 的回归：Web 设置的 `5m` / `1h` 现在传到 CLI 自有 system/tools 缓存断点；调用方保留的 message 断点不被覆盖。
- #863 / #864：风险审计的决策模型用量按当前配置的每把 JEV key 列出请求数、成功数、估算消耗和最近状态（正常、余额不足、鉴权失败、限流、请求错误、已暂停、未请求）。key 只显示前 4 位和后 4 位，不回传完整 key 或地址。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.035 — 2026-11-03

- 清理：删除零引用导出 `rewriteTelemetryBody`、`persistVmFingerprint`（REQ-CLEANUP-01 D-08），无行为变化。
- #847：官方用量只返回 weekly 窗口时不再当成残缺结果丢掉。缺 5 小时窗口保持未知；窗口给了但读不出来仍算无效。
- #848：修复 Docker/KVM guest OAuth 换票把控制面的宿主 loopback SOCKS 地址传给 `kin-oauth-auth`，导致容器内连接 `127.0.0.1` 被拒；Linux guest 改由槽位 `kin-eg-*` 透明出口选路，macOS native 路径不变。
- #854：persona 重渲染注入的 `# Environment` role=system 消息改为锚定在首个 user 之后（原为最后一个 user 之后）。客户端下一轮不会回传该临时块，旧位置的 content block 数量变化会让 cache prefix 在历史中段断开、整段重写 cache；位置固定后前缀稳定。zero 模板保持原有尾部位置。
- #861：面板 `usage_logs` 大查询改到只读 worker，失败时回退同步读。请求 finish 和 hop 尝试先入队，再在同一条写连接上分批提交，避免另开写连接撞上 `SQLITE_BUSY`。

已部署机升级：只更新 Node 控制面后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.034 — 2026-11-02

- #859：透传关闭时，任何入站都先收成标准 Anthropic 结构再进人设：调用方 billing 删掉并由项目重写；调用方 User-Agent 不出站。只有协议页打开官方家族透传才保留这两者。第三方工具名改为 `mcp__`，回包按原名还原。
- #836：`ensureSlotGuestBinDir` 原子替换失败时清理 `${dest}.${pid}.tmp` 暂存文件，避免 `data/run/slot-guest-bin` 下残留堆积。

已部署机升级：只更新 Node 控制面后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.033 — 2026-11-02

- #850：回滚 #843 对已识别官方 Claude Code 的 cli-hop 强制 persona。识别命中且未开「官方 Claude Code 家族透传」时，cli-hop 保留入站 system 和缓存断点，不再把无 TTL 的调用方断点留给上游当成隐式 5m。`forceConfigured` 仍可改写。API 直连在开关关闭时仍按原分支清洗。
- 风险审计送审调用方提示词（system / instructions / developer）。「官方提示词」和「官方完整提示词」正文在白名单内，不送审；夹在官方正文后的调用方文字仍送审。工具结果和 Environment 不送审。

已部署机升级：只更新 Node 控制面后重启。不必 `wrap-cli/sync`，不必换 payload。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.032 — 2026-11-01

- OpenAI GPT 模型页支持按上游 `priority` 档位公开 `<model>-fast` 别名；调度前还原基模型并发送 `service_tier: "priority"`。
- Codex Image 增加 `gpt-image-2` 及 `gpt-image-2-2026-04-21` 快照，覆盖模型目录、Images 端点、Responses 图像工具、计费和槽位白名单。
- Codex kernel 对齐 `codex-proxy-rs`：支持大图像 WebSocket 帧，并用增量字节 SSE 解码器处理拆分 UTF-8、LF/CRLF 和大流。
- OAuth 换票与 bootstrap 全程沿用目标 VM 绑定出口。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启；本版包含 Codex kernel payload 更新，不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.031 — 2026-11-01

- #841：设置 → 配额直接显示并管理「请求体上限」（`failover.max_request_mib`，8–128 MiB）。账号池「重试与切号」不再包含这项。保存后的生效方式不变：各槽 kernel 在没有请求时重启。
- #843：官方 Claude Code 家族不再仅凭识别放行。协议页「官方 Claude Code 家族透传」（`official_cc_passthrough`）关闭时，直连、中转、子跳以及任何看起来像官方的 Messages 都走 persona 清洗；只有该开关打开才保留入站 system。cli-hop 与 HTTP 同一条门。
- #842：上游 HTTP 400/503「Third-party apps now draw from your extra usage…」和「no third-party apps allowed」不再当无效请求、过载或额度错误。不换号、不修复重试，客户端收到 400 `refusal_guard`，该 prompt 永久写入拒答缓存，近似正文按已有阈值拦截。这是计费限制，不封 device。内容策略错误码（含只写在 `upstream_code` 的）同样永久入库并带相似度签名。

已部署机升级：须更新 Node 控制面与 `web/dist` 后重启；无迁移、不必 `fetch:payload` / `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.030 — 2026-10-31

- #837：`prepareSlotOAuth` 正确读取 `startSlotReady` 嵌套的 kernel health（`boot.rust.rust.health`），兼容扁平 mock；修复非 native 槽 OAuth 上号必抛 `oauth_runtime_not_ready`。
- #838：HTTP server `keepAliveTimeout=120000`、`headersTimeout=125000`、`timeout=0`，避免反向代理长连接被过早掐断。
- auto mode 提示词对齐 Claude Code 2.1.310：cli-node 只在进入 auto mode 时发一次完整提醒，不再每几轮插入 `Auto mode still active…`。网关把 `Auto mode still active (reported by harness).`、旧的 sparse/六点全文折叠成这一次官方提醒；模型回声整段删掉。官方原文（Bias toward working…）不改。
- 本机 `share/wrap-cli/cli-node` 换成 auto mode 提醒对齐后的构建。源码 `bbadf5d4`。plain 118306944 字节，SHA256 `724a94390a3cfa0a57bc590ac0c7bd4448979b6c6843753806bd32aa52426286`。UPX 5.0.2 `--best --lzma` 后 27932800 字节，SHA256 `ae120fa09a61d6ba7afa3bb57e8e389a0183c4d2026957607143d9b39562c421`。`upx -t` 通过，`--version` 为 `2.1.303 (Claude Code)`。payload 未更新，线上槽位未部署。

已部署机升级：更新 Node 控制面后重启（本版不必更新 web/dist）。不要覆盖 routing.json、vms/、data/、.env。

## 1.4.029 — 2026-10-30

- #815：取消 Opus/Sonnet 5.5 将强制 `tool_choice` 静默改写为 `auto` 并强加 `strict:true` 的行为；入口 `validateToolChoice`，不兼容请求明确 400（`tool_choice_incompatible` / `invalid_tool_choice`），兼容模型保留调用方 `tool_choice` 与 `strict`。**行为破坏**：原先静默降级为 auto 的强制工具请求，现返回 400。
- #832：对齐 #814/#807：官方 cache 断点单测保留 CLI `eager_input_streaming`；调度 admission 单测不再依赖 `accounts.schedulable`。

已部署机升级：更新 Node 控制面后重启（本版不必更新 web/dist）。不要覆盖 routing.json、vms/、data/、.env。

## 1.4.028 — 2026-10-30

- #818：缓存前缀快照过期即删，不再等到 1 万条。查询判定不变。
- #814：CLI 路径不再剥掉 `eager_input_streaming`；最终组装再按面板开关补。只清 tool `cache_control`。
- #819：`/v1/messages` 转 Codex 时保留数组形式的 `system`（含 `cache_control`），不再只接受字符串。
- #807：调度不再读取无人写入的 `accounts.schedulable`。面板「参与调度」仍只看槽位开关；`account.status !== 'active'` 不变。
- #817：官方初装的 hello 与 `/usage` 追加官方 CLI 身份句。这条路径清空 `ANTHROPIC_BASE_URL`，网关 persona 不参与；缺身份句时上游回 429 `rate_limit_error`。
- #672：账号列表和机架卡片显示订阅到期。GPT 只用凭证里的 `chatgpt_subscription_active_until`；没有该字段或 Claude 显示「未知」，不用 access token 到期或额度重置推算。
- #665：GPT 等待队列按账号定向唤醒，消除满载时的唤醒空转。

已部署机升级：更新 Node 控制面与 web/dist 后重启。不要覆盖 routing.json、vms/、data/、.env。

## 1.4.027 — 2026-10-29

- `kin-kernel` / `kin-kernel.bin` 换成会在健康检查里报 `vm_telemetry`、`telemetry_ready`、`telemetry` 的 `f57d4e71081b`（13228472 字节）。cli-node 仍是单次 slot 开始发送端 `8484c4c58f4b`（27933052 字节），槽内不拨代理。`payload-2026.10.29-telemetry-kernel`。`v1.4.026` 镜像烘焙时还是旧内核 `8a61aaa3cba0`，新装要这一版才会带上这三个字段。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启；须 `npm run fetch:payload` 后 `wrap-cli/sync`（`restart:true`）。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.026 — 2026-10-29

- #820：决策模型收窄误伤。综合、破限、逆向、渗透、网络攻击五题明确放过：修本机故障时的「所有权限都给你」和 tool loaded、抄进来的审查说明、阅读自己的或客户的源码、路径里的「反编译」、在自己的机器上搭中转并设置登录密码，以及排查已交付系统的 ssh、redis、kafka 和配置密码。色情、暴力伤害、破解授权、明确越狱、对未授权目标的渗透和窃取别人的凭据仍然拦。已保存的旧出厂题会在读配置时自动升级为新句（LEGACY 集合；拦截静默放宽，面板改过的不动）。
- #822：Linux VM 遥测迁入同一 Rust 内核管理的常驻 cli-node，移除 Go 遥测服务及自愈/回退；仅使用目标 VM 身份、凭据、settings 与动态出口。在每个 slot 开始时伴生发送一条必要原生 1P 事件，不合并、不堆积作业结果；缺有效 profile scope 或已发布出口地理时暂停，401 不降级匿名发送。关闭立即清队列。
- #822：Linux 初登、重新授权工具进入目标 Docker/KVM guest，保留原 helper 和唯一 Go refresh 写者；实际换票阶段经受鉴权的 native 私有入口确认，缓存命中不制造事件。单 VM / 批量开关、间隔、状态和计数日志统一原生通路，远端必须确认 kernel 与 seed 均已发布；macOS 遥测明确不支持。升级须配套 Node / Go OAuth worker / kernel / cli-node 新产物，真实 KVM 验收仍需可访问的测试环境。
- #823：设置 → 遥测写明唯一开关是 `telemetry_disabled === false`：`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0` 不会打开，该变量只是播种镜像；展开槽位提取最近 40 条计数日志。设置 → 初装的「发布原生遥测策略」仍只同步已保存开关，不改官方 hello、用量、指纹或内存。
- #823：遥测发布从 VM 配置里的代理读取已保存的 IP 和地理信息，覆盖写入槽位 `telemetry/egress.json`；失败占位会被改写。发送者加载这份快照，不再自己探测，也不在槽内拨代理，也不把多次 slot 开始合成一批。出口只走槽网络外层转发。没有可用地理信息时不发明快照，也不阻断其余发布。`payload-2026.10.29-telemetry-slot-start` 钉住 cli-node `8484c4c58f4b7782a190f7cab7c8aa5d1f706ae26b2d2a5cafe81af070f0611b`（27933052 字节）：每个 slot 开始伴生一条原生事件，不合并、不堆积作业结果。
- #824：请求日志的思考强度改读出站 envelope：调用方 effort 优先，没有则记模型缺省（面板 `default_effort`，未设置用目录缺省，Sonnet 5 为 high）。`off` 仍为空。失败在发出之前的请求仍只显示入站值。
- #825：上游 Usage Policy 的 400（内核常记成 `upstream_invalid_request`）归入拒答，风险审计能看到。拒答指纹显示用户原文，不显示 `<system-reminder>`。近似只比较去掉提醒、环境和工具回传后的用户正文；短于 512 字只做精确指纹，不靠共享提醒误伤。
- #825：**行为变化**：决策模型默认由六题收成三题（`usage_policy` / `nsfw` / `abuse`），破限、逆向、渗透与网络攻击合并进 `abuse`。读配置时 `normalizeJevConfig` 迁移：若保存的仍是未改过的旧内置 `safety`/`jailbreak`/`reverse`/`pentest`/`cyber` 出厂句（LEGACY 集合命中），整表替换为三题新文案并保留原 `nsfw` 的 enabled；任一条目被面板改过、或存在自定义 id，则只刷新仍匹配 LEGACY 的内置句，不删自定义题。使用政策按近期上游拒答改过，轴承和编码器这类机械句不拦。色情低于阈值就拦，并写入 device 封禁。三题各自打分，任一题低于阈值就拦。
- #826：`deploy/arm64-cli.json` 与 `payload-2026.10.29-telemetry-slot-start` 对齐钉住同一 cli-node，修复 ARM64 控制面内置 CLI 与 payload 不一致导致 main CI 失败。
- #826：修复协议 `mapProtocolClientError` else 分支未附带池选型 summary（`formatPoolSelectionSummary`）的回归。
- #826：ARM64 native CLI 部署 smoke 在 cancel 探测后轮询 `/internal/health`，直至全部槽 ready 且 `cli_restarts=0`，降低 CI flaky。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启；须 `npm run fetch:payload` 后 `wrap-cli/sync`（`restart:true`）。重部署 Go OAuth worker（`kin-oauth-auth`）。ARM64 控制面镜像须重建以随 `deploy/arm64-cli.json` 钉住 `payload-2026.10.29-telemetry-slot-start` 的 cli-node（`8484c4c58f4b7782a190f7cab7c8aa5d1f706ae26b2d2a5cafe81af070f0611b` / 27933052 字节）。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.025 — 2026-10-28

- #812：新增默认开启的 notify.events.vm_down：节点 SSH 失联、watchdog 内核恢复预算耗尽，或运行中的 VM 变为 stopped/dead/error 时，经已启用的 Telegram / 企微 / 邮件通道告警（含设置页开关）；移除 server 独立 watchdog 通知路径，统一由通知监控处理。人工停调、维护、额度冷却及未知运行状态不告警；同一次下线只通知一次，失败通道可重试。

## 1.4.024 — 2026-10-28
- #804：准入钩子期间释放后按实时 inflight 递增，避免占位复活。
- #805：修复请求体省略 `stream`、`Accept: application/json, text/event-stream` 时 `/v1/messages` 等入口返回 SSE：Claude Code 2.1.311 起 auto 模式分类器以非流式发出、按 JSON 解析，SSE 回包让非流式网关判为空消息 502，子代理工具调用全部失败。省略 `stream` 时仅当 `Accept` 对 `text/event-stream` 的偏好高于 `application/json`（q 值，同值算 JSON）才流式；只写 `text/event-stream` 及显式 `stream` 行为不变。
- #809：ARM64 本机推理 CLI 改为原生运行（镜像内建 arm64 CLI overlay，`deploy/arm64-cli.json` 钉 cli-node），修复大请求 stdin 写入超时 / `native stdin write blocked`；Fixes #808。仅本机 ARM64 Docker Claude 槽；共享 amd64 模板、远程节点、KVM、Codex 不变。

已部署机升级：更新 Node 控制面与 web/dist 后重启；无迁移。ARM64 控制镜像主机须拉含本版原生 CLI 的新控制面镜像并重建（随镜像内 `deploy/arm64-cli.json`）；若曾手工挂载原生 CLI，升级时移除旧覆盖改用镜像内置。cli-node / kernel 的 payload.json 哈希未变，不必仅为 #809 做 `fetch:payload` / `wrap-cli/sync`。不要覆盖 routing.json、vms/、data/、.env。

## 1.4.023 — 2026-10-28

- #791：识别官方 Claude Code 的 `agent_summary` 进度摘要请求（末尾完整摘要指令，含同消息 tool_result + text 与 token-budget 提醒），每次用临时出站会话和独立 seat，不进父会话串行队列、不绑定父会话 sticky / family；VM 亲和、槽位、并发与额度准入照常，容量耗尽时仍排队。普通同会话请求继续串行。此前摘要被父会话长请求挡住，观测到总 TTFT 185 秒（模型 TTFT 2.2 秒）。
- #797：修复 zero 自定义模板重排调用方变量或插入中间 system 后产生 `5m → 1h` 非法顺序：仅对原本合法、被模板重排打乱的调用方策略，将过早出现的短时断点顺延到最后一个调用方 `1h` 断点后。保留正文布局、显式 / 隐式 TTL、标记字段与数量，断点仍覆盖原标记内容；模板断点随后按剩余预算合并。
- #797：修复 Chat assistant 文本块转换丢失缓存标记，保留分块、显式 / 隐式 TTL 及工具调用顺序。zero 自定义模板展开调用方变量时保留原块与缓存所有权，重复引用不复制断点，完整组装后统一计算 TTL 顺序与四断点预算；插入消息的调用方 system 断点同样避开历史优化搬移。去重 token-budget 提醒时保留其缓存锚点，避免误触发默认 TTL 补点。
- #797：修复消息内 system / developer 提升到顶层 system 时丢失缓存标记：保留前置消息的文本块、空白与显式 / 隐式 TTL，覆盖 Messages、Chat 及 Responses 转换。中间 system 必须提升时，正文仍保持 system 优先级，缓存标记通过独立文本锚点留在原历史边界，避免 5m 被移到已有 1h 前面；不覆盖原断点或打乱工具结果顺序。
- #797：自定义提示词模板也统一合并缓存策略：缺失 TTL 按配置及前后顺序补齐，优先保留调用方断点，省略冲突或超出四断点预算的模板标记，保留模板正文；同时覆盖 CLI 与 API 路径。
- #797：官方 / 完整官方不再因业务 system 提及 SDK、客户端名称、协议字段或使用相似章节标题而删除整段；仅清理明确的独立身份行、计费头与完整已知官方模板，保留相邻业务指令。
- #797：历史缓存优化在模板组装前识别调用方消息 / 顶层缓存策略：此类请求只记录前缀诊断，不搬移消息断点或裁剪历史图片，保留原位置、显式 / 隐式 TTL 与同消息多标记；网关生成的消息断点继续优化，额度预估同步使用相同策略。
- #797：官方 / 完整官方及自定义模板出站使用明确的组装状态，关闭或删除动态边界后也不再二次清理、重建 system 或覆盖调用方消息 TTL；缺少消息标记时继续按配置及剩余预算补齐。
- #797：官方 / 完整官方与 zero 共用缓存合并约束，优先保留调用方断点；模板显式 TTL 冲突或超过四断点预算时仅省略模板标记、保留正文。CLI 在模板计算 TTL 前清理不出站的工具及顶层标记，避免已移除的工具隐式 5m 将配置的 1h 降级；API 仍按保留的工具标记约束顺序。
- #797：zero 的顶层自动缓存转换为当前消息尾部断点，保留其显式 / 隐式 TTL，跳过 thinking，已有尾部标记不覆盖；随请求历史增长重新定位，不再因 system 已有断点而丢失消息缓存。
- #797：已保存且仍匹配旧默认结构的官方模板自动补回 `caller_system` 段；编辑器与预览同步显示。用户明确关闭该段或编辑过的模板不被覆盖。
- #797：zero 出站按当前槽位已解析的预设识别，不再依赖可关闭或编辑的 billing 文本；关闭 billing 后也保留调用方 system 与原缓存时长，缺少标记时继续按配置补消息断点。官方 / 完整官方模板补 TTL 时计入前置工具标记与顶层自动缓存；zero 自定义模板同时将顶层标记纳入四断点预算。
- #797：修复 zero 档默认模板丢失调用方 system：保留原始文本块、顺序与缓存标记，仅替换 billing 行；已保存的仅含 billing 的模板同样生效。显式使用 `{{caller_system}}` 的自定义模板继续控制其位置，出站预览同步展示调用方示例。
- #797：zero 自定义模板中已被 `caller_agent` / `agent_official` 使用的文本不再重复追加；未启用的模板位置不消耗调用方内容。调用方动态边界文本不再触发官方模板的工具缓存清理。合并缓存时优先保留调用方标记，模板缺失 TTL 按配置与前后约束补齐；冲突或超出四断点预算的模板标记被省略，文本仍保留。
- #797：自动修复重试在当前槽位模板组装后重放修复策略，保留调用方 system、槽位覆盖与修复结果；已缓存的搜索历史修复同样生效。API 直连的日志与计费保留上游实际 5m / 1h 用量，不再按默认 TTL 重标；usage 隐藏排除调用方原有文本，包括与旧 billing 行同块的 Environment。
- #797：官方 / 完整官方提示词已组装动态边界后，恢复对话历史的消息缓存断点：没有调用方消息断点时，按剩余四断点预算补最后及上一条 user（预算只剩一个时优先最后一条）。保留 system 文本和调用方消息断点；沿用官方档工具断点清理行为，在清理后计算消息断点预算。lean / preserveSystem / requestContext 路径不启用消息补点。
- #797：默认缓存写入 TTL 同时用于网关生成的官方模板断点和新增消息断点。模板标记未声明 TTL 时在生成阶段补齐，使用请求覆盖及会话固定后的值；已有明确 TTL 和调用方消息标记保持不变，并约束新增 TTL 避免 5m 后出现 1h。不会仅凭调用方 system 的动态边界标记认定其为网关生成的模板。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启；cli-node 哈希未变，不必 `fetch:payload` / `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.022 — 2026-10-28

- 官方 Claude Code 入站带 `x-claude-code-agent-id` 或 `x-claude-code-parent-agent-id` 时，出站原样保留；没有则不添加，也不写入槽位头文件。非官方入站不转发。cli-node 不生成这两个头。Go worker 与 kernel hop 放行同名头。
- kernel hop 放行已有的 `x-claude-code-agent-id` / `x-claude-code-parent-agent-id`。新 ELF SHA256 `8a61aaa3cba06567a4c3b0039d357b341975e2495ec7fc7e8b5c3425cc53ec16`（12947192 字节），payload `payload-2026.10.28-kernel-agent-id`。`bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 是同一份。其余 payload 附件哈希不变。
- #777：Codex 用量的 `service_tier` 与费用改按网关实际发出的档位（`fast` 已改写为 `priority`），与 codex-proxy-rs 一致；上游 `response.service_tier` 回显另存到新列 `upstream_service_tier`（迁移 047），不再覆盖计费档。发出 `priority`、上游回显其他档位时，日志「特殊设置」显示「Fast 未生效：priority → default」。未发档位的请求不再拿上游回显当计费档。网关发出的请求体与 `x-codex-routing-hint` 不变；上游回 `default` 是账号或上游决定，网关不能强制 Fast。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启；启动应用迁移 047。kernel payload 更新，须 `npm run fetch:payload` 后 `wrap-cli/sync`（`restart:true`）。cli-node 哈希未变。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.021 — 2026-10-28

- #795：池调度候选阶段一次联合查询复用账号与运行状态快照，健康写回与过期清理移出请求热路径；迁移 046 拆分 `queue_wait_ms` 与 `scheduling_ms`，`wait_ms` 总调度口径不变，历史行 NULL。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启；启动应用迁移 046。cli-node 哈希未变，不必 `fetch:payload` / `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.020 — 2026-10-28

- #726（作者 eshao731，Closes #722 / #723 / #724 / #725）：Codex HTTP 省略 `stream` 且无 `Accept: text/event-stream` 时返回 JSON，非流式 Chat/Completions 返回对应格式而不是 Responses 对象；首事件等待用 `KIN_UPSTREAM_TIMEOUT`，之后按流空闲超时检查，不再在内核回头后无限等待；未输出时内核 `503 no_capacity` 在候选范围内换槽；按实际 envelope 检查槽内限额，内核纯文本 413 报 `413 body_too_large` 而非 `worker_invalid_json`。**行为变化**：未设 `failover.max_request_mib` 时入口请求体上限由进程天花板（默认 128 MiB）改为与槽内 kernel 一致的 32 MiB，32–128 MiB 请求现在在入口直接 413。
- Fixes #768 / #789 / #793：槽终端交互式启动 `claude` 时 cli-node 在 REPL 渲染阶段报 `SandboxManager.isSupportedPlatform is not a function` 退出。构建用的 `@anthropic-ai/sandbox-runtime` 桩只有 `start/stop`，适配层转发的静态方法全为 undefined；补齐后平台报不支持沙箱，`isSandboxingEnabled` 为 false，Bash 不进沙箱。`CLAUDE_CODE_HOST_REFRESH` 下读写宿主 `credentials.json`，logout 不 unlink 宿主文件。源码 `cleanup/local-src` `cb65c855`（含 `8917b95a`）。payload 钉到 `payload-2026.10.28-cli-host-cred`，cli-node `4975763790088a0eba226f20152b3c45261a0654b8bbc038701757b7699ab4e1`（27789668）。
- 遥测主路径对齐 Claude Code 2.1.303。`env` 始终带 `node_version`（`v26.3.0`）、`is_running_with_bun`（`true`）和构建时间 `2026-10-18T20:20:57Z`，不再用槽位安装时间；版本回退为 `2.1.303`。空的 distro、git、GitHub Actions 字段不再上传，`coworker_type` 不再出现。进程指标补上 `cpuWindowMs`。`tengu_api_success` 带本次请求的模型，`tengu_init` 不带。主路径和 GrowthBook 不再带邮箱。旧 `worker.json` 里残留的硬件和密钥字段仍会在发送前丢掉。

已部署机升级：须 `npm run fetch:payload` 后 `wrap-cli/sync`（`restart:true`），并更新 `kin-worker`，再重启 Node；仅更新 Node 不够。需要 >32 MiB 请求体的部署须在设置里显式调大「请求体上限」。本机槽需重启遥测旁路后才按新字段上传；集群槽在下次槽位启动、重载或出口重建时推送新的 `kin-worker`。只读根文件系统的集群槽需按现有流程换镜像。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.019 — 2026-10-28

- Fixes #738 / #763：GPT/Codex 请求（`/v1/responses`、Chat/Completions、`/v1/messages` 转 Codex、`/v1/alpha/search`、`/v1/images/*`）补上托管 API Key 的 acquire/release 与扣费：成功请求按与 `usage_logs` 同一官方价（含生图）× 分组倍率累计 `requests` / tokens / `quota_used` / 5h·1d·7d 窗口与 `last_used_at`；USD 额度、请求数额度、窗口限额、RPM 与 Key 并发对 GPT 流量生效，额度用尽返回 `429 api_key_quota_exhausted`。此前 GPT 路径直接跳过，Key 计数恒为 0。

已部署机升级：仅更新 Node 控制面后重启。历史 GPT 用量不回填到 Key 计数（`usage_logs` 不变）。cli-node 哈希未变，不必 `fetch:payload` / `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.018 — 2026-10-27

- #720：风控页新增「JEV 使用记录」（全部 / JEV 视图下，默认折叠）：每次真正发给审核模型的调用记一行，含北京时间今日次数、累计调用/成功、上游返回的输入/输出 tokens 和按官方 TypeSafe 公开价的费用估算；去重缓存命中不算调用，上游没报用量的记为未知而不是 0。只存 Key 指纹（sha256 前 12 位），不存密钥、正文、问题和响应；明细保留 30 天，按天汇总保留 90 天，累计汇总一直保留。接口 `GET /api/panel/jev-usage` 仅管理员可读。新增迁移 045。
- #666：arm64 控制面 `deploy/Dockerfile.arm64-control` 的 `NODE_IMAGE` digest 升到 Node 22.23.4（`sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`），覆盖 Node 10–21 安全更新；amd64 Dockerfile 用浮动标签，下次构建自然跟上。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启；启动应用迁移 045。arm64 部署须拉新控制面镜像重建（含 Node 22.23.4）。cli-node 哈希未变，不必 `fetch:payload` / `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.017 — 2026-10-27

- #782：CI：main 自 1.3.154 起 `npm run test:unit` 一直红（20 个文件 80 项），后续 Go / web 步骤从未执行。本次逐项二分到引入提交，过时断言改为当前设计，下面几处是真回归，已修：
- #782：出口（kin-egress）：端口 0 启动时按字面 `:0` 等监听者，永远失败；二进制被替换后旧进程仍被当作可复用、`/proc` 扫描在最后一项不匹配时整体返回空，旧出口不回收导致 `egress_port_busy`（91acb94e 引入）。
- #782：换号 thinking 归属：cli-hop 从原始请求重渲染时绕过了按账号过滤，别的账号签名的 thinking 原样发出（5a4f2f1d 引入）。
- #782：人设：`official` 档丢掉调用方顶层 system（既不在 system 也不在 messages）；面板 `persona_guidance_presets` 不生效；旧 rewrite 路径总带槽位 ` - Locale:`；不支持 mid-conversation system 的模型（如 haiku-4-5）在 API 后端出站带 `role=system` Environment，会被上游 400。均为 e358143c 引入。
- #782：面板：0注入档的 usage 遮罩显示与网关一致（网关按档默认遮罩）。
- #782：已知未改：0注入档按 d917dd2a 设计不保留调用方顶层 system；人设重复渲染不幂等（生产只渲染一次）。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。无迁移，不必 `fetch:payload` / `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.016 — 2026-10-27

- #778：zero 档已带 billing `prompt_version`、调用方未提供 cache 标记时，恢复消息 `cache_control` 断点兜底（单轮 1 个、多轮最多 2 个，复用 `officialMessageMarker` 与解析后 TTL；不追加 system 模板；已有 system/tools/消息断点则保留不补点；lean/shaped/preserveSystem/requestContext 路径不启用）。

已部署机升级：仅更新 Node 控制面后重启；cli-node 哈希未变，不必 `fetch:payload` / `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.015 — 2026-10-27

- #775：风险审计的硬正则和决策模型只读用户正文。`system`、`instructions`、消息里的 `role=system`、`# Environment` 和已闭合的 `<system-reminder>` 不再送审；未闭合的提醒标签不再把后面的用户句子一起删掉。多轮请求把最后一条用户正文再标成 `[current ask]`，避免 16000 字尾窗只剩历史。拒答缓存的指纹不变，仍含工具回传。决策模型拦住时，`usage_logs.jev_state`（迁移 044）记下当时 POST 的 `state`，请求详情显示为送审正文；这是送审上下文，不是模型指出的命中句。`intercept.keyword` 仍只是题库类别。

已部署机升级：更新 Node 控制面与 `web/dist`，重启一次 Node。启动应用迁移 044。不必 `fetch:payload` / `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。旧日志没有 `jev_state`，补不回来。

## 1.4.014 — 2026-10-27

- #773：重复合法自定义工具名出站前唯一化（保留首个，后续 `kin_tool_<hash>`；`tool_choice`/历史指首个）；唯一性不再受 `tool_name_rewrite` 影响；相同服务端工具去重，冲突/非法本地 400 `invalid_tool_name`。

已部署机升级：仅更新 Node 控制面后重启；cli-node 哈希未变，不必 `fetch:payload` / `wrap-cli/sync`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.013 — 2026-10-27

- #769：API 内核 SSE 响应逐块 flush，修复小响应缓冲到结束才返回的问题，保留实际流式交付和首 Token 时序。
- #769：协议 token 口径：Claude 转 Chat / Responses 的输入总数包含缓存；OpenAI 规范化区分 inclusive / disjoint 输入并识别显式缓存写入别名，reasoning 保留为 output 子集，不重复累加。
- #769：日志真实性：TTFT 按 cli-node / OpenAI 实际生成内容或进度打点；新增 `first_byte_ms`、`generation_ms`（迁移 043），列表、请求概览和性能页统一按实测上游输出窗口计算 tok/s，包含隐藏推理、排除终结后的收尾。旧日志或单包缓冲窗口不可测时不再估算速率。
- #769：日志实际用量：合并 SSE 与最终 usage 时保留缓存读写明细，不重复扣缓存；Codex 明确报告的缓存写入赋值到日志列，未报告为未知（`null`），不从未命中输入推算；详情总 token 使用输入、输出、缓存读写的完整总量。

#769 已部署机升级：须更新 Node、`web/dist` 与源码构建的 `kin-api-kernel`，重启对应控制面/API 内核进程；启动自动应用迁移 043。无需替换 cli-node / Claude 或 Codex kernel payload，不需 `wrap-cli/sync` 或重建槽。历史错误速率无原始时序不能补算，历史缓存写入 0 也不臆测回填。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.012 — 2026-10-27

- #764（Fixes #764）：新装/缺省出站 `cc_entrypoint` 改为 `cli`（原 `sdk-cli`）。`routing.json` 未写或省略该字段时，网关补 billing、出站 UA 与 kernel 投影均解析为 `cli`；仅显式保存 `sdk-cli` 时仍为 `sdk-cli`。**不**迁移已有部署里已写入的 `sdk-cli`。

已部署机升级：须更新 Node 控制面 + `web/dist` 后重启。cli-node 附件哈希相对 1.4.011 **未变**，故 **不必** `fetch:payload` / `wrap-cli/sync`；完整 cli-node 热读新缺省仍依赖后续 payload 升级。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.011 — 2026-10-27

- #736：修复 KVM 槽在关机或「恢复服务」时因换镜像重建容器却未回填 `KIN_KVM_MAC` / `KIN_KVM_DISK_SERIAL` 导致 kin-kvm 启动失败；停/启与恢复路径会从槽配置、旧容器 env 或已采集的 guest hardware 回填并写回 `vm.machine`，env 不完整的容器会强制重建。

已部署机升级：仅需更新 Node 控制面后重启；不必 `fetch:payload` / `wrap-cli/sync`，不必重建槽，无 DB 迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.010 — 2026-10-27

- #759：默认身份句与 0注入 `prompt_version` 改为 `You are Claude Code, Anthropic's official CLI for Claude.`。页面摘要、预览和 cli-node 读取的 `{{identity}}` / `{{identity_cli}}` 都是这句；已保存的自定义模板不变。

已部署机升级：须更新 Node 控制面 + `web/dist` 后重启。cli-node 哈希相对 1.4.009 **未变**（仍 f29bbfa45b68308367f4091699cbeb3a0baba860d327d349d6d55cc11408fb68），故 **不必** `fetch:payload` / `wrap-cli/sync`。无 DB 迁移、不必重建槽。已保存自定义 persona 不变，仅默认/重置路径吃新身份。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.009 — 2026-10-27

- #757：升级/安装后槽刷新改经控制面（等节点 ready → `wrap-cli/sync` restart:true → fleet-update telemetry），修复远程槽 `cluster_unavailable` 且不同步 cli-node；同内容哈希镜像的远程运行中槽跳过重建；`syncInstalledKernels` 串行防并发。无 `deploy/payload.json` / cli-node 哈希变更。

已部署机升级：须更新 Node 控制面镜像（含新 `fleet-services`）后重启。`panel-upgrade` / `install` 升级路径会经控制面执行 `wrap-cli/sync`（restart:true）再 telemetry。cli-node 哈希相对 1.4.008 **未变**（仍 f29bbfa45b68308367f4091699cbeb3a0baba860d327d349d6d55cc11408fb68），故 **不必** `fetch:payload`。无 DB 迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.008 — 2026-10-27

- #754：面板可配置每模型缺省 effort（off=不向上游补）；保存/重置模型策略后热写运行中 Claude 槽 kernel.json 的 model_effort；Node ensureUnofficialEffortHigh 对 off 不补 output_config.effort。Supersedes #748。

已部署机升级：须更新 Node 控制面 + `web/dist` 后重启。`deploy/payload.json` 的 cli-node 哈希相对 1.4.007 **未变**（仍 f29bbfa45b68308367f4091699cbeb3a0baba860d327d349d6d55cc11408fb68 / payload-2026.10.26-cli-effort），故本版 **不必** `fetch:payload` / `wrap-cli/sync`。完整「cli-node 热读 model_effort」依赖更新的 ELF，本 tip 未换附件；仅 Node/面板路径的 off 不补与 kernel.json 投影已生效。无 DB 迁移、不必重建槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.007 — 2026-10-26

- #752：`deploy/payload.json` 的 `cli-node` 对齐线上哈希（size 27789508，sha256 f29bbfa45b68308367f4091699cbeb3a0baba860d327d349d6d55cc11408fb68）——已部署机升级须 `npm run fetch:payload` + `wrap-cli/sync`（restart:true）后重启 Node；仅更 Node 不够。

已部署机升级：须 `npm run fetch:payload` 拉取更新后的 payload 后执行 `wrap-cli/sync`（`restart:true`），再重启 Node 控制面；仅更新 Node 不够。不必重建槽，无 DB 迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.006 — 2026-10-26

- #749：`run/` 目录属主与目录内文件一致（Fixes #740）——`writeKernelConfig` 目录 chown 改用 `runtimeFileOwner`，避免命名槽 ID（如 account2example）目录/文件 uid 不一致导致 Permission denied。

已部署机升级：仅需更新 Node 控制面后重启；不必 `fetch:payload`，不必 `wrap-cli/sync`，不必重建槽，无 DB 迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.005 — 2026-10-26

- #746：修复 ARM64 预构建镜像安装：`.env` 的 `COMPOSE_FILE` 若含源码用的 `docker-compose.arm64.yml` 会错误走本地镜像名；**新版** `deploy/install.sh` 在镜像模式下只去掉该项（保留其它 overlay，去掉后为空才设为 `docker-compose.yml`），且不为空的 `COMPOSE_FILE` 写入默认值以免屏蔽 `docker-compose.override.yml`。**仅跑新版 install.sh 时生效**；面板一键更新不改 `.env`，用旧脚本升级的那一次仍是旧逻辑。面板升级 Compose 运行前忽略宿主 `DOCKER_DEFAULT_PLATFORM`（与 install.sh 一致）。见 `docs/ARM64.md`。
- #744（取代 #697，作者 VankaIn）：本机 SOCKS5 槽位不再随 Docker 守护进程抢先启动：使用 `restart=no`，由控制面的自动恢复流程先恢复代理规则再启动槽位；升级时原地迁移已有容器的重启策略。出口初始化先安装阻断规则，代理进程失败时保持断网。升级后须确认控制面启动成功，再重启 Docker；详见 `docs/DEPLOY.md`。

已部署机升级：仅需更新 Node 控制面后重启；不必 `fetch:payload`，不必 `wrap-cli/sync`，不必重建槽，无 DB 迁移。#744 为高风险：须先确认控制面启动成功（`restart=no` 迁移失败会阻止启动）再重启 Docker；远端节点 iptables 顺序同步变化；ARM64 预构建镜像用户需再跑一次新版 `install.sh`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.04 — 2026-10-26

- #743（Fixes #717 / #715）：GPT 额度刷新或面板「恢复状态」时，按窗口用量重算并清除过期的 `codex.extra.codex_limited_until`；手动恢复不再只清 Claude 冷却字段而留下 Codex 专用停用标记。
- #716：出口代理把「域名转发」开关 `domain_forward` 透传到 kin-egress；已开该开关的代理需再点一次开关或触发出口修复/槽启动，旧 kin-egress 才会写出 domain_forward。
- #713：删除槽位时清理其账号池成员（removeVm / reconcileVms prune），面板阻止同一槽位跨池勾选。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启一次 Node；不必 `fetch:payload`，不必 `wrap-cli/sync`，不必重建槽，无 DB 迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.03 — 2026-10-26

- #712：重载 GPT（Codex）槽位时，先停掉并等待控制面里实际在跑的 Codex 内核再重新拉起，使其应用当前代理；停不掉（`untracked_kernel` / `recycle_timeout`）时返回 `codex_kernel_reload_failed`，不再复用旧内核的健康状态。（作者 venn0126，Fixes #711）

已部署机升级：仅更新 Node 控制面后重启一次 Node；不必 `fetch:payload`，不必 `wrap-cli/sync`，不必重建槽，无 DB 迁移。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.02 — 2026-10-26

- 对话结束且没有排队的后续请求时，立即释放 `session_slots`。粘性 TTL 只记住用过的 VM、账号和出站 session，不占席位，到期时间不刷新。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启一次 Node。不必 `wrap-cli/sync`，不必重建槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.01 — 2026-10-26

- catalog effort 缺省，修复 1.4.00 haiku effort 400。payload 钉住 `payload-2026.10.26-cli-effort`，cli-node `01740e54`。

已部署机升级：须 `npm run fetch:payload` 换上 `payload-2026.10.26-cli-effort` 后 `wrap-cli/sync`（`restart:true`），再重启 Node；仅更新 Node 不够。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.4.00 — 2026-10-26

修复大量bug,全新版本.额度50%+,安全100%增加

部署机需要 `wrap-cli/sync`（`restart:true`）：本版 payload 换成 `payload-2026.10.26-cli-node`，cli-node 为 `9a481c94`；同步后各 Claude 槽重启进程，容器不重建。

- #727：system提示词页改版：出站预览为主窗口，提示词按块显示摘要、点详情编辑，环境注入（运行环境、模型附加句）单独成区并标明位于 system 末尾；去掉旧注入卡的长说明与重复入口，出站入口开关只留在设置 → 协议。本版只搬页面，出站行为不变：官方档仍按档选择、缺省 `sdk-cli`，不加 #727 的完整环境说明 / 时区 / 语言开关。
- #703 与 #731 合并后，`reason: 'sticky'`（按 session 选中 VM 的选号依据）登记为不改槽态。
- #733/#732：槽位列表（表格 / 机架）、详情页与列表弹窗展示 **Active** 徽标（`vm.active` / `vms/active.json`）；行菜单与运维页提供「设为活跃」，调用既有 `POST /api/panel/vms/:id/activate`。
- #733/#732：删除仍占活跃指针的槽位时，若有其它可调度且凭证有效的候选，确认后先自动 `activate` 到推荐槽再 `DELETE`；无安全候选时禁用删除并提示先切换活跃。
- VM 详情页额度栏在「本窗口 5H 已用」下加「上个 5H 已用」：结束时已用比例、起止、官方价花费与请求数。本窗口已用 < 5% 算不出总额度时，花费提示改用上个窗口的「花费 ÷ 结束时已用」推算余额，并注明「按上个窗口」。
- 查看统计弹窗重排：顶部为「上个窗口」「当前窗口」（各含 5H 与 7D 的已用、起止或重置、花费、请求、token）和「预计剩余 5H 额度」；去掉「花费最高的一天」「请求最多的一天」。Key 统计弹窗不变。
- 后端在额度写入时归档已结束的 5H / 7D 窗口（Claude 存 accounts `extra.window_history`，GPT 存 `vm.codex.window_history`），`/vms/:id` 新增 `billing.prev_window_5h` / `prev_window_7d` / `window_5h_projection`。不加迁移；上线后第一次窗口翻转前上个窗口显示「暂无记录」。
- #730：面板模型目录固定模型 `auto`；三种目录模式在其启用时均列出，`worker_only` 也会追加已启用的 `auto`；停用后不列出。请求 `model: "auto"` 原样出站，不改写成具体 Claude 模型。
- #730：auto mode 分类器契约对齐 cli-node 2.1.310：`temperature` 默认 1，stage 1 为 64/256，stage 2 与 tool 路径 `max_tokens=8192`。网关继续原样传递这些已有字段。`extra_body` 仍在官方字段清洗时丢弃；attribution 与 `auto-mode-classifier-2026-07-16` 的透传不由这次测试证明。
- #731：修复同一 client session 占到 VM 后被其它 session 抢走槽位：席位按 session 计，不再按 device 把同一客户端的多个会话挤在一个槽上。请求进行中占槽；这一轮结束且该 session 没有排在这台 VM 上的后续请求时，槽立刻释放。粘性 TTL 只记住用过的 VM，不占 `session_slots`，到期后才忘掉这份记忆。VM 不可调度 / 额度、凭证、暂停、换 VM 重试会清掉记忆。Node 重启不把已经结束的对话占回槽位。
- #731：出站占位以 device id / machine id 为先：一个 machine 先占一台 VM，同一 machine 的后续 session 优先使用这台 VM 内的空槽，槽满才去别的 VM。每个 session 在请求进行中独占一个槽，结束后释放。分配原因里 `device-affinity` 表示落到这台 machine 已占的 VM。
- #731：修复同一 VM 上每轮重建出站 Session：family 亲和与会话已占席位不一致时，先判断席位是否继续保留，再处理粘性绑定；仍使用原席位时不再因 family 不同删除出站 Session。真实额度门禁 / VM 不可用触发换 VM 时仍换代。

- cli-hop 每次请求从 routing 文件读一次 `cc_entrypoint`。system 身份、guidance 和补出的 billing 使用同一次结果；文件正在写入时退回内存快照。改 `sdk-cli` / `cli` 后这三处一起变。

- 动态 profile 按出站入口分成两套。`cc_entrypoint=cli` 用交互身份句，并保留 guidance 里的 `! <command>` 提示。缺省 `sdk-cli` 用 Agent SDK 身份句，去掉这句，对齐 `--print` 抓包。billing、UA 和兜底头仍走原来的入口开关。

- 设置 → 协议和 system提示词可切换出站入口 `sdk-cli` / `cli`。网关生成的 billing、出站 UA、cli-node 兜底 billing 使用同一个值。调用方自带的 billing 入口不改，CCH 密封只改 `cch`。保存后写入各 Claude 槽 `kernel.json` 的 `cc_entrypoint`，当前本机 cli-node 每次请求热读，不重启槽。缺省仍是 `sdk-cli`。plain ELF 已验证两个值同步切换，非法值回到 `sdk-cli`。

- cli-node 对齐 2.1.303 计费行和 beta 选择器后重编。源码 `9a0f53da`，协议 `850b57aa`。plain ELF 五模型最终 beta 与 API key 路径的抓包顺序一致，haiku 的 `claude-code` 在第 6 位，auto 为 12 项。plain 117487744 字节 `56f068f0…`；UPX 5.0.2 `--best --lzma` 后 27794232 字节，SHA256 `d9f0ba21f2b12f2b00117e0f2fc8862ac8569477f5a4f5797324d9336c523e0b`。`upx -t` 与压缩后 cli-hop e2e 7/7 通过，`--version` 为 `2.1.303 (Claude Code)`。已替换本机 `share/wrap-cli/cli-node`。payload 未更新，未部署。
- 官方档和完整档的 system 对齐 2.1.303：billing、身份、harness（`1h` + `scope global`）、guidance（`1h`）。拆分边界只交给 cli-node，最终请求不出站。调用方 system 和第三方 harness 接在 guidance 后，不替换官方提示。

- 本机 `share/wrap-cli/cli-node` 替换为隔离快照构建：源码 `ed9fd21`，外部依赖 `src/lib/protocol/claude-code-betas.mjs` SHA256 `0dd4d8d9…`，另补已提交代码所需的 `SYSTEM_PROMPT_REPORTING_OUTCOMES` 导出。plain 111237248 字节 `d6fd3a91…`；UPX 5.0.2 `--best --lzma` 后 27177428 字节，SHA256 `2c1b271df033e23830cc8cdc0181fab60d4de96ff8cf4cd406651aecd9b5ae9f`。`upx -t` 通过，`--version` 为 `2.1.303 (Claude Code)`。尚未更新 payload，未部署。
- 面板默认 beta 对齐 cli-node 2.1.303 `--print` 的 14 项前缀。setup-token 仍用短列表。模型句补 Haiku 4、Sonnet 4、Opus 4 的知识截止。
- official_303 在 harness 与 guidance 之间保留 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`，只交给 cli-node 拆分。cli-node 认出 303 的 billing、身份、harness 后保留该边界：harness 出站为 `1h + scope global`，guidance 为 `1h`，边界字符串本身不出站。HTTP 渲染仍丢弃它。旧 `share/wrap-cli/cli-node` 不认这个形状，临时验证二进制 SHA256 `62029a65…`，未替换交付二进制，未部署。
- 模型附加句改为按档开关，默认关闭。关闭时 `{{model_sentence}}` 不渲染；打开后才取 `model_env_extra` 里当前模型的句子。清空模板块后也不追加。
- 网关生成的 billing 与 cli-node 缺失 billing 时的兜底头改为 `cc_entrypoint=sdk-cli`，与 2.1.303 抓包一致；调用方自带的 billing 不改写。出站 UA 已是 `(external, sdk-cli)`，`cc_turn_origin` 仍为 `sdk`。所有档位的出站 billing 字节随之变化，各会话首轮重建一次缓存。
- 请求日志的 `outbound_headers` 改为新 cli-node 在最终 fetch 前回传的脱敏请求头，新增采集来源；Node → worker 中间头另存 `worker_envelope_headers`。流式与非流式入站均支持，内部事件不发给客户端、不触发提交或上游 idle 计时；旧 CLI 未回传时明确显示未获取，旧日志不冒充最终值。需同时更新 Node、web 与新 cli-node；本轮尚未发布 payload 或部署。
- cli-node 补齐 `Accept: application/json, text/event-stream` 与 `Accept-Encoding: gzip, br`，在 CCH 密封后按最终 UTF-8 请求体写 `Content-Length`；修复旧 SDK 把毫秒 timeout 写入 `x-stainless-timeout` 的问题（缺省 `600000` → `600` 秒）。对应构建尚未进 payload。
- 缓存前缀兼容 oh-my-pi 的图片预算：omp 超出图片上限（未识别的 provider 未配 `imageCountBudget` 时为 5 张）后，每来一张新截图就丢弃最旧一张；最旧那张在长会话里位置很深，改动之后的历史全部失效，每张截图都整段重写。现在会话一旦观察到客户端丢图，网关按 omp 丢图后的同一形态（含 `(see attached image)` → `[image omitted: provider image limit]` 与报错结果的提升图说明）去掉水位以下的图片：超过 48 条消息的图片会把水位推到最近 24 条，客户端在水位以上丢图时跳过剩余图片的较旧一半，客户端此后的丢图都落在水位以下。客户端仍保留的图片中，最近 24 条消息内的与最新截图始终发出。水位按调用方会话（含 API key）记录，换号后仍然有效；水位以下的历史与上一轮不一致（压缩、回退、同长度替换）时清零。从不丢图的客户端出站不变。
- 历史改动后的缓存断点：读断点放在改动前最近一个确实写过且仍在 TTL 内的缓存位（只认已确认成功的请求写下的位置；未写 `ttl` 的断点按上游的 5 分钟计；重启后退回改动前最后一条 user）；写断点放在改动之后最旧一张仍发送的图片前面，下一次去图从这里只重写这张图之后的部分；下一轮显式读这个位置。不超过 4 个断点，尾部断点的 TTL 保留。上游缓存模型下（预算 5，截图每 1/3/8/20 轮一张，240 轮，缓存写入按 2 倍、未缓存输入按 1 倍计），总费用约为理想值的 2.0–2.6 倍；不在图片前写入时为 4.5–15 倍，仅客户端丢图时为 6–45 倍。`[cache-prefix]` 日志附 `anchored messages[N]`、`checkpoint messages[N]` 与图片水位。

- #703：调度状态统一为四态：调度开 / 调度关（仅操作员）/ 不可调度（确定性错误，只能人工开回）/ 受限（自动恢复）。调度、面板、日志共用一张归因表（`src/lib/pool/schedule-state.mjs`）。面板新增「不可调度」分组与原因，席位满、GPT 对话窗口满、临近闸线显示为「受限 · 仅新会话」。
- #703：不可调度只由操作员开回：调度开、导入凭证、改绑代理、「恢复服务」成功。后台凭证刷新、worker 有票、代理探活不再自动开回（`no_credential` 在凭证落盘后仍自动解除）。操作员调度开之后再出现的凭证失效照常出池。
- #703：组织禁用 OAuth（400/401/403 `organization disabled` / `OAuth authentication is currently not allowed`）：当前请求换号，该槽记为不可调度并保存上游原文，只能人工开回（并入 #664）。
- #703：kernel 升级排空、worker 重载、代理探活失败改为系统暂停（受限），不再写成调度关；移除设置「手动开关优先」（`manual_schedule_wins`）。
- #703：升级首次启动迁移 `vms/*.json` 到新字段，原文件备份到 `backups/schedule-migration-<ts>/`；旧字段保留可回滚。迁移前可用 `node scripts/replay-schedule-state.mjs --project <dir>` 预览。

## 1.3.226 — 2026-10-24

- 协议 / billing（#698）：调用方自带的 billing 不再改写 `cc_entrypoint`；网关生成或 cli-node 缺失 billing 时的补头仍为 `cc_entrypoint=sdk-cli`，并带上 `cc_turn_origin` 与轮次索引。文档明确 CCH 密封块属于 billing body、非 User-Agent；补充 crs-persona 与面板协议页回归测试。
- 出站身份对齐 2.1.303：中间 hop 与出站 UA 为 `(external, sdk-cli)`；官方身份预设、`official_303` 别名与「官方完整提示词」模板/首句对齐 2.1.303 样本；透传抓包到的 Claude 身份相关头。
- 各档位网关生成与 cli-node 兜底 billing 的 `cc_entrypoint` 由 `cli` 改回 `sdk-cli`（与 2.1.303 抓包一致）；出站 billing 字节随之变化，各会话首轮重建一次缓存。
- 请求日志：`outbound_headers` 改为 cli-node 在最终 fetch 前回传的脱敏请求头；Node → worker 中间头存入 `worker_envelope_headers`。流式与非流式入站均支持；旧 CLI 未回传时显示未获取，旧日志不冒充最终值。
- payload 钉住 `payload-2026.10.24-cli-303-sdk`，cli-node `cb2f8fb9`（27784880 字节）。新 cli-node 补齐 `Accept: application/json, text/event-stream` 与 `Accept-Encoding: gzip, br`，CCH 密封后按最终 UTF-8 请求体写 `Content-Length`；修复旧 SDK 把毫秒 timeout 写入 `x-stainless-timeout`（缺省 `600000` → `600` 秒）。

已部署机升级：须同时更新 Node 控制面与 `web/dist`，执行 `npm run fetch:payload` 换上 `payload-2026.10.24-cli-303-sdk` 后 `wrap-cli/sync`，再重启 Node；仅更新 Node 不够。勿对槽位做 sync/recreate 以外的破坏性操作。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.225 — 2026-10-24

- CI：PR 的 run 先合入 base 分支最新提交再测，Re-run 即对着当前 main（GitHub 的 `refs/pull/<n>/merge` 停在 PR 最后一次 push 时的 base）；`cancel-in-progress` 只对 PR 生效，main 每次 push 都留下结论。新增 `pr-rerun.yml`：main 的 ci 由红转绿时自动重跑最近一次 ci 失败的 open PR（非草稿、无冲突），也可手动触发。

已部署机升级：无运行时变化（仅 CI / 文档），可不升级。

## 1.3.224 — 2026-10-24

- API 直连原生 Anthropic Messages：端点上显式配置的头优先于调用方协议头；`anthropic-beta` 取端点与调用方的并集（未知 beta / safeguards 照常透传）；调用方带来的 `context-1m` 按模型页 1M 策略剥离或放行，端点自己配的不受影响。修复 #667 后 Claude Code 请求使端点 headers 配置失效、并绕过 1M 门禁的问题。

已部署机升级：仅更新 Node 控制面后重启（无 web、无 payload 变化）。不必 `fetch:payload` / `wrap-cli/sync` / recreate 槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.223 — 2026-10-24

- 以 v1.3.221 生产验证产物为基线：`deploy/payload.json` 改指 `payload-2026.10.23-v1.3.221`，并钉住 `kin-worker` / `kin-egress` / `kin-slot-gate`（与线上逐字节一致）。release.yml 与 amd64 镜像不再从源码编译这三个 helper；改 `worker/` 后须重新钉 payload 才会发出。ARM64 镜像与附件不变。
- CI 合并为单个 job：格式与语法、payload 校验、Node unit、Go vet/test、web；去掉 ARM64 冒烟、真链路 CCH e2e 与 ARM64 主机脚本测试。
- 删除 1.3.198–1.3.219 的 CLI CCH 历史热修 `scripts/fix-cli-cch.mjs` 及其测试与文档；钉住的 cli-node `944f6457` 已含该修复。
- 原生 Anthropic Messages 转发调用方协议头（含未知 anthropic-* beta / safeguards）；OpenAI 兼容路由不变。（#667）

已部署机升级：仅更新 Node 控制面后重启（#667 无 web；#696 payload 字节与 1.3.221 相同）。不必 `fetch:payload` / `wrap-cli/sync` / recreate 槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.222 — 2026-10-23

- 保留调用方自带 description+schema 的 web_search 族 function 工具，不再改写成原生服务端搜索；非搜索名工具不受影响。（#694）

已部署机升级：仅更新 Node 控制面与 `web/dist` 后重启；不必 `fetch:payload` / `wrap-cli/sync` / recreate 槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.221 — 2026-10-23

- 新增提示词档「官方 2.1.303（按模型）」`official_303`，手动选择，默认档仍是官方完整提示词。Opus 4.8 / 5 / 5.5、Fable、Mythos 等按 2.1.303 样本组装：system 为 billing、身份句、2.1.303 主提示词；调用方 system 放进第一条 user 的 `<system-reminder>`（官方调用方的 system 不出站，`<total_tokens>` 计数先抹平）；Environment 作为尾部 role=system，只替换 `# Environment` 段；断点为身份句、主提示词、最后一条 user，4 条消息起再加上一条 user（共 3–4 个），TTL 取面板缓存 TTL。Sonnet、Haiku、Opus 4.0–4.7 沿用现有 cli-hop 结构（含 1.3.218 的两个 user 断点），只把版本号换成 2.1.303。
- 「官方提示词」模板的身份块与「0注入」billing 里的 `prompt_version=<…>` 改为交互 CLI 身份句 `You are Claude Code, Anthropic's official CLI for Claude.`；已保存的自定义模板不变。
- 网关生成的 billing 与 cli-node 兜底 billing 的 `cc_entrypoint` 固定为 `cli`（原 `sdk-cli`），出站 UA 也锁为 `(external, cli)`；`cc_turn_origin` 不变。所有档位的出站 billing 字节随之变化，各会话首轮重建一次缓存。
- 选 303 档的槽位 UA、billing `cc_version` 与 CCH 输入为 2.1.303，按 job 热读 kernel.json，不重启槽位；其余四档仍为 2.1.296。
- 设置 → 协议新增只读「当前出站参照」：按已保存的全局档位列出提示词档、CLI 版本、UA、billing `cc_version` 与 OAuth beta 样例（`GET /api/panel/outbound-profile`）。协议页保存逻辑不变。
- 新增 `scripts/outbound-shape.mjs`（出站 body 归约成脱敏结构，与 2.1.303 骨架逐项对照；`--wire` 校验 CLI 最终字节）与 `scripts/outbound-replay.mjs`（私有 fixture 经真实 kernel + cli-node 链路回放并判定）。
- 控制面的出站参照 UA 同步为 `cli`，Node → worker 的 envelope 日志不冒充 CLI 最终请求头。
- payload 改钉 cli-node `944f6457`（附件 `cli-node-303-944f6457`）：在 1.3.220 的 CCH system-only 修复上加 profile 模式（`official_303`）并锁 `cc_entrypoint=cli`。
- 仓库自带的 `src/config/routing.json` 默认请求日志模式由 `debug` 改为 `normal`（普通）；Debug 需在 设置 → 日志 手动切换，或用 `KIN_REQUEST_LOG_MODE=debug` / 单请求 `X-Kin-Debug: 1`。已部署机的 `routing.json` 不被覆盖，现有档位保持不变。

已部署机升级：需要同时更新 Node 控制面、`web/dist` 与 cli-node（`npm run fetch:payload` 换上 `944f6457` 后 `wrap-cli/sync`；新 cli-node 已含 1.3.220 的 CCH 修复，不必再跑 `fix-cli-cch`；除 billing 外，不选 303 档时出站结构与 `b5054cb8` 一致）。槽内已是 `944f6457` 的机器 `SLOT_SYNC=skip`。**新 cli-node 上线前不要选 303 档**：旧 cli-node 会把 `kin_outbound_shape` 当调用方字段转发，上游 400。回滚到旧版本后，旧面板不接受 `official_303`，需在 system提示词页重新选档再保存。OMP 工具图片尾置仍未恢复，另行处理。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.220 — 2026-10-23

- cch：Node 与原生 CLI 只投影/赋值首个 canonical system billing block，不再误把 messages 或后续 system 中的 billing 示例当作真实计费头改写历史；manifest 钉住已在线验证的 cli-node；提供 `scripts/fix-cli-cch.mjs` 热修 1.3.198–1.3.219 四种历史 CLI payload。（#692）

已部署机升级：须 `npm run fetch:payload`（或等价方式）换上新 cli-node；已在 1.3.198–1.3.219 部署的机器须显式执行 `fix-cli-cch`；勿做集群 sync、勿 recreate 槽位。**仅更新 Node 控制面不够**。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.219 — 2026-10-23

- `kin-guest-exec`：修正 `if ! run_ssh` 在 POSIX 下吞掉真实退出码的问题；来宾非零退出、ssh 255、timeout 124 不再误报为 0，控制面不再把来宾崩溃误判为 `worker_output_invalid`。（#680）
- **KVM 运行器**：需同步重建/部署 `docker/kin-kvm` 镜像（或等价方式更新 runner 内 `kin-guest-exec` 脚本）后，线上槽位才会生效。

已部署机升级：须重建并同步部署 **kin-kvm** 镜像（或等价更新 runner 内 `kin-guest-exec`）；**仅更新 Node 控制面与 `web/dist` 不够**。更新后重启相关服务。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.218 — 2026-10-23

- 版本号对齐线上。官方 Claude Code / Codex 透传（原 #674、#676）已从 1.3.212 起的历史中移除：透传上线后缓存读命中锁在 system+tools 前缀（约 39.7K），messages 每轮新建缓存。cli-hop 重写与 kernel persona 恢复 1.3.209 行为。
- cli-hop 出站 message 缓存断点恢复为两个：最后一条 user 与上一条 user（4 条消息起）。只打尾部一个点时，上一轮写入接不上就只能靠上游 20 位置回溯，越界后读命中锁在 system+tools 前缀（约 39.7K），messages 每轮整段重写。system 两点不变，总数 4 点。

已部署机升级：更新 Node 控制面与 `web/dist` 后重启一次。不必 `wrap-cli/sync`、不必 `fetch:payload`、不必重建槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.217 — 2026-10-23

- 新增 `POST /v1/images/generations`、`/v1/images/edits`（edits 支持 multipart）：经槽位直连 Codex Images 接口，与 `/v1/alpha/search` 同一做法，不经内核；Free 槽不接生图，`x-codex-image-turn-id` 固定同一轮编辑的槽，槽位按密钥属主过滤。（#685）
- 图像模型 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` 可在面板分别启停；停用后 Images 请求与 Responses `image_generation` 工具在本地 400，启用的列入 `/v1/models`。（#685）
- 生图单独计价：迁移 `042` 给 `usage_logs` 加 `image_*` 列，`image_cost` 计入总费用；用量拆分不自洽时整行未定价。（#685）
- OpenAI 模型页：`codex.model_mappings` 可增删改（`codex-auto-review` 置顶，目标限已启用 GPT 对话模型，拒绝 `claude-*` 别名）；「同步 GPT」保存上下文窗口、推理与服务档位；去掉 Thinking / budget / 1M beta / cache TTL 等 Claude 专有控件。（#685）

已部署机升级：更新 Node 控制面与 `web/dist` 后重启一次，启动时自动执行迁移 `042`（只加列）。无新依赖，不必 `wrap-cli/sync`、不必 `fetch:payload`、不必重建槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.216 — 2026-10-22

- GPT（Codex）槽调度按密钥属主收窄，与 Claude 池一致：租户密钥不再落到平台或其他租户的 GPT 槽，平台密钥也不进租户 GPT 槽。
- API 直连（category=`api`）仅管理员：租户不能在面板创建或把密钥改为 `api`；推理入口在 api-kernel hop 拒绝租户已有 `api` 密钥（`api_backend_forbidden` / 403）。
- 删除 VM/槽位仅管理员：租户不能删除自建槽；面板删槽按钮对租户隐藏。
- **破坏性**：租户若仍持有 category=`api` 的密钥，调用平台 API 上游将收到 403；租户不能再自行删除槽位，需联系管理员。
- `/v1/usage` 在 Codex 路径上读取用量窗口（与 Messages 属主解析一致）。

## 1.3.215 — 2026-10-22

- `/v1/usage` 与 `/v1/messages/count_tokens` 传入 `apiKeyStore`，与 Messages 一致解析密钥属主角色；面板会话无 `apiKeyRecord` 时按会话角色收窄作用域（admin/super → 平台池，user → 仅本人 VM），避免租户 peek 平台账号用量或 admin 托管密钥误报 503。（#658，#677）
- 管理端 `enrichVm` 输出 `owner_user_id`、`origin`，租户自建槽位不再显示「平台池（未分配）」；槽位重建 `buildRecreatedVmRecord` 保留 `origin`，避免租户自建槽被误判为 `admin_assigned` 并影响配额与删租户回收。（#677）

已部署机升级：更新 Node 控制面与 `web/dist` 后重启一次。无迁移、无新依赖，不必 `wrap-cli/sync`、不必 `fetch:payload`、不必重建槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.214 — 2026-10-22

- OpenAI Responses 上游：生命周期元数据（`response.created` / `queued` / `in_progress` / `metadata` / `keepalive`）在首条真实模型输出前不 commit attempt；仅 metadata 或 `overload` / `slow_down` 等早退失败时保持 `committed: false`，failover 仍可重试。（#645）

已部署机升级：更新 Node 控制面与 `web/dist` 后重启一次。无迁移、无新依赖，不必 `wrap-cli/sync`、不必 `fetch:payload`、不必重建槽。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.213 — 2026-10-22

- 版本号保留；原官方透传修正（#676）已从历史移除，本版无运行时变化。

## 1.3.212 — 2026-10-22

- 版本号保留；原官方透传（#674）已从历史移除，本版无运行时变化。

## 1.3.211 — 2026-10-22

- 单测对齐 cli-hop 缓存标记已写入的会话 TTL（默认 `1h`，请求带 `5m` 则为 `5m`），以及 OAuth persona 三块 system（billing / identity / persona）；修正 `officialMessageMarker` 过时注释。纯测试修复，无运行时行为变化。（#675）

## 1.3.210 — 2026-10-22

- 槽位「采集特征」和终端「系统特征」不再读到宿主机：Docker 槽的 CPU 型号、DMI、MAC 读槽位计算机（`/etc/kin-hardware`、`/etc/kin-dmi`），核数与内存读容器 cgroup 配额；没有配额时读计算机文件，都没有才回落 `/proc`、`/sys`。KVM 槽不变。（#673）
- `kin-computer` 默认造 Linux PC 计算机（Docker 槽原为 macOS 人设），`--os` 可选 `windows` / `macos`，KVM 支持 linux / windows。payload 改指 `payload-2026.10.22-computer-linux`，只换 `kin-computer`。已有槽位身份不重算。（#673）
- 一键升级与 fleet `action=telemetry` 刷新 Go 槽位服务时，数据库仍登记但本机已无 Docker 容器（`No such container: kin-NN`）的 VM 记为跳过并继续处理其余槽位，不再因此整批失败；真实容器上的刷新失败仍会硬失败。（#642，#628，REQ-0628）
- KVM 面板终端与官方登录终端显式设置 HOME=/home/kincli、CLAUDE_CONFIG_DIR 与工作目录，避免继承 root SSH 的 HOME 导致 mkdir /root/.claude 失败；Docker 槽行为不变。（#656）
- 导入页以 start:false 建空槽后，打开官方登录终端前会先启动已绑定出口的槽位；已运行直接开终端，无出口拒绝，失败可重试。（#650，#657）
- 池调度：异步 worker 健康探测返回后重新读取 `Date.now()` 再判 cooldown 与凭证门禁，避免探测期间已过期的 cooldown 被重新入队且错过唤醒通知。（#671）
- JEV 语义审核：`jevModelDocument` 保留 system / user 消息与 input 的来源标签（如 `user message N`），同来源+正文才去重，assistant / tool 不参与，避免历史引用被当成当前提问。（#671）

已部署机升级：更新 Node 控制面与 `web/dist`，执行 `npm run fetch:payload`（或更新控制面镜像）换上新 `bin/kin-computer`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`，不必重建槽位容器；已有槽位计算机身份不变。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.209 — 2026-10-22

- 遥测 `event_data.env` 不再附带客户机硬件（`cpu_model`、`cpu_cores`、`memory_bytes`、`root_disk`、`mac`、`dmi_*` 共 11 项），与官方 Claude Code 2.1.296 的 env 字段一致；`worker.json` 的 identity 也不再写这些键。新 `kin-worker` 发送前会剔除旧 `worker.json` 里残留的同名键。槽位运维页「物理特征」照旧读取和展示。（#646）
- 面板窄屏修复：设置 → 关于的 changelog 里长键名、路径可任意处折行，手机上不再把整页撑宽；设置页左侧分栏导航改按内容区宽度切换（`@2xl/content`），平板竖屏（768）不再把正文挤到约 270px 导致协议 / 遥测 / 通知页横向溢出；Anthropic 控制台地址行同样按内容区宽度横排，「测试 / 保存 / 删除」收进同一格，宽屏下「删除」不再单独掉到下一行。（#662）
- debug 请求日志的 `outbound_body` / `outbound_headers` 改为在传输层 `finalizeWorkerPayload` 之后、真正 POST 给槽位 worker 的 envelope 上取值；从未发出则为 null。不改出站内容、不改推理路径。（#669）

已部署机升级：更新 Node 控制面、`web/dist` 与 `bin/kin-worker`，重启一次 Node。无迁移、无新依赖。`worker.json` 重写（播种、换票、fleet `action=telemetry`）或换上新 `kin-worker`，两者任一发生后就不再上传硬件键；集群槽在下次启动、重载或出口重建时推送。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.208 — 2026-10-21

- 回退 1.3.208 的请求体重组与缓存断点改动，保持 1.3.207 的 thinking、system 和消息结构；仅在 cli-node 最终 hop 补回缺失的 `x-anthropic-billing-header`。

## 1.3.207 — 2026-10-21

- 设置导航里 OpenAI 只留一个入口（调度组）。去掉「白名单」页和 `persona_rules` 整套：网关不再按末轮 user 正则追加防泄漏 / 身份 / 无工具提示，park 与 overlay 只带 `persona_standing`，overlay 模板去掉 `{{rules}}`。保存协议时 `routing.json` 里的 `persona_rules`、`persona_leak_append` 一并删除。
- 设置 → 遥测重做：槽位分布条、每槽实时旁路状态（运行中的槽每 20 秒探测）、按槽开关，旁路重启失败单独提示；展开可看上传时间线（批次、GrowthBook、失败）和脱敏原始记录。「上传中」要求 `worker.json` 遥测生效且进程在跑；种子开但没有官方身份显示「开 · 无官方身份」，集群槽注明。全开 / 全关先确认并逐槽显示进度，GPT 槽不参与批量写入。附播种写入键对照、上传链路说明，以及「换票后同步遥测」「Codex analytics」的当前值和跳转。
- 遥测上传间隔可调：`routing.telemetry.upload_interval_seconds`，整分钟、1 分钟到 24 小时，默认 10 分钟（原固定 10 秒）。设置 → 遥测可按分钟或小时设置，保存后重写各 Claude 槽 `worker.json`，旁路热重载，不重启；集群槽改为排队推送到节点。GrowthBook 仍是 6 小时，10 分钟会话窗口不变。
- 遥测旁路读官方身份时不再要求 `machineID`。当前 CLI 初装只写 `userID`，这类槽原先一直卡在 `waiting_official_identity`，不上传也没有记录。`.claude.json` 都缺失时，改从槽记录的 `fingerprint.official_user_id` 取身份。GPT 槽不写 Claude 遥测身份。

已部署机升级：更新 Node 控制面、`web/dist` 与 `bin/kin-worker`，重启一次 Node。无迁移、无新依赖，不必 `wrap-cli/sync`。上传间隔要新的 `kin-worker` 才生效：本机槽需重启遥测旁路（fleet `action=telemetry`）；集群槽在下次槽位启动、重载或出口重建时推送新的 `kin-worker`。旧旁路忽略该设置，仍每 10 秒上传。卡在 `waiting_official_identity` 的本机槽，播种或保存一次种子后 `worker.json` 会写入身份。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.206 — 2026-10-21

- 官方登录终端把授权链接显式提取出来，跨终端帧也不会漏。复制链接、打开授权页和回填授权码与普通 OAuth 相同。
- VM 页 OAuth 方式顺序为 Claude Code、授权链接、Cookie。设置里的「同步遥测」按默认关闭显示。

## 1.3.205 — 2026-10-21

- cli-hop 出站的缓存标记写上请求解析出的 TTL。原来只有 `{type: ephemeral}`，上游按 5 分钟过期，间隔超过 5 分钟的下一轮整段重写。默认 `1h`，显式 `5m` 保持 `5m`。

## 1.3.204 — 2026-10-21

- 官方 OAuth 的 Claude Code 终端启动真实 `claude`，不再执行 `claude auth login`。初次进入按两次回车拿到授权链接；按 c 经 OSC 52 复制到浏览器剪贴板，授权码粘回终端。授权写入既有 `credentials.json`，`.credentials.json` 仍是它的链接，不另存一份。
- cli-hop 以本地最终形态覆盖 1.3.203 合入的两段样板：官方家族保留入站 system 与省略的 TTL，调用方 system 不再被收成 identity + 正文。缓存标记只打最新 user 的文本，thinking 尾不打；eager_input_streaming 和工具 cache_control 仍去掉，避免 CLI 回填省略的 TTL。
- 缓存断点按字段差记录，不再把 structure 当成块形变化。tools 差异不挡住消息断点，嵌套计数器单独标出；截断采样里混有未采样的正文变更时，不再标成仅计数器。

## 1.3.203 — 2026-10-21

- 实验性 macOS 原生节点（Apple Silicon，#585）：节点连上后按 `uname -s` 记录平台（迁移 040 `cluster_nodes.platform`）；macOS 节点不用 Docker，每个槽是 SSH 用户 `gui/<uid>` 域里的两个 launchd 服务（kernel、telemetry），plist、日志、套接字都在 `~/.vm2api/vms/<id>/`，kernel.json 写节点真实路径。产物取自 `payload/darwin-arm64/`（`KIN_DARWIN_PAYLOAD_DIR`），按内容哈希上传到 `~/.vm2api/native/<digest>/`；kin-kernel / cli-node / cc-node 需另行提供 darwin/arm64 构建。预检检查 arm64、图形登录、目录、套接字长度、产物与休眠；看门狗与 supervisor 经 `launchctl` 观察、重启、补加载。首版只支持 Claude 槽与节点本机出口，终端、槽内登录、直连通道、内存在线调整返回 `native_node_unsupported`。见 `docs/MACOS_NODE.md`。
- 集群节点 SSH 断开（离线、休眠、重启）期间，调度器跳过该节点上的槽位（`node_offline`），重连后自动恢复。
- 远端读文件在 BSD 工具链（macOS 节点）上改为先拒绝符号链接与非普通文件再读取；GNU 节点仍用 `dd iflag=nofollow`。
- 面板 Claude 用量：`utilization_*` 超过 1（如 header 1.04）按 ratio×100 显示，不再误成约 1%；Codex `used_percent` 路径不变。（#625，#631）
- 自动/手动备份流水线改到 worker 线程执行（VACUUM INTO + tar），避免主线程长时间阻塞网关导致 Cloudflare 524。（#638，#639）
- cli-hop 出站收成官方两段 system（identity + 调用方正文，ephemeral 无 TTL）、缓存标记打最新 user、去掉 eager_input_streaming/工具 cache_control/temperature/context_management，thinking display 默认 summarized 等。（#641）1.3.204 起官方家族改回保留入站 system。
- 设置 → 遥测新增日志总开关和保存时间（默认 24 小时，1–168）。这是各槽上传日志的唯一启动源：关闭不写、不显示；打开后槽位运维页直接显示该槽保留窗口内已有记录。sidecar 按同一窗口裁 `telemetry-upload.log`。
- 槽内 cli-node 进入 native loop 前丢掉 `settings.json` 里安全名单以外的 env（如 `LD_PRELOAD`）。cli-node 2.1.296 UPX，sha256 `b5054cb8494670354e61f3e0a0f7b2c3b768832c841140a4e22407fec24ab009`。
- 授权页默认 OAuth。顺序为 Claude Code、Cookie、授权链接；Setup Token 为授权链接、Cookie。去掉 Console 导入。
- 入站 device 迁移改为 `041_usage_logs_inbound_device`，避开 macOS 节点占用的 040。

## 1.3.202 — 2026-10-20

- 官方凭证只保留一份 refresh token：`.credentials.json` 里较新的授权先并入宿主 `credentials.json`，再把官方文件名链回去。进行中的槽内 `claude auth login` 不再拿旧 refresh token 去换票，避免新授权被判 revoked。
- cli-node 2.1.296 在 `CLAUDE_CODE_HOST_REFRESH=1` 时读写宿主 `credentials.json`，logout 不删除该文件。仍有效的 access 不再因为残留 `oauth_revoked` 被钉成无效凭证。
- 集群槽官方登录：票据与 WebSocket 升级走 Engine API 异步检查容器与 cli-node；登录终端开前把控制面空凭证与 `.credentials.json` 链接推到节点 `claude/` 挂载，粘贴完成后从节点拉回 OAuth 再 `adoptShellLogin` 入账，避免只读本地空文件。（#630）
- 面板租户（role=user）权限收紧：导入凭证、导入代理时绑定槽位、API Key 的 `allowed_vms` 只认本人的槽（他人的与不存在的同样回 404）；租户改 Key 时忽略 `user_id`、`group_id`，`vm_pool_id` 仅管理员可设（非管理员带值回 403 `key_pool_forbidden`，前端隐藏账号池）；改角色或停用用户时撤销其全部面板会话；`GET /api/panel/test-models` 对租户与 super 只读放行，带他人 `vm_id` 回 404，`refresh=1` 仅管理员生效。
- Docker 槽在线扩容：面板成功须 HostConfig 内存与 swap 一致；可读 cgroup 时核对 v2 `memory.max` 或 v1 `memory.limit_in_bytes`（`max`/无上限哨兵在 HostConfig 已匹配时跳过）。扩容后校验失败会 docker update 回滚至扩容前限额且不写 vm 配置。（#623，REQ-0441）
- 集群槽 prepareRemoteDir：程序目录 slot-bin 改为 0755（私有 run/claude/cli-home 仍 0700），使 CapDrop ALL 的 egress 能 traverse /opt/kin-live，避免迁 live 后容器停在 Created / permission denied。（#632）

已部署机升级：更新 Node 控制面后重启一次。cli-node 字节已变，需要 `wrap-cli/sync`（逐槽重启 dataplane，不要 `docker rm`）。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.201 — 2026-10-20

- 消息线程 beta 在控制面按消息 id 记住 24 小时（最多 1 万条）：同模型的 `continue` 补回上一轮 beta，并保留本轮新算出的；换模型、过期或未知 id 用现算值，不失败。create 轮对支持的模型仅凭 `thread` 带上 `mid-conversation-output-config`，continue 不再回放 effort 控件也能带上该门。命中 / 未命中 / 换模型记在 `hop_meta.thread_betas`。进程重启后 pin 丢失，按未命中处理。（#621）
- Docker 在线扩容只在容器运行中、且 `HostConfig.Memory`、`HostConfig.MemorySwap` 与容器内 cgroup `memory.max` 三者都等于请求字节时写入 `vm.machine.memory`。停着的容器在 `docker update` 前拒绝；不一致返回 502 且不改配置。校验失败不回滚已经执行的 `docker update`，容器限额可能已经是新值。cgroup v2 读到 `max` 视为不一致。（#621）
- 官方 Claude Code 登录（`cc`）在已有授权链接之前打开槽终端，避免链接面板盖住「打开官方登录终端」。（#621，#622）
- Responses WebSocket：入站 `response.interrupt`（Codex steer）本地中止在飞 hop 并回 `response.interrupt.accepted`；取消走既有 handleProtocol 终态记账，不再报 `unsupported Responses WebSocket message type` 或网关 `incomplete_response`。上游 interrupt 转发对齐 CPR 后置。（#616）
- Fable `7d_oi`：reset 已过（含秒级时间戳）不再永久判 rejected；`fableWindowResetAt` / weekly split 用 `parseResetMs`；过期清理纳入 `unified['7d_oi']`，且 `elapsedExtraResetMs` 纳入 `7d_oi` 后会在窗口过期时触发 usage probe；无 reset 时仍按 rejected 处理。（#601）
- OpenAI 槽：从 OAuth `id_token` 读取 `chatgpt_subscription_active_until`（含 epoch 秒/毫秒归一化为 ISO），刷新时新 token 带 claim 则覆盖到期日、不带则保留旧值；账号页只读展示「订阅到期（以凭证为准）」，缺失显示「—」。`plan_type` 缺失时用 id_token 的 `chatgpt_plan_type` 兜底展示；wham 写入的套餐类型优先。（#609）

已部署机升级：更新 Node 控制面与 `web/dist` 后重启。不必更换 kernel / CLI，不必重建槽。已有 Docker 槽的内存限额不会因本次升级自动改变。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

## 1.3.200 — 2026-10-20

- 官方 OAuth（claude_code）：在已运行槽终端里执行 `claude auth login`，面板弹出槽终端、授权链接在终端复制、授权码由用户粘贴；宿主机不再自造 authorize URL。Cookie 导入与 Setup Token 路径不变。（#615）
- 槽位种子页默认锁定：需确认解锁后才能改配置，播种前再次确认；时区/语言提供 en、cn、jp 基础选项。时区跟随当前 SOCKS5（空/非手动钉住）时展示出口时区，播种经 `timezone_follow_proxy` 写入；可改固定 IANA 时区或改回跟随。TZ/LANG/LC_ALL 仍不经 `extra_env` 覆盖契约键。（#613）
- 槽位种子页：`settings.json` 的 env 行与 `theme` 可直接编辑并随播种写入；`autoUpdates`、`grove_enabled` 只读且播种时固定为 `false`；TZ/LANG/LC_ALL、遥测 kill-switch、Bedrock/Vertex、gateway hint 等同理只读（播种由契约重写）。缺 `CLAUDE_CODE_ATTRIBUTION_HEADER` 时默认 `0`。调试上传默认关，独立 query 拉最近 40 条上传，切换开关不重置未保存编辑；Go sidecar 写 `vms/<id>/run/telemetry-upload.log`，面板 `GET seed-settings?debug=1` 返回 `telemetry_log`。（#611）
- 协议页可配置 `routing.compatibility.auto_compact_window`（100K–1M 或跟随模型）；入站在清理 settings 前提取调用方 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`，经内部 `auto_compact_window` 字段进入当前 job，清理后的 body 不再携带该 env。（#607）
- 槽位种子页按当前槽 `settings.json` 列出真实配置；`claude.setting` 可编辑播种；缺失文件返回 `null`、空文件返回空串，不用策略默认冒充槽内文件；遥测开关与 sidecar 进程状态分开展示，保存不因遥测进程刷新失败而 502。（#608）
- 集群槽 legacy kin-worker / kin-egress 容器可一次性迁到持久化 `/opt/kin-live` 挂载：旧容器重命名为 `*-legacy-<timestamp>` 保留作回滚，替换容器复用原镜像与网络身份；rename 后先从 user-defined 网 disconnect 释放 IP/别名再 create；KVM 已挂 `/opt/kin-guest/opt/kin-live` 不再误判 legacy；`scripts/migrate-legacy-cluster-slots.mjs` 与 fleet `action=telemetry` 同路径；迁移时保留 CapDrop/CapAdd 等 HostConfig，避免 canReuse 后 egress 权限缩水。（#605）
- fleet 遥测刷新在 kin-egress 二进制被替换（含 `(deleted)` 旧进程与脏 pidfile）时，会按 egress 配置扫停全部 helper、等待 `/proc/<pid>` 消失后再绑定新二进制；同一 SOCKS 出口的 stop/start 与 `ensureProxyEgress` 共用 per-proxy 锁，避免并发 telemetry 互相 SIGTERM。（#604）
- 扩展节点直连通道：`PUT /api/panel/cluster/nodes/:id/direct-link` 在节点上建 `kin-slot-gate`（TLS 1.3，首次启动自签证书，控制面经 SSH 读取并固定指纹；每节点随机令牌），远程槽 kernel / worker 请求改为每次一条直连 TLS 连接，不再全部挤在一条 SSH 长连接里（长连接在零碎流量下拥塞窗口会卡在约 17KB/s，突发请求正文排队数秒）。请求正文随握手后的第一包发出、不等应答。gate 只连槽的两个 socket 且不跟随符号链接；连不上、证书不符或令牌被拒时该节点退回 SSH 30 秒。面板节点详情可启用 / 关闭，节点行显示「直连」/「直连→SSH」。新增 Go 命令 `kin-slot-gate`（`npm run build:gate`，Release 附件同名）。（#614）
- 面板：侧栏「GitHub / 文档」两枚链接不再折行，字体偏宽时「文档」不会逐字竖排，空间不够先缩箭头再省略文字；VM 列表搜索框关闭浏览器自动填充，不再被回填成登录邮箱。（#602）
- 集群页「扩展节点」新增 CPU / 内存 / 容器三列：健康检查（每 30 秒）经同一条 SSH 连接读节点 `/proc` 和 cgroup，口径同本机宿主列；容器 = 节点上全部 Docker 容器内存合计（扣除 inactive_file，同 `docker stats`）。修复本机宿主列 CPU 最高只显示 10%（`Math.min(100, …×1000)/10` 写错上限）。链路列不再折行。（#603）
- 集群槽无需重建 VM 即可更新 Go 槽位服务（kin-worker / kin-egress）：持久化 `slot-bin` 挂载推送二进制，fleet `action=telemetry` 热更新遥测与 egress。（#600）
- Codex 入站在平台探测前支持 CPR 式 `routing.codex.model_mappings` 精确模型映射；默认 `codex-auto-review` → `gpt-6-luna`（清空该键时回退 `gpt-6.1-sol`）。日志保留 `requested_model` / `upstream_model`；非法或非 GPT 目标 400，不 hop Anthropic。（#598，#526）
- 保留路径不再给没有可用签名的 thinking 补 `signature: ""`：缺失、空、短于 24、dummy 的删掉；签名可用的留，空正文也留。这一支里的 `redacted_thinking` 不看 data 和签名，原样留；不走保留路径时仍按原规则删。5.5 的非保留路径仍接受短的非 dummy 签名。没有按账号归属过滤签名。（#592）
- 协议页新增「thinking 显示」，`routing.compatibility.thinking_display` 默认 `summarized`。调用方打开 thinking 却要求隐藏（`omitted`、`updates`，或默认隐藏的模型上没写 display）时，出站改成 `summarized`；显式 `passthrough` 保留调用方的值。已保存的 `routing.json` 不写这个键也按 summarized 生效。（#592）
- Claude kernel / CLI 依赖固定到不可变快照 `payload-2026.10.19-kernel-cli`（kin-kernel + cli-node）；Codex kernel 与其余原生产物保持不变。（#594，#597）
- 安全：web 依赖 `source-map-js` 固定 1.2.2（CVE-2026-93749）。（#599）

已部署机升级：更新 Node 控制面与 `web/dist` 后重启；数据库迁移 `039_cluster_node_direct_links` 启动时自动执行。Claude kernel / cli-node 改为快照 `payload-2026.10.19-kernel-cli`，需一键更新或 `wrap-cli/sync`（keep）刷新（#594）。集群槽：#600 槽布局 2→3（`kin.vm.layout=3`），旧布局槽需 recreate 一次才挂上 `slot-bin`，或用 `scripts/migrate-legacy-cluster-slots.mjs` 或 fleet `action=telemetry` 迁到 `/opt/kin-live`，**容器 ID 会变**，旧容器保留为 `*-legacy-<timestamp>` 作回滚（#605）。扩展节点直连为可选：控制面 `bin/` 需放入新附件 `kin-slot-gate`（控制面经 SSH 下发到节点），面板节点详情启用并放行防火墙端口，默认仍走 SSH（#614）。`thinking_display` 默认 `summarized`（#592）；官方 OAuth 改为槽终端内 `claude auth login`（#615）；可配 `auto_compact_window`（#607）。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

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

- Opus / Sonnet / Haiku 5.5 的出站过滤：历史里出现一块无效 thinking，整段 thinking 与 `redacted_thinking` 都拆掉，只留正文；拆完没有内容的轮删掉。没有 `type` 但带 `thinking` 字段的块也算无效。`redacted_thinking` 有 `data` 就留，否则看签名；非空且非 dummy 的签名不再按 24 字符丢弃。全部有效时不拆。cli-hop 首跳和默认 HTTP 保留路径不变。更早型号仍逐块过滤，`redacted_thinking` 只在签名达到 24 字符时留。

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
- 「仅允许 Claude Code 家族请求」改严：只认 UA 已不够，直连须同时带 Claude Code 的整组请求头（`x-app: cli`、`anthropic-beta` 含 `claude-code-20250219`、Stainless SDK 头、`x-claude-code-session-id`），Messages 还要官方 system + user_id、会话头与 user_id 会话一致、计费块版本与 UA 一致。count_tokens 只验请求头。CLI 自身的 quota 探测只放行固定原样（`max_tokens: 1`、无 system/tools、单条 user 文本 `quota`、会话头与 user_id 一致）；其他 `max_tokens: 1` 的请求按普通请求判，因为输出下限会把它抬成真实补全。健康探测形状（含账号连通性测试）一律 403，不再由探测缓存回答。中转流量跟随「识别中转来的官方 Claude Code」。面板测试对话和内部健康探测（master key 钉槽）不受影响。
- 蒸馏默认规则不再把 `Respond in the following format: &lt;think&gt;` 当模板。中转用 `Go-http-client` 转发时带这句正常系统提示，`skip_official` 对不上，之前整段 403 `不允许蒸馏`。已保存的规则加载时也会丢掉这句，和裸 `&lt;think&gt;` 一样。收割针、指纹和「提取思维链」这类规则不变。
- 「识别中转来的官方 Claude Code」加强：系统里有官方计费块（`x-anthropic-billing-header` 和 `cc_entrypoint`，且不是 oh-my-pi）就按官方处理，不再同时要求 `user_id`。有的中转用 `Go-http-client` 转发时留着计费块、丢掉 metadata，之前不算官方，蒸馏和其他官方绕过都没走。没有计费块的中转仍要客户端 beta、官方 system 和合法 user_id。`local-agent` 仍不算官方。

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

- 控制台入口（`/cc`、`/console`）改为公开欢迎页 `#/welcome`：介绍、能力、三步快速开始和 Claude Code / Codex / curl 接入片段，配色只作用于欢迎页和登录页，控制台主题不变。登录改为独立页面 `#/login`，右上角「登录」进入；`/cc#/login`、`/console/#/login` 旧地址照常可用，未登录打开受保护页面会带 `redirect` 到登录页，登录后回原页面。
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

- 设置 → 协议新增「仅允许 Claude Code 家族请求」（`routing.compatibility.claude_code_only`，默认关）。开启后，Claude 模型的请求只放行官方 Claude Code：识别与人设/拦截路径共用 `isOfficialClaudeCodeTraffic`，「识别中转来的官方 Claude Code」开启时也放行被中转的官方流量；放行带官方 `claude-cli` UA 的 `max_tokens=1` 探测与 `count_tokens` 请求。其余（第三方客户端、`/v1/chat/completions` 等 OpenAI 格式入口调 Claude）在选号前返回 403 `claude_code_only`，`count_tokens` 同样拦截。GPT 模型与 Codex 搜索不受影响。该错误归「请求格式」，不计 SLA 失败；非布尔值 PUT 400。
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

- 预热拦截规则：haiku `max_tokens=1` 探测需 `claude-cli` UA；messages/system 必须是 `{type,text}` 数组，含字符串 content 的请求不拦截；命中后直接返回模拟响应，支持流式和非流式。
- 额外一条保护：带 tools 的请求一律不拦截，避免长对话里提到 `Warmup` 或标题生成句被误回 "New Conversation"。

已部署机升级：覆盖控制面并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。不要覆盖 live `routing.json`。

## 1.3.71 — 2026-09-28

- 修复预热拦截误伤正常对话：旧逻辑扫描整段历史，长会话里只要出现过 `Warmup` 或标题生成句就被回 "New Conversation"。现在只拦截无 tools、至多两条消息的旁路请求，且只看最新一条 user。
- 预热拦截与健康缓存改为默认开启（设置 → 探测可关）。

已部署机升级：覆盖控制面并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。live `routing.json` 里已显式写成关的开关保持关，需要在面板打开。

## 1.3.70 — 2026-09-28

- 探测/测试请求不再占主会话席位：单条短 user、无 tools 的一次性请求（如账号连通性测试、渠道测试、验证脚本）跳过 session seat，只占并发。粘性身份不变。
- 新增「拦截预热请求」全局开关（设置 → 探测，默认关）：仅 Claude 模型 `/v1/messages`，Claude Code 的 Warmup、标题生成、SUGGESTION MODE、haiku `max_tokens=1` 连通性检查在选号前直接返回模拟响应。流式 haiku 探测与非流式一致返回 `#` / `max_tokens`。
- 新增 `max_tokens` 下限（默认开，128，可关、可改）：所有 Claude 出站路径（含 chat/responses 转换）生效；开启 thinking 时保证 `max_tokens` 大于 `budget_tokens`。cli-hop 原有 ≤64→1024 保留。
- 健康缓存识别不带 `max_tokens` 的 Chat / Responses 测试和账号连通性测试载荷；Claude 与 GPT 分开快照（GPT 探测模型留空则不缓存 GPT）；Chat 流式末块带 usage 与 `[DONE]`，Responses 流式补 `response.created` / `response.completed`。
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

- 额度用尽现在会挡住调度。kernel cli-hop 先回 200 再流出 `event: error`，也会把额度用尽包成 502 `provider_error`。传输层按报错内容还原成 429 / 529 / 401，不再落进 `http_200` 直接停止。
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

- 加强经中继转发的官方 Claude Code 识别。有的中继会把 billing 头剥掉，只留下 `anthropic-beta: claude-code-20250219`、官方 `user_id` 和官方 system 正文。通过 `Go-http-client` 转发、具备这些特征的请求现在也算官方流量：不注入 persona、不改 system 前缀。只有身份那一行、没有这个 beta 的第三方请求仍然不认。

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

- cli-hop 默认不再改写 messages 上的 `cache_control`，system 断点也保留。只给最后一个非延迟工具补 5m 断点
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

- `deploy/install.sh`：安装 / 更新 / 检查 / changelog / 状态
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

messages 缓存断点规则：

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
