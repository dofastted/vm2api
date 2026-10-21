# Kubernetes 控制面实现计划（#648）

日期：2026-10-21。分支：`codex/kubernetes-control-plane`。
依赖：`codex/postgresql-migration@cf9462d5`（#647）。

## 目标和验收条件

目标为 #648 的 Kubernetes 部署与多活动控制面水平扩容。至少两个副本须部署在不同节点，同时承载重叠请求；认证、配置、业务数据和全局限额保持一致；后台任务不重复，异常退出后能够安全接管；HTTP、SSE、WebSocket、扩缩容和滚动更新均需运行验证。全部推理转交给单个 leader 不能代替此验收。

当前 Draft PR #651 和以下第一阶段结果尚未满足全部条件。后续增量继续在同一分支实现，不关闭 #648。

## 第一阶段范围和完成条件（历史）

本次先提交可运行、可评审的 Kubernetes 部署基础 Draft PR。默认只允许一个活动控制面。控制面多副本同时处理推理尚未具备安全条件，本 PR 不关闭 #648，也不将单副本部署称为水平扩容。

完成条件：

1. 提供原生 Kubernetes/Kustomize 资源和部署说明；不用宿主 Docker socket、hostNetwork、hostPath 或特权能力，控制面连接外部 PostgreSQL。业务文件使用持久卷，本地二进制和进程 socket 使用临时目录。
2. 使用显式 Kubernetes 运行模式。部署默认一个副本和 Recreate 策略。启动前取得 PG 独占控制面锁，误扩容时第二个实例在业务初始化之前失败；失去锁时拒绝新请求并排空退出，禁止悄悄运行多个写入者。
3. `/healthz` 保留存活语义；新增 `/readyz` 检查初始化、PG、控制面锁、维护和排空状态。SIGTERM 先停止准入，在限时内等待 HTTP/SSE 与活动 WebSocket 请求及持久化完成，再停止本地运行组件和数据库。
4. Kubernetes 模式的面板会话存 PG。验证跨连接登录状态、注销、改密撤销及过期行为；令牌只存摘要，故障时不回退到旧本地会话缓存。
5. 通过针对性的独立 PG 测试、双进程独占保护测试、真实 Kubernetes Pod/Service/探针与 HTTP 验证。只创建本任务独立测试资源；不修改现有部署或其他命名空间。
6. 推送独立 fork 分支、尝试创建依赖 #647 的上游 Draft PR，并在 #648 评论中注明实现范围、验证 SHA、PR/分支链接和剩余项。

## 为什么暂不开放多副本推理

当前 key/user/账号/VM 并发与 RPM、Claude 座位、Codex 会话、同会话请求顺序、熔断及 OAuth single-flight 仍有进程内状态。AccountQuota 和 ProxyPool 的缓存快照存在跨实例覆盖问题。RuntimeSettings、路由、模型策略和 Sticky 映射也没有跨实例一致性协议。

更关键的是，远端执行取消目前是 best-effort。控制面失联后，不能仅因租约过期就重新分配仍可能执行中的账号/VM 容量。安全的多活需要执行端 fencing 或可确认终止的 orphan 处理协议。活凭据、VM 文件和 Pod 本地 socket 的归属也必须先明确。

因此，本阶段提供独占保护和必要基础，不能通过修改 `replicas` 绕过限制。单副本 Pod 重启和跨节点数据可用性仍取决于持久卷；本机单节点验证不能证明多节点高可用。

## 文件分工

- 数据层：新的 PG 迁移、面板会话 repository、独占控制面锁及其测试。
- 生命周期：server、security、WebSocket 排空、探针及相关测试。
- 部署：`deploy/k8s/`、容器入口、独立集成测试和部署文档。
- 集成：本计划、测试环境、PR 和 Issue 评论。

## 后续多副本验收

后续必须使用至少两个不同节点上的活动副本，验证全局准入/限流/座位、配置同步、认证和一次性票据、原子计数、任务唯一执行、全局维护，以及故障后的 fencing 和安全接管。不同副本须同时处理重叠推理请求；不能以将全部推理转发给 leader 代替水平扩容。

## 多副本实施增量（进行中）

#648 的完成条件仍包含两个不同 Kubernetes 节点上的活动副本同时处理请求，以及扩缩容、滚动更新和异常退出。单活动部署仅是已完成的第一阶段。本轮继续实现跨副本共享状态，没有将目标缩减为只支持 API endpoint。

在 `bf9f508d` 上已实现的增量：

- `api_key_admissions` 通过 PG 事务、密钥锁和用户锁原子协调密钥/用户并发、密钥 RPM 和请求数额度。请求计数与 pending 额度结算同事务；释放幂等且保留 RPM 历史。删除执行中的密钥仍保留用户并发占位。
- HTTP、SSE、Codex Responses/Search 与 WebSocket 每个推理请求均使用同一预留接口。WebSocket 握手不预留推理容量。计费完成前保留占位；执行后异常或计费结果不明时保留持久占位。
- 网关 token bucket 存 PG，使用取锁后的数据库时间。存储键为摘要；PG 故障不会回退到各进程分别限流。
- 每次 API endpoint 调度及模型目录读取前刷新 PG 数据。自动 cooldown 只延长截止时间；管理员显式清除继续可用。
- 设置快照显式刷新，防止迟到查询覆盖较新的本地提交或已发布快照。Kubernetes 认证前刷新设置，并同步更新 Claude/GPT 模型及价格缓存；读取路径不执行策略迁移或默认值回写。

当前没有开放多活动控制面，独占锁与 `replicas: 1` 保留。新增的共享预留没有 TTL，不会把仍可能执行中的容量自动重新分配。进程死亡后的自动回收尚需执行端 fencing 和可确认终止的协议。

接下来的必要工作：

1. 将账号/VM 并发、账号 RPM、设备座位、同会话顺序、Sticky 映射及运行态变更纳入共享原子协调；控制整行快照写入冲突。
2. 明确远端执行请求和控制面 owner/epoch 的绑定，覆盖 TLS gate、SSH fallback、UDS、Codex/Search 与 VM 生命周期命令。确认旧执行终止后才允许回收占位。
3. 协调后台任务、全局维护、备份恢复和凭据刷新；完成 routing/VM/凭据文件的共享存储与更新协议。减少每请求全量设置读取的成本。
4. 全部条件具备后再允许两个活动副本，补充 HPA、PodDisruptionBudget 和多节点部署，并验证并发、滚动更新、缩容与故障接管。

本轮运行证据及未验证项将在增量验证报告中记录。第一阶段的镜像 digest 与 k3s 结果只覆盖当时源码，不能用于证明本轮新代码已部署。

## 共享执行准入增量（进行中）

`fb90450d` 已加入账号/VM/Fable/RPM 的共享准入、设备座位与 generation、发送前实际 kernel request ID 绑定，以及未知执行保留和停止重试。设备预算按账号跨 VM 计算。standalone 保留原同步调度路径。详细结果见 [共享执行验证](2026-10-21-kubernetes-execution-results.md)。全量 unit 为 3493 pass、7 fail、10 skip；全量 E2E 为 103 pass、17 fail、1 skip。失败差异和基线依据均在报告中列出。

当前队列仍为进程内队列。同会话顺序和 Sticky 的跨副本条件更新未完成。HTTP/SSE EOF 终态还依赖正常 kernel 协议，尚无执行端 fencing；控制面死亡后的占位没有自动回收。独占锁和单副本限制继续保留。

下一阶段需优先拆除整行快照覆盖：AccountQuota 的计数改为 PG 原子增量，响应头/probe 改为有数据库观测顺序的字段补丁，身份与并发/RPM 配置使用管理补丁。`panel-api` 的显示检查、Fable probe、手工清理以及 `panel-routes` 的身份修改也会调用整行 `save`，需要同时覆盖。保留已有 bigint 精度和 `countRequest:false` 行为。ProxyPool 的 probe 当前仍调用 `replaceAll` 删除重建代理表，需要拆成目标行配置、健康、绑定及删除操作，并校验 probe 对应的配置版本。
