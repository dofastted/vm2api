# 节点独立消费响应与恢复观察

## Controller 断连后的读取

失败规格 `53bbcd65` 使用本地 TCP RST 分别复现 OK 前缀前、JSON 中途和 SSE 中途断连；原 command 都停留 pending。原因是转发写失败立即返回，defer 关闭了原 kernel body/socket。

本批 KSG2 在提交原请求后由节点 goroutine 继续拥有同一 kernel 响应。下游写有固定短 deadline；controller 断连或持续阻塞时，停止向该连接交付并丢弃后续输出。HTTP 序列化仍持续读取原 body，通过现有正常 JSON/SSE 终态解析器消费到结束。没有重试、第二个 job、重新查询最新 Fence 或取消后猜测结束。

不能在 `http.Response.Write` 返回写错误之后才尝试补读 body，因为该路径可能已经关闭 body。节点 writer 在客户端交付失败时切换 discard，使原 body 保持可读；HTTP/body 读取错误仍会传播。

正常终态和完整响应允许沿用 Authority 的 journal fsync 标记 completed。断连本身不提供完成证明；截断、尾随 error、错误 trailer、parser 限制或 journal 失败继续保留 pending/unknown。节点生命周期取消仍关闭本地连接；不能据此释放远端未知执行。此路径不会用 timeout 或 TTL 释放容量。

测试只用 fake kernel、临时 Unix/TLS 监听和 controller RST，并验证错误终态不能 completed。没有真实 Docker、SSH、节点或 provider 操作。

## 后续恢复状态和计费 receipt

当前本批尚未提供无 ticket 的历史 recovery-status、seal-not-started 或持久 usage receipt。后续只读查询必须使用 PG 保存的原 VM/Fence/command ID，不能从当前 state 重新授权。notfound 不等于未开始；未 dispatch 也不能直接释放，因为旧 owner 仍可能延迟发送。

usage 缺失不得补零结算；节点只提供原始公开 model/usage/terminal 信息，PG 根据原 command 对应的 parent/attempt 和价格快照处理。node health、ready_slots 和取消 ACK 均不是恢复终止证明。以上节点能力不表示生产 HA 已完成。
