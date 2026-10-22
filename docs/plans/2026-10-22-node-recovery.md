# 节点独立消费响应与恢复观察

## Controller 断连后的读取

失败规格 `53bbcd65` 使用本地 TCP RST 分别复现 OK 前缀前、JSON 中途和 SSE 中途断连；原 command 都停留 pending。原因是转发写失败立即返回，defer 关闭了原 kernel body/socket。

本批 KSG2 在提交原请求后由节点 goroutine 继续拥有同一 kernel 响应。下游写有固定短 deadline；controller 断连或持续阻塞时，停止向该连接交付并丢弃后续输出。HTTP 序列化仍持续读取原 body，通过现有正常 JSON/SSE 终态解析器消费到结束。没有重试、第二个 job、重新查询最新 Fence 或取消后猜测结束。

不能在 `http.Response.Write` 返回写错误之后才尝试补读 body，因为该路径可能已经关闭 body。节点 writer 在客户端交付失败时切换 discard，使原 body 保持可读；HTTP/body 读取错误仍会传播。

正常终态和完整响应允许沿用 Authority 的 journal fsync 标记 completed。断连本身不提供完成证明；截断、尾随 error、错误 trailer、parser 限制或 journal 失败继续保留 pending/unknown。节点生命周期取消仍关闭本地连接；不能据此释放远端未知执行。此路径不会用 timeout 或 TTL 释放容量。

测试只用 fake kernel、临时 Unix/TLS 监听和 controller RST，并验证错误终态不能 completed。没有真实 Docker、SSH、节点或 provider 操作。

## 历史恢复状态

失败规格 `caab8b81` 证明原接口不能在 controller/node runtime 变化后读取历史完成记录。新增 authenticated KSG2 `recovery-status` 请求固定为 `{op,vm_id,fence,command_id}`，无需 ticket。fence 必须与该 command 的历史记录完全相等；不会拿当前 slot state 的 generation、executor 或新 nonce 替换旧身份。

找到记录时返回 `{ok:true,found:true,command:{id,fence,status,dispatched}}`。历史 completed 跨 generation 保留；重启后 pending 变 unknown 的记录继续返回 unknown。接口仅查询 inference command，不提供管理动作的执行权限，不发送 kernel/Engine 请求，不创建或修改 command。

找不到记录时仅返回 `{ok:true,found:false,unknown:true}`。它不证明未开始，也不产生 seal/tombstone；旧 owner 仍可能延迟 prepare/forward。调用方必须继续保留 PG 未知占位。输入错误、原 Fence 不匹配、节点 journal 不可用时拒绝，不退回当前 state 或其他传输。

## 节点启动标识

节点启动时独立读取宿主 bootID。新 prepare、forward 和 health 必须匹配原 Fence 中 executor 的 bootID；forward 在 Dispatch 边界再次核对。旧 ACTIVE 日志和相同路径的 Unix socket 不能自动授权新启动环境中的执行。失败规格 `5824f8a9` 分别复现旧 boot 仍可 prepare、dispatch 和读取健康状态。

bootID 不匹配仅拒绝新授权，不是旧 executor 终止证明，不更新 generation，也不释放 PG 容量。已有旧 boot 的 ACTIVE 状态仍需撤销、保留未知并走可信恢复。历史 recovery-status 按原 command/Fence 读取已持久结果，不要求当前 boot 或当前 generation 相同。

## 原 command 未发送封存

失败规格 `2e3b6af2` 覆盖原先缺少未发送封存接口的情况。新增 authenticated KSG2 请求 `{op:"seal-not-started",vm_id,fence,command_id}`。它只拒绝该 command ID 的未来发送，不发 kernel/Engine 请求，不停止任何作业，也不增加 revoke、advance、stop 或 refresh 权限。原 runtime token 已能通过 prepare 占用同 ID；此 deny 操作使用同一 token，但仅允许当前 ACTIVE、当前 boot、完整原 Fence 完全匹配且已受信任 allocate/publish 的 managed kernel incarnation。未知管理动作、旧 generation、非 managed 状态或不匹配的 manifest incarnation 均拒绝。接口不接受 ticket、kind、management grant、manifest 替换或 body。

Authority 在与 Dispatch 相同的锁下检查原 ID。不存在的 ID 或原同 Fence 的 pending 且未 dispatch 的 inference command 可以写入持久 tombstone。响应为 `{ok:true,found:true,command:{id,fence,status:"not_started",dispatched:false}}`，不含用量凭证或最新 state。`not_started` 独立于表示已验证 executor 终止的 `terminated`，也不属于 dispatched completed。既有 dispatched 标记在任何状态都拒绝 seal。

先封存成功时，之后的同 ID prepare/forward 永久拒绝；先 Dispatch 持久化时，seal 不返回未发送证明。两者不通过连接关闭或时间推断胜负。写盘失败时不返回证明，Authority 保持不可用。节点重启保留已持久 tombstone；原 recovery-status 可按原 Fence 读取它。重复 seal 仅在同一当前授权下幂等，不重新授权旧 generation 的 notfound，也不把请求身份替换为最新 state。

本批测试使用 fake Engine、临时 Unix/TLS 监听和合成 journal。覆盖与 prepare/forward 的并发、迟到发送、重启、原 Fence 拒绝和写盘故障。PG 释放须另行核对原持久 job/attempt 身份；本接口没有 PG 释放逻辑，不以 TTL 释放容量。

## 正常终态的用量凭证

失败规格 `c3a3bc6c` 证明已完成执行原先没有可供死 controller 后续对账的持久用量信息。正常 JSON/SSE 终态及完整 body/trailer 验证后，节点在同一次 journal 提交中记录 completed 和 `terminal_receipt`。凭证 ID 由节点生成，不接受客户端提交。原 command 的 ID/Fence 与凭证保存在同一条记录；`recovery-status` 在原 command 旁返回顶层 `receipt`，保持 command 的四个原字段不变。历史读取不会将其他 command 的凭证拼接到当前身份。

凭证仅保留有界的实际 model、usage、speed、service_tier 和白名单 stop_reason。usage 的四个主计数为 input_tokens、output_tokens、cache_read_input_tokens、cache_creation_input_tokens。原帧存在时才保留 cache_creation 的 5m/1h 细分和 server_tool_use.web_search_requests。计数统一为 `0` 至 PostgreSQL bigint 上限的规范十进制字符串，避免 JavaScript 数值转换丢失精度。SSE 累计值按帧覆盖，不相加；完成用量要求最终 message_delta 明确给出 output_tokens。

`usage_complete:true` 还要求实际 model 与四个主计数都明确存在，且未遇到非法、重复或越界的用量。缺失字段保持缺失，不填零，不以请求 model 替代实际 model。普通终态已经确认但用量不完整时仍可记录 completed；凭证标记 `usage_complete:false`，调用方保留待对账状态。凭证不含正文、thinking、工具参数、headers、凭据、USD 或定价输入。HTTP 错误终态、截断、尾随错误、无效 trailer 或 journal 失败不产生可用完成凭证。

## 后续 PG 对账

notfound 不等于未开始；原 command 未持久 seal 时，未 dispatch 也不能直接释放，因为旧 owner 仍可能延迟发送。

usage 缺失不得补零结算；节点只提供原始公开 model/usage/terminal 信息，PG 根据原 command 对应的 parent/attempt 和价格快照处理。node health、ready_slots 和取消 ACK 均不是恢复终止证明。以上节点能力不表示生产 HA 已完成。
