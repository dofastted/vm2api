# 04 · 运维手册：出口门禁、时区一致性、usage 端点（M2d）

> 版本 v0.1 — M2d 落地。对照 openai/codex `ddfaef9`。

## 出网硬门禁（维度 5：所有出口固定 IP）

槽内只允许两类流量出网，全部经 `KIN_EGRESS_*`（SOCKS5/CONNECT）：

| 源 | 目标 | 说明 |
|---|---|---|
| `codex` 二进制 | `chatgpt.com`（API）、`auth.openai.com`（OAuth refresh） | 由槽透明代理强制走固定槽 IP |
| helper 自身 | 本地 unix socket（控制面） | **不出网**，无第二指纹面 |

白名单审计（槽容器 iptables/nftables 或宿主机 egress 网关）：

```
# 直接出网应为 0——任何命中即泄露面
nft list ruleset | grep -v "daddr 127.0.0.1\|via proxy"
```

- `codex` 自身出网域名清单（源码 `core/src/*`）：`chatgpt.com`、
  `auth.openai.com`、`api.openai.com`（usage/credits 页）、
  `*cdn.oaistatic.com`（icon 等静态资源，可不放行）。
- 日志巡检：进程级 `ss -tnp | grep -v 127.0.0.1` 应只有 codex 到代理的
  连接。

## 时区/地理一致性（维度 2）

源码侧 codex 不发送显式时区字段；时间一致性的泄露面是**容器本地时区**
（`turn_started_at_unix_ms` 由 UTC 毫秒构成不受影响，但 `Date` 头、
TLS 握手时间戳漂移、rollout 本地时间戳均受容器 TZ 影响）。

- 镜像按槽 GeoIP 结果写 `/etc/localtime` + 环境 `TZ=<geoip zone>`；
  helper 已透传 `TZ`/`LC_ALL`/`LC_TIME` 给 spawned TUI（`tui.go`）。
- 验证：槽内 `date` 时区缩写应与代理出口 IP 的 GeoIP 一致；
  `curl --socks5 <proxy> ifconfig.co` 拿到出口 IP 后用 ipinfo 比对。

## usage 端点（M2d 新交付）

```
GET /internal/v1/codex/usage      （x-kin-internal-token 认证）
```

返回：

```json
{
  "kernel": "codex-tui",
  "account_id": "<auth.json account_id>",
  "workers": 2,
  "sessions": [
    {
      "session_id": "<codex thread id>",
      "dir": "codex-work/proc-0",
      "busy": true,
      "model": "gpt-5.2",
      "usage_record": {
        "usage": {"input_tokens": 0, "cached_input_tokens": 0,
                  "output_tokens": 0, "reasoning_output_tokens": 0,
                  "total_tokens": 0},
        "turn_token_usage": {},
        "thread_token_usage": {}
      }
    }
  ]
}
```

- 数据源 = 每 worker rollout 的最后一条 `token_usage_record`
  （`payload.usage` 当次响应用量；`thread_token_usage` 累计）。
- **账号配额/限速**（rate limits）只存在于上行响应头和 TUI 内存
  `RateLimitSnapshot`，codex 不落盘 → 本端点不返回；M3 方案：
  屏幕抓取 `/usage` 视图或挂 app-server `account/rateLimits`。
- 控制面建议：每次 `response.completed` 后的 `usage` 字段即是
  当次用量，计费/配额以它为准，本端点用于巡检与会话级累计。

## 巡检清单

| 项 | 手段 | 通过条件 |
|---|---|---|
| 出口唯一 | 槽内 `ss -tnp` + 网关白名单日志 | 仅 codex→代理 |
| TZ=GeoIP | `date` vs ipinfo | 缩写一致 |
| 设备唯一 | `CODEX_HOME/installation_id` | 槽间 UUID 互不相同 |
| 会话隔离 | usage 端点 sessions ≠ 复用 worker 的 thread | 每逻辑会话一 thread |
| usage 闭环 | `response.completed.usage` + `/usage` 端点 | 与 rollout 一致 |
