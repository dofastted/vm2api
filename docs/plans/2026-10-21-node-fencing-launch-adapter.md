# 节点侧 Docker 启动接口的范围与启用条件

本批只实现普通 Claude Docker executor 的可信启动与绑定。它使用现有 slot image 中的 `/opt/kin/kin-kernel`、`cli-node` 和 glibc shim，不修改预编译 payload。`remote-slot.mjs` 的普通 Docker spec 和 `slot-image.mjs` 的 payload 布局是路径依据。

这不是生产 HA 的启用条件。fenced 模式默认关闭，现有部署仍保持单活动控制面。验证仅使用临时 Unix socket 上的合成 Engine API，没有连接真实 Docker、节点或 provider。

## 接口与持久状态

KSG2 增加 `launch` 操作。客户端只提供 `vm_id`、创建操作时捕获的 `fence` 和唯一 `command_id`。镜像、挂载、用户、网络、环境变量、命令和 HostConfig 均由节点代码生成。客户端不能提交 `bind`、`complete`、`ended` 或原始 Docker spec。

节点配置中的 `launch` policy 只有四项：

| 字段 | 允许值 |
| --- | --- |
| `image_id` | 经过节点管理员批准、包含现有 payload 的完整 `sha256:` image ID；不接受可变 tag，也不自动拉取镜像 |
| `network_id` | `none`，或节点预先批准的完整 bridge network ID；不接受 host、container 或 service 网络命名空间 |
| `uid`、`gid` | 非 root 的正整数；不能由 RPC 调用者覆盖 |

`launch` policy 缺失时拒绝启动。当前接口要求目标 VM 已有 `VACANT` 状态，且可信节点组件已准备好该 captured incarnation 的私有文件树。本批没有提供初始 allocate、文件上传或文件发布 RPC，也不会自动接管 legacy executor。

启动顺序为：

1. 校验 captured fence、`VACANT` 状态、私有文件和固定镜像、网络。
2. 持久 `BeginLaunch`，再用 `StartLaunch` 持久记录 dispatched。
3. 在 Authority 全局锁外向 Engine create；名称和 labels 绑定 VM、generation、incarnation 和 command ID。
4. create 返回完整 immutable ID 后，先将 ID、daemon ID、boot ID、镜像 ID 和名称保存到 pending launch，再按该完整 ID start。
5. 节点 inspect 同一 ID 的运行状态、StartedAt、镜像和 labels，并再次核对 daemon ID。
6. `BindExecutor` 对原 captured fence 做条件更新；成功后才将状态置为 `ACTIVE`。

只读预检失败不会创建 launch claim，也不会发送 create。进入 dispatched 后的 create/start/inspect 或持久化错误保留 pending，不自动重试。节点重新打开遇到 pending launch 会保留为 unknown，进入 `REVOKING`。pending launch 阻止 generation 推进。create 返回晚于 revoke 时仍保存目标 ID，但不继续 start 或 bind。

客户端连接关闭、超时或控制面 owner 消失均不是终止证明。未知响应和不受支持的协议继续保留 pending。当前状态机没有自动处理未知 launch 的恢复操作。

## 正常 Claude 终态与持久确认

节点只为 kernel 的 `POST /internal/v1/messages` 识别正常 Claude 终态。请求 envelope 的 `request_id` 必须与 node command ID 相同。其他 endpoint、worker、Codex、错误响应以及 ID 不符时继续 pending。

- JSON 必须是完整 HTTP 200 响应，包含合法 assistant message、非空 message ID、受支持的 content block 和明确 stop reason。当前只接受 `end_turn`、`tool_use`、`max_tokens`、`stop_sequence`。
- SSE 必须包含合法 `message_start` 和 `message_stop`，content block 的 start/delta/stop 顺序须有效，且完整读取 HTTP body 与 trailers。仅 stop_reason 加 EOF 不会完成。message_stop 后仍会继续检查错误、未知帧及 trailers。
- header 的 `verified`、HTTP EOF、普通拒绝、cancel ACK 和健康计数都不会单独完成命令。取消、内部错误、传输截断、已声明 terminal trailer 缺失或失效、重复 terminal、尾随错误、未知内容或超出解析上限时继续 pending。

解析器按增量观察原响应，不修改响应内容。JSON 上限为 1 MiB；SSE 每行上限为 64 KiB、单事件上限为 1 MiB。超过上限仍可转发响应，但不会确认完成。新 stop reason、内容块类型和协议目前不会自动纳入允许范围。

正常终态仅在 `CompleteCommand` 持久成功后成为 node 的 `completed`。新增只读 `command` RPC，要求原 captured fence、command ID、目标 kind 与 ticket，并只向已认证 token 返回状态，不暴露内部 nonce。客户端不能提交完成状态。

已转发的 HTTP body 不等于持久确认。`SlotgateClient` 在完整读取响应后使用原 captured fence、command ID 与 ticket 查询 node 的持久状态。只有 `completed` 且 `dispatched=true` 才能确认执行结束。node 写盘失败、状态不可用、身份不符或 unknown 都会保留 PG job；pending 只允许短时重读原状态，不会重发执行。

该客户端仅在可信调用方显式注入 `exec.slotgate` 时使用。配置必须包含 `trusted=true`、`pgBindingReady=true`、node/VM ID、immutable Docker fence 以及固定证书与 token 的 TLS link。构造时按值捕获并冻结 fence。generation 在控制面与 PG 使用无损十进制字符串，在 KSG2 wire 使用 uint64 数值。未知或多余身份字段拒绝。

发送前的 `onExecutionStart` 必须先持久 `execution_jobs.node_binding`，并返回相同 request ID 和 node binding 的确认。绑定失败或确认不符时不会调用 node prepare/forward。每次 forward 的 command ID 与 kernel envelope 的 request ID 相同。完整响应后取得的原 node `completed` 保存到 `node_completion`；PG 不接受本地 EOF 或其他 generation 的完成声明。PG 完成记录失败仍保留 pending，不会重试执行。

生产 capability 来源和节点权限迁移尚未接入，现有部署没有自动启用该路径。显式 fenced executor 拒绝旧 UDS/SSH 辅助入口；health、凭据管理、初始 allocate 与文件发布尚需 typed adapter。controller 在 prepare/forward 之后崩溃仍会保留未知作业，本批没有提供自动恢复或自动删除 prepared command。

## 容器与文件权限

启动命令固定为 `/opt/kin/kin-kernel --gateway-worker --config /run/kin/kernel.json`。容器使用非 root UID/GID、只读 rootfs、`CapDrop=ALL`、`no-new-privileges`、固定资源上限和 `RestartPolicy=no`。不开放任意 exec、设备、host PID/IPC/network 或 privileged 能力。

容器只能挂载以下 captured incarnation 内的路径：

| 节点路径 | 容器路径 | 权限 |
| --- | --- | --- |
| `vms/<vm>/incarnations/<inc>/home` | `/home/kincli` | guest 读写 |
| `vms/<vm>/incarnations/<inc>/claude` | `/home/kincli/.claude` | guest 读写 |
| `vms/<vm>/incarnations/<inc>/run` | `/run/kin` | guest 创建 socket |
| `vms/<vm>/incarnations/<inc>/config/kernel.json` | `/run/kin/kernel.json` | 只读单文件挂载 |
| `vms/<vm>/incarnations/<inc>/config/internal.token` | `/run/kin/internal.token` | 只读单文件挂载 |

父目录和 config 目录必须归节点服务用户所有，目录权限为私有目录。guest 可写的三个叶目录必须归批准的 guest UID 所有。config 文件必须是节点服务用户所有的普通文件，不能是 symlink 或 hardlink，不能允许 group/other 写入，并须允许批准的 guest 用户读取。启动预检只检查元数据，不读取凭据内容，也不创建缺失的 bind source。

Authority journal、其父目录、节点 agent 的可执行文件与配置，以及 Docker socket 不得挂载给 guest。节点文件发布接口尚未实现；后续 stage/publish 必须限制目标文件、拒绝 symlink/hardlink，并在最终 rename 前校验原 captured fence。当前 metadata 检查依赖节点权限已隔离；它不能代替权限迁移，也不能对抗仍持有原始 host 写权限的旧 owner。

## 实际节点迁移前仍需完成

- 把容器生命周期和文件写权限迁移到节点服务。runtime Pod 不得继续持有 root/docker-group SSH、raw Docker socket、可写 SFTP 或替换 gate 的权限。bootstrap 凭据须与 runtime 分离。
- 迁移时撤销旧授权，并关闭已经建立的 SSH、SFTP、终端和 forwarding 会话。只修改新连接的认证方式不能阻止旧 owner 的延迟命令。
- 将已具备的 KSG2 客户端与 PG job 绑定接到可信 capability、captured VM operation 和文件发布生产调用链。fenced 节点不得回退到 KSG1 或原始 SSH 路径。
- 提供节点可信 allocate、文件发布、未知 launch 的有证据恢复，以及尚未覆盖的响应终态处理。恢复只能关闭同一 immutable executor/incarnation 映射的作业；不能靠 TTL、ready_slots 或 cancel ACK 释放。
- 单独处理 KVM、原生 macOS 和 Codex 进程归属。现有 Codex Docker 容器仅持有身份和终端，停止它不能证明控制面 detached Codex 子进程已经终止。
- 在两个不同节点上的控制面验证同时执行、旧命令迟到、节点服务崩溃、Engine 故障及安全接管。本批合成测试不能代替该验收。

本任务不在用户节点执行以上权限迁移、升级或资源操作。实际迁移须另行获得对应节点与操作范围的授权。
