# Codex 五维防封清单（RFC-01 配套）

> 每个控制点标明：实现位置 + 验证方法。迭代中新发现的泄露面追加到本文件。

## 1. TLS 指纹 / ClientHello

| 检查项 | 控制点 | 验证 |
|---|---|---|
| JA3/JA4 与官方 codex 一致 | 槽内仅运行官方 `codex` 二进制（reqwest+rustls）；SOCKS5 CONNECT 纯 TCP 转发，不终止 TLS | `tls.peet.ws` / ja4 探针容器内直连对比官方裸机 |
| HTTP/2 SETTINGS/帧序 | 同上 | 同上，h2 指纹对比 |
| WebSocket 握手（`prefer_websocket`） | 由 codex 原生 ws 客户端发起 | 抓包对比官方 CLI |
| 出口链路无注入 | `kin-worker` CONNECT-only；禁用 env proxy 变量进 CLI（沿用 `kernelEnv`） | 单元：config 断言 + 集成抓包 |

## 2. 出口 IP / 时区一致性

| 检查项 | 控制点 | 验证 |
|---|---|---|
| 单槽单出口 | `proxy_required=true`；容器无直连路由 | 容器内 `curl ip`（应失败或仅见代理出口） |
| IP 固定 | 槽绑定固定住宅代理；漂移即熔断 | 周期探测出口 IP 哈希 |
| 时区=GeoIP | 槽创建时 `TZ`/`/etc/localtime` 按出口 GeoIP 写入 | GeoIP 库 vs `date +%Z` 断言 |
| DNS 不泄露 | DoH 经 kin-worker；禁 53/853 裸出口 | 抓包无 UDP/53、TCP/853 |
| NTP/系统时间 | 容器时间同步宿主机但不出网 | 容器无外联 NTP |

## 3. 每账号设备信息唯一且真实

| 检查项 | 控制点 | 验证 |
|---|---|---|
| installation id | codex 首次启动自生成，持久于槽卷 | 两槽 id 互不相同、符合官方格式 |
| account_id / tokens | 官方 OAuth 签发 | `codex login status` 在槽内通过 |
| `~/.codex` 状态全量唯一 | 槽持久卷，不共享 | 文件 diff |
| machine-id/hostname/MAC/SMBIOS | pillar-1 拟真一次固化 | 出槽巡检脚本 |
| 运行时三元组 | `runtime_os/arch/version` 取容器真实值 | 与遥测字段一致 |

## 4. 行为特征零泄露

| 检查项 | 控制点 | 验证 |
|---|---|---|
| `SessionSource` | 只允许 TUI（`Cli`）；禁用 `exec`/`app-server` 通道 | 上游抓包 metadata 断言 `thread_source=cli` |
| `client_metadata` 完整性 | 由 codex-core 生成，不自建 | diff 官方裸机请求 |
| 并发形态 | 每槽 TUI 进程池上限 + 账号级 RPM | 压测并发曲线 vs 单人可解释上限 |
| 退避/重试/降级 | 原生 codex 行为，不干预 | 注入 429/5xx 观测 |
| 提示词零注入 | 沿用 zero 改写 | 干净度基准 codex 版 |
| 请求-响应时序 | 不人为加速；helper 不加额外上游调用 | 时序审计 |

## 5. usage/辅助行为全封装 + 固定出口

| 检查项 | 控制点 | 验证 |
|---|---|---|
| usage 查询 | 容器内官方端点，同一 auth.json，同一出口 | socket 回传 + 抓包源 IP |
| token 刷新 | codex 自身刷新，容器内完成 | 等待过期观测续用 |
| 模型目录/feature flag/analytics | 全部容器内、同一出口 | 出网审计只有 chatgpt.com/auth.openai.com 等官方域 |
| login 流程 | 容器内 OAuth loopback，授权 URL 经控制面透出给用户 | 端到端登录演练 |
| 全部出网白名单 | slot-gate 域白名单（chatgpt.com、auth.openai.com、ab.chatgpt.com、otel 端点） | 容器外 pcap 审计非白名单即告警 |
