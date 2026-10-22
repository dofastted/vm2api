# Kubernetes 单实例控制面（Draft）

本阶段运行一个活动控制面，使用 PostgreSQL 17、持久卷和远端计算节点。默认 `replicas: 1`、`Recreate` 更新策略。更新期间会有服务中断。此部署不提供水平多活或节点故障后的无损接管；不要增加副本或添加 HPA。

显式多副本模式使用独立的 [HA 部署清单](kubernetes-ha.md)。其支持范围、节点授权和存储前提与本清单不同。

`VM2API_CONTROL_PLANE_MODE=kubernetes` 启用 PG 独占控制面锁及 PG 面板会话。第二个实例连接同一数据库和 schema 时，在业务初始化前退出。连接丢失后，控制面停止准入并退出。该锁不向远端执行器提供 fencing，不能证明失联的远端请求已终止。迁移时必须先停止旧控制面，并确认在途任务的状态。

## 前提

- 使用包含本分支运行模式、独占锁、PG 会话和探针实现的镜像。清单中的 `kubernetes-draft` 是待替换镜像标签，不能改用不支持这些功能的既有 `latest`。
- 独立 PostgreSQL 17 业务数据库。连接角色拥有应用 schema 和迁移对象，不需要超级用户或创建数据库权限。所有部署使用同一业务加密密钥。参见 [PostgreSQL 部署与迁移](postgresql.md)。
- 集群有可用的 RWO StorageClass，或者将清单改为已有 PVC。示例申请 10Gi；按 VM 文件和备份保留量调整。`local-path` 卷绑定节点，不能据此声明跨节点数据可用。换节点需要可迁移的持久存储和已验证的恢复流程。
- kubectl 含 Kustomize。控制面不访问 Kubernetes API，不挂载 ServiceAccount token、宿主 Docker socket 或 hostPath，也不使用 hostNetwork、特权模式或附加 Linux capabilities。

只使用远端计算节点。Pod 内的 Docker CLI 用于访问已注册远端节点的连接，不管理所在 Kubernetes 节点的 Docker。入口在 Kubernetes 模式下跳过宿主镜像拉取和自动同步。该模式不把普通 Kubernetes 工作节点变成计算槽位宿主。

## 配置与部署

在安装命名空间中预建 `vm2api-secrets`。使用权限为 `0600` 的受控环境文件提供以下键，不将文件提交到 Git，也不把值放进命令参数或日志：

```text
VM2API_DATABASE_URL
VM2API_ADMIN_PASSWORD
VM2API_API_KEY
VM2API_DB_SECRET
```

`VM2API_DB_SECRET` 是现有数据库字段加密密钥，兼容旧名 `KIN_DB_SECRET`。Kubernetes 模式下生成浏览器 OAuth 授权链接必须配置该密钥；缺失时拒绝发起 PKCE，不能将 verifier 明文存入 PostgreSQL。各副本使用同一密钥，不能在升级或导入时替换。字段示例见 `deploy/k8s/secret.example.yaml`；该文件不参与默认 Kustomize 部署，不能直接使用占位值。

PKCE 会话通过 PostgreSQL claim 防止并发换票，成功后消费，供应商失败后恢复原会话供重试。进程在换票期间退出时，claim 保留至原会话到期，之后必须重新发起授权。终端 ticket 在 PostgreSQL 只存随机票据摘要，有效期为 30 秒，成功匹配资源后只能消费一次；错误节点、VM 或登录模式不消耗其他资源的票据。

管理员用户名默认为 `admin`。已有 SQLite 安装应先按 PostgreSQL 文档完成离线导入，保留原业务加密密钥和对应的 VM、配置及备份文件，之后再启动 Pod。

```sh
kubectl create namespace vm2api
kubectl -n vm2api create secret generic vm2api-secrets --from-env-file=/secure/vm2api.env
```

在本地创建覆盖目录，例如仓库内 `.local/k8s-production/kustomization.yaml`：

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: vm2api
resources:
  - ../../deploy/k8s
images:
  - name: ghcr.io/dofastted/vm2api
    newName: registry.example.com/vm2api
    digest: sha256:REPLACE_WITH_VERIFIED_IMAGE_DIGEST
patches:
  - target:
      kind: ConfigMap
      name: vm2api-config
    patch: |-
      - op: add
        path: /data/PUBLIC_BASE_URL
        value: https://vm2api.example.com
```

确认实际镜像和 StorageClass 后渲染、部署：

```sh
kubectl kustomize .local/k8s-production
kubectl apply -k .local/k8s-production
kubectl -n vm2api rollout status deployment/vm2api
kubectl -n vm2api port-forward service/vm2api 8787:8787
```

入口将镜像默认配置复制到空配置目录。业务目录与进程目录分别挂载：

| 路径 | 存储 | 用途 |
| --- | --- | --- |
| `vms` | PVC | VM JSON、CLI-home 和既有凭据文件 |
| `src/config` | PVC | 路由等持久配置 |
| `data` | PVC | 备份、恢复维护标记及其他持久业务文件 |
| `data/run` | emptyDir | 当前 Pod 的 API kernel 与 cluster relay sockets |
| `bin`、`share` | emptyDir | 从当前镜像复制的二进制和工具文件 |

Pod 使用固定 UID/GID `1000`，持久卷通过 `fsGroup: 1000` 提供访问权限。导入既有文件时，应先核实该 UID 的访问权限。删除 Deployment 或重建 Pod 会保留 PVC；删除整个 Kustomization 会同时删除示例 PVC，不能将其用作普通停止操作。

## 探针、终止与入口

`/healthz` 只用于存活检查。`/readyz` 检查初始化、PG 查询、独占锁、维护及排空状态。启动探针成功后才开始常规存活和就绪探针。SIGTERM 停止新 HTTP 请求和 WebSocket 升级，等待在途处理及持久化完成。默认排空期限为 `VM2API_SHUTDOWN_TIMEOUT_MS=60000`，Pod 的 `terminationGracePeriodSeconds=75` 留出清理余量。修改期限时同步调整 Pod 配置。超过期限的长连接可能被中断，客户端需要处理重连。

可选的 `deploy/k8s/ingress.example.yaml` 不包含在默认资源中。修改域名、IngressClass 和已有 TLS Secret 后单独应用，并配置匹配的 `PUBLIC_BASE_URL`。Traefik 支持 WebSocket；SSE 路径不应附加响应缓冲中间件。入口层的超时和请求大小限制需要按实际长请求验证，不能只检查 `/healthz`。

Kubernetes 的 [Recreate 策略](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#recreate-deployment)、[探针语义](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)、[持久卷与 emptyDir](https://kubernetes.io/docs/concepts/storage/volumes/) 和 [ServiceAccount token 配置](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/) 是这些清单的依据。Traefik 配置参见 [WebSocket](https://doc.traefik.io/traefik/master/user-guides/websocket/) 和 [缓冲中间件](https://doc.traefik.io/traefik/middlewares/http/buffering/)。

## 验证

静态与入口测试需要 Python 3、PyYAML 和 kubectl；缺少工具直接失败。Debian/Ubuntu 可安装 `python3-yaml`。测试只渲染清单，并在临时目录用合成 Unix socket 和假 Node 命令执行入口分支，不启动服务器或容器。

```sh
python3 -m unittest test/deploy/test_kubernetes.py -v
```

真实集成脚本只接受 API 地址为本机 loopback 的显式 context。候选镜像应先导入本地集群，或使用集群可拉取的已验证镜像标签：

```sh
python3 test/deploy/smoke_kubernetes.py --context cube-local --image vm2api:kubernetes-candidate --storage-class local-path
```

脚本创建全新 `vm2api-k8s-649-*` 命名空间，部署独立的临时 PostgreSQL 17 和业务角色，并通过 stdin 提交随机测试 Secret。它使用同一候选镜像启动 Node.js 合成上游，配置 API endpoint 和 `category=api` 的托管 key。验证范围包括：

- Pod 就绪、Service DNS/ClusterIP、探针和控制台。
- Cookie 登录、PG 指标及 API key 创建。
- 经过实际 Go API kernel 的非流式和 SSE 请求，校验本次唯一响应文本、分段到达及两条成功请求日志。
- 第二实例被独占锁拒绝。
- Recreate 重启后 Cookie 会话、托管 key、endpoint 和持久卷文件保留。

测试命名空间的 egress policy 只允许同命名空间 Pod 和集群 DNS；后台使用的 `models.dev` 在测试 Pod 中映射到 loopback。测试不使用真实上游凭据。输出仅包含检查结果、合成响应文本和运行镜像 ID。退出时核对命名空间 UID 及本次唯一标签，再删除本任务创建的命名空间。它不复用或删除现有命名空间。

该脚本验证单实例部署和 API endpoint 推理。它不验证远端槽位的活凭据或真实供应商推理。SSE/WebSocket 排空与故障处理还需结合对应的应用集成测试。单节点 k3s 验证不等同于跨节点存储、远端执行 fencing 或水平扩容验收。
