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

## 计费与维护限制

本阶段不写 usage、model、请求成功状态或金额，也不释放 API key reservation。缺少节点用量、实际模型和 PG 定价快照时，不能按 0 结算。API key 的业务 claim 继续阻止破坏性维护。恢复不会释放任何 VM operation、background task 或其他 parent 的资源。

后续用量回执应在节点 completed 的同一 journal 事务持久化，通过原 node binding + command ID 关联 `execution_jobs`。回执仅包含 receipt ID、实际 model、usage_complete 和明确计数白名单；缺字段不得补 0，不保存响应正文、headers 或凭据。控制面按原 pricing snapshot 结算；它不能重发原 command 或重新 mint grant。

历史清理保留两类原始执行图：仍有未 release 的同 parent API key reservation；已封闭但 execution_recovered_at 仍为空的 parent。正常已结束且无这些待处理关联的历史仍遵循旧清理策略。节点 proof 的长期独立审计存储和完整计费恢复尚未实现。

新 HTTP/异步请求可能继承已关闭的 HA context。新 context 仅在新真实 coordinator gate 的 scope 下允许建立；继承的 active context 仍拒绝嵌套，原 activity 无法借 closed context 重新建立 parent。attempt context 共用父 context 的关闭状态。
