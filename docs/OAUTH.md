# OAuth 凭证生命周期

活票只写在槽位 `credentials.json`。换票由控制面 host `RefreshIfNeeded` 经槽 SOCKS5 完成；`vm.json`、SQLite 只存脱敏元数据。Go `kin-worker` 不再做 hop / refresh。

```text
sessionKey（默认 Setup Token）或 授权码
   │ 必须先有 VM + 槽位 SOCKS5（禁止 direct fallback）
   ▼
bin/kin-cookie-auth（控制面 spawn；过程不在 Node）
   │ 先展平 helper/token 里的 oauth_account / account
   │ 身份仍缺则经同一条槽 SOCKS5 GET /api/claude_cli/bootstrap
   │ 不靠官方初装，不 PATCH Grove
   ▼
槽 ~/.claude/credentials.json   ← 活票只在这里（含 email / account_uuid / org_uuid）
   │ host RefreshIfNeeded（推理临期 或 面板显式 refresh）
   │ 无后台定时器；401 不强制换票
   │ GET /v1/models 走 host SOCKS，避免 401 烧 refresh
   ▼
https://platform.claude.com/v1/oauth/token
   │
   ▼
commitImportedOauth → 仅完整 OAuth 排队官方 Claude Code 初装
                   → setup-token / apikey 不初装
```

## 导入门控

三条入口都要求槽位已存在且绑定可用 SOCKS5。生产忽略 `require_proxy: false`（仅测试 mock 可绕过）。

| 入口 | 路径 | 说明 |
|------|------|------|
| sessionKey（默认） | `POST /api/panel/vms/import` `{ type: "setup-token", sessionKey }` | 面板默认。`sk-ant-sid*` 经槽 SOCKS5 交给 `kin-cookie-auth`，scope 只有 `user:inference`，不跑官方初装。无 `type` 仍是完整 OAuth。 |
| 已有 OAuth → Setup Token | `POST /api/panel/vms/:id/oauth/to-setup-token` | 读 worker 活票，改 `type=setup-token`，保留 access/refresh/真实过期。禁止把短 oat 盖成一年期。 |
| 授权链接 | `POST /api/panel/vms/:id/oauth/generate-auth-url` | 完整 OAuth 用。默认 CAI / sub2api。`{ flavor: "claude_code" }` 走官方 Claude Code 授权页。Setup Token 不走 CLI；`{ flavor: "setup_token" }` 只是 PKCE `user:inference`。服务端 PKCE，30min；无代理不能生成 URL。 |
| 粘贴授权码 | `POST /api/panel/vms/:id/oauth/exchange-code` | 经槽 SOCKS5 换票，redirect / token URL 以服务端 session 为准，再 `commitImportedOauth` |

换出的 access/refresh 只写入 credentials.json。`vm.json` / DB 只留 `has_access` / `has_refresh` / email / expiry / generation。Claude 面板默认选 Setup Token + Cookie。

## 刷新规则

**只有 host `RefreshIfNeeded` 决定是否换票**，没有第二套定时器。Go worker 不再 Ensure。

1. 推理（Messages / usage）或面板「刷新凭证」调用 Ensure。
2. access 到期前 5 分钟进入刷新窗口；未进窗口则只读现票。新票未过期，导入后不强制 refresh。
3. worker 先进程内 singleflight，再拿 credential file lock。
4. 锁内重读 credential 与 generation，二次确认仍需刷新。
5. refresh 必须走该 VM 绑定的 SOCKS5。
6. 成功后原子写 access、轮换后的 refresh、expiry、新 generation。
7. context/deadline 已取消的迟到响应不得落盘。
8. `invalid_grant` 先重读 generation，识别其他路径已完成的竞争刷新。
9. 上游 401 **不** force-refresh（端点拒票 ≠ 过期；硬刷会把还能用的 grant 烧成 `invalid_grant`）。
10. 目录 / 模型列表 **不** hop worker `/v1/models`。

过期且无 refresh 的槽不入调度池。面板「网页可用」与调度选槽同一套资格。

## 网络不变量

以下请求共用该槽绑定的 SOCKS5（控制面 host 或 kernel 透明出口），不允许 VPS 直连 Anthropic：

- `/v1/messages`（Rust kernel cli-hop）
- `/api/oauth/usage`、`/v1/models`（额度与模型，槽内 worker；完整 OAuth 可打官方 usage。Setup Token 只有 `user:inference` 时 usage 会报 scope 不足，仍不跑官方初装）
- `/v1/oauth/token`（refresh / 授权码）
- 健康 / 额度探测
- 遥测 sidecar 的 event_logging / eval（若开启）

代理缺失或连接失败时槽位 fail closed，不允许 VPS 直连 Anthropic。

## 官方 Claude Code 初装

换票（import / exchange-code）进入 `commitImportedOauth` 后，按 `routing.official_cc` 排队。默认自动；**同一槽再次换票也会重新初装**，不因 `already_initialized` 跳过。

| 键 | 默认 | 含义 |
|----|------|------|
| `enabled` | true | 换票后自动排队 |
| `wipe` | true | 清空初装残留文件 |
| `apply_seed` | true | hello 成功后置播种 |
| `reconcile_fingerprint` | true | 官方 userID/machineID 覆盖槽位自造 id |
| `sync_telemetry` | true | 初装成功后写 sidecar 身份并 reload 槽位 |
| `hello_prompt` | `hello` | |
| `timeout_ms` | 240000 | |
| `memory` | `2g` | 仅初装期间 `docker update`；结束/失败收回 768m |

顺序：

1. wipe 初装文件  
2. 物化 `~/.claude/.credentials.json`（worker 活票）  
3. 官方 CLI 经 HTTP CONNECT → 槽 SOCKS5 跑 `hello`  
4. 槽内 CLI `/usage` 写 5h/7d/Fable 刻度，失败再试 2 次。账号等级只用成功且完整的官方 `/usage` 判定 Pro/Max
5. 后置播种（含强制 env：`DISABLE_TELEMETRY` 等按 seed_policy）  
6. `~/.claude.json` 的 userID/machineID 写入槽位指纹；清 leftover `.claude/.claude.json`  
7. `sync_telemetry`：写 `kin-identity.json` + `worker.json.telemetry`，reload 槽位拉 sidecar  

换票成功（import / exchange-code）在 `enabled` 时**每次重新初装**（wipe → 物化官方登录文件 → hello），不因「已初装」跳过。推理走 Rust kernel cli-hop。关 `enabled` 后换票不排队；`POST /api/panel/vms/:id/official-cc-bootstrap` 带 `{manual:true}` 仍可跑。

进度：`GET /api/panel/vms/:id/official-cc-bootstrap`。

## 用量刻度

面板探测走槽内 `kin-worker oauth`（usage、models）。完整 OAuth 打官方 `/api/oauth/usage`；Setup Token 若只有 `user:inference` 会得到 scope 错误，面板保留失败原因并提示需完整 OAuth。出口是槽的 SOCKS5 或透明网络，Node 不直连 Anthropic：

- `five_hour` / `seven_day` utilization 0–100
- 成功且完整的官方 `/usage`：有 5h、7d，且能确定 Fable 7d 是否存在；有 Fable 即 Max，没有即 Pro。失败、scope 不足、只有 5h 或 CLI 文本不完整都不改套餐
- Fable `weekly_scoped` → `7d_oi`
- 同包可带 Sub2API 对照；旧 KIN「窗口滚过后仍 100%」刻度已废弃

已判定 Pro（完整 usage 无 Fable 模型）的槽只探 5h/7d，不再 hop Fable。完整 usage 一旦列出 Fable，即使 hop 403/401 或落盘 pro 也改判 Max。Fable 不可用、7d_oi、家族冷却 **不**把账号标成整号限制。探测早于 `refreshed_at` 不算整号吊销。

## 调度资格

网页「可用」= 调度会选。死凭证出池并拆粘性。缺 refresh 的过期票不入池。`POST /api/panel/vms/:id/schedulable` 只改是否入池，不改容器状态。

## 管理 API

- `POST /api/panel/vms/:id/oauth/refresh`：Node 只转发该槽 `Ensure`，自己不换票。成功 `{ ok, data: { refresh_owner, refresh_class, refreshed, credential: { has_access, has_refresh, needs_refresh, expires_at, ttl_seconds, generation } } }`，不回 token。`fatal` = 凭证被拒；`retryable` = 可稍后重试。
- `POST /admin/vm/oauth/refresh`：同上，可用 `vm_id`。
- `GET /api/panel/oauth`、`GET /admin/vm/oauth`：worker + 脱敏 credential 状态。
- `GET/POST /api/panel/vms/:id/official-cc-bootstrap`：初装进度 / 手动再跑。

Claude CLI 不参与推理或 token rotation；只在初装窗口启动一次。
