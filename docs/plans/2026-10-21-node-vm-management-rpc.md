# 节点持有 VM 管理权限的下一批接口

本设计只规划替换 Kubernetes 控制面的 SSH、Docker 和 SFTP 管理路径。它不启用 HA，不修改节点配置，不创建 VM，也不要求修改闭源 kernel。执行侧复用开源 slotgate 和现有 payload。当前单活动控制面保护继续保留。

## 当前可复用的状态

- `worker/internal/slotgate/authority.go:285` 的 `CreateSlot` 只供可信节点组件调用，分配 `VACANT` generation/incarnation；KSG2 尚无 allocate RPC。已有 VM 不会被自动认领。
- Authority journal 使用临时文件 fsync、rename、父目录 fsync，持久化失败令该 daemon 拒绝后续授权；重开时 pending 变成 unknown/revoking。command ID 保留，不能改用新 fence 重试旧 ID。
- `docker_launch.go:63` 只启动普通 Claude Docker executor。节点 `DockerLaunchPolicy` 固定 image ID、network ID、UID/GID。客户端不能传 Docker spec、路径、环境变量或命令。启动记录完整 container/daemon/boot 身份，inspect 后才绑定。
- `docker_launch.go:216` 的私有树必须预先存在；没有上传或发布接口。config 文件按单文件只读挂载。原子替换宿主机该文件不保证现有单文件 bind mount 看到新 inode，因此第一批 publish 仅覆盖启动前，不声称支持现有进程热更新。
- `ksg2.go:112` 当前只提供 state、prepare/forward、command、revoke、advance、launch。客户端不能提交 bind、complete 或 ended。现有正常 Claude 消息终态和只读 command 查询可复用，其他 worker 管理响应不能因此自动成为 node completed。
- `docker_verifier.go:25` 的 verifier 会核对原 daemon、boot、container ID、StartedAt，停止并删除该容器，再验证同 daemon 下 404。`advance` 是有副作用的结束确认，不是普通状态读取；它还拒绝未知 mutation。没有 executor 的初始 VACANT 状态不能直接套用这条推进路径。

## 第一批：allocate、启动前 publish、现有 launch

只覆盖新的普通 Claude Docker 槽位；KVM、macOS native、控制面 Codex 子进程、交互 PTY 和 legacy executor 不回退到原始命令。

| 提议接口 | 输入约束 | 节点持久结果 |
| --- | --- | --- |
| allocate | 规范 VM ID、全局 VM operation ID、独立 allocation ID；不接受宿主机路径 | 初始 fence 和 allocation receipt；同 ID/同意图可查询，同 ID/不同内容冲突 |
| publish-initial | captured fence、command ID、预期 manifest revision、固定文件枚举、受限内容 | manifest digest/revision 与 completed；没有 secret bytes |
| launch | 继续使用已有 captured fence + command ID | 现有可信 executor identity |

PG VM claim 必须先独立提交。新逻辑身份、现有物理别名、node placement 和每个 node command 的绑定须在实际 dispatch 前持久化。node 不能只相信客户端提交的 operation ID；需验证服务端绑定的 action/fence/node/owner/未撤销状态。最小实现可给 node 一个受限的 PG 只读授权视图，避免把发行管理授权的密钥交给所有 runtime Pod。授权查询失败即拒绝新操作，不释放已执行操作。

allocate 应在 journal 保存 allocation ID，解决响应丢失后的同一分配查询。不能对已存在 VM 重新调用 CreateSlot 后用 State 的新值替换原 captured fence。尚未绑定 executor 的取消/删除需要单独证明未 dispatch 的规则，不伪造 termination proof。

publish 从节点私有 staging 开始；不向最终路径流式写入。禁止 absolute/relative path、任意文件名、symlink/hardlink、客户端 UID/mode/chown。节点生成目录权限、internal.token 和固定 credential link。kernel config 从节点 preset 与有界参数生成，不直接接收可改变启动程序或 host 路径的 JSON。

发布前核对原 fence、VACANT、无未知操作及预期 manifest revision；节点在最终 rename 的发送边界再次校验，持久记录 completed 后才允许 launch。stage、rename、fsync 或响应不明保留 pending，不自动重传。新 incarnation 使用独立目录，晚到的旧 publish 不能改新目录。上传大小/文件数沿用明确的协议上限，不增加用户配置。

现有 `LaunchPolicy.network_id` 是每节点固定策略，尚不覆盖每 VM 动态 SOCKS 绑定；第一批不能据此宣称现有所有 egress 路径已迁移。镜像仍由节点管理员批准，不开放任意 pull/build/spec 上传。

## 第二批：停止、重建、删除与受限管理

- stop/restart 使用 captured executor，沿用 revoke 后 verifier 的不可变 ID 删除确认；restart 在新 incarnation 发布并重新 launch，不直接 Engine restart 旧 ID。
- 为 stop 增加持久 operation receipt，保证响应丢失后可查询原操作。不能把 stop 当普通 pending mutation 再调用现有 advance，否则会被自己的 pending mutation 阻止；只允许可信停止适配器结束它自己的 exact intent，其它未知 mutation 继续阻止推进。
- destroy 先取得上述结束 receipt，再删除该 VM 的受控私有数据。保留逻辑身份、旧 generation 与 command tombstone；不提供任意 rm 路径，也不因客户端报成功删除 PG 记录。
- 下一组 typed RPC 可分别提供 credential import/refresh、seed/config publish、telemetry restart、identity read 和 approved payload revision 切换。每个动作独立列明开始、结束和 unknown 规则，不开放 shell/exec/env 的通用替代接口。
- 活动 credential 发布在固定目录内做原子替换，校验权威 credential revision/预期 generation，拒绝晚完成的旧导入或刷新。节点为真实凭据持有者；Pod 本地镜像不能覆盖已经轮换的节点凭据。导出必须走已有用户权限与专用受保护响应，不进入 journal、日志或 SharedBG sharedResult。

调用方优先替换 `slotHost` 的 start/reload/stop/destroy、syncRun/onImport/afterRefresh，再替换 `remote-slot.mjs` 和 `remote-slot-files.mjs` 的直接 Engine/SFTP。保留 standalone 路径；已声明 fenced 的节点遇到不支持动作直接拒绝，禁止退回 KSG1、SSH、UDS relay 或 raw Docker。

## 权限迁移与未覆盖的异步写入

现有 `placement.nodeSession:95` 返回 SSH client 和 sshDocker；`cluster-manager:798` 仍可向 Engine 发送请求。`remote-slot-files:56/106` 经 SFTP 写 run/seed、credential 与二进制；远端凭据在运行后权威。Pod 即使持有 PG claim，仍可能发送绕过 fence 的旧 SSH/SFTP 命令。

另有需要先补的当前调用链：`rust-kernel-supervisor.writeKernelConfig:782` 调 `queueSyncRun`；`remote-slot-files.queueSlotPush:223` 只在本 Pod 串行、捕获错误后仅记录日志。现有管理 flush 不等待这些原始 Promise。这意味着局部文件更新测试不能证明远端写入已结束。迁移前应把本操作产生的 push Promise 显式返回并 await，传播错误；不能只加一个吞错的全局 flush。节点 publish 再以 fence/revision 拒绝跨 Pod 的迟到写入。

权限迁移分为：先以 mock/临时 Unix socket 验证新接口；再由另行授权的节点初始化流程安装服务、批准 payload/image/network、建立 TLS pin；然后迁移调用方并拒绝 legacy fallback；最后撤销 runtime Pod 的 SSH 私钥、docker-group/root、SFTP 写入、Docker socket、替换 gate/journal 的权限。需终止已经建立的 SSH/SFTP/forward/终端会话，不能只撤销新连接认证。runtime 与初始化/升级凭据分离。没有完成这一步，node fence 不能阻断仍有任意节点权限的旧 owner。

## 验收范围

先失败规格分别证明：双连接 allocate 唯一；响应丢失不重复创建；旧 fence publish 无写入；路径/链接/权限拒绝；rename 与 revoke 竞态不改新 incarnation；stage/Engine/journal 故障保留；原 container ID stop/remove 确认；unknown mutation 阻止 generation 推进；原始 push Promise 未完成时 claim 不释放；fenced 节点不走 SSH fallback。测试只用合成 Engine、临时目录与专用 PG。

两个不同节点上的迁移验证、旧会话撤权、节点崩溃恢复、Codex/native/KVM/交互 PTY 归属和全部管理生产调用链，均不由本设计或现有合成测试证明。
