# OAuth 凭证生命周期

活票只写在槽位 `credentials.json`。换票由控制面 host `RefreshIfNeeded` 经槽 SOCKS5 完成；`vm.json`、SQLite 只存脱敏元数据。Go `kin-worker` 不再做 hop / refresh。

```text
sessionKey（默认 Setup Token）或授权码
   │ 必须先有 VM + 槽位出口：SOCKS5，或本地出口 px-local（宿主机默认路由直连）；未绑定一律拒绝
   ▼
目标 VM 内的 `bin/kin-oauth-auth`（控制面只负责 `docker exec`，OAuth 源码只在本地构建）
   │ sessionKey / 授权码 → authorize → token
   │ 换票后两条路同一后续：profile → eval（bearer 分区）→ roles → first-token date → eval（套餐字段）→ bootstrap（entrypoint=sdk-cli&model=claude-opus-5-5）
   │ 控制面接收完整凭证，不在 helper 返回后再次 bootstrap 或套一层代理
   ▼
槽 ~/.claude/credentials.json   ← 活票只在这里（含 account_uuid / org_uuid，不含 email）
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

三条入口都要求槽位已存在且绑定可用出口：远程 SOCKS5，或本地出口 `px-local`。本地出口没有 SOCKS URL，控制面传 `proxy_url: ""`，换票、bootstrap 都走宿主机默认路由直连（GPT 槽沿用 DEPLOY.md 里的部署代理）；未绑定传 `null`，仍报 `proxy_required`。生产忽略 `require_proxy: false`（仅测试 mock 可绕过）。

| 入口 | 路径 | 说明 |
|------|------|------|
| Setup Token + Cookie | `POST /api/panel/vms/import` `{ type: "setup-token", sessionKey }` | `sk-ant-sid*` 经槽位出口取 code，采集身份；落盘后以 Setup Token 运行模式执行，不跑官方初装。浏览器段（organizations + authorize）由 `kin-worker oauth session-code` 发出，走 Chrome TLS 指纹。**scope 由 `runtime_mode` 决定，有效期不由我们伪造**：两条路都申请完整 5 项（身份链要 `user:profile`），也都不发 `expires_in`，换回来的是上游的短效票；一年期 mint 不在这里铸造（需要时由本地用短效票换）。 |
| 已有 OAuth → Setup Token | `POST /api/panel/vms/:id/oauth/to-setup-token` | 读 worker 活票，仅切换运行模式；保留 access、refresh、真实过期时间和全部实际 scope。不会凭空增加权限，也不会删 scope。官方一年期 token（`official-setup-token`）不能转。 |
| 官方 `claude setup-token` | 槽内 PTY / 粘贴一年期 oat | 只有 `user:inference`、无 refresh。落盘 `credential_mode=official-setup-token`，与面板转换的完整 Setup Token 区分。 |
| Claude Code OAuth（默认） | 账号面板 → OAuth → Claude Code 授权 | 打开专用终端，VM 内原生 `claude auth login` 生成链接并处理回调；面板保存并同步结果。登录本身不再设 wall-clock 上限（用户节奏），凭证落盘由 180 秒 commit deadline 兜底（`KIN_LOGIN_COMMIT_DEADLINE_MS`）。 |
| 通用授权链接 | `POST /api/panel/vms/:id/oauth/generate-auth-url` | CAI 与 Setup Token 都走面板 PKCE 的 CAI 授权链接（`claude.com/cai/oauth/authorize`）；两个 flavor 都用完整 OAuth scope（身份信息需要 `user:profile`），换票都不请求 `expires_in`，拿到的是上游短效票。要求绑定可用出口。 |

正式凭证的 access/refresh 写入 `credentials.json`（不含 email，同步时也排除 email）；导入时文档顶层和 `claudeAiOauth` 都写 `kinGeneration`，文件仍是 `0444`。`vm.json` / DB 只留 `has_access` / `has_refresh` / email / expiry / generation。

远端 Claude 槽以节点上的 `credentials.json` 为准。官方 CLI 的 `.credentials.json` 使用同目录相对软链接；即使轮换通过原子替换更新文件，下次打开也会读到最新版。节点凭据回拉（包括启动、重载）会修正丢失或指向旧副本的链接，不会把旧副本写回凭据。对已运行的槽，启用的 `credential_refresh` 巡检也会检查链接（默认每 300 秒），不等令牌到期，不读取令牌内容、不额外换票、不重启槽。巡检快照的 `link_failures` 单列未修复的槽，与换票结果分开。

CAI 粘贴码换票规则：`code#state` 只将 `#` 后的上游返回值作为 token 请求的 `state`；只有 code 时不发送 `state`。Claude Code 由原生客户端保存 PKCE，面板将完整授权码交给原进程处理。Setup Token 和 Cookie 流程不变。

### 换票传输

`kin-oauth-auth` 的 cookie 导入和粘贴授权码在换票之后走同一条后续，对齐 2026-11-19 原生登录（`login-20261119-024437`）。authorize 主机仍按 `runtime_mode` 分：cookie 打 `claude.ai`，setup-token 打 `platform.claude.com`。常量在 `oauth-contract.mjs`。

| 跳 | 请求 |
|---|---|
| browser | `kin-worker oauth session-code --config /run/kin/worker.json`（Go，`req` + `ImpersonateChrome` + 禁 CookieJar）：`GET /api/organizations` → `POST /v1/oauth/{org}/authorize`，返回 `code#state`。只有 cookie 段需要；授权链接段的证明由浏览器页面自己铸。配置必须是 **worker.json**——`kernel.json` 没有 `egress_mode`、`proxy_url` 为空，worker 会退化成拒绝所有连接（表现为 `upstream transport failed`） |
| token | `POST /v1/oauth/token`，`axios/1.15.2`，只带 `content-type`。抓包 body 无 `expires_in`、无 Chrome 头；mint 仍可显式带一年期 |
| 1 | `GET /api/oauth/profile`，UA `claude-code/2.1.321`，`cache-control: no-cache` |
| 2 | `POST /api/eval/sdk-zAZezfDKGoZuXXKe`，`sdkCachePartition=served-to-bearer:<uuid>`，尚无套餐字段 |
| 3 | `GET /api/oauth/claude_cli/roles`，只有 accept + authorization |
| 4 | `GET /api/organization/claude_code_first_token_date`，UA `claude-cli/2.1.321 (external, sdk-cli)` |
| 5 | 同一 eval。attributes 带 `subscriptionType`、`rateLimitTier`、`organizationRole`、`subscriptionCreatedAt`，没有 `sdkCachePartition` |
| 6 | `GET /api/claude_cli/bootstrap?entrypoint=sdk-cli&model=claude-opus-5-5` |

不发 Grove PATCH。

- 每次请求 60 秒上限（`OAUTH_REQUEST_TIMEOUT_MS`），不是整条流程 60 秒；helper 的整体超时按 token 加 6 跳留余量。
- 浏览器阶段发 Chrome 的 HTTP 头（`sec-ch-ua`、`sec-fetch-*`、`accept-language`）。TLS/HTTP2 指纹伪装需要 libcurl/utls 客户端，Node helper 做不到，别把它当已实现。
- 不保存响应 Cookie：整个流程只主动带 `Cookie: sessionKey`，`Set-Cookie` 一律不落盘。
- profile / roles / eval / first-token / bootstrap 都是尽力而为：票据已经绑定该账号，不因为后续一跳失败丢掉一次换票。profile 和 bootstrap 都空时身份留空。
- 出口仍是 fail closed：`proxy_url=""` 是本地出口（直连），`null` 是未绑定（`proxy_required`），不因为上游直连就放开。
- **helper 自报能力**：`{"operation":"capabilities"}` 返回 `session-code-bridge`、`setup-token-inference`、`proxy-fallback-local`。e2e 按二进制声明选择断言，避免「行为改了但发行二进制还没换」时 CI 必然变红；策略本身放在入库的 `src/lib/oauth/profile-policy.mjs`，由单测直接覆盖。
- **代理无效时的去向可配**：`KIN_OAUTH_PROXY_FALLBACK=local` 时，浏览器段（organizations + authorize）在出口被拒/不可达后改用本地出口重试一次；其它取值（默认 `off`）直接把代理失败抛给面板。只重试不消耗授权码的阶段，token 那一步永不重放。
- authorize 的来源头会按序回退：上游按调用方 `Origin` 做允许列表，来源不对时是 `403 permission_error: Origin not allowed`（与 sessionKey 失效无关）。`claude.com/cai/oauth/authorize` 已 307 到 `claude.ai/oauth/authorize`，官方 CLI 的 `CLAUDE_AI_ORIGIN` 也是 `https://claude.ai`，所以 `auth.js` 依次尝试「profile 参考来源 → 同一主机的另一来源 → 不带 Origin」；只有这条 Origin 拒绝才换下一组，其它 403 立即失败，全被拒时错误列出尝试过的来源（面板映射成 `origin_rejected`，502）。
- token 端点两种边缘拒绝单独归类，不再和授权码问题混在一起：`429 rate_limit_error` → `token_exchange_rate_limited`（面板 429，提示等 1 分钟再交同一个码，别连点；持续出现说明该出口 IP 被限速）；`403 Request not allowed` → `token_exchange_forbidden`（面板 502，提示换出口，通常是地区不支持）。
- authorize 的**客户端指纹**才是门槛：claude.ai 前端会给每个改动型请求补 `client_attestation: { hcaptcha_token }`，但闸门量的是传输层——同样的 body/Cookie/出口，Chrome TLS + HTTP/2 客户端能通过，Node/undici 只写 Chrome 头会被判 `400 missing_client_attestation`。因此 cookie 段改由 `kin-worker oauth session-code`（`worker/internal/oauthcmd/sessioncode.go`，客户端 = `upstream.NewOAuthHTTPClient`，与 `claude_oauth_service.go` 对齐）取 code，`auth.js` 拿回 code 后照旧换票。缺 kin-worker / worker.json 时退回内置 fetch，那条会报 `authorize_client_attestation` / 面板 `client_attestation_required`（502），立即失败不试来源头。授权链接那条完全在浏览器里发生，页面自己铸证明，不受影响。

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
11. 槽内 cli-node（kernel 推理、初装 hello / `/usage` / 常驻、`setup-token`）带 `CLAUDE_CODE_HOST_REFRESH=1` 和 `CLAUDE_CODE_VERSION`：临期或 401 时只重读 `credentials.json`，不请求 token 端点，不写回凭证。否则它与 host 同用一个轮换 RT，后到的一方拿 `invalid_grant`，且其写回会丢掉 `kinGeneration`。运维终端使用官方原生 Claude 2.1.321，它不读这个变量，终端不覆盖其版本号。CRAG v2 拉起的那个进程会在连上 `platform.claude.com:443` / `console.anthropic.com:443` 后先写 `KIN-BLOCK\n`；kin-egress 看到标记就关掉连接，不向 SOCKS 拨号。`kin-oauth-auth` 和 `kin-worker oauth refresh` 不写这个标记，面板换票仍走原来的出口。

过期且无 refresh 的槽不入调度池。面板「网页可用」与调度选槽同一套资格。

## 网络不变量

以下请求共用该槽绑定的 SOCKS5（控制面 host 或 kernel 透明出口），不允许 VPS 直连 Anthropic：

- `/v1/messages`（Rust kernel cli-hop）
- `/api/oauth/usage`、`/v1/models`（额度与模型，槽内 worker；Setup Token 运行模式若保存了完整 OAuth scope，同样可打官方 usage；独立的官方一年期 `claude setup-token` 仍只有 `user:inference`）
- 健康 / 额度探测
- 遥测 sidecar 的 event_logging / eval（若开启）

代理缺失或连接失败时槽位 fail closed，不允许 VPS 直连 Anthropic。

## 面板换票与原生 Claude Code 终端

「OAuth → Claude Code 授权 → 生成授权链接」打开交互终端、可复制的链接和回调输入栏。支持粘贴完整 `code#state` 或授权回调链接，也可直接在终端输入。原生 CC 在临时配置中换票；面板成功保存并同步凭证后才显示完成。关闭或重新连接会结束旧会话，旧链接不再使用。

登录成功后的凭证回填不等待推理内核就绪，也不为保存凭证重启 VM。面板只显示凭证状态和账号信息；VM 内的原生 CC 继续通过现有相对软链接读取同一份凭证。

此入口使用已装载的签名 CRAG 包内原版 Claude Code，不读取 CRAG 源码，也不回退到 `cli-node`。若缺少原生可执行文件，先按[二进制安装说明](DEPLOY.md#crag-v2-二进制更新)补齐包；仅升级面板 OAuth 代码无需替换已有的同版 CRAG 内核。

- 原生客户端的 `.credentials.json` 链接到面板管理的 `credentials.json`。显式导入以面板新凭证为准，不让旧原生客户端留下的文件覆盖新账号。远程槽导入时先推送凭证；后续手动同步保留节点已轮换的凭证，再修复原生客户端链接。
- 运维终端在连接时及打开后每 60 秒检查凭证链接，临期时通过槽位现有刷新链路刷新。`/sync` 可手动修复链接，不触发重新授权、不输出 token。若已打开的 CC 仍持有旧凭证，请退出后重开。
- 终端中的 `claude` / `cc` 始终使用包内原生 CC。本地 Docker / KVM 槽使用 `/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude`，集群 Docker 槽使用 `/opt/kin-live/crag-v2/claude-code-2.1.321/claude`。本地缺少程序时从已校验发布包暂存原生客户端；缺包或不可执行会报错。
- 推理使用当前所选内核对应的客户端：标准内核（wrap）启动 cli-node，cc 使用 cc-node，CRAG v2 启动包内原生 CC。切换时更新 `kernel.json` 的 `claude_bin`；旧的 `KIN_CLAUDE_BIN` 环境变量不覆盖这个选择。OAuth 入口始终使用原生 CC，与推理内核选择无关。
- `/usage`、`/probe`、`/wrap`、`/reload`、`/sync`、`/help`、`/clear` 在 shell 提示符处可用，也支持粘贴后按回车。原生 CC 或其它前台程序运行时，斜杠输入直接交给该程序。
- `login: true` 票据只打开专用登录终端，不能用于运维 shell。运维终端中的 `claude auth login` / `claude setup-token` 提示回到账号面板。

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
2. 物化 `~/.claude/.credentials.json`，且必须是指向 `credentials.json` 的相对软链接  
3. 凭证必须仍在有效期内（access + refresh，未过期）。然后槽内执行 CRAG 包内原生 Claude Code（本地 `/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude`，集群 `/opt/kin-live/crag-v2/claude-code-2.1.321/claude`）跑 `hello`。不使用 `cli-node` / `cc-node`，不注入 `CLAUDE_CODE_VERSION` 或 system prompt。缺原生程序或软链接未建立则报错，不执行  
4. 槽内官方 usage 端点写 5h/7d/Fable 刻度。账号等级只用成功且完整的官方 usage 判定 Pro/Max  
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
- 旧 KIN「窗口滚过后仍 100%」刻度已废弃

已判定 Pro（完整 usage 无 Fable 模型）的槽只探 5h/7d，不再 hop Fable。完整 usage 一旦列出 Fable，即使 hop 403/401 或落盘 pro 也改判 Max。Fable 不可用、7d_oi、家族冷却 **不**把账号标成整号限制。探测早于 `refreshed_at` 不算整号吊销。

## 调度资格

网页「可用」= 调度会选。死凭证出池并拆粘性，记为不可调度（`unschedulable`），只有重新导入凭证或操作员调度开才回池；后台刷新成功不会自动开回。缺 refresh 的过期票不入池。`POST /api/panel/vms/:id/schedulable` 只改是否入池，不改容器状态。四态定义见 `PANEL_API.md`「调度状态（四态）」。

## 管理 API

- `POST /api/panel/vms/:id/oauth/refresh`：Node 只转发该槽 `Ensure`，自己不换票。成功 `{ ok, data: { refresh_owner, refresh_class, refreshed, credential: { has_access, has_refresh, needs_refresh, expires_at, ttl_seconds, generation } } }`，不回 token。`fatal` = 凭证被拒；`retryable` = 可稍后重试。
- `POST /admin/vm/oauth/refresh`：同上，可用 `vm_id`。
- `GET /api/panel/oauth`、`GET /admin/vm/oauth`：worker + 脱敏 credential 状态。
- `GET/POST /api/panel/vms/:id/official-cc-bootstrap`：初装进度 / 手动再跑。

Claude CLI 不参与推理或 token rotation；只在初装窗口启动一次，且只在凭证有效、`.credentials.json` 已软链接到 `credentials.json` 之后。
