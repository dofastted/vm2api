# Kubernetes HA 验证记录（#648）

本次实现增加显式 `kubernetes-ha` 模式。普通 Claude Docker 槽位的控制面副本通过 PostgreSQL 共享状态，各副本独立处理请求。默认 `kubernetes` 部署仍为单实例。本记录不表示 #648 的全部后端和协议已完成，也不作为生产部署批准。

依赖 PostgreSQL 改造 PR [#649](https://github.com/dofastted/vm2api/pull/649)。测试复用既有预编译内核和 CLI，没有其源码改动。

## 固定源码与运行镜像

| 源码 | 检查 | 结果 |
| --- | --- | --- |
| `f53e005f4794782b0a8e0b4bb152f68d4a3a7aa0` | PG、TLS 节点、恢复扫描、计费和 HTTP/SSE 排空定向检查 | 73/73 |
| `48aa2a284ab057c2b525d5426c6e7dd1c74a744d` | 初始化前提、默认数据库迁移、计费、HA 启动、双副本请求和排空 | 50/50 |
| `ff4e43486fa98af21aee366f8c3779202e81e1d0` | 混合大小写 schema、两个 CLI 和默认数据库回归；固定源码归档 | 25/25 |

`f53e005f` 镜像的实际 containerd image ID 为 `sha256:f2ce099f07273f1a187c01cfbbaffaee24f2cad57239b7627da917d17d5dcb3e`。`48aa2a28` 为 `sha256:a4927a617e980e4ca20636810281b201f9d469f76107587fb8f9feaead95586e`。两次均比对 Docker 与 containerd 的 rootfs 层，并将运行容器的关键源码文件与固定归档逐字节比对；没有仅依赖版本或 SHA 字段。见 [运行身份](evidence/kubernetes/ha-verification/48aa2a28-runtime-identity.json)。

`ff4e4348` 相对运行中的 `48aa2a28` 只改变 CLI 使用的只读迁移前提查询及其测试。最后这项修复通过固定归档的实际 CLI/PG 测试验证；没有将此前集群镜像结果标成 `ff4e4348` 的运行验收。

## 专用 Kubernetes 环境

仅使用本任务独立 k3d 集群、任务命名空间和专用 PostgreSQL。未修改生产服务、生产容器、生产网络或默认 kubeconfig。集群有三个可调度节点，支持两个副本及额外一个滚动更新副本。

| 场景 | 固定源码 | 实际结果 |
| --- | --- | --- |
| 两节点上的活动副本 | `f53e005f`、`48aa2a28` | 两 Pod 并发派发；跨 Pod 面板 cookie、路由刷新、key 并发限制共享；账号/VM 容量满时第三个不同 key 不进入执行端，取消后释放其预留；9/9 场景通过 |
| HTTP/SSE 与计费 | 同上 | 正常响应和完整 SSE 结束；原节点完成证明关联原命令；唯一结算并释放准入 |
| 手动扩缩容和滚动更新 | `f53e005f` | 2→3、3→2、滚动重启分别发起 19、1、25 次业务请求，均为 200；采样可用副本数不低于二 |
| 控制面异常退出 | `f53e005f` | 通过 CRI 立即停止任务控制面容器，退出码 137；未完成的原节点继续占用容量；另一副本读取原命令持久完成回执后恢复容量，5 个输入 token、7 个输出 token 只计费一次；随后请求成功 |
| HPA | `f53e005f` | 使用实际 metrics-server，以测试覆盖值 CPU 1%、min=2/max=3 自动扩至三个就绪副本；31 次业务请求为 200。没有验证默认 70% 阈值下的容量 |
| WebSocket | `f53e005f` | 升级、Claude Responses 的既有 400 拒绝、滚动时 1001 关闭空闲连接、有界重试后重连通过。立即重连发生过连接错误，原因未查明；未声称零错误重连或成功模型推理 |

控制面、PostgreSQL、固定证书的 Go TLS 节点和持久日志为实际运行进程。内核和模型供应商为本地合成服务，节点 Engine 为 fixture。上述结果不能替代真实供应商推理、真实 Docker 执行隔离或生产节点验收。各场景的结构化结果见 [证据目录](evidence/kubernetes/ha-verification)。

实际预编译 ELF 的单独 [AT 投影测试](../../test/e2e/prebuilt-credential-projection.e2e.test.mjs) 使用本地合成 OAuth 供应商。替换仅含 AT 的文件后，两次请求分别携带新旧合成 AT；内核和 CLI PID、socket 与重启计数不变。它不验证真实 RT 刷新或真实供应商接受凭据。

## 全量检查与已知失败

固定 `4de403f9ee5411fee1c2266ef80cfd4315267a4b` 的全量结果如下，不能称为全绿：

| 检查 | 文件 | 测试数 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: | ---: |
| unit | 395 | 4373 | 4339 | 24 | 10 |
| E2E | 35 | 135 | 117 | 17 | 1 |

7 项 unit、17 项 E2E 的规范化错误摘要与此前固定基线一致。新增 17 项 unit 均为 runner 遗漏数据库 fixture 自动初始化，实际错误为 `database not opened — await openDatabase() first`。`0d9c4348` 修正 fixture 识别后，通过实际 isolated runner 复验相关三个文件 18/18。未把这一复验合并成不存在的全量通过数。失败名称及摘要见 [checks.json](evidence/kubernetes/ha-verification/checks.json)。

`4de403f9` 的 Go race 为 299 通过、1 辅助跳过。之后到 `48aa2a28` 没有 worker 源码变化。`f53e005f` 的 Go vet、gofmt、779 文件 Biome、336 个源/脚本 MJS 语法、4 项部署静态检查及 1 项 HA entrypoint 检查通过。`ff4e4348` 的 779 文件格式检查及修改的两个 MJS 语法检查也通过。

## 独立会话审查

审查使用独立 Codex CLI 会话和固定、干净的 detached worktree。审查会话不运行测试、服务或部署命令，不访问凭据；动态复现和修复检查由主会话另行执行。

- `f53e005f`，会话 `01a15fb1-f02a-7761-9bf2-7cdaa751f3aa`：2 项 P2（保留 VM ID、CLI 隐式迁移业务 schema），已在 `48aa2a28` 修复。[原报告](evidence/kubernetes/review-progress/independent-review-f53e005f.md)。
- `48aa2a28`，会话 `01a15fc4-4eb3-72f3-a643-07fd87e6f797`：确认上轮两处修复，新增混合大小写 schema 名称误判 P2，已用实际 PG 失败规格复现，并在 `ff4e4348` 修复。[原报告](evidence/kubernetes/review-progress/independent-review-48aa2a28.md)。

- `ff4e4348`，会话 `01a15fc9-6ab0-7da1-98e3-a3a61d0fe2e9`：核对混合大小写修复及两文件增量，未发现新增可证 P0/P1/P2。[原报告](evidence/kubernetes/review-progress/independent-review-ff4e4348.md)。

更早轮次及各自范围见 [历史审查记录](2026-10-21-kubernetes-review-progress.md)。

## 范围限制

HA 仅支持普通 Claude Docker 的 Messages 及 Claude Chat/Completions 转换。GPT/Codex、API 后端、Search、原生执行器、KVM、终端和旧管理入口均明确拒绝。Claude Responses 保持原有拒绝行为，成功 WebSocket 模型推理不在本次支持范围。

任务集群没有安装 Ingress controller，Ingress 的实际 SSE 缓冲、WebSocket 和超时行为未验证。真实模型、真实 RT 刷新、已有生产节点及生产容量未验证。没有对生产环境部署本分支。
