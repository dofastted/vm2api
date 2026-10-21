# 节点首次发布与启动授权

本增量仅增加独立 PostgreSQL 授权和回执保存。生产启动流程不会自动启用该特性，不改变现有控制面单活限制。

`NodeManagementGrants.initializeCommands()` 是可信初始化入口。它要求已有 allocation v1 私有 authority、维护状态为 OPEN，并在一个事务内新增 `command_grants`、只读视图和授权函数，同时将私有 `meta` 与 coordination feature marker 的 `command_protocol_version` 设为 1。allocation 的 `protocol_version` 保持 1。运行时不执行 DDL；缺少任一已启用对象或两处版本不一致时拒绝操作。

新对象仍位于由业务 schema 唯一派生的私有 authority schema。业务备份和恢复不包含它们。授权函数动态读取业务 `vm_operations`，不对可替换的业务表建立静态依赖。旧业务操作被恢复后，也必须匹配 coordination 中的当前 epoch。

## 动作与接口

- `issueInitialPublish(input)`：要求当前精确 `node_publish_initial` VM 操作。输入绑定 PG 中已保存的原始 VACANT allocation 回执、原始 fence、清单版本 0→1、完整受限凭据 payload 的 SHA-256、固定 preset 和节点 policy 摘要。
- `issueLaunch(input)`：要求当前精确 `node_launch` VM 操作。输入绑定已保存的首次发布回执、清单版本 1 和 manifest 摘要，使用同一原始 VACANT fence。
- 两个发行入口均返回 `{intent, intentDigest}`。`intent` 使用 Go 协议约定的 snake_case 字段。`epoch` 和 revision 为规范十进制字符串；首次 VACANT fence 的 generation 固定为可无损编码的数字 1。
- `recordInitialPublishReceipt(grant, receipt)` / `recordLaunchReceipt(grant, receipt)`：在原精确操作仍有效时重新检查授权、epoch 和完整来源链，原子保存固定字段回执。相同回执可重复确认；不同回执拒绝覆盖。
- `readLaunchReceipt({vmId, nodeId?})`：从 PG 确定节点并验证完整链，返回原 launch 回执。正常撤销授权不会删除已确认回执。它证明历史启动已被确认，不证明容器当前仍在运行，也不获取新 fence 替换原值。

`publishInitial(input)` 和 `launch(input)` 将上述接口组合为发行授权、事务外单次 TLS 请求、严格校验回执、原子保存。首次发布要求 Buffer，复制后绑定其完整 SHA-256，限制为 1..65536 字节。客户端只接受固定 IP、TLS 1.3 和证书指纹；节点 token 用于运输认证，不能代替 PG 动作授权。客户端不重试、不重新发行授权，不接受 shell、路径、Docker 参数或任意配置 RPC。

仅在 TLS 应用数据尚未发送时，证书或连接拒绝可带明确的 `vmOperationNotStarted`。发行前的维护阶段/特性拒绝同样使用这一证明。发送后的断连、无效回执和 PG 回执提交失败继续保留原 VM 操作。回执上限为 8192 字节，错误不包含上传内容或节点返回的原始文本。

每个 allocation 的每种新动作只允许一条命令。command ID、动作、操作、owner、epoch、fence、payload、preset 和 policy 不能通过重新发行修改。未知操作继续占用 VM；本增量不提供超时释放或自动恢复。

## 固定协议

intent 字段固定为 `action,node_id,vm_id,allocation_id,operation_id,owner_id,command_id,epoch,fence,expected_manifest_revision,manifest_revision,payload_digest,preset_id,policy_digest,manifest_digest`。

intent 摘要为以下字符串按 NUL 连接后的 SHA-256：

```text
slotgate-command-v1
action,node_id,vm_id,allocation_id,operation_id,owner_id,command_id,epoch
decimal(fence.generation),fence.incarnation
expected_manifest_revision,manifest_revision,payload_digest,preset_id,policy_digest,manifest_digest
```

以上换行仅用于排版；摘要输入的所有 17 项只以 NUL 分隔。VACANT executor 必须精确为 `{kind:'',node_boot_id:''}`，因此不另列入摘要。

publish 回执固定为 `{intent,intent_digest,manifest_revision,manifest_digest}`。launch 回执增加 `fence`，其中 executor 必须符合已有 `container` 身份规范。禁止额外字段；授权表和回执不保存 token、凭据字节或任意配置内容。`payload_digest` 只用于绑定上传输入，不可作为凭据描述符或登录状态使用。

## 授权与锁

发行、回执保存和撤销使用 `VM 操作行 → node/VM advisory 排他锁`。节点 reader 使用相同 namespace/resource 的短事务共享锁，通过 `authorized_commands` 查询精确动作、身份和摘要。`command_current` 还检查当前 epoch、OPEN 阶段、有效原 VM 操作和双 feature marker。

共享授权窗口只覆盖节点本地 journal 或最终 rename。上传和 Docker I/O 位于授权事务之外。节点必须在发布前和提交时分别核对同一授权；未知结果不能通过后续命令或健康观察覆盖。

现有 reader 安装 SQL保持不变。新增 `commandReaderRoleSql({role})` 仅授权新只读视图和函数，不授予基表写权限；它要求可信配置已安装该 role 的节点关联。

## 验证范围

定向测试使用两个独立 PG 连接、合成 allocation/publish/launch 回执及专用数据库临时 reader role，覆盖显式启用、精确操作、回执不可变、未知保留、共享授权锁与 epoch 拒绝。真实 Go 发布、启动与 TLS 路径由独立 worker 增量负责集成验证。
