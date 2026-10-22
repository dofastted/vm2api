# Node-owned credential refresh

本批只覆盖新建普通 Claude Docker 节点实例。standalone 的本地 worker 刷新路径保留。所有验证使用合成凭据、fake Engine、httptest provider 和本任务 PostgreSQL。没有向真实 provider 或现有节点发请求。

新的 initial publication 在 AuthorityDir/credentials/<vm>/<incarnation>/credentials.json 持久保存 canonical 凭据。该路径不在任何 guest mount 内。guest 的既有 credentials.json 格式只投影 AT、generation、expiry、identity，不包含 RT。manifest 的 credential_authority=node-private-v1 与 private digest 绑定此布局。旧的已暴露 RT manifest 不自动接管；typed refresh 明确拒绝。guest 文件不能提供权威 generation；health 从 canonical 读取，并核对 guest 投影摘要、字节与固定 .credentials.json 链接。guest 替换同账号文件也会拒绝。

NodeCredentialRefreshGrants.initialize() 是显式可信初始化。private meta 与 coordination marker 的 refresh_protocol_version=1 必须同时存在。运行时不执行 DDL。readerRoleSql 仅授予 authorized_refreshes 和 refresh_current 的读取/执行权限；既有 reader_identity 仍校验该节点的独立角色。

KSG2 独立操作 credential-refresh 使用 refresh 字段，不使用 management/allocation/inference grant。RefreshIntent 固定字段为 action,node_id,vm_id,allocation_id,operation_id,owner_id,command_id,account_id,bg_task_key,bg_execution_id,bg_owner_id,epoch,fence,expected_credential_generation,manifest_revision,manifest_digest,preset_id,policy_digest,force。epoch/generation/revision 使用十进制字符串；Fence generation 沿用数字 wire 并无损解析。fence 必须是原 ACTIVE container 身份，node boot ID 必须等于当前节点。preset 固定 claude-docker-v1，provider 固定 https://platform.claude.com/v1/oauth/token，禁止 redirect。RPC 不接收 URL、argv、env、path 或 token。

intent_digest 为 SHA256，NUL 顺序为 slotgate-refresh-v1、action 到 epoch 的前12个字段、fence generation/incarnation、executor kind/node_boot_id/container_id/docker_daemon_id/started_at、expected_credential_generation、manifest_revision、manifest_digest、preset_id、policy_digest、force(0/1)。PG 只存公开 intent 和 receipt。grant 要求当前 SharedCredentialRefresh 回调的 live scope、exact VM operation/account 和当前 BG execution/owner。仅持有别人的 claim ID 不够。锁顺序为 BG row share → VM operation row → node/VM advisory lock → control row share；节点的共享授权锁只跨 journal commit，不跨 provider 请求。

节点先持久化 pending，再使用现有 Refresher。只有完整 provider 结果、canonical 保存、guest 投影 fsync、第二次 exact 授权和 journal commit 全部确定，才返回 finished receipt。完整 HTTP 拒绝可结束本次 attempt，后续显式 attempt 仍可重试。响应截断、timeout、保存失败、投影失败、journal/PG receipt 提交未知均保留占位；同 command 不重发，未完成 generation 不能重新 issue。容器结束证明不能清除节点上未知的 refresh mutation。

receipt 仅包含 intent、intent_digest、finished、ok、status、refreshed、可选固定 error_code 和公开 credential summary(generation/expiry/identity/presence)。Node 在任何 Pod 凭据读取前选择 typed 路径；PG receipt 发布后才完成共享 BG/VM claim。不通过 SFTP、Pod 凭据文件或 token hash 推断 freshness。未实现的 OAuth helper 保持明确拒绝，不隐式裸 Ensure。

验证边界：真实 PG + pinned TLS + Go 节点的组合场景使用未过期凭据、force=false，因此不请求 provider。实际 RT 轮换成功、截断及部分投影失败由 Go httptest provider 验证。未对真实闭源 payload 进行业务推理验收；guest 对新 AT 的运行时重新加载行为未验证。本批没有提供未知 attempt 自动恢复或旧 manifest 升级。
