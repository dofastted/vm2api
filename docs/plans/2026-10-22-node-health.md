# 捕获执行身份的只读节点 health

本批在节点初始发布之后新增只读 KSG2 health。失败规格为 `967711c8`：原节点尚不识别此 RPC；原初始凭据发布允许缺少唯一账号身份。仅使用 fake kernel、fake Engine、临时目录和 Unix/TLS 监听，未接触真实节点、Docker、SSH 或 provider。

## 固定请求与公开响应

请求固定为 `{op:'health',vm_id,fence,manifest_revision,manifest_digest}`。manifest revision 为规范字符串 `1`，fence 必须是历史 launch receipt 捕获的 ACTIVE Fence，包含原 immutable executor。不能提交 URL、HTTP 路径、headers、身份、凭据、command/ticket 或 management intent。

响应为 `{ok:true,fence,manifest_revision,manifest_digest,health}`。节点从不返回最新 state 替换原 Fence，不通过 prepare/forward，不创建 command，不刷新凭据或请求外部 provider。

节点在请求前、固定 GET 发送边界和响应后核对原 ACTIVE Fence、manifest 和 pending management。任何 pending/unknown mutation 或 REVOKING 状态均拒绝。GET 的响应读取不持 Authority 全局锁；只在初始小请求写入时校验原状态。固定路径是捕获 incarnation 的 `run/kernel.sock`，HTTP 路由仅 `GET /internal/health`，内部 token 从节点固定文件取得。上下文和 socket deadline 均限制为两秒，不回退到其他路径。

kernel 必须返回完整、受限的 HTTP 200 application/json；截断、trailer、重复字段、额外 JSON 和错误字段类型被拒绝。只保留明确的公开布尔值、计数、engine/provider/version 字段。未知字段、嵌套 provider 扩展和 headers 不返回。非空内部 unhealthy_reason 变为固定 `kernel_unhealthy`，避免原始错误描述泄露认证或 endpoint 内容。

## 账号身份与凭据摘要

已有 payload health 取证 `/tmp/vm2api-648-kernel-busy-capabilities.json` 仅有 credential_state，不提供 account_uuid。本接口不从该状态猜测账号。

初始发布现在要求 account_uuid，并允许 org_uuid/email。它们是受可信 grant 批准且纳入摘要的输入。节点按既有凭据 schema 写入，并在私有 manifest 保存身份。health 读取 node-owned 凭据目录中的普通文件，拒绝 symbolic/hard link；当前凭据的 accountUuid/account_uuid 必须与私有 manifest 一致。kernel 若明确报告了不同账号，也被拒绝。

公开 credential 固定含 account_uuid、has_access、has_refresh、expires_at、generation，另可含 needs_refresh、org_uuid、email。identity 只含 account_uuid/org_uuid/email。不会返回 access/refresh/API/internal token、原始凭据或单个 secret 文件摘要。

generation 保留原始数字文本或受限 opaque string，避免 JavaScript 安全整数边界导致精度丢失。时间按现有 store 的 seconds/milliseconds 规则归一到毫秒文本；无效或溢出的 expiry 被拒绝。needs_refresh 只调用现有纯判断函数，不触发刷新。响应后再次检查凭据 bytes 和 config/token 摘要；读取期间发生轮换或状态变化时，整次观察被拒绝。

## 证明边界

这是原捕获身份的一次节点观察，不是某个推理 job 的终止证明。ready_slots、正常 health、HTTP 取消或连接关闭不能释放 unknown execution。controller 仍须在提交前用 PG 准入，并等待原 command 的持久完成。

controller 断连后的独立读取见同目录 `2026-10-22-node-recovery.md`。尚未提供节点 credential refresh、运行期 config 修改、无 ticket recovery receipt 或完整 HA 故障接管。这些不通过 health 隐式执行。旧 SSH/SFTP/Docker 权限迁移仍未完成，因此不能据此开启生产多副本 HA。
