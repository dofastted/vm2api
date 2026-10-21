# Kubernetes 共享执行准入增量（#648，进行中）

本轮继续实现账号/VM 准入、设备座位与执行状态绑定。两个活动控制面尚未启用。`replicas: 1`、Recreate 和独占控制面锁仍保留，本轮结果不满足 #648 的多节点验收条件。

## 变更范围

- `execution_admissions` 原子协调账号并发、VM 并发、账号 RPM 和 Fable 并发。账号和 VM 上限分别计算。释放后保留 RPM 窗口记录；活动记录没有 TTL，不因时间经过或控制面断开而重新分配。
- `execution_seats` 与请求准入在同一事务中分配。设备的 VM、slot index 和 generation 从 PG 读取。有效座位数量按 VM 检查容量，按账号检查预算；同一账号跨 VM 共享预算。未知执行继续持有座位；最后一个已确认请求释放后才开始 grace。
- `execution_jobs` 在发送前将实际 kernel request ID 绑定到持久准入。同一准入不能同时绑定两个未结束作业。释放在锁定准入行后重新检查 pending 作业；迟到的旧作业结果不能释放后来绑定的作业。
- Kubernetes 调度器等待异步准入，进程内 inflight 不覆盖 PG 的容量判断。保留 standalone 同步路径。异步排队处理拒绝、错误、取消后的迟到准入及释放；退出时等待调度器任务。等待队列目前仍属于各进程，未实现全局 FIFO。
- 工作客户端返回实际 kernel request ID 与 `execution.started/ended/reason`。普通响应的 `ended=true` 由完整 HTTP 响应或 SSE EOF 推断，依赖正常 kernel 协议在结束响应前停止对应执行的约定，尚不是独立的执行端终止证明。kernel 内部未确认错误是例外：现有 payload 在取消后可返回完整 HTTP 502 `worker_error/provider_error: client disconnected`，不能据此判定执行结束；此类取消、内部 transport/timeout 及无法识别为明确供应商拒绝的 kernel 错误保留 `ended=false`。超时、连接中断和取消请求的成功返回不能作为执行结束证明。`ready_slots` 是汇总状态，不带 request ID 或 epoch，不能作为单个 job 的结束证明。此元数据仅供控制面内部使用。
- 共享准入下，kernel router 等待作业结果（包括结束未确认）写入 PG。未确认结束时禁止隐式重试。FailoverRunner 同时停止跨账号重试，并保留账号/VM 和 managed key 并发。用量结算与执行结束分别判断。
- 作业绑定或完成记录失败时不继续发送新执行。mock 和预先取消而未提交的请求不完成未注册的作业。

## 修复前的实际差异

先提交失败测试，再提交对应修复。除新增行为规格外，本轮独立审查还复现了以下问题：

- 迁移被目标 VM 拒绝后，原 grace 座位实际为 `null`，预期保留原 VM 和 generation。
- 同一账号跨两台 VM，各新座位预留 0.02，账号 headroom 0.03。第二个座位实际获准，预期 `seat_budget` 拒绝。
- 第一次 PG 释放失败后，后续 release 重复返回同一个拒绝的 Promise，没有重试 SQL。
- 未知状态标记尚在持久化时，普通 release 曾先释放容量，PG inflight 实际为 0，预期保留 1。
- 截断传输曾触发第二次 kernel 请求，实际作业数 2，预期 1。
- mock 和预先取消未提交的请求曾调用完成回调，实际调用 1 次，预期 0 次。

## 验证结果

验证提交为 `fb90450d06fd3aaaee8a0a4b52aca13d2f675431`。测试使用本任务 PostgreSQL 17.11 的随机 schema、Node.js 22.23.2 及 Unix socket 合成 kernel；没有调用真实模型，也没有修改现有业务环境。

| 检查 | 结果 |
| --- | --- |
| 本轮变更的 13 个测试文件 | 181/181 通过，包含迁移/备份 31 项和 Unix socket 共享执行生命周期 5 项 |
| 全量 unit | 301 文件，3510 项：3493 通过、7 失败、10 跳过 |
| 全量 E2E | 28 文件，121 项：103 通过、17 失败、1 跳过 |
| Node 语法、Biome | 本轮 22 个 MJS 文件通过 |
| `git diff --check 919c4e5e..fb90450d` | 通过 |

全量回归仍有失败。7 项 unit 失败已在原始 `eee8f6ecb6ca04455e6edef0c8e498fb3be21f21` 上重新执行；测试名称、断言位置及实际/预期差异逐项相同。例如实际 TTL 为 `1h`，预期 `undefined`。归档中 698 个源码、测试、脚本及 package 文件与该提交的 git blob 核对一致。

17 项 E2E 失败的断言文本与上一轮已核实基线记录相同，本轮未重新运行原始提交的整套 E2E。例如 Responses 实际返回 400 `protocol_not_allowed`，预期 200；classifier 的 thinking 实际多出 `display: summarized`。未将这些失败改成通过或跳过。

结构化结果与日志摘要见 [验证元数据](evidence/kubernetes/execution-state/verification.json) 和 [原始 unit 复核](evidence/kubernetes/execution-state/baseline-unit-recheck.json)。上一轮原始 E2E 对照见 [既有基线记录](evidence/kubernetes/shared-state/baseline-e2e.json)。本轮没有重新部署容器，验证 SHA 仅标识被测试的源码。

## 尚未完成

- 同会话跨副本顺序、全局等待队列、Sticky generation 的数据库条件更新。
- AccountQuota、ProxyPool、SchedulingRuntime 的字段级原子更新及配置同步优化。
- Codex/Search 全部执行和会话状态的共享协调。
- 执行端 epoch/fencing、未知作业的终止证明、控制面死亡后占位的安全接管。当前保留未知占位，尚未提供自动恢复。
- routing、VM/凭据文件共享归属、后台任务唯一执行、全局维护及备份恢复。
- 两个不同 Kubernetes 节点上的活动副本、HPA、PodDisruptionBudget、滚动更新、缩容和故障接管。

第一阶段镜像与 k3s 证据不覆盖本轮新增源码。本轮没有重新部署，不能用旧镜像 digest 证明当前代码生效。Draft PR #651 的远端分支更新仍等待用户确认 push。
