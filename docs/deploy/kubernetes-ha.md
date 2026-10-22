# Kubernetes 多副本控制面（Draft）

`deploy/k8s-ha` 使用 `VM2API_CONTROL_PLANE_MODE=kubernetes-ha`。默认部署两个控制面 Pod，通过 PostgreSQL 共享状态，通过固定证书指纹的 TLS 节点接口执行请求。控制面不选举推理 leader，各副本独立处理请求。

候选 `f53e005f4794782b0a8e0b4bb152f68d4a3a7aa0` 已在隔离 k3d 集群验证普通 Claude Docker HA 的跨节点并发、扩缩容、滚动更新、控制面异常退出恢复和 HPA 扩容。测试使用真实 PostgreSQL、Go TLS 节点协议，以及合成的本地内核和供应商；具体范围见下方验证记录。运行镜像通过 rootfs 层摘要与七个关键运行文件的 SHA-256 对照确认，未仅依赖进程报告的版本字段。

预编译内核的 access token（AT）投影重载已有单独的本机合成供应商测试。真实模型请求、真实 refresh token（RT）刷新、成功的 WebSocket 模型推理和 Ingress 运行行为仍未验证。部署依赖 [#649](https://github.com/dofastted/vm2api/pull/649) 仍为 open；本页不作为生产启用依据。

## 支持范围

| 对象 | HA 模式行为 |
| --- | --- |
| 普通 Claude Docker 槽位 | 必须使用已批准的 `claude-docker-v1` 节点策略、私有授权和原始启动回执 |
| Anthropic Messages、Claude 的 OpenAI Chat/Completions 转换 | 通过共享请求准入和原节点执行身份处理，支持 HTTP 与 SSE |
| Claude Responses | 保持 `400 protocol_not_allowed` |
| GPT/Codex、外部 API 后端、Search、原生执行器、KVM | 拒绝 HA 调度 |
| 旧 SSH、SFTP、Docker 管理、终端、在线导入、备份恢复 | 拒绝 HA HTTP 操作；不能沿用旧管理连接绕过节点授权 |
| 旧主动健康探测、用量探测、内核重启和目录同步 | HA 下停止；路由配置刷新不会重新启动 |

面板登录、API key、配额、路由配置、会话顺序、粘滞路由及执行状态存放在 PostgreSQL。各 Pod 的 `vms`、`data`、`src/config` 和运行目录使用独立 `emptyDir`。节点持有预编译执行包、凭据和执行状态日志；这些文件不放在共享卷。

未知执行不会按超时释放容量。恢复必须确认原控制面已失去 PostgreSQL 会话锁，并获取原节点、原 command ID、原执行身份对应的持久完成证明。计费缺少可信用量或原始定价依据时继续保留相应预约。

## 安装前提

1. PostgreSQL 17、相同业务 schema、相同业务加密密钥。所有副本使用相同管理员配置和初始 API key。
2. 至少两个可调度的 Kubernetes 节点。必需的 Pod 反亲和保证副本分布在不同节点。默认滚动更新为 `maxUnavailable: 0, maxSurge: 1`，因此两个副本更新时需要第三个可调度节点。HPA 最大副本数也应预留这一节点；默认策略需要至少 `maxReplicas + 1` 个可调度节点才能在扩容上限继续滚动更新。
3. 已安装并校验固定镜像 ID、网络 ID 和 UID/GID 的远端 Go 节点服务。节点的原始 Docker/SSH 权限不能交给控制面 Pod。
4. 通过可信初始化安装独立 allocation、command 私有 authority、节点专用只读 PostgreSQL role，以及授权的 allocation → 首次凭据发布 → launch 回执链。普通应用启动不会自行安装这些授权。相关接口见 [节点授权](../plans/2026-10-22-node-command-authority.md) 和 [首次发布](../plans/2026-10-22-node-initial-publication.md)。可信离线初始化与槽位创建命令见 [节点初始化 CLI](ha-node-bootstrap.md)。该命令不安装节点服务或配置宿主 Docker。

从旧安装切换前停止旧控制面并核实在途任务。`kubernetes` 单实例模式与 `kubernetes-ha` 多副本模式使用互斥的 PostgreSQL 模式锁，不能并存。旧版独立进程不持有该锁，必须由操作者停止。

## Secret 与清单

在目标命名空间创建现有 `vm2api-secrets`，键与 [单实例部署](kubernetes.md) 一致。所有值来自受控文件，不写入命令参数或 Git。

另准备权限为 `0600` 的 `nodes.json`。格式见 `deploy/k8s-ha/node-trust.example.json`。每个节点必须包含固定 IP、端口、运输认证 token、证书 SHA-256、preset 和批准策略 SHA-256。占位内容不能使用。

```sh
kubectl -n vm2api create secret generic vm2api-node-trust --from-file=nodes.json=/secure/nodes.json
```

在仓库 `.local/ha` 建立自己的覆盖目录，设置命名空间、经过验证的镜像 digest 和对外地址：

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: vm2api
resources:
  - ../../deploy/k8s-ha
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

```sh
kubectl kustomize .local/ha
kubectl apply -k .local/ha
kubectl -n vm2api rollout status deployment/vm2api
kubectl -n vm2api get pods -l app.kubernetes.io/name=vm2api -o wide
```

Pod 使用 UID/GID 1000、只读根文件系统，不挂载 Kubernetes API token、宿主路径或 Docker socket。节点信任配置在启动时固定读取；更换该配置后需要滚动更新。

## 扩缩容与更新

手动扩容使用 `kubectl -n vm2api scale deployment/vm2api --replicas=N`。每个副本都需要不同的可调度节点。缩容及滚动更新先取消就绪状态，再排空请求。默认排空期限为 60 秒，Pod 终止宽限期为 75 秒。长于宽限期的连接需要客户端重连。

可选 `deploy/k8s-ha/hpa.example.yaml` 使用 CPU 指标，需要 metrics-server。调整最大副本数以匹配节点数和 PostgreSQL 容量。启用 HPA 后，不应继续通过应用清单覆盖 `spec.replicas`。

Pod 中断预算要求自愿驱逐时至少保留一个副本。它不替代节点故障处理，也不延长长连接的终止宽限期。入口层的 WebSocket、SSE 缓冲和超时仍需按实际网关配置验证。

## 验证记录

以下记录对应候选 `f53e005f` 的隔离 k3d 环境，执行端内核与供应商均为本地合成服务，没有使用真实供应商凭据。

| 场景 | 已验证行为 |
| --- | --- |
| 两个活动 Pod | 分布于不同节点，并发派发请求；共享面板会话、账号/VM/API key 准入、路由更新和计费状态 |
| HTTP 与 SSE | 按原节点完成证明记录计费并释放占位；取消等待者释放其预留；未支持的管理动作在宿主操作前拒绝 |
| 手动扩缩容与滚动更新 | 两副本扩至三副本、缩回两副本并滚动重启；期间 45 次 HTTP/SSE 请求均为 200，采样可用副本数至少为二 |
| 控制面强制退出 | 通过 CRI 立即终止一个控制面容器；原节点未完成时继续保留容量，收到原 command 的完成回执后由其他副本恢复容量并只计费一次 |
| HPA | 在测试覆盖配置 `minReplicas: 2`、`maxReplicas: 3`、CPU 阈值 1% 下自动扩至三个就绪副本；31 次请求均为 200。未验证默认 70% 阈值下的生产容量 |
| WebSocket 排空 | 升级成功、Claude Responses 按既有策略拒绝；滚动更新时以 1001 关闭空闲连接，重试后可连接新 Pod。未验证成功的 WebSocket 模型推理 |

另有 [预编译凭据投影测试](../../test/e2e/prebuilt-credential-projection.e2e.test.mjs)：使用实际预编译 ELF 内核和 CLI，将仅含 AT 的凭据文件原子替换。两次请求分别使用替换前后的合成 AT，内核与 CLI 进程及 socket 保持不变。该结果证明被测制品能读取更新后的投影，不证明真实供应商接受凭据、真实 RT 轮换或既有生产节点行为。Ingress 的 WebSocket/SSE 缓冲与超时配置仍需在实际入口中验证。

固定源码检查、独立审查和全量既有失败详见 [HA 验证记录](../plans/2026-10-22-kubernetes-ha-verification.md)。
