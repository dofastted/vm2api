# Kubernetes 控制面实现计划（#648）

日期：2026-10-21。分支：`codex/kubernetes-control-plane`。
依赖：`codex/postgresql-migration@cf9462d5`（#647）。

## 当前范围和完成条件

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
