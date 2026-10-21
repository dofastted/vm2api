# Kubernetes 共享状态与请求接线验证（#648，进行中）

固定源码提交：`6732a8648a4a57c6483abc7f685fce4d8cb28946`。本轮在独立检出执行全量检查，并以该提交构建候选镜像，在单节点 k3s 完成 12 项单活动控制面检查。控制面仍使用独占保护和单活动副本；这些检查尚未满足 #648 的多节点扩缩容与异常退出验收。后续认证、后台任务及执行生命周期增量没有部署到该镜像。

## 已实现的增量

- 账号计数使用 PG 原子增量。身份和策略使用字段补丁。响应头、OAuth usage、probe、worker heartbeat 使用在远端 I/O 前取得的数据库观测序号，拒绝迟到观测；本地异步序号分配也保持调用顺序。账号缓存刷新保留当前进程的活动请求状态。
- 代理配置、绑定和健康状态按行提交。健康及地理位置结果校验配置版本，不再删除重建整张代理表。调用方等待持久提交；刷新读取已提交快照，不等待网络 probe。
- SchedulingRuntime 按字段及模型合并运行状态。配额清理和冷却副作用使用 PG 条件更新的实际结果。旧观测被拒绝时，不修改 VM 限制和当前粘性会话。
- 同会话请求使用 PG FIFO。当前 turn 只有在执行结束和容量释放后才交给下一请求。未知执行和 owner 异常退出保留占位，无 TTL 自动回收。等待队列中的 owner 死亡也尚未自动清理。
- Sticky 使用 PG generation 条件更新和解绑墓碑。首次绑定及墓碑后的绑定都受版本约束。Claude 和 Codex 在实际发送前等待原生会话绑定；条件冲突不发送旧请求体。迟到完成不能恢复其他副本已迁移的绑定。
- Codex 复用持久账号/VM/RPM 准入、作业登记和同会话 FIFO。每个实际 kernel hop 有不同 request ID。截断、取消和数据库完成/释放失败保留容量，停止重试。Kubernetes 模式暂要求凭据文件只有一个带稳定 `chatgpt_account_id` 的账号；不能确认内核实际选择账号时拒绝发送。
- 路由配置以 PG 中带 revision 的配置为准。首次从只读文件初始化，之后不以 Pod 文件覆盖 PG。互补 patch 在 PG 最新值上合并。同步消费者读取已提交快照；请求前和定时刷新更新本地策略。候选携带产生它的 revision，在准入事务中先校验配置，再取得账号/VM/设备锁。配置写入会等待该准入事务提交。
- VM 变更使用持久操作记录，与推理准入互斥。已接入凭据导入、credits 查询/兑换、reset 和 clearcredentials 四条调用链。错误和未知远端结果保留操作记录。它不覆盖其他 VM 管理入口，也没有改变远端 Claude 凭据清理的既有行为。

## 全量检查

环境为 Node.js 22.23.2、任务专用 PostgreSQL 17.11、每测试随机 schema、合成 HTTP/Unix socket 上游。测试使用独立制品副本；没有操作真实 VM 或模型供应商。

| 检查 | `6732a864` 的结果 |
| --- | --- |
| 全量 unit | 318 文件，3675 项：3658 通过、7 失败、10 跳过 |
| 全量 E2E | 28 文件，122 项：104 通过、17 失败、1 跳过 |
| 本轮 78 个 MJS 文件语法与 Biome | 通过 |
| `git diff --check fb90450d..6732a864` | 通过 |

7 项 unit 和 17 项 E2E 的失败名称及断言文本，逐项匹配此前 `fb90450d06fd3aaaee8a0a4b52aca13d2f675431` 的记录。未把这些失败改成通过或跳过。例如 unit 实际 TTL 为 `1h`、预期 `undefined`；E2E Responses 实际为 400 `protocol_not_allowed`、预期 200。

本次没有重新执行原始 `eee8f6e` 的整套测试。7 项 unit 在原始源码上的复核、17 项 E2E 的既有对照来源，见 [上一轮共享执行报告](2026-10-21-kubernetes-execution-results.md)。结构化统计及错误摘要哈希见 [本轮证据](evidence/kubernetes/shared-snapshots/verification.json)。完整测试日志保留于任务临时目录，证据包含其 SHA-256。

## `6732a864` 的实际单实例部署

候选镜像为 `vm2api:kubernetes-6732a864`，运行于本机单节点 amd64 k3s。临时 Dockerfile 仅在开头增加 `ARG BUILDPLATFORM=linux/amd64`，供 legacy builder 解析原有 `FROM --platform=$BUILDPLATFORM`，没有加入功能补丁。测试使用独立 PostgreSQL、合成上游和任务命名空间 `vm2api-k8s-649-77d914a4a9`；该命名空间已清理。

- OCI manifest：`sha256:db695e30d1ae3165bc88003f134584761db40dba09f1166e364b7dd9af683d05`。
- manifest config 与实际 Pod imageID：`sha256:e1b150ae36e2a80e785eb62b899aa144e4ad05692da05290e757489727451118`。

Pod imageID 对应 manifest 中的 config digest，不能与 OCI manifest digest 混用。构建制品、containerd 映射和实际 smoke 输出见 [部署证据](evidence/kubernetes/singleton-6732a864/verification.json)。

12 项检查全部通过：Pod 就绪、Service DNS/ClusterIP、探针与控制台、Cookie 登录与 PG 指标、API key 创建、托管 key 推理、真实 Go API kernel 的 JSON/SSE、两条请求日志、第二控制面拒绝、Recreate 重启、PG 会话与 key 保留、PVC 文件保留。实际 SSE 响应头在 29.0ms 到达，两段正文分别在 29.1ms 和 1030.0ms 到达，HTTP 在 1216.5ms 结束。本次唯一文本为 `kubernetes-proof-77d914a4a9f4`。

这些结果验证单活动控制面的实际容器行为。它们没有验证两个活动副本、跨节点执行、自动扩缩容或故障接管，也不构成高可用（HA）验收。

## 后续提交的定向检查

这些结果没有替代后续源码的全量回归：

| 提交 | 检查范围与结果 |
| --- | --- |
| `12f19167ae5b2544add8e2a719993b5c972c644e` | PG 冷却副作用、共享调度与会话保护：170/170 通过 |
| `06d841cd5fb5d81366cf0a7684b408fcd7368ac3` | 配置 revision、准入事务和锁顺序：44/44 通过 |
| `c5f6ff3d1e3728c74ceb630929bc876298322a2a` | Codex 与 Search 生命周期：145/145 通过 |
| `97b4a087ae486814ffdc912f7b662fdeb2e387ff` | 路由面板接口与 VM 变更：34/34 通过 |
| `b32641b84aebb3f4beac656e09c59beee8c78270` | kernel 未确认错误、现有 payload 取消与 Claude/Codex 共享占位：228/228 通过 |
| `08998f406eb7a2bf7ac3512d4b20895879cc2829` | API endpoint 执行 hook、终态与 PG job：72/72 通过 |
| `bdda2026dca0ed5905c70514bc3fad94e727a53e` | 固定源码归档上的请求 activity hook 接线：75/75 通过 |

前两项提交位于全量检查点之前。后两项在其后。Search 直接 HTTP 请求只有在响应体读取完成后才结束作业；401/403 重发前完成旧作业并使用新 ID。响应体截断、取消、超时及 PG 故障保留容量。Search 不增加原协议没有定义的同会话队列。

面板路由更新显式返回已提交 revision 和 application 状态。VM/kernel 投影未执行时返回 pending。PG 提交失败不回退到可能过期的本地配置，也不在提交前切换执行端引擎。

后续发现普通 EOF 假设的例外：现有 `kin-kernel`/`cli-node` 在合成上游保持 SSE 时，外部 cancel 返回 200 `cancelled:true`，原请求随后可返回完整 HTTP 502 `worker_error/provider_error: client disconnected`。`b32641b8` 对这类取消、内部 transport/timeout 和无法确认的 kernel 错误保留 `ended=false`，停止共享执行重试及容量释放。普通完整响应和明确供应商拒绝保留原有 EOF 语义。`ready_slots` 是汇总状态，不含 request ID 或 epoch，不能证明单个 job 已结束。

`e854273a5d7016c160a24237ef9aeac3df0cf988` 修正 Go API proxy 在 `io.Copy` 失败时正常结束响应、隐瞒上游 body 截断的问题。`08998f40` 和 `bdda2026` 接入 API endpoint 及请求 activity 的发送前登记和读取结束确认。取消、超时、截断、`upstream_transport` 或 SSE 缺终态不释放未知执行。源码验证与现有 payload 反例见 [后续生命周期证据](evidence/kubernetes/singleton-6732a864/later-lifecycle.json)。这些修正及新的认证、后台任务/全局维护代码没有部署到 `6732a864` 候选镜像。

## 未完成和未验证

- 后台任务共享执行、跨副本一次性 OAuth/终端 ticket、全局维护和请求 activity 的后续源码增量，尚未完成新镜像的部署验收。
- VM/凭据文件的权威来源、其他 VM 管理入口、共享熔断和跨 VM 组织兑换等仍需继续核实和实施。
- VM/kernel 远端配置投影为 pending。PG 配置提交不证明执行端已更新。
- 当前 HTTP/SSE 结束标记依赖正常执行端协议。执行端 epoch 校验、旧作业终止证明和 owner 死亡后的自动恢复尚未实现。未知占位没有自动回收。
- 两个不同 Kubernetes 节点上的活动副本、HPA、PodDisruptionBudget、滚动更新、缩容和异常退出接管尚未验证。单节点 `6732a864` 镜像的 12 项检查不覆盖其后的源码增量。
- Draft PR #651 的已发布分支仍是早期部署基础。后续本地增量尚未 push；按用户规则等待 push 确认。
