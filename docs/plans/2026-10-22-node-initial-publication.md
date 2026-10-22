# 节点启动前发布协议

本批基于 `9d06160d`，仅覆盖 Linux 上普通 Claude Docker 的初次发布和启动。复用 slot image 内现成 `/opt/kin/kin-kernel`、`/opt/kin/cli-node`，不修改闭源 payload。测试只使用合成凭据、临时目录、Unix/TLS 监听和 fake Engine。没有实际 Docker、SSH、生产节点或 provider 验收。

## 授权与身份

沿用 allocation 的私有 authority schema、maintenance epoch 和 node/VM advisory resource，但采用独立 `command_protocol_version=1`、`publish-initial`/`launch` action。缺新 view、feature marker、权限或 PG 可用性均拒绝；不得退回 allocation grant、静态 forwarding token、KSG1 或 SSH。

KSG2 metadata 为 `{op,vm_id,management:<ManagementIntent>,content_length?}`。除 `op`、`vm_id` 外，旧 flat fence/command/allocation/operation/owner/kind/ticket 必须为空。publish metadata 后紧跟 `content_length` 个 payload bytes，连接仅执行一次动作。metadata 仍受 8 KiB 上限约束；payload 上限 64 KiB。

ManagementIntent 固定字段：`action,node_id,vm_id,allocation_id,operation_id,owner_id,command_id,epoch,fence,expected_manifest_revision,manifest_revision,payload_digest,preset_id,policy_digest,manifest_digest`。epoch 和 revision 使用规范十进制字符串。fence 是 PG allocation receipt 的原始 generation 1、incarnation 和空 executor，不读取最新 state 给旧动作重新授权。

`intent_digest` 是以下字符串以 NUL 连接后的 SHA256 小写 hex：

```
slotgate-command-v1, action, node_id, vm_id, allocation_id,
operation_id, owner_id, command_id, epoch, decimal(fence.generation),
fence.incarnation, expected_manifest_revision, manifest_revision,
payload_digest, preset_id, policy_digest, manifest_digest
```

publish 固定 `0→1`、`payload_digest=SHA256(payload bytes)`、空 `manifest_digest`。launch 固定 `1→1`、空 `payload_digest`，绑定 PG 保存的 published manifest digest。preset 固定 `claude-docker-v1`。policy digest 为 NUL 连接 `slotgate-policy-v1,claude-docker-v1,image_id,network_id,decimal(uid),decimal(gid)` 的 SHA256。

节点受限 PG role 通过 `authorized_commands` 精确匹配原 command/allocation/node/VM/operation/owner/action，再比较 epoch 和完整 intent digest。该 view 与 private feature marker、maintenance epoch、live VM operation 的验证由配套 PG service 提供。授权共享锁只覆盖本地 journal 和最终 rename；不跨上传或 Docker I/O。

## 固定内容和私有文件

payload 只接受 `{credential:{type,account_uuid,org_uuid?,email?,access_token?,refresh_token?,api_key?,expires_at?,scopes?}}`。type 为 `oauth`、`setup-token`、`official-setup-token`、`apikey`。account_uuid 必选，org_uuid/email 为受限公开字符串。未知字段、重复字段、额外 JSON、文件名、路径、mode、UID、URL、env、argv 和原始 settings/config 均拒绝。单 token 上限 16 KiB；scopes 最多 32 项，每项 128 字符。setup-token 不接受 refresh token；API key 不与 OAuth 字段混用。

身份元数据来自可信 initial grant 批准的完整 payload，参与 payload/manifest digest，并写入节点私有 manifest。OAuth 按现有 `credential.Store` schema 写 `claudeAiOauth.accountUuid/orgUuid/email`；API key 按该 store 的 document fallback 保存同名元数据。没有唯一账号身份的旧发布输入被拒绝，不能从 Pod 后续 health 参数补充或猜测账号。

节点生成固定 kernel config、256-bit 随机 internal token 和固定 `.credentials.json → credentials.json` link。内部 token 不返回 controller。批准的 image ID、network ID、UID/GID 来自 node-owned DockerLaunchPolicy；RPC 不能改变这些值。

受信任初始化先提供 node-owned 0700 Root。publisher 经 nofollow 目录描述符创建 `vms/<vm>/incarnations`，再创建私有 `.stage-<node-random-id>`。输入不能选择 staging 名称。stage 内只生成 `config/home/claude/run`，config 属于节点；guest 只拥有后面三个叶目录。journal、staging 父目录和 Docker socket 不挂载给 guest。已有未知 incarnation 目录不得覆盖或采用。

Linux 文件操作使用 descriptor-relative `openat/mkdirat`、`O_NOFOLLOW`、`O_EXCL`，检查 owner/mode、普通文件类型和 link count=1。所有输入 link 均拒绝；唯一固定 credential link 由节点自己创建并验证。文件和目录 fsync 后，最终 publish 再检查原授权、原 VACANT Fence、command、expected revision 和文件摘要，使用 `renameat2(RENAME_NOREPLACE)` 发布，再 fsync 父目录并持久化 completed manifest。非 Linux 平台明确拒绝本接口。

## 完成与未知状态

BeginPublish 先持久化 pending，再接收或写入内容。上传、stage、rename、fsync、journal 或响应不明时，不换 ID重发，不把存在的目录当完成证明。pending/unknown publication 阻止 launch 和 generation 推进；节点重启将 pending 标记 unknown。已完成的同意图重读返回原 receipt，不重写文件。

publication receipt 固定为 `{intent,intent_digest,manifest_revision,manifest_digest}`。journal 仅额外保存私有 config/token/credential 摘要，不保存 secret bytes。公开 receipt 不包含各 secret 文件摘要。

launch 必须先验证 completed manifest 和实际私有文件。节点在短 PG 授权内持久接受 manifest-bound launch，再复用现有 create/start/inspect/bind 状态机；Docker I/O 不持 Authority 全局锁。已接受的 launch 是 pending 动作，不能因 HTTP 断开、grant 撤销或 timeout 被视为未开始。接管仍要求原 immutable container/daemon/boot 身份的终止证明。

launch receipt 为 `{intent,intent_digest,manifest_revision,manifest_digest,fence}`，其中 intent.fence 保持原 VACANT Fence，输出 fence 含实际 ACTIVE executor，kind 为 `container`。controller 必须保存确认 receipt 后再释放 operation；未知结果继续保留。receipt 是历史启动证明，不证明当前仍在运行。

managed forward 只允许 kernel `POST /internal/v1/messages`，无 query，body.request_id 必须等原 command ID。Dispatch 内按捕获的 incarnation 检查 node-owned config/token 摘要，覆盖 `x-kin-internal-token` 和 `x-internal-token`。不能用此转发访问 credential/import 等管理 HTTP。正常响应仍须查询原 ticket 的持久 command completion 才能释放 PG execution；不会因 token 注入放宽 terminal parser。

## 验证与未覆盖范围

失败规格 `9c6fad09` 先复现未记录目录可以 launch，以及缺独立 publish 授权入口。后续专用测试覆盖完成 receipt、重放、错误 Fence/revision/大小/摘要、截断上传、PG authorizer hook 拒绝、rename 前 revoke、symbolic/hard link、目录冲突、journal fault/restart、不同 VM 并行、manifest-bound launch、node token 覆盖和管理 HTTP 拒绝。

这些测试不代替配套 PG service 与 Go reader 的双连接组合验证，也不代替现成 payload 的实际启动与推理验收。后续只读 health 见同目录 `2026-10-22-node-health.md`。未提供运行期 credential refresh/config 热更新、新 generation 再发布、native Mac/KVM/Codex executor 或自动未知状态恢复。

runtime 的旧 SSH/SFTP/Docker 权限及已建立会话尚未撤销。节点服务、批准 image/network、受限 PG role 和文件权限仍需另行授权的可信初始化。因此本批不能作为生产开启多副本 HA 的条件。
