# 推理数据面（实现备查）

> **产品主路线**见 [技术路线.md](技术路线.md)：Setup Token → Console API、Claude Code 原生 subagent、TCP → Console endpoint、0 提示词注入。
> 本文只记当前进程怎么挂。公开仓 **只走 rust cli-hop**。Go HTTP 转发不再启用。

Node 只做控制面（鉴权、协议、人设、调度、面板）。**不直连** `api.anthropic.com`。无直连回落，也无 Go hop 回落。

## 唯一推理路

`engine=rust`：envelope → Claude kernel → patched Claude Code `native_messages`（预开 20 slot）→ CLI TLS → 本机 HTTP CONNECT → 槽 SOCKS5 → Console / Anthropic。

`dataplane=crag` 的原生 V2 走同一 rust cli-hop 和 Unix socket，按需启动或复用独立的官方 Claude Code 进程，不使用 wrap 预开的 native slot。

```
client ──nginx──► Node :8787
                     │ fingerprint / persona / pool
                     └─ rust cli-hop
                           envelope → Claude kernel
                           provider=local_cli → Claude Code native_messages
                           CLI TLS → CONNECT → 槽 SOCKS5 → 上游
```

代码钉死：

- `resolveHopEngine` 永远返回 rust；缺二进制 / 不健康时 **blocked**，不切 Go。
- `resolveOfficialCcInference`：engine=rust 时 **强制** `cli-hop`。
- `writeKernelConfig`：`provider: local_cli`。
- 历史 `go` / `fallback_to_go` 写入一律收成 rust / false。
- Go hop 服务端已删除。`kin-worker` 只剩 `telemetry` 子命令。

## 不要和这两件事搞混

| 名字 | 是不是推理 |
|---|---|
| 官方 Claude Code **初装**（wipe → hello → /stats） | **不是**。换票后用槽内 cli-node 跑一次（不再另装官方 CLI）。推理不跑初装的常驻 CLI。 |
| kernel `HopClient` / `provider=anthropic_api` | **退役的 rust HTTP hop**。不要再当现网。 |
| `worker/` 凭证客户端 | 换票 / ensure 仍可能用到，**不**再做 `/v1/messages` hop。 |

## 槽位约束

- 强制槽 SOCKS5（`proxy_required=true`）。
- wrap 预开 20 native slot；面板「并行」只改 Node inflight，不重启 kernel。
- Extra 5h 以 Messages **headers** 为准。wrap 必须把 `anthropic-ratelimit-unified-5h-*` 从 CLI → kernel trailer → Node `ingestHeaders`。

## vm2api 托管原生 CRAG V2

仅当通过 readiness 的原生 worker 健康报告明确带 `gateway_policy_v1: true`，vm2api 才在经内部 token 认证的 `/internal/v1/messages` envelope 下发 `gateway_policy`。旧 worker 不收到该字段，继续使用原来的处理方式。

| 设置 | 生效边界 |
|---|---|
| `pool.queue_max` | vm2api 全池等待上限，不复制成每个 CRAG worker 的队列深度。 |
| `pool.sticky_wait_timeout_ms` / `pool.fallback_wait_timeout_ms` | 分别约束粘性与全池等待阶段。送入 CRAG 的是当前阶段剩余额度，并受 `failover.total_retry_deadline_ms` 截止约束；无额度只尝试立即准入。worker 保留独立容量和队列深度上限，未下发等待额度时才使用启动配置的排队时限。 |
| `failover.session_queue_timeout_ms` | 同会话进入调度前的串行等待；`0` 不限时，不占号池等待队列或 worker 槽。 |
| `KIN_UPSTREAM_TIMEOUT` / `failover.stream_idle_timeout_ms` | CRAG turn 的首个有效内容等待 / 后续内容间静默上限；HTTP 响应头、verified 完整交付和推理总时限是不同的计时点。已开始的 turn 保留原策略。 |
| `sticky.ttl_seconds` | vm2api 的账号/VM 绑定记忆；已保存的绑定不会因改值而重写到期时间。 |
| `inference.session_idle_ttl_seconds` | CRAG 已结束 turn 的热进程保留时间。缩短后，新请求可拒绝复用已经超龄的进程；延长不会延长已停车会话的原到期时间。与工具等待无关。 |

账号并行、逻辑会话席位、内核热进程、物理进程槽和当前上游并发各自计数。释放逻辑席位不等于解除账号/VM 粘性绑定；热进程也不等于在途推理。CRAG 可以回收空闲进程，不会为排队请求抢占正在推理或等待工具的进程。热会话和工具续接由已认证身份隔离，不接受调用方指定的 `x-tenant-id`。

面板仍写 `kernel.json` 作为启动/兼容配置。支持该协议且健康的原生 CRAG 不因单独修改流空闲时限而重启；新请求使用新值。旧 worker 和请求体大小变更保留原来的空闲重启行为。
