# M3 调度对照：v1.4.238 JS 调度 → Rust kin-scheduler

v1.4.243（4e0068de，dofastted/vm2api#1994）把调度切到 Rust kin-scheduler。本文逐条对照 238 的调度规则（`pool-scheduler.mjs` 及其依赖 slot-model-gate、seat-planner、schedule-state、quota-window、account-quota、claude-tier、tier-limits、failover-runner），列出每条规则在 243+ 的去向，以及本分支补齐了哪些。

判定规则：
- **有意删除**：只认代码里写明的证据（注释、PR 里的具体说明）。PR 正文里泛泛的一句 "Removes legacy Node scheduling state" 不算证据。
- **丢失**：没有证据的删除。
- 修复优先级：打错号 > 挂起或长等待 > 仅影响负载均衡。

缩写：
- PS238 = `v1.4.238:src/lib/pool/pool-scheduler.mjs`；FR238 = `v1.4.238:src/lib/pool/failover-runner.mjs`
- SR = `src/lib/scheduler/scheduler-runtime.mjs`；FR = `src/lib/pool/failover-runner.mjs`
- ENG / ADM = `scheduler/crates/scheduler-core/src/engine.rs` / `admission.rs`

## 1. 本分支补齐的规则

| 规则 | 238 位置 | 243 去向 | 本分支 | 线上影响（修复前） |
|---|---|---|---|---|
| `pool.fable_requires_max`：Fable 只进 Max；池里没有 Max 时立即 429 `fable_requires_max` | slot-model-gate `slotAllowsModel`；PS238:2193、2928；FR238:1376 | 无（只剩面板和健康探测在用） | c79f47f3：SR `#computeAllowedNodeKeys` 调 `slotAllowsModel`；pool_exhausted 改写成 429；面板角标和派发共用 `slotDeniesFableForPlan` | **打错号 + 挂起**：Fable 落到 Pro。开了遥测的 Pro 槽上，CRAG 吞掉 credits 429，请求挂满 600s（见第 3 节） |
| `unified.model_denied_until`：上游拒过的模型冷却期内不派 | slotAllowsModel | 无 | c79f47f3（同上） | 打错号：每个请求先打一次已知不支持的号 |
| 按模型冷却 `modelCooldownKeys`（含 Fable 族键）、Fable 7d_oi `fable_quota`、周拆分 `fable_split`/`regular_split` | PS238:2337-2365 | Rust 只按精确模型冷却，并且只有 429/529 才写 | 20ee66f3：`claudeModelWaitGate` | 打错号：Fable 某变体被限后，其他变体仍派到同一号 |
| 节点闸：account_disabled、proxy_required、proxy_desynced/worker_proxy_missing、kernel_faulted、node_offline、no_credential/oauth_*、credential_blocked、concurrency_disabled、worker_unhealthy | PS238:2160-2396 `checkEligibility`；schedule-eligibility.mjs | 每 2s 一次的遥测一律写 `schedulable=true`，健康探测写的 false 会被覆盖 | 34fd5809：`claudeNodeGate` 接进 `buildTelemetryBatch` | **打错号/风控**：无代理、代理失配（出口 IP 和账号对不上）、凭据已死、worker 不可达的槽照样接流量 |
| `pool.keep_pin_on_model_gate`（线上开）：home 只是不能服务这个模型时借号一次，pin 不动 | PS238 reconcileSticky 1881-1892；FR238 bindAll 1096 | 无；commit 无条件改 `pinned_node` | 822b4a99：proto `keep_pin_on_model_gate` + `model_gated_node_keys`，lease 带 `keep_session_pin` | **打错号**：补上 fable 闸之后，Pro 会话发一轮 Fable 就永久搬到唯一的 Max |
| 摘要分叉、seatless 短探针跟着会话 pin 走 | PS238 selectDirect/familyVmId 2711；reconcileSticky | `is_ephemeral_probe` 跳过 L1、父会话跟随和 L2 | ac60bd63：engine 对 ephemeral 做只读跟随（`ephemeral_follow_session`） | 打错号：同一段对话的内容进了别的账号 |
| `failover.keep_session_home`（线上开）+ `home_slot_busy_retry_ms` / `home_slot_busy_max_wait_ms` | FR238:1181-1244、1362、1770-1778 | src 里没有读取方 | e8e47d2c：FR `isHome` 分支 | **打错号**：续聊会话出错就重放到别的号（违反用户裁定"会话不跨号"） |
| `quota.exhaustion_guard`（线上开）：≥stop 停号；new_session～stop 之间只放已 pin 的会话 | PS238:380-460、2203-2218 | Rust 固定 95% 剔除；85–95% 只降排序子桶，新会话照进 | 26515cbe：遥测 `new_sessions_blocked` / `quota_guard_stop` | 打错号：临界号继续接新会话 |
| 宿主内存 critical：不接新会话，续聊的 sticky VM 保留 | PS238 filterByHostMemory 299-304 | ADM 对所有请求硬剔除 | 26515cbe：`filter_members_for(continuing_node)` | 打错号：内存告急时续聊会话被迫换号 |
| batch_group 成员（线上 key_36b7 开）：按成员键粘号；同成员不串行 | HP238 batch 段；FR238:976-979 | 成员被当成 ephemeral：不粘号、不计会话、不计 RPM | 3df438a2：`skip_session_gate`，成员不再是 ephemeral | **打错号**：分组形同虚设，批处理散到全池（关联簇） |

每个提交的说明都按"238 行为 / 243 行为 / 修法 / 测试"写，用例以 238 行为为预期：
- 真二进制：`test/unit/scheduler-m3-parity-{fable,session-home}.test.mjs`
- 纯函数和遥测：`test/unit/scheduler-m3-parity-node-gates.test.mjs`
- Rust：`scheduler-core/tests/{admission_affinity,session_gate}_tests.rs`

## 2. 全量对照表

### 2.1 逐候选资格闸

| 规则 | 238 位置 | 243+ 去向 | 状态 | 线上影响 |
|---|---|---|---|---|
| vm.policy.allowed_models | slot-model-gate:163 | SR allowlist → allowed_node_keys | 已迁移 | — |
| 平台/模型族互斥（GPT↔Claude 槽） | PS238:608、slot-model-gate:150 | SR 按 modelFamily + nodeTypes 过滤 | 已迁移 | — |
| 租户隔离 vmMatchesOwnerScope | PS238:1978 | owner_id → ADM:104 | 已迁移 | — |
| Key 范围 keyAllowsVm | PS238:1979 | allowed_vms / Rust 池成员 / allowed_pool_ids | 已迁移 | — |
| 排除表 excluded | PS238:1981 | exclude_nodes | 已迁移 | — |
| 调度关 / vm.unschedulable / VM 状态 | schedule-eligibility:104 | 遥测 schedulable | 已迁移 | — |
| IPv6 出口关闭 | schedule-eligibility:106 | proxy_ready | 已迁移 | — |
| fable_requires_max、model_denied_until | slot-model-gate:158-162 | — | **已补齐** c79f47f3 | 见第 1 节 |
| 未绑代理、代理失配 | schedule-eligibility:99-131 | — | **已补齐** 34fd5809 | 见第 1 节 |
| accounts 行停用 | PS238:2190 | — | **已补齐** 34fd5809 | — |
| 凭据资格、运行态凭据封禁 | schedule-eligibility:90-229 | 只靠请求失败后冷却 | **已补齐** 34fd5809 | — |
| 并发 0 = 停号 | PS238:2324 | 0 回落成默认值 | **已补齐** 34fd5809 | — |
| 内核故障、离线、worker 不可达 | PS238:2386-2396 | 遥测覆盖 | **已补齐** 34fd5809 | — |
| 额度窗口（5h/7d rejected、gated） | PS238:2240 | syncQuotaSchedule 事后 park → temp_unschedulable | 已迁移（时机改为事后） | — |
| 账号硬封 rate_limit_reset_at / overload_until | PS238:2155 | temp park + Rust 429/529 冷却 | 大体迁移 | 仅负载均衡 |
| 账号冷却 cooldown_until | PS238:2334 | Rust node_cooldown（只来自 release 上报） | 部分迁移 | 仅负载均衡 |
| 模型冷却 / Fable 族 / 7d_oi / 周拆分 | PS238:2337-2365 | — | **已补齐** 20ee66f3 | — |
| exhaustion_guard 分档 | PS238:380-460 | — | **已补齐** 26515cbe | — |
| 宿主内存续聊豁免 | PS238:299 | — | **已补齐** 26515cbe | — |
| Fable 每号并发 `concurrency.fable_max_per_account` | PS238:2369、2973 | 无 | **丢失，未修** | 仅负载均衡（Pro 本来 ≤2；线上值 256 等于不限） |
| 临界带大冷请求 `quota_guard_request_too_large`（`quota.guard_large_cold`，线上开） | account-quota@238:1105 | 无 | **丢失，未修**（需要把请求的未缓存 token 数传进调度） | 打错号/烧额度：临界号吃下大冷请求。exhaustion_guard 的新会话带已拦掉其中的新会话部分 |
| 闸前缓冲带 quota_band_inflight | account-quota@238:1074 | 无 | 丢失，未修 | 仅负载均衡 |
| 新号隔离 fresh_account_isolation_ms | PS238:1943 | 无 | 丢失，未修 | 线上为 0，无影响 |
| 熔断 unitCircuit admit | PS238:2160、2997 | Rust 冷却阶梯 + probeOne（health.rs:23、ADM:363） | 有意替代（health.rs 冷却阶梯取代） | — |
| 内核满载 slot_busy 等待 | PS238:2392 | Rust in_flight 记账 | 有意替代 | 仅负载均衡 |
| kernel lease 账本 | PS238:3046 | 无 | 丢失，未修 | 线上 kernel_lease=observe，无影响 |
| CRAG 席位超额 | PS238:2283 | crag_license_ok | 已迁移 | — |
| 工作时段 | active-hours | active_hours_ok | 已迁移 | — |
| 预算余量排序 budgetHeadroom | availability:230 | Rust quota_headroom_bps | 有意替代 | 仅负载均衡 |
| seat_budget_reserve_pct / SeatPlanner | PS238:675 | 无 | 有意删除（PS:395 注释 "SeatPlanner ... have been deleted"） | 仅负载均衡 |

### 2.2 亲和、粘性、子代理

| 规则 | 238 位置 | 243+ 去向 | 状态 | 线上影响 |
|---|---|---|---|---|
| 续会话回原号 | PS238 reconcileSticky 1871 | ENG L1 SessionHit | 已迁移 | — |
| 原号忙先等 sticky_wait 45s | PS238 stickyShouldWait 569 | 虚拟池立即溢出 | 有意删除（`Locked D2 default`：types.rs:113、config.rs:188-191、ENG:729、SR:1366） | 仅负载均衡 |
| 溢出时 pin 是否跟着走（session_affinity_first） | FR238:1065、1106-1116 | commit 总是改 pin（等于 session_affinity_first=true） | 部分丢失：false 的语义没了 | 线上为 true，**无影响** |
| keep_pin_on_model_gate | PS238:1881 | — | **已补齐** 822b4a99 | — |
| keep_session_home | FR238:1181 | — | **已补齐** e8e47d2c | — |
| 同会话串行 | FR238 sessionTails 969 | Rust SessionGate（超时取池列，默认 60s） | 已迁移 | — |
| batch 成员粘号、不串行 | FR238:976 | — | **已补齐** 3df438a2 | — |
| 摘要分叉、短探针跟会话 | PS238:2711 | — | **已补齐** ac60bd63 | — |
| 家族 home / family_affinity_first（含由 callerSession 推出的家族） | PS238 seatHomes 272、FR238:1126 | 只剩一次性的 parent_session_id 跟随，并且 parent 先于 L2 | 部分丢失：有声明 parent 的子代理已覆盖；callerSession 家族和 homeFull 排队没了 | 打错号（轻） |
| 设备/机器 home | PS238 machineHome 691 | ENG L2 machine stick | 已迁移 | — |
| 设备/家族 home 满时在 home 上排队 | PS238 openNewSeat 1591 | 立即溢出 | 有意删除（ENG:926 注释 "zero-wait, zero-cooldown immediate spill"） | 仅负载均衡 |
| 子代理锁根 VM、max_subagents_per_session 池级上限、共用根席位 | PS238:760-928、1644 | 只算同节点上限，超了就溢出 | 丢失，未修 | 线上 max_subagents_per_session 为 null，**无影响** |
| 直连 VM 重连等待 clusterHome | PS238:1827 | 离线即排除并溢出 | 丢失，未修 | 打错号（直连槽闪断时） |
| 内容席位 seat:h 单轮缓存亲和 | identity-rewrite@238:376 | 无 | 丢失，未修 | 仅负载均衡（缓存命中） |
| priorityOf / 严格最高档 / SWRR | PS238:537-546 | Rust weight_tier + tier_rank | 已迁移 | — |
| restoreStickySeats | PS238:717 | bootstrap 时从 scheduler_sticky_bindings 恢复 | 已迁移（架构替代） | — |

### 2.3 等待、合成错误、failover

| 规则 | 238 位置 | 243+ 去向 | 状态 | 线上影响 |
|---|---|---|---|---|
| 全部候选被 fable 闸 → 429 fable_requires_max | PS238:327、FR238:401 | — | **已补齐** c79f47f3 | — |
| 全部冷却 → 429 pool_rate_limited（Retry-After=最早到期） | PS238:322、FR238:380 | 503 pool_exhausted，Retry-After 1 | 丢失，未修 | 仅错误码（客户端 1s 重试） |
| 529 过载冷却 → pool_overload_cooldown | FR238:365 | 503 | 丢失，未修 | 仅错误码 |
| 休息时段 Retry-After=开工时间 | FR238:772 | Retry-After 1 | 部分迁移 | 仅错误码 |
| 容量耗尽 529 pool_overloaded | FR238:347 | 排队超时 503，队列满 429 | 语义变化 | 仅错误码 |
| 槽等待预算 slotWaitMs/slotWaitDeadlineMs 下传内核 | PS238:1003、3074 | 不设置，内核 queue_wait_ms=0 | 丢失，未修 | 内核没有空闲槽时立即 slot_busy。keep_session_home 补齐后，home 会每 2s 重试，受 120s 截止约束 |
| max_account_switches / max_total_attempts | FR238 budget | AttemptCoordinator（unit-decision.mjs） | 已迁移：238 也不是硬上限，只是超过后只尝试没试过的号 | — |
| retryOrStay / 同号重试 | FR238:1202 | FR advanceOrRetrySame | 已迁移 | — |
| poisonGuard sizeRefused | FR238:1253 | FR:1014 | 已迁移 | — |
| 单跳时长上限（不是 238 新增：238 的截止同样只在两跳之间检查） | — | — | 未变 | 600s 挂起靠 fable 闸消除，见第 3 节 |

### 2.4 Codex / OpenAI / API 调度器（函数 diff）

| 文件 | 238 有、HEAD 无的函数 | 去向 | 状态 |
|---|---|---|---|
| failover-runner | fableRequiresMaxError、homeSlotRefused、keptHome、retryOrStay、waitHomeSlot、selectionFailure、poolRateLimitedError、quotaGuardTooLargeError、waitForSessionTurn、bindAll 等 | 前五个本分支已补齐（含义并入 SR `#rethrowGated` 和 FR `isHome` 分支）；sessionTails 由 Rust SessionGate 代替；bindAll 系列属 sticky 绑定，HEAD 只保留出站 session_id 台账 | 见上表 |
| codex-slot-pool | orderOpenAIAccounts、smartScore、quota*Rank、rpmRetryAt、holdRetryAt、withModelAllowed 等 | Rust RpmExceeded / NodeCooldown / tier_rank；allowlist 由 SR 过滤 | 有意删除（openai-account-selector.mjs 头注释 "Legacy Node scoring/sorting selectors were removed"）；Retry-After 合成丢失 |
| openai-account-selector | selectOpenAIAccount、smartScore、resetBurnFactor 等 | 同上 | 有意删除（同上注释） |
| api-scheduler | 无（只增不减） | — | 无丢失 |

### 2.5 第 1 节函数清单的去向

| 238 函数 | 243+ 去向 |
|---|---|
| slotAllowsModel | SR `#computeAllowedNodeKeys`（c79f47f3）；面板 `slotDeniesFableForPlan` |
| checkEligibility 节点部分 | `node-gates.mjs claudeNodeGate` → `buildTelemetryBatch` |
| checkEligibility 模型等待部分 | `node-gates.mjs claudeModelWaitGate` → `#computeAllowedNodeKeys` |
| quotaGuardLevel / quotaGuardConfigOf | `buildTelemetryBatch` → `new_sessions_blocked` / `quota_guard_stop` |
| reconcileSticky（借号不搬家） | ENG `pinned_node_model_gated` + lease `keep_session_pin` |
| reconcileSticky（续会话回原号） | ENG L1 |
| selectSeat / openNewSeat / SeatPlanner | Rust tier_rank + L1/L2（SeatPlanner 有意删除） |
| makeWaitPlan / resolveWaitPlan / waitForCapacity | Rust session_overflow_policy + wait_any_ready_node；冷却中的号不再等待 |
| slotWaitDeadlineMs / remainingSlotWaitMs | 无（见 2.3 槽等待预算） |
| emptyPoolFailure | SR `#rethrowGated`（只合成 fable_requires_max），其余是 Rust 的 pool_exhausted |
| filterByHostMemory | ADM `filter_members_for` |
| selectSubagent / trackSubagent | ENG parent 跟随（只试一次） |

## 3. 600s 挂起：根因和修后验证

生产只读数据（11-28 07:11–07:43，request_attempts）：

| 请求 | 落点 | 结果 |
|---|---|---|
| Fable | 遥测关的 Pro 槽（a186/632f/4b99/720a） | 约 2.3s 上游 429，然后换号（5/5） |
| Fable | 遥测开的 Pro 槽 `cf-24ffd6bf61df`、`cf-7efee1afb3c6`（11-23 起 `CRAG_GUEST_ENABLE_TELEMETRY=1`） | 约 600s 后内核报 `request timed out: first_output`（6/6） |
| 非 Fable | 同上两个槽 | 62 条全部正常 |
| Fable | Max `cf-6c9168d8638d` | 约 4s 200（6/6） |

结论：
- 遥测开的槽上，CRAG 内核/CLI 吞掉了 Fable 在 Pro 上的 credits-required 429，网关看不到上游错误，只能等 first_output 超时。
- JS 的 120s failover 截止只在两跳之间检查，单跳可以跑满内核的 600s。这一点 238 也一样。238 不会出事，是因为 fable 闸根本不会把 Fable 派到 Pro。

修后：
- fable 闸恢复后，Fable 只会进 Max，没有 Max 时 1s 内返回 429（测试 `fable_requires_max: no Max slot -> immediate 429`，上游调用 0 次），不再有请求落到 Pro 槽，挂起的前提不存在了。
- 生产只读演练（green 容器内，用分支代码对线上 vms/accounts 求值）：20 个运行槽全部通过节点闸。三个 Fable 模型都只允许 `cf-6c9168d8638d`，opus 允许全部 20 个。

- exhaustion_guard 演练（11-28，线上 routing.quota = 0.85 / 0.95）：20 个运行中的 Claude 账号里 19 个 open，1 个在新会话带（5h 0.88），没有 stop。恢复后只有这 1 个号不接新会话。

遗留（不在本分支）：CRAG 遥测开启时吞 429 需要另提 CRAG issue；单跳内截止是否要加，单独讨论。

## 4. 配置键：谁在读

本分支接上的：`pool.fable_requires_max`、`pool.keep_pin_on_model_gate`、`failover.keep_session_home` / `home_slot_busy_retry_ms` / `home_slot_busy_max_wait_ms`、`quota.exhaustion_guard` / `exhaustion_guard_new_session` / `exhaustion_guard_stop`（新会话带）、`batch_group`（成员粘性）。

仍然没有读取方的键，以及处理决定：

| 键 | 238 作用 | 决定 | 依据 |
|---|---|---|---|
| pool.sticky_wait_timeout_ms（面板可编辑） | sticky 等待截止 | 删除（连同面板项） | 有意删除：`Locked D2 default` |
| pool.seat_budget_reserve_pct（面板可编辑）、seat_grace_ms | SeatPlanner | 删除（连同面板项） | 有意删除：PS:395 注释 |
| pool.circuit_failure_threshold / circuit_open_ms（Claude 面板可编辑） | UnitCircuit admit | 删除 Claude 面板项；Gemini 仍在读，保留 | 有意替代：Rust 冷却阶梯 |
| pool.kernel_lease_queue_grace_ms、heartbeat_stale_ms | kernel lease 宽限、默认值 | 删除 | 没有读取方；kernel_lease 本身只剩面板展示 |
| failover.session_queue_timeout_ms | 同会话排队 900s | 删除，改用池列 session_queue_timeout_ms | Rust SessionGate 取池列 |
| pool.session_affinity_first | spill 时 pin 是否跟随 | 待接上（Rust L1），线上为 true，与现状一致 | — |
| pool.family_affinity_first | 家族 home 顺序 | 待接上（部分），线上为 true，与 Rust 固定的 parent 优先一致 | — |
| pool.fresh_account_isolation_ms | 新号隔离 | 待接上；线上为 0 | — |
| concurrency.fable_max_per_account | Fable 每号并发 | 待接上；线上为 256 | — |
| quota.guard_large_cold / large_cold_uncached_tokens | 临界带大冷请求 | 待接上（线上开） | — |
| scheduler_pools.plan_tags_json | 只展示 | 保留，只用于展示 | — |
| required_runtime_capabilities | Rust 会消费 | 待接上：表里没有这一列，链路断了 | — |

"删除"的几项会改动 web 面板（pool-pane.tsx、routing-draft.ts）和 normalize，单独开 PR，不和本分支的行为修复混在一起。

## 5. 升级注意

- 生产 green v1.4.246 挂载了 `patches/1.4.246/admin/request-log.mjs` 和 `protocol/outbound-snapshot.mjs`。它们只 import pricing、error-class、openai-usage、db/*、log-fields、core/security、core/errors，本分支都没改，可以兼容。升级时仍要对这两个文件和新版本做 diff。
- proto 新字段都带 serde default：旧二进制配新 JS 会忽略这些字段（行为退回 243）；新二进制配旧 JS 时字段取默认值。JS 和二进制必须一起升级，修复才会生效。
- 本分支不改线上 routing.json，也不改号池。
