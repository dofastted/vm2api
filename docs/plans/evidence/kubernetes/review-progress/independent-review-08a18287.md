新增 **1 项 P1**。未发现其他有证据支持的 P0/P1/P2。

审查提交：`08a182870b6334691a114c7b93a0f07032588ff7`。增量基线：`068919906653acf0e6dd0f749f83cb808f9f36f1`。开始和结束时 HEAD 一致，工作区干净，`git diff --check` 无输出。

**新增 P1：已明确结束的远端准备失败，被 telemetry touch 路径持久标为未知。**

位置：

- [src/lib/cluster/remote-slot-files.mjs:228](https://github.com/liubing0806/vm2api/blob/08a182870b6334691a114c7b93a0f07032588ff7/src/lib/cluster/remote-slot-files.mjs#L228)
- [src/lib/protocol/handle-protocol.mjs:1358](https://github.com/liubing0806/vm2api/blob/08a182870b6334691a114c7b93a0f07032588ff7/src/lib/protocol/handle-protocol.mjs#L1358)
- [src/lib/pool/failover-runner.mjs:1167](https://github.com/liubing0806/vm2api/blob/08a182870b6334691a114c7b93a0f07032588ff7/src/lib/pool/failover-runner.mjs#L1167)

触发条件：节点连接后的首次目录准备尚未完成缓存；请求在提交模型作业前发布 telemetry touch；远端 `mkdir/chmod/chown` 因权限或磁盘错误正常退出，并已收到非零退出码和通道关闭。

可证实调用链：

1. `touchTelemetrySession` → `pushTelemetryTouch` → `queueSlotPush` → `pushSlotFiles` → `prepareRemoteDir`。
2. [ssh-link.mjs:167](https://github.com/liubing0806/vm2api/blob/08a182870b6334691a114c7b93a0f07032588ff7/src/lib/cluster/ssh-link.mjs#L167) 保存退出码，收到 `close` 后返回。[remote-fs.mjs:115](https://github.com/liubing0806/vm2api/blob/08a182870b6334691a114c7b93a0f07032588ff7/src/lib/cluster/remote-fs.mjs#L115) 将非零退出转换为普通异常。此时前台命令已经结束，`openSftp` 尚未执行。
3. queue 对所有异常无条件添加 `vmOperationUncertain` 和 `executionUncertain`。
4. protocol 再无条件标记执行准入、API key 准入和请求活动未知。runner 在 `callEntered=false` 时仍接受该未知标志并停止。
5. 普通释放不能清除 `execution_admissions.uncertain_at`；protocol 的释放条件也排除未知 API key 准入。

影响：没有模型作业、没有未结束远端命令的普通失败，会持续占用账号和 VM 容量。并发上限为 1 时，后续请求被拒绝。请求活动未知还会阻止全局维护。HTTP 返回或结束不会清除这些 PostgreSQL 状态。

最小修复：保留远端命令的明确结束证明，并贯穿 queue 和 protocol。已确认结束的准备失败按普通失败处理；缺少结束证明的发布失败继续保留未知准入。仅修改 queue 不够，protocol 当前仍会无条件重新添加未知状态。

交主会话的合成复现，本轮未执行：

1. 使用隔离 PostgreSQL、合成节点 VM，以及并发上限为 1 的执行准入和 managed API key。
2. 保留实际 touch、queue、`prepareRemoteDir` 和 runner。合成 SSH 通道依次发出 `exit(1)`、`close`，错误内容使用普通合成字符串。
3. 断言 SFTP 未打开、模型调用次数为零、远端退出已确认。
4. 请求结束后检查执行准入、API key 准入和请求活动。当前源码路径会留下未知且未释放的记录；预期普通失败可以释放。另保留断连场景，确认缺少结束证明时仍保留准入。

**上一轮五项逐项复核**

以下“已修正”仅指指定触发路径的静态源码结论。

| 项目 | 状态与依据 |
|---|---|
| 1. Go worker 首次刷新未知被后续明确失败覆盖 | **已修正。** `worker/internal/oauth/refresher.go:197` 遇到未知立即停止重试；`:142` 不再用后续文件观察覆盖未知。`oauthcmd/oauthcmd.go:348` 输出未知标志，`src/lib/transport/slot-oauth.mjs:238` 将其排除出完成证明。 |
| 2. package Codex quota 嵌套未知被吞后释放 | **已修正。** `src/lib/vm/shared-vm-operations.mjs:223` 在嵌套返回未知或抛出未知异常时直接标记继承的操作。额度层仍会压平返回值，但外层正常返回不能清除该操作的未知状态。 |
| 3. manual Codex refresh 绕过共享账号声明 | **已修正。** `src/lib/admin/panel-routes.mjs:5262` 取得 VM 操作；`:5283` 调用共享 Codex 刷新；`:5289` 保留未知。嵌套共享刷新会核对并补充账号声明。 |
| 4. package bootstrap 普通已结束失败误标全 pool unknown | **已修正。** `src/lib/admin/panel-routes.mjs:889` 使用 `officialCcBootstrapFinished` 作为执行完成判定，业务 `ok:false` 保留在 `value`，不会再单独触发原来的未知判定。 |
| 5. 同账号另一执行拒绝刷新后，已结束首 job 永久 unknown | **已修正。** `shared-credential-refresh.mjs:198` 确认未启动任务完成后传播标志；`kernel-router.mjs:322` 保留原 job 已结束证明；`failover-runner.mjs:526`、`:1083`、`:1143` 据此停止并允许普通释放。 |

**已覆盖与未验证范围**

已读取增量及必要完整调用链，覆盖：

- private node authority 的 schema、meta、view、feature marker，以及业务 restore 的依赖和 epoch 隔离。
- `SECURITY DEFINER`、固定 search_path、节点 reader 权限、grant 发行与撤销锁序、Go pgx 授权窗口、默认拒绝管理 RPC。
- allocation receipt 的校验、持久化、同 intent 重读，以及节点 management binding 的持久检查。
- SFTP queue 原始 Promise，以及 start、reload、worker、supervisor、protocol、panel、routing 的等待和异常消费。
- 共享 circuit、KSG2 原始 Fence、持久绑定及节点完成证明；另复核 active endpoints 清理和 watchdog bridge claims。

未执行测试、服务、网络、数据库、Docker、Kubernetes、SSH或生产操作。真实并发、断连时序、磁盘持久化和 worker 制品行为均未动态验证。角色安装按测试或管理员显式流程评估；未将尚未启用的生产 grant、初始创建路径或多节点 HA 记为缺陷。

`ControlPlaneLock`、`replicas: 1` 和 `Recreate` 仍保留。**本报告不批准发布。**