新增 **1 项 P1、2 项 P2**。未发现其他可证的新增 P0/P1/P2。以下均为静态源码结论，合成复现交主会话执行。

**1. P1：允许的 routing 更新会重新启动 HA 已禁用的后台探测，产生持久未知任务。**

位置：[src/server.mjs:1794](https://github.com/dofastted/vm2api/blob/a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f/src/server.mjs#L1794)、[src/lib/admin/routing-runtime.mjs:169](https://github.com/dofastted/vm2api/blob/a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f/src/lib/admin/routing-runtime.mjs#L169)、[src/lib/oauth/usage-probe-monitor.mjs:415](https://github.com/dofastted/vm2api/blob/a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f/src/lib/oauth/usage-probe-monitor.mjs#L415)。

触发条件：PG 原配置保留 `usage_probe.enabled=true`；存在具备凭据标记、代理元数据且需要用量探测的普通 Claude VM；HA 启动后保存一次允许的 `pool` 等 routing 配置。

调用链：

- HA 仅在启动回调中跳过 monitor `start()`。
- `SharedRoutingConfig.patch/refresh → applySharedRouting` 仍调用 health、usage monitor 的 `setConfig()`。
- `setConfig()` 默认 `restart=true`，重新安装定时器。
- usage 定时器取得共享后台任务声明，再进入 `server.mjs:634 → buildProbeOne`。
- `buildProbeOne` 构造的旧执行上下文没有 capability。`callWorkerGet → requireNodeCapability` 抛出 `slotgate_capability_required`。
- 该异常没有 `taskNotStarted/taskTerminal`，因此 [shared-background-tasks.mjs:131](https://github.com/dofastted/vm2api/blob/a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f/src/lib/core/shared-background-tasks.mjs#L131) 将任务和 activity 标为未知。

影响：一次正常配置保存可以留下 `finished_at IS NULL` 的后台任务，持续阻止全局维护。该任务不属于请求恢复服务可处理的执行图。

最小修复：HA 下配置应用不得重启未支持的 monitor；同时在按需 `onUsageProbe` 入口、取得后台声明之前拒绝探测。

合成复现：使用隔离 PG 和上述合成 VM，保留实际 routing、usage monitor、`buildProbeOne` 与 capability guard；保存 `pool` 配置后推进测试时钟。断言旧 worker 调用为零，并检查 `usage-probe:<vmId>` 是否留下未知任务及未完成 activity。

**2. P2：HTTP Claude Responses 从原有 400 回归为 500。**

位置：[src/server.mjs:1295](https://github.com/dofastted/vm2api/blob/a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f/src/server.mjs#L1295)、[src/lib/protocol/handle-protocol.mjs:562](https://github.com/dofastted/vm2api/blob/a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f/src/lib/protocol/handle-protocol.mjs#L562)。

`POST /v1/responses` 和 `/responses` 被 HA 路由允许，但不在建立请求 context 的 HTTP 路径集合内。外层已登记 `requestActivities`，所以 `dispatchProtocol` 的再次包装直接复用外层，不会补建 context。

协议入口随后无条件调用 `currentHaRequestContext()`，抛出 `ha_request_context_required`。请求在鉴权、模型检查和原有 `handle-protocol.mjs:932` 的 `400 protocol_not_allowed` 分支之前返回 500。

最小修复：区分“需要协议 context”和“允许执行恢复”的路径；为 Responses 建立不可恢复的 context，保留原有拒绝行为。

合成复现：通过实际 server HTTP 包装器发送合成 Claude Responses 请求，不替换 `currentHaRequestContext`。预期为原有 400；当前调用链为 500。现有 [协议 fixture:16](https://github.com/dofastted/vm2api/blob/a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f/test/fixtures/ha-protocol-boundaries.mjs#L16) 固定替换了该函数，因此未覆盖此问题。

**3. P2：启动清理会删除恢复服务必需的原 attempt，导致已完成作业无法恢复。**

位置：[src/lib/core/ha-request-recovery.mjs:103](https://github.com/dofastted/vm2api/blob/a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f/src/lib/core/ha-request-recovery.mjs#L103)、[src/lib/db/repos/request-attempts-repo.mjs:60](https://github.com/dofastted/vm2api/blob/a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f/src/lib/db/repos/request-attempts-repo.mjs#L60)、[src/lib/admin/routing-runtime.mjs:843](https://github.com/dofastted/vm2api/blob/a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f/src/lib/admin/routing-runtime.mjs#L843)。

触发条件：HA 孤儿请求超过日志保留期，仍持有执行准入或 API key 预约；随后另一 Pod 启动。

启动时 `initPoolRuntime → attemptsRepo.cleanup` 只按 `started_at` 删除 `request_attempts`，没有保护待恢复请求。新增的执行历史保护只作用于 `execution_admissions`，无法保留 attempt。

恢复服务要求每个 job 恰好匹配一个原 attempt。删除后，`recover()` 在读取节点完成证明之前返回 `request_job_binding_unproven`。即使原节点已有可信 completed，执行准入、席位和 session turn 仍无法通过当前恢复服务释放。

最小修复：attempt 清理增加待恢复执行图和未释放 API key 预约的保留条件，并与恢复事务协调清理并发。

合成复现：沿用 `ha-request-recovery.test.mjs` 的真实关联图，将 attempt 时间设为保留期之前；断开原 owner，执行实际 `cleanup()`，再提供原 command/Fence 的 completed。当前结果应为 `request_job_binding_unproven`，资源继续占用。

**覆盖与未验证**

审查 SHA：`a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f`；基线：`e9076922a4af1f43840e6f9db8381790c809ee21`。审查前后 HEAD 一致，工作区干净；95 文件增量及必要调用链已读取，`git diff --check` 无输出。

覆盖了授权与回执链、私有 authority/角色/epoch/锁序、Go staging 与固定路由、capability 和 PG job 绑定、HA 启动与后台入口、019/020 请求关联及恢复、断连终态与历史 receipt、backup 同 schema 外键清理及外部依赖保护。

未运行测试、服务或任何外部环境操作。并发时序、TLS/文件持久化和运行制品行为均未动态验证。未将其他 worktree 的 refresh、billing recovery、notstarted seal 计划记为本增量缺陷。部署仍为 `replicas: 1`、`Recreate`。**本审查不批准发布。**
