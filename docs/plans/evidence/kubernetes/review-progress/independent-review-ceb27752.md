发现 **2 项新增 P2**，未发现可证的新增 P0/P1。

1. **P2：明确未发送的刷新 grant 会永久占用 generation**

   位置：[src/lib/db/node-credential-refresh-authority.mjs:51](https://github.com/dofastted/vm2api/blob/ceb2775221fb73549e542855356073bacf8e54a8/src/lib/db/node-credential-refresh-authority.mjs#L51)、[src/lib/cluster/node-credential-refresh-grants.mjs:158](https://github.com/dofastted/vm2api/blob/ceb2775221fb73549e542855356073bacf8e54a8/src/lib/cluster/node-credential-refresh-grants.mjs#L158)。

   触发条件：`issue()` 已提交，但刷新连接在 TLS 请求发送前失败。客户端将其标为 `vmOperationNotStarted`，共享刷新随后完成后台任务并释放 VM operation。释放仅设置 grant 的 `revoked_at`，其 `receipt` 仍为 NULL。

   `refresh_pending_generation` 的唯一条件只检查 `receipt IS NULL`，因此该已撤销记录仍占用 generation。下次合法刷新会得到 `node_refresh_conflict`。该错误又不属于明确未开始的分类，随后会将新的后台任务和 VM operation 标为未知，导致该账号持续无法刷新。

   最小修复：在节点锁下，为明确未发送的 grant 记录终态并解除其 generation 占用；发送后结果未知的 grant 继续保留占用。

   合成复现：使用现有 PG 刷新 fixture，让第一次 `grants.refresh()` 连接关闭的本地端口。确认其返回未开始、后台任务结束、VM operation 释放。保持 generation 不变，第二次使用有效节点连接刷新；当前代码会报 `node_refresh_conflict`，而非取得新授权。

2. **P2：派发前取消请求会因未绑定的 command ID 留下 API key 预约**

   位置：[src/lib/protocol/handle-protocol.mjs:231](https://github.com/dofastted/vm2api/blob/ceb2775221fb73549e542855356073bacf8e54a8/src/lib/protocol/handle-protocol.mjs#L231)、[src/lib/core/ha-request-billing.mjs:315](https://github.com/dofastted/vm2api/blob/ceb2775221fb73549e542855356073bacf8e54a8/src/lib/core/ha-request-billing.mjs#L315)。

   触发条件：客户端在 `prepareRust()` 的节点健康检查期间断开。该健康检查未传递取消信号，仍可返回成功。随后 `streamGoWorker()` 在调用 `onExecutionStart` 前发现取消，返回带随机 `requestId` 的 `started:false / ended:true / not_started` 结果，此时没有持久 job。

   新计费逻辑仅依据非空 `requestId` 调用 `selectHaBillableCommand()`，因此抛出 `ha_billable_command_mismatch`，无法进入已有的 `not_dispatched` 分支。异常设置 `billingFailed`，外层 finally 保留 API key 预约。原控制面仍连接时，其他副本也不能恢复该预约。

   最小修复：先在 parent 锁下确认执行图没有 job，再记录 `not_dispatched`；存在 job 时继续校验原 command，不能仅依据 `started:false` 释放。

   合成复现：暂停正常 Messages 请求在 `callAttempt` 内的节点健康响应，断开客户端，再返回健康成功。确认节点未收到推理、`execution_jobs` 为零。当前代码会出现上述异常，且 `api_key_admissions.released_at` 保持 NULL。现有 `not-started` fixture 将 `requestId` 固定为 NULL，未覆盖此路径。

审查对象为 `ceb2775221fb73549e542855356073bacf8e54a8`，基线为 `a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f`。开始和结束时 HEAD 均一致，工作区干净。已通读全部 79 个文件的增量及必要原调用链，`git diff --check` 无输出。

上轮三项均见对应源码修正：HA 路由更新禁止重启旧 monitor；Responses 建立不可恢复 context；attempt 清理保护待处理执行图并取得 parent 锁。以上仅作静态复核。

按要求未运行测试、服务或动态复现，未修改文件，未使用子 agent、网络或外部环境。真实 provider、现有内核读取新 AT、多节点部署行为均未验证。未将声明 unsupported 的路径、新 CLI bootstrap 或未交付的自动 recovery monitor 计为已完成功能。本次审查不构成发布批准。
