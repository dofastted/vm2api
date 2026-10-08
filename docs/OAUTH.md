# OAuth 凭证生命周期

活票只写在槽位 `credentials.json`。换票由控制面 host `RefreshIfNeeded` 经槽 SOCKS5 完成；`vm.json`、SQLite 只存脱敏元数据。Go `kin-worker` 不再做 hop / refresh。

```text
sessionKey（默认 Setup Token）或授权码
   │ 必须先有 VM + 槽位出口：SOCKS5，或本地出口 px-local（宿主机默认路由直连）；未绑定一律拒绝
   ▼
bin/kin-oauth-auth（控制面 spawn；OAuth 源码只在本地构建）
   │ sessionKey → /api/organizations → 完整 scope authorize → token
   │ bootstrap 读取 oauth_account，并 PATCH Grove 账号设置
   ▼
槽 ~/.claude/credentials.json   ← 活票只在这里（含 email / account_uuid / org_uuid）
   │ host RefreshIfNeeded（推理临期 或 面板显式 refresh）
   │ 无后台定时器；401 不强制换票
   ▼
https://platform.claude.com/v1/oauth/token
   │
   ▼
commitImportedOauth → 仅完整 OAuth 运行模式排队官方 Claude Code 初装
                   → Setup Token 运行模式保留完整授权 scope，但不初装
```

## 导入门控

三条入口都要求槽位已存在且绑定可用出口：远程 SOCKS5，或本地出口 `px-local`。本地出口没有 SOCKS URL，控制面传 `proxy_url: ""`，换票、bootstrap、Grove 都走宿主机默认路由直连（GPT 槽沿用 DEPLOY.md 里的部署代理）；未绑定传 `null`，仍报 `proxy_required`。生产忽略 `require_proxy: false`（仅测试 mock 可绕过）。

| 入口 | 路径 | 说明 |
|------|------|------|
| sessionKey（默认 Setup Token） | `POST /api/panel/vms/import` `{ type: "setup-token", sessionKey }` | `sk-ant-sid*` 经槽位 SOCKS5 申请完整 OAuth scope（profile、inference、sessions、MCP、文件），采集 bootstrap 身份并 PATCH Grove；落盘后以 Setup Token 运行模式执行，不跑官方初装。 |
| 已有 OAuth → Setup Token | `POST /api/panel/vms/:id/oauth/to-setup-token` | 读 worker 活票，仅切换运行模式；保留 access、refresh、真实过期时间和全部实际 scope。不会凭空增加权限，也不会删 scope。官方一年期 token（`official-setup-token`）不能转。 |
| 官方 `claude setup-token` | 槽内 PTY / 粘贴一年期 oat | 只有 `user:inference`、无 refresh。落盘 `credential_mode=official-setup-token`，与面板转换的完整 Setup Token 区分。 |
| 授权链接 | `POST /api/panel/vms/:id/oauth/generate-auth-url` | CAI、Claude Code、Setup Token flavor 都请求完整 OAuth scope。Setup Token flavor 仍只改变运行模式；服务端 PKCE，30min；未绑定出口不能生成 URL，本地出口可以。 |

换出的 access/refresh 只写入 credentials.json。`vm.json` / DB 只留 `has_access` / `has_refresh` / email / expiry / generation。Claude 面板默认选 Setup Token + Cookie。

完整 OAuth 授权链接（`cai` / `claude_code`）的粘贴码按 sub2api 换票规则处理：`code#state` 只将 `#` 后的上游返回值作为 token 请求的 `state`；只有 code 时不发送 `state`，不补生成链接时的 nonce。手动粘贴不是浏览器自动回调，code 与授权会话仍由 PKCE verifier 绑定，30 分钟期限与 VM 绑定检查不变。`setup_token` flavor、Cookie 换票和官方 Setup Token 流程不变。该修复只改控制面，现有 `kin-oauth-auth` 已支持可选 `state`，无需重编或 `wrap-cli/sync`。

Cookie authorize 的组织 UUID 同时出现在 `/v1/oauth/{uuid}/authorize` 路径和 JSON 的 `organization_uuid` 字段；只有路径 UUID 不够，上游会返回 400 `Invalid request format`。

SSH 扩展槽同样由控制面经绑定出口换票。拿到授权后，提交阶段先启动节点槽并同步凭据；远端配置与票据均按 UTF-8/Buffer 的字节长度分块写入 SFTP，0600 临时文件原子替换，不跟随目标符号链接。节点启动失败不代表上游授权失败。

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
11. 槽内 cli-node（kernel 拉起的 native 槽、面板运维终端里的 `claude`、初装 hello / `/usage` / 常驻、`setup-token`）带 `CLAUDE_CODE_HOST_REFRESH=1` 和 `CLAUDE_CODE_VERSION`：临期或 401 时只重读 `credentials.json`，不请求 token 端点，不写回凭证。否则它与 host 同用一个轮换 RT，后到的一方拿 `invalid_grant`，且其写回会丢掉 `kinGeneration`。

过期且无 refresh 的槽不入调度池。面板「网页可用」与调度选槽同一套资格。

## 网络不变量

以下请求共用该槽绑定的 SOCKS5（控制面 host 或 kernel 透明出口），不允许 VPS 直连 Anthropic：

- `/v1/messages`（Rust kernel cli-hop）
- `/api/oauth/usage`、`/v1/models`（额度与模型，槽内 worker；Setup Token 运行模式若保存了完整 OAuth scope，同样可打官方 usage；独立的官方一年期 `claude setup-token` 仍只有 `user:inference`）
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
3. 槽内 cli-node（`~/.kin/cli-node`，与 kernel 同一构建，不再另装官方 Claude Code）跑 `hello`；缺 cli-node 时报错，先 `wrap-cli/sync`  
4. 槽内 CLI `/usage` 写 5h/7d/Fable 刻度，失败再试 2 次。账号等级只用成功且完整的官方 `/usage` 判定 Pro/Max
5. 后置播种（含强制 env：`DISABLE_TELEMETRY` 等按 seed_policy）  
6. `~/.claude.json` 的 userID/machineID 写入槽位指纹；清 leftover `.claude/.claude.json`  
7. `sync_telemetry`：写 `kin-identity.json` + `worker.json.telemetry`，reload 槽位拉 sidecar  

换票成功（import / exchange-code）在 `enabled` 时**每次重新初装**（wipe → 物化官方登录文件 → hello），不因「已初装」跳过。推理走 Rust kernel cli-hop。关 `enabled` 后换票不排队；`POST /api/panel/vms/:id/official-cc-bootstrap` 带 `{manual:true}` 仍可跑。

进度：`GET /api/panel/vms/:id/official-cc-bootstrap`。

## 用量刻度

- 面板探测走槽内 `kin-worker oauth`（usage、models）。Setup Token 运行模式如果凭证实际 scope 完整，可打官方 `/api/oauth/usage`；scope 只有 `user:inference` 的独立官方 Setup Token 会得到 scope 错误。出口是槽的 SOCKS5 或透明网络，Node 不直连 Anthropic：

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
