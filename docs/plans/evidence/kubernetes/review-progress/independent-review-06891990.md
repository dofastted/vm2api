发现 **5 项 P1**，未发现有证据支持的 P0。以下均为静态源码结论，合成复现步骤交主会话执行。

核对提交为 `068919906653acf0e6dd0f749f83cb808f9f36f1`，基线为 `66a580de17670a954638fbfb46fee25740adab78`。开始和结束时 HEAD 一致，工作区干净。`git diff --check` 无输出。

1. **P1：Claude worker 的内部重试仍会覆盖刷新结果不明。**

   位置：`worker/internal/oauth/refresher.go:171`、`:175`、`:181`；`worker/internal/oauthcmd/oauthcmd.go:89`；[src/lib/transport/slot-oauth.mjs:236](https://github.com/liubing0806/vm2api/blob/068919906653acf0e6dd0f749f83cb808f9f36f1/src/lib/transport/slot-oauth.mjs#L236)。

   触发条件：首次刷新请求已被上游接收，刷新令牌（RT）可能已经轮换，但响应中断；worker 随后使用原 RT 重试，取得明确的 400/401 拒绝。

   调用链：共享刷新服务 → `runSlotOauthRaw` → worker `Ensure` → `requestWithRetry`。worker 只返回最后一次错误。Node 根据最后的退出码、HTTP 状态和错误码设置 `attemptFinished:true`。`shared-credential-refresh.mjs:162` 随后完成后台任务并释放 VM 操作记录。首次刷新结果不明没有保留。

   影响：账号恢复接受新执行或刷新，而首次刷新是否消耗 RT 仍未确认。

   最小修复：worker 累积每次请求的不确定性；传输结果不明后停止重试，并显式返回未知状态。

   合成复现：首次模拟上游接收请求后断开响应，第二次返回 `invalid_grant`。检查 worker 输出以及共享任务 `finished_at`、VM 操作 `released_at`。预期保留未知；当前源码路径会按明确失败完成。

2. **P1：package 的 Codex 探测可在嵌套刷新未知后释放账号互斥。**

   位置：[src/lib/vm/shared-vm-operations.mjs:210](https://github.com/liubing0806/vm2api/blob/068919906653acf0e6dd0f749f83cb808f9f36f1/src/lib/vm/shared-vm-operations.mjs#L210)、`src/lib/oauth/shared-credential-refresh.mjs:141`、[src/lib/oauth/openai-quota.mjs:305](https://github.com/liubing0806/vm2api/blob/068919906653acf0e6dd0f749f83cb808f9f36f1/src/lib/oauth/openai-quota.mjs#L305)。

   触发条件：导入带有效账号标识、AT 和 RT 的 Codex package；启动成功；额度探测返回 401；刷新请求超时或断连。

   调用链：`panel-routes.mjs:4242` 的外层 VM 操作 → `bringUpImportedVm:895` → `buildProbeOne` → 共享刷新。嵌套 `SharedVmOperations.run` 直接返回回调结果，不处理 `vmOperationUncertain`。刷新服务将后台任务标为未知，但没有标记继承的 VM 操作。额度层把未知转换为普通 `rotateError`，package 再转换为 `probe.ok:false`。

   外层回调正常结束后，VM 和账号互斥被释放。执行准入只检查 `vm_operations`，因此同 VM 或同账号另一 VM 可以取得新准入。未知后台任务仍存在，但它不能阻止该准入。

   最小修复：嵌套 VM 操作在返回未知结果或发生效果不明异常时，直接标记继承的操作未知；额度层同时保留未知标志。

   合成复现：在实际 `SharedVmOperations.run` 内调用 `queryOpenaiQuota`，模拟额度 401、刷新断连。外层正常返回后，用第二条 PG 连接尝试同账号新准入。当前路径可释放 VM 操作；预期应拒绝新准入。

3. **P1：已启用的手动 Codex 刷新仍绕过共享刷新与账号互斥。**

   位置：[src/lib/admin/panel-routes.mjs:5272](https://github.com/liubing0806/vm2api/blob/068919906653acf0e6dd0f749f83cb808f9f36f1/src/lib/admin/panel-routes.mjs#L5272)、同文件 `:5282`。

   触发条件：Search 或 quota 已持有该账号的共享刷新操作，或者此前刷新仍为未知；用户调用 `POST /api/panel/vms/:id/oauth/refresh`。

   该入口直接调用 `refreshCodexAccessToken`，成功后直接写凭据。它不查询共享任务，也不取得 VM/账号互斥。外层面板包装器只等待持久化，没有补充互斥。失败分支也没有使用新增的 `attemptFinished`。

   影响：同一 RT 可以并发提交；迟到结果可以覆盖共享刷新发布的凭据；手动刷新超时后仍允许再次刷新。这是当前可调用入口的遗漏。

   最小修复：Kubernetes 模式下改用 `refreshSharedCodexCredential`，统一处理发布、明确失败和未知结果。

   合成复现：保持一个共享刷新回调未完成，再调用手动刷新 handler；在模块边界注入合成刷新函数。断言原始刷新调用次数应仍为一次。另覆盖已有未知任务的情况。

4. **P1：package 把已明确结束的 bootstrap 普通失败标为未知，长期占用代理池。**

   位置：[src/lib/admin/panel-routes.mjs:888](https://github.com/liubing0806/vm2api/blob/068919906653acf0e6dd0f749f83cb808f9f36f1/src/lib/admin/panel-routes.mjs#L888)、同文件 `:669`、`:673`。

   触发条件：package 启动成功；bootstrap 前台命令正常退出，但 hello 或 usage 业务检查失败；辅助操作和清理均已结束；resident 关闭。

   原始 bootstrap 可以返回 `{ok:false, attemptFinished:true, vmOperationUncertain:false}`。统一完成判定接受该结果，但外层 `vmEffect` 仍因 `ok!==true` 标记 VM 和代理池未知。

   影响：没有未结束执行的普通初始化失败，也会阻止后续代理管理和全局维护。

   最小修复：该入口依据统一执行完成证明决定互斥释放，另行保留业务失败结果。

   合成复现：在 package fixture 注入上述 bootstrap 返回值。请求结束后检查 VM claim 和 `proxy_operation:pool`。预期均可释放；当前路径保留未知。

5. **P1：刷新因其他活动执行被拒绝启动后，runner 将已结束作业的准入永久标为未知。**

   位置：`src/lib/oauth/shared-credential-refresh.mjs:184`；[src/lib/transport/kernel-router.mjs:317](https://github.com/liubing0806/vm2api/blob/068919906653acf0e6dd0f749f83cb808f9f36f1/src/lib/transport/kernel-router.mjs#L317)；`src/lib/pool/failover-runner.mjs:526`、`:1150`。

   触发条件：同账号允许至少两个并发请求；A 的模型作业已明确结束并返回 401；B 的准入仍活动。

   刷新获取 VM 操作时，`shared-vm-operations.mjs:97` 因 B 返回 `vm_execution_active`。共享刷新服务确认回调未进入，并将任务完成为 `refresh_not_started`，但继续抛出普通异常。

   kernel router 未保留 A 已结束的结果。异常进入 runner 后被标为执行未知；`recoverCredential` 也会对刷新异常无条件标记未知。随后普通 release 无法释放 A 的准入。

   影响：正常并发下的刷新拒绝会持久占用账号容量，并阻止维护。此触发条件发生在正常开放状态，超出已知的 DRAINING 保守边界。

   最小修复：传播明确的刷新未启动结果；在原模型作业已结束且刷新未启动时，保留可释放的准入状态。

   合成复现：建立 A、B 两条同账号准入，完成 A 的 job，保持 B 活动，再调用 A 的 `recoverCredential`。确认 worker 调用次数为零。释放 B 后检查 A 是否仍有 `uncertain_at`。

上轮四项的指定触发路径复核如下，状态仅代表源码证据：

| 上轮项目 | 状态与证据 |
|---|---|
| usage 超时被重试成功覆盖 | 已修正。`official-cc-bootstrap.mjs:1091` 遇到未确认结束立即停止重试；`:1336` 转为未知；`:1532` 返回统一完成状态；`:1661` 决定任务和 VM 操作保留。 |
| package/import 辅助错误提前释放 | 指定未知路径已修正。原始函数在 `:1351`、`:1363`、`:1401` 汇总辅助未知；package `panel-routes.mjs:890` 和 import `import-commit.mjs:304` 使用统一判定。普通已结束失败另见发现 4。 |
| active endpoints 正常清理变永久 unknown | 指定路径已修正。`egress.mjs:1103` 按 ID 和名称复核网络；`:1117` 保留仍有端点的网络；`:1125` 处理明确的 active endpoints 删除拒绝。helper 结束证明仍单独检查。 |
| watchdog bridge helper 缺 claims 和未知传播 | 已修正。`slot-recovery.mjs:702` 先取得代理池 claim，`:706` 补充绑定 VM，`:716` 取得 VM claims 后执行；`:667` 返回未知。`kernel-watchdog.mjs:227` 据此保留后台任务。 |

覆盖范围还包括：

- 共享刷新使用 PG 事务锁及前次 execution ID 条件去重。新准入和新 job 绑定均与账号/VM 操作使用相同资源锁。已结束 job 例外核对了数据库、owner、账号、VM、未释放及无 pending job。
- 成功发布位于结束事务之前。server 的 Claude 发布回调先写 VM 投影并等待持久化。正常独立刷新路径在任务和 VM 操作结束后才完成 activity。
- 共享结果写入凭据哈希和受限错误码。本轮检查的 metadata 路径未发现 token 内容泄露。
- KSG2 客户端按值冻结原 Fence；发送前要求匹配的持久绑定确认；响应后使用原 ticket 查询节点持久终态。PG 拒绝身份不符或缺失完成证明。显式 fenced worker 路径拒绝旧传输回退。未发现额外可证实问题。

未执行测试、网络、服务、数据库或运行环境操作。真实 PG 并发、worker 制品行为、Docker 端点和跨 Pod 时序均未动态验证。DRAINING 拒绝暂保守保留未知仍记为已知边界。生产启动权限、管理 grant 和节点发布能力仍属后续范围。

`ControlPlaneLock`、`replicas: 1` 和 Recreate 仍保留。本检查点不代表高可用完成，**本报告不批准发布**。
