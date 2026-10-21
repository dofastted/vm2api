# HA 请求的显式孤儿恢复

本阶段提供显式服务，不安装定时器，也不在 server 自动调用。仅支持服务器明确标记 `recoveryKind: 'claude_messages'` 的 HA 普通 Claude Messages 与已支持的 OpenAI 转换路径。旧行默认 NULL，不能从 HTTP 路径字符串或同名 request ID 推断恢复资格。

## Owner 退出证明

`GlobalMaintenanceCoordinator.start()` 在专用 activity PG 连接上取得 owner session advisory lock，然后才登记 `owner_lock_version=1` 的成员。锁没有 TTL，连接关闭或进程 SIGKILL 才释放。成员 UUID 不允许重新登记。旧私有 schema 增加 nullable 列，旧成员仍为 NULL；无锁不构成其退出证明。

`lockAbsentOwner(ownerId)` 只允许在当前活跃 activity 的短 PG 事务调用。它核验 open epoch、成员协议版本，并尝试同键 transaction advisory lock。`HaRequestRecovery.seal(requestId)` 在同事务锁定精确 parent 与原 activity，随后关闭 parent 的 child 准入。它不按 owner 批量处理请求。未知历史协议、epoch/owner 不匹配、一个 activity 对应多个 parent、尚未结束的 activity handoff operation 均拒绝。

## 原节点终态

`recover(requestId, {readCompletion})` 封闭 parent 后释放数据库事务，再逐一调用：

```js
readCompletion({requestId: originalCommandId, nodeBinding: originalPgBinding})
// -> {id, fence, status: 'completed', dispatched: true}
```

调用方必须用可信固定 TLS 链接查询原 node。Go `recovery-status` 返回 `found:true` 时才可提取 `command`；`found:false`、未 dispatch、pending、unknown、失联、不同 command/Fence 均不能释放。服务不读最新 node State，也不依赖死 Pod 的 ticket。已持久化的原 completion 可以直接复核。

所有关联来自 019 的 parent/admission/attempt/job 外键与显式字段。服务再次核验原图，在 parent→device→account→VM→session 的锁顺序下原子记录 completion 并归还该 parent 的执行准入、席位和会话 turn；席位宽限期采用 PG 时间。原 uncertain_at 保留在审计行，重试不延长宽限期。无 bound job 的已封闭受支持请求可归还执行资源，因为该协议在任何节点提交前必须持久 bind。

原节点正常 completed 仅依赖现有 kernel 正常终态加 EOF 的协议假设。它不证明未知异常的 provider 行为已经结束。未 dispatch 的已绑定 command 仍需要节点持久 tombstone 或后续可靠停止证明，本阶段保留占位。

## API key 对账

021 在实际 job bind 的短事务内保存 dispatch 前价格快照，包含 model 的 resolved rates/modes/tiers、group multiplier、实际 cache TTL 和请求 speed。后续改价不改变已提交快照。正常 handler 将最终 result.execution.requestId 持久选为 billable command；服务用原节点 recovery-status 的公开 receipt 结算。派发和结算都不读取 Pod 凭据文件。

`ApiKeyStore.recordHaUsage({reservation,commandId,nodeStatus})` 与恢复服务共用同一 parent/key/reservation 事务和唯一 `ha_request_settlements` 行。它更新原 key 的请求/token/USD 与 5h/1d/7d 窗口。现有推理链不扣 users.balance，本阶段保持该规则。key 已删除仍写 key_deleted 审计；原 reservation 已 settled 则写 already_settled，不重复增加计数。正常 handler 的 outer finally 负责 release；孤儿执行图已恢复后才原子结算并 release。

恢复仅选择已有持久 billable command，或 sealed parent 的唯一原 job。多 command 缺最终选择、usage_complete=false、缺实际 model/四项主计数、原 snapshot 无价格或模型不匹配时，API key claim 继续保留。不会猜最高 attempt、累加多 attempt 或按 0 结算。无 job 的 sealed/execution_recovered parent 可以写 not_dispatched，释放未使用预留且不增加请求数或金额。

receipt 仅允许 ID、实际 model、usage_complete、规范 decimal-string 的主计数、缓存时间拆分、web search 次数与明确 speed/service_tier/stop_reason。计数进入 PG bigint 时保持精确字符串；USD 仍沿用现有 double precision schema 与价格计算规则。账单独立保留原 receipt、binding 和 snapshot；不保存响应正文、headers 或凭据。

## 分页发现与保留

`scan({limit:20,afterRequestId:null})` 返回 `{results,nextCursor}`。它在当前真实 activity 内只读发现 recovery_kind=claude_messages、原 activity/owner/epoch 一致的候选，随后每条 recover 再证明 owner session lock 已空闲。单条错误不终止其余条目，cursor 防止未知旧条目占满同一页。settled 但未 release 的原预留仍需处理；全部资源和额度已结束才排除。服务本身没有 timer。

历史清理保留仍有 active API key/执行资源、parent 尚未封闭、恢复未结束或原 activity 未确认 completed 的原始图。attempt cleanup 在精确 parent 锁下判断，与恢复读取互斥。正常已结束且无这些依赖的历史仍遵循旧清理策略。长期财务审计保留在 settlement 行，不依赖 admission/job 的短期历史。

新 HTTP/异步请求可能继承已关闭的 HA context。新 context 仅在新真实 coordinator gate 的 scope 下允许建立；继承的 active context 仍拒绝嵌套，原 activity 无法借 closed context 重新建立 parent。attempt context 共用父 context 的关闭状态。
