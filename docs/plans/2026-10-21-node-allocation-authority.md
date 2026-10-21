# 初始槽位分配与节点独立授权

本批只分配普通 Claude Docker 槽位的初始逻辑身份。它不创建目录、文件、容器或 provider 请求。文件 stage/publish、launch grant、停止与回收、生产 createVM 路由和节点权限迁移不在本批。现有预编译 payload 保持不变，生产没有启用 HA。

## 授权来源与持久状态

`NodeManagementGrants.issueAllocation` 必须在同一数据库与 application schema 的当前 exact `SharedVmOperations.run` 回调内调用。节点、VM、独立 allocation ID 与当前 operation 的 owner、目标和 `node_allocate` 类型绑定。仅提交 operation ID 不能发行授权。operation 必须已独立提交且没有 released/uncertain。

授权存储在 `vm2api_node_<sha256(applicationSchema) 前32个hex>` 私有 schema。`meta` 固定 `protocol_version=1` 与 application schema；`allocations` 保存 node、逻辑与物理 VM 唯一身份、operation/owner、maintenance epoch、intent digest、原 node receipt 和撤销时间。allocation、VM 与物理别名保留唯一记录，不会因旧业务备份恢复重新分配。

GlobalMaintenance 的私有 coordination schema 另保存 `node_authority_features` 启用标记。首次初始化同时创建 marker、meta、授权表、只读 view 与函数。业务迁移数与表数不因这些私有对象变化。该功能没有自动协议升级；已有 marker 后，缺 schema、表、函数、view、绑定不符或未知协议均拒绝。只有 marker 和 authority schema 均不存在时才保留从未启用的旧操作路径。

只读 view 绑定当前私有 maintenance epoch 与 OPEN 阶段，并通过固定 schema 的动态 SELECT 核对当前 operation。业务表不是 view 的静态依赖；删除/恢复业务表不会删除私有 view。缺业务表时拒绝，恢复旧 operation 行也不能绕过 epoch 或持久撤销记录。

## 节点检查与本地 receipt

节点 `Config.management` 只能由可信初始化流程安装，包含 node ID、private authority schema 和节点专用只读 PostgreSQL DSN。RPC 不能提供或更换这些值。节点使用固定 pgx v5.11.0；远程数据库要求验证证书的 TLS，Unix socket 与 loopback 可用于本地验证。

节点 role 仅获得自身授权 view、schema USAGE 和指定只读函数的权限。`reader_identity` 拒绝超级用户、可创建角色/数据库、BYPASSRLS、角色成员关系、private schema CREATE 或底表写权限。`SECURITY DEFINER` 函数固定 search_path，显式限定 schema，默认撤销 PUBLIC EXECUTE。`readerRoleSql` 只生成不含凭据的授权 SQL；运行时不会创建角色。实际节点安装 role、view 或配置需要另行授权，本任务仅在隔离测试库执行。

KSG2 `allocate` 只接受 VM、allocation ID、operation ID 与 owner ID。它不能提交 generation、executor、路径、模式、命令或文件内容。节点独立核对 PG 授权与 intent digest，随后在共享授权锁持有期间写本地 journal。锁只跨短时本地 journal I/O，不跨 Docker 或外部请求。发行、release 与 uncertain 使用 operation 行锁后再取授权排他锁；节点使用 MVCC 读取 operation，不反向锁行。

初始 generation 固定由 node 创建为 1，incarnation 由 node 随机生成。journal 同时持久原 allocation receipt。同 ID、同 intent、同 epoch 返回原 receipt；不同 intent 冲突。已有未受此流程管理的槽位不被自动认领。replay 返回原 VACANT fence，不使用最新 State 将旧请求重新授权。

节点首次配置 management 时把 node ID、authority schema 与协议写入本地 journal。重开时缺少或更换该绑定会拒绝启动。journal 写盘失败不返回成功，daemon 拒绝后续授权。PG 查询失败无本地授权回退；PG commit 失败也不能确认本地分配成功。

`NodeManagementGrants.allocate` 组合已提交 grant、固定证书的 TLS typed client 和 PG receipt 保存。只有原 node receipt 与 grant 严格相同才保存。receipt 保存失败会保留 unknown VM operation；没有自动删除、重新分配或重试。

## 默认拒绝与范围

转发 token 仅认证传输，不授予管理权限。`Config.Fenced=true` 时，未接入独立 action grant 的 launch/revoke/advance 默认拒绝。allocate 未配置 PG authorizer 也拒绝。state、prepare/forward、command 保留原 captured Fence 推理协议。单元测试中的 management fake authorizer 仅为明确注入的测试适配器，不是可用的节点配置项。

SSH、raw Docker、SFTP、旧会话权限、KVM、原生 macOS 和控制面 Codex 子进程仍未迁移。节点文件发布接口也未实现。任何用户节点启用前都必须完成这些权限与调用链迁移。本批临时 TLS/Unix、合成身份和两条 PG 连接的协议验证不证明可信容器启动或多节点 HA。
