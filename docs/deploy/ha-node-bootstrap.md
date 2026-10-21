# HA 节点的可信离线初始化

`scripts/ha-node-bootstrap.mjs` 提供 `trusted-init` 和 `slot-create` 两个操作者命令。它不会安装节点、修改 Docker daemon、上传镜像、创建数据库角色或增加 HTTP 管理接口。执行前须由可信部署流程安装固定版本节点 daemon、镜像/网络/UID/GID policy、节点证书与 PostgreSQL 连接配置，并通过独立可信渠道核对 TLS pin 与 policy digest。

运行环境需要 Node.js 22、PostgreSQL 17 应用 owner 的连接，以及到所选节点的固定 TLS 链路。配置必须是当前操作者所有、权限恰为 `0600` 的普通文件；拒绝符号链接和 hard link。业务 schema 必须显式指定且不能是 `public`、PostgreSQL 系统 schema 或 node/coord 派生 schema。DBA 预先创建无继承、无成员关系、无超级用户/建库/建角色/复制/BYPASSRLS 权限的独立 LOGIN reader 角色。密码由 DBA 单独配置，不能写入命令参数。

以下是配置结构。用安全编辑器写入私有文件，示例字符串必须替换；不要把实际连接串、节点 token 或凭据贴到终端历史。

```json
{
  "database": { "url": "postgresql://APP_OWNER@DB/APP", "schema": "vm2api" },
  "node": {
    "id": "original-node-id",
    "address": "192.0.2.10",
    "port": 9443,
    "token": "REPLACE_WITH_PRIVATE_NODE_TRANSPORT_TOKEN",
    "certSha256": "REPLACE_WITH_64_LOWERCASE_HEX",
    "presetId": "claude-docker-v1",
    "policyDigest": "REPLACE_WITH_64_LOWERCASE_HEX"
  },
  "reader": { "role": "node_reader", "sqlOutput": "/private/node-reader.sql" },
  "vm": { "id": "original-vm-id", "accountId": "original-account-uuid" },
  "credentialFile": "/private/initial-credential.json"
}
```

node ID、VM ID、account UUID 使用原始值。TLS/policy 字段必须与应用的固定 HA trust 文件以及节点配置一致。`policyDigest` 的生成规则见 [节点初次发布协议](../plans/2026-10-22-node-initial-publication.md)，不能从未授权的 runtime State 猜测。`vm.fingerprint` 可显式提供 `{device_id:64位小写hex,session_id:UUID}`；未提供时仅在首次新记录中生成并与该记录原子保存。

先运行：

```sh
node scripts/ha-node-bootstrap.mjs trusted-init --config /private/bootstrap.json
```

该命令显式安装 allocation、command 和 refresh 三套 private authority/coordination marker，并安装 `allocation_terminal_protocol_version=1`。后者保留未发送 allocation 的原 ID/终态历史，仅在明确未发送时释放 VM/physical target 的唯一占位。各项升级在可信初始化事务锁内执行；运行时不执行 DDL，也不创建角色。stdout 仅输出节点 ID、私有 authority schema 和 SQL 文件位置。SQL 文件以 `0600`、禁止覆盖的方式创建，包含 reader 与节点的绑定以及最小 view/function GRANT，不含密码或 DSN。

已有 authority 升级时，仍由操作者显式执行 `trusted-init`，并为 `reader.sqlOutput` 选用新的私有输出路径。已有 reader 绑定和函数权限保持；无需重复执行包含同一 reader 绑定的 SQL。升级不自动清除旧未知任务。尚未升级的 authority 在 allocate 明确未发送时返回 `node_allocation_terminal_unavailable` 并保留占位，须按恢复证据流程处理原任务。

DBA 检查并以应用 owner 身份执行该 SQL 文件。随后把返回的 authority schema、原 node ID 和该 reader 的连接串装入节点原有 `management` 配置；连接串只保存在受控节点文件。节点 reader 不能修改业务表或签发 grant。数据库连接角色拥有额外权限时，节点 authorizer 会拒绝。

初始凭据文件也是当前操作者所有的 `0600` 普通文件，最大 64 KiB，结构为 `{ "credential": { "type": "oauth", "account_uuid": "原始账号UUID", "access_token": "…", "refresh_token": "…", "expires_at": 0 } }`。`expires_at` 可省略；实际值须是非负整数。也支持既有 `setup-token`、`official-setup-token`、`apikey` 固定类型，遵循节点初始发布字段限制。account UUID 必须与配置一致。不接受 provider URL、path、argv、env 或任意配置内容。

```sh
node scripts/ha-node-bootstrap.mjs slot-create --config /private/bootstrap.json
```

也可从显式文件描述符读取凭据。此时从配置移除 `credentialFile`，调用 `slot-create --config /private/bootstrap.json --credential-fd 0` 并由操作者的受控 secret 管道提供 stdin。凭据内容不进入 argv、stdout 或 PostgreSQL VM 元数据。

`slot-create` 持有一个持久 bootstrap BG claim，顺序执行独立的 allocate、publish-initial、launch VM operation。每一步都等待严格 receipt 后再进入下一步。RT 仅保存在节点未挂载的 canonical 路径；guest 只得到 AT 投影。launch receipt 确认后才原子新建公开 VM 元数据和指纹。已有 VM、并发插入或未知旧任务均拒绝，不覆盖记录。stdout 只输出公开 IDs、manifest 摘要与原 captured Fence；它证明节点 launch/元数据步骤，不证明真实模型推理成功。

发生发送后的超时、断连、节点启动未知或元数据提交失败时，相关持久 claim 和目标占位保留。再次执行不会换 command ID 重发。首个节点回调前明确 busy 的拒绝会结束本次未提交任务。首个 allocate 在 TLS 应用数据发送前失败时，只有原 grant 的未开始终态及撤销已持久化后才结束本次任务；操作者修正 pin/连接配置后可显式再运行。终态写入失败仍保留未知占位。不能删 claim、改 VM ID 或重新发 allocation 来猜测恢复；须先按节点终止/恢复证据流程人工核实。CLI 不提供未知任务自动恢复，也不升级旧的 RT 已暴露 manifest。

测试只覆盖合成凭据、任务 PostgreSQL、TLS 和 fake Engine；没有真实 provider 或现有节点操作。闭源 kernel 在投影更新后是否重新加载 AT，仍需独立业务验证。旧 HA credential monitor 不能因此直接启用。
