# 托管节点内核排障与验收

适用基线：v1.4.121 的 Linux 集群节点。旧控制面、KVM 和 macOS 的安装合同可能不同；先核对实际部署版本与运行时。本文的请求示例需要已认证、具备目标槽管理权限的面板会话，`<VM_ID>` / `<NODE_ID>` 是待替换的目标标识。

## 先确定错误发生在哪一层

VPS 已接入集群时，控制面负责下载、验证和缓存内核包，再通过保存的节点连接下发。节点地址不是控制面地址；在本机用另一把私钥连接失败，不能证明控制面的连接失败，也不能证明从未尝试的密码无效。

先从面板或以下接口核对槽到节点的映射及现有连接：

```http
GET /api/panel/vms/<VM_ID>
GET /api/panel/cluster/nodes/<NODE_ID>
GET /api/panel/cluster/nodes/<NODE_ID>/docker/containers
GET /api/panel/kernels
```

单槽详情在 `data.vm`，节点详情在 `data`；核对 `vm.node_id`、节点 `host` / `link.state` / `health.docker.ok`。容器列表在 `data.items`，用 `vm_id` 和 `role: "slot"` 对应到实际容器。内核库存位于 `data.kernels`，它是控制面库存，不能作为节点已安装的证据。

连接 ready 且 Docker 正常时，继续使用控制面已有管理链路。出现节点网络、认证、主机指纹、Docker 或磁盘故障时，再针对该层诊断；只有管理链路不能定位时才补独立 SSH / 云控制台取证。不要重新猜测密码、关闭主机指纹校验或公开完整节点配置、环境变量及凭据。

## 缺包与首次信任

从「内核」页拉取需要的产品。拉取只更新缓存，不安装或停止槽：

```http
POST /api/panel/kernels/pull
Content-Type: application/json

{"kernel":"cli-node"}
```

选择 CRAG 时将 `kernel` 改为 `crag`，并按现有许可选择标准包或旧授权兼容包，见 [CRAG V2 二进制更新](DEPLOY.md#crag-v2-二进制更新)。下载成功不能证明许可与所选载荷兼容；不要为修复免费 cli-node 的安装错误而切换到付费 CRAG。

首次 CRAG 下载优先信任已验证出厂包的发行公钥；没有有效出厂包时，必须有可信部署随附的 `deploy/payload.json` 固定公钥摘要。下载包自带公钥不能作为自己的首次信任锚。缺少可信锚时，使用包含配套元数据的正式控制面发行物；不要手工接受下载包中的公钥、跳过签名或放宽归档路径检查。

v1.4.121 已支持上述空缓存初始化及正式包的 `unpack-note.md` 成员。遇到旧版本报错，应先确认部署的消费端实现和元数据，不能只替换一个新版 shell 脚本；也不应对最新版重复回补已经存在的逻辑。

当前 Docker 槽镜像允许 CRAG 包不存在，但发现损坏包时仍会拒绝。KVM 的双内核预装合同即使选择 cli-node 也要求完整 CRAG 包；这是包完整性要求，不代表 cli-node 需要 CRAG 付费授权。不要把 Docker 的可选包行为直接套到 KVM，详见 [KVM 原生 CRAG](crag-kvm.md)。

## 单槽安装与启动

先确认目标、产品、当前运行意图和持久目录备份；安装会排空、停止并重新启动目标槽。不要为一个槽的缺包错误重装全部槽。

```http
POST /api/panel/kernels/install
Content-Type: application/json

{"targets":[{"id":"<VM_ID>","kernel":"cli-node"}]}
```

确认具体版本时，使用库存返回的 `release_tag` 作为 `expected_tag`；CRAG 还可传完整 `payload_tag`，避免确认后缓存变化。许可与重签边界见 [管理台 API](PANEL_API.md)。不要把不明确的授权问题转成自动重签或购买。

HTTP 200 仍可能包含失败项。必须检查 `data.ok`、`data.failed_count` 和对应 `data.items[].ok` / `code` / `stopped`。在本基线中，成功项应有 `restarted: true`、`stopped: false`、`status: "running"`；安装器已负责重启和健康校验，无需紧接着重复调用 start。

旧部署若成功报告 `stopped: true`，先核对该版本安装器是否确实只安装不启动。需要恢复原运行意图时，再通过面板或 `POST /api/panel/vms/<VM_ID>/start` 显式启动。失败后的 stopped 状态不是成功安装证据；检查错误、实际节点容器和包版本后再决定恢复方式。响应丢失时先读回，避免盲目重复重装。

启动可能为镜像、网络或挂载布局升级而重建容器，持久目录与账号状态才是保留数据的验收对象。不要以容器 ID 改变推断数据丢失，也不要承诺未挂载的容器可写层会保留。备份应落在持久私有位置；恢复前检查后续变化，不回灌已轮换的旧 token。

## 安装成功不等于账号可用

| 层次 | 验收证据 | 不能推断 |
| --- | --- | --- |
| 控制面包 | 对应产品 `ready: true`、已下载发行标签及校验结果 | 节点已经安装 |
| 指定槽安装 | 明确目标的逐项安装报告和 `kernel_installation` | 运行的是该程序或账号有效 |
| 真实运行 | 对应节点容器状态、`GET /api/panel/vms/<VM_ID>/diagnose` 及槽内实际入口的版本命令 | Claude 已登录或模型调用成功 |
| 登录/许可 | 当前凭据状态；选择 CRAG 时还需适配载荷的有效许可 | 上游请求一定成功 |
| 推理 | 在授权范围内对目标槽发出的最小真实请求及结果 | 长时间稳定性或其它槽可用 |

本基线的普通面板终端 `claude` 固定使用包内原版 Claude，独立于所选推理内核；`claude --version` 只验证该终端入口。Linux 集群 Docker 的 cli-node 入口是 `/opt/kin-live/cli-node`，应通过现有控制面 Docker 桥对该实际路径执行 `--version`，再结合运行与诊断证据核对所选推理内核。CRAG 的包内 Claude 路径同样应从当前布局确认；任何入口的版本都不能单独证明推理内核已运行，也不能代表另一入口已升级。旧部署的终端映射可能不同，先核对源码和实际路径。版本命令不发送模型请求。

普通槽终端也会加载 shell rc、创建必要目录或凭据链接。严格的安装前摘要应先通过已有控制面 Docker 桥执行有限只读检查，公开记录只保存白名单字段和摘要。合法凭据轮换可能改变文件摘要，不能为满足“摘要不变”恢复旧 token。

`no_credential` 表示还需要登录或导入适用凭据；包已就绪、内核健康以及 `--version` 成功都不能替代登录。在面板完成相应登录/凭据导入流程后再验收模型请求。一次 CLI 退出 137 也不能单凭退出码判为 OOM，应保留错误并核查实际子进程和内存证据。

## 常见失败分流

| 错误或状态 | 检查方向 |
| --- | --- |
| `CRAG v2 缺失` / `slot_payload_missing` | 先查控制面完整包、部署版本与运行时要求，再查节点文件；不要先更换 SSH 凭据 |
| `crag_v2_authority_missing` | 有效出厂包或可信部署中的唯一、正确架构公钥 pin 是否存在 |
| `crag_v2_authority_mismatch` | 包的发行公钥是否与现有信任锚匹配；保留拒绝结果，不接受包自带公钥 |
| `crag_v2_hash_mismatch` / `slot_payload_invalid` | 包成员、架构或完整性；保留旧缓存，不忽略损坏包 |
| `kernel_release_changed` / `crag_payload_changed` | 缓存已与确认版本不同，刷新后重新确认目标版本 |
| `license_payload_key_mismatch` | 为当前许可选择兼容包，或按明确授权取得适配当前载荷的许可 |
| `kernel_start_failed` / `stopped: true` | 核对实际节点状态、内核错误和失败阶段，单独验收恢复启动 |

源码核验入口：[下载信任与缓存](../src/lib/admin/kernel-catalog.mjs)、[安装与恢复](../src/lib/vm/kernel-install.mjs)、[远端镜像资源](../src/lib/cluster/slot-image.mjs)、[下发与凭据协调](../src/lib/cluster/remote-slot-files.mjs)、[普通终端入口](../src/lib/vm/slot-shell.mjs)。
