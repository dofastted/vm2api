# Kubernetes 控制面验证报告（#648，Draft）

日期：2026-10-21。已验证源码：`6589eab3ca1179250a24c6ee5a5fee5e738e7f47`。分支：`codex/kubernetes-control-plane`，依赖 PostgreSQL 分支 `cf9462d5`（PR #649）。后续交付提交只补充文档和脱敏证据。

## 实现范围

已实现单活动控制面的 Kubernetes 部署基础。默认一个副本、Recreate 更新策略；第二个控制面在业务初始化前被 PostgreSQL 独占锁拒绝。面板会话持久化到 PG，只保存令牌摘要。新增就绪检查；退出前停止准入，等待 HTTP、SSE、WebSocket、终端实际关闭及最后一次持久化。容器不需要宿主 Docker socket、hostNetwork、hostPath、特权或 Kubernetes API token。

此阶段不开放多副本同时处理推理，不关闭 #648。账号、VM、用户和密钥的全局准入/限流、配置缓存一致性、任务唯一执行、全局维护和远端执行 fencing 尚未实现。部署说明保留单副本限制，不提供 HPA。

## 验证结果

测试使用本任务创建的专用 PostgreSQL 17.11、合成上游和唯一 Kubernetes 测试命名空间，没有迁移现有部署或使用真实供应商凭据。

| 检查 | 被验证提交 | 结果 |
| --- | --- | --- |
| 锁、生命周期、会话、认证/ACL、WebSocket/终端及 K8s E2E | `1366e203` | 12 文件，119/119 通过 |
| 数据库、SQLite 导入、指标和备份 | `6589eab3` | 44/44 通过，含旧 PG 快照恢复、跨 schema 外键/分区拒绝 |
| Node 全量 unit | `1366e203` | 285 文件；3350 通过、7 失败、10 跳过；7 个断言与原始 `eee8f6e` 逐摘要相同 |
| Node 全量 E2E | `6589eab3` | 27 文件；101 通过、17 失败、1 跳过；17 个断言与原始提交逐摘要相同，无清理超时 |
| Go API kernel | `11ee7dc1` | `go test -race ./...` 通过，新增真实 HTTP 流式回归 |
| Python 部署 | `6589eab3` | 33/33 通过，含清单、入口与测试资源所有权检查 |
| 格式与语法 | `6589eab3` | 本次 22 个 MJS 格式检查、Go 格式、shell 语法及 diff 检查通过 |
| 实际 amd64 容器与 k3s | `6589eab3` | 候选镜像构建成功；12 项运行检查通过，退出 0；测试命名空间已删除 |

全量测试仍有基线失败，不能标记为全绿。例如 unit 实际 cache TTL 为 `1h`、预期 `undefined`；既有 E2E 包含 thinking 多出 `display: summarized` 的差异。原始基线记录在 PostgreSQL 证据目录；本次对照见 [unit](evidence/kubernetes/baseline-unit.json) 与 [E2E](evidence/kubernetes/baseline-e2e.json)。最后的备份边界修复另以 44 项定向测试验证；没有重跑全量 unit。

## 实际 Kubernetes 行为

本机 `cube-local` 为单节点 amd64 k3s，存储使用 local-path RWO。只创建并删除带本次唯一标签、经 UID 核对的测试命名空间。未修改其他命名空间、集群配置或已有服务。

唯一候选标签：`vm2api:kubernetes-6589eab3`。

- containerd manifest：`sha256:a2d4d0ffa17e833eac84c466bc13ccc0985872a277d092cf63cf5d95c29a2340`。
- manifest config / 实际 Pod imageID：`sha256:2bf42f9e9d5fd7c652dca757e62e69c79364dfc5f548338eddcbcd87ef688dce`。

实际验证 Pod 就绪、Service DNS/ClusterIP、探针与控制台、Cookie 登录、PG 指标和托管 API key。通过真实 Go API kernel 调用合成上游，校验本次唯一响应文本及两条成功日志。第二实例因独占锁启动失败，原实例继续就绪。Recreate 重启后，原 Cookie、API key、endpoint 和 PVC 文件保留。

首次容器实测暴露了 Go 小 SSE 帧缓冲：上游相隔 1000ms 的两段正文，在客户端仅相隔 0.1ms。先提交失败测试 `41905226`，再提交刷新修复 `11ee7dc1`。新镜像客户端两段正文到达间隔 999.9ms，证明实际运行包含该修复，而非仅检查版本字段。前后记录见 [修复前](evidence/kubernetes/runtime-before.json) 与 [修复后](evidence/kubernetes/runtime-after.json)。

独立审查还复现并修复了迟到终端关闭后写库、恢复旧 PG 快照残留后续会话表，以及 DROP TABLE 默认 RESTRICT 仍删除跨 schema 分区的问题。相应失败回归均先于修复单独提交。

## 未验证和后续条件

- 多节点活动副本同时处理请求、全局容量一致性、执行 fencing 和安全接管未实现。
- 原生 ARM64 构建运行、真实远端槽位和供应商推理、生产规模压测未验证。
- 外部 Ingress、跨节点持久存储及节点故障接管未验证；单节点 RWO 和 Pod 重启不能证明这些能力。

部署入口参见 [Kubernetes 说明](../deploy/kubernetes.md)，后续多副本验收参见 [实施计划](2026-10-21-kubernetes-control-plane.md)。
