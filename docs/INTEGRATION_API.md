# 通用外部集成 API（`/api/integration/v1`）

面向外部控制面、运维脚本或第三方集成面板的受限通用 API。与管理台 `/api/panel/*` 和推理协议 `/v1/*` 严格隔离：使用独立的集成令牌（`sk-int-*`），默认仅允许本机回环接入，并按细粒度 Scope 控制可见与可写能力。

## 网络边界与安全设计

- **默认仅允许回环地址**（`127.0.0.1` / `::1`）：不信任 `X-Forwarded-For` 等转发头，仅校验直连 socket 对端地址。
  - **同机部署**：外部服务直接访问 `http://127.0.0.1:8787/api/integration/v1/...`。
  - **跨机部署（推荐）**：外部服务通过 **SSH 隧道**连接到本机 `127.0.0.1:8787`，无需将集成 API 暴露到公网。
  - **私网/HTTPS 远程直连（可选）**：如需跨机直连，须显式开启 `allow_remote: true`（或环境变量 `VM2API_INTEGRATION_ALLOW_REMOTE=1`），并建议配合 `allowed_ips` 白名单及反向代理 TLS。
- **凭据严格隔离**：
  - 集成令牌只能访问 `/api/integration/v1/*`，无法调用 `/api/panel/*`、`/admin/*` 或 `/v1/*` 推理接口。
  - `VM2API_API_KEY`、面板登录会话（`kin-panel-*`）和普通推理密钥（`sk-vm-*`）均不可调用 `/api/integration/v1/*`。
  - 数据库仅存 HMAC-SHA256 哈希，明文令牌只在创建时返回一次。
- **最小暴露面**：仅开放下述白名单端点。系统升级、内核管理、集群 SSH、整库备份、数据库指标、面板用户、交互终端与凭据/密钥 `reveal` 均不可访问。

## 鉴权方式

支持以下请求头传递集成令牌（按优先级依次读取）：

1. 配置了 `custom_auth_header` 时读取该自定义 Header
2. `X-Integration-Token: <token>`
3. `Authorization: Bearer <token>`
4. `X-API-Key: <token>`

## 权限 Scope

| Scope | 说明 |
|---|---|
| `overview:read` | 读取脱敏后的系统总览指标（健康、实时并发/排队、今日请求/费用/Token、代理池摘要） |
| `vms:read` | 读取 VM 槽位列表/详情与 Gemini 环境列表 |
| `vms:write` | 创建、启动、停止、删除 VM 槽位；创建、删除 Gemini 环境 |
| `proxies:read` | 读取 SOCKS5/HTTP 代理池列表（脱敏，不含账密） |
| `proxies:write` | 导入、探活、绑定、解绑、删除代理 |
| `credentials:write` | 生成 OAuth 授权链接、换码、导入凭证（Cookie / Setup Token / OAuth JSON / API Key）、Gemini OAuth 授权 |
| `endpoints:read` | 读取官方 API Key 渠道列表（脱敏，不含上游明文密钥） |
| `endpoints:write` | 创建、更新、删除租户/平台归属的官方 API Key 渠道及其密钥条目（响应不回显明文上游密钥） |
| `keys:read` | 读取受管推理 API Key 列表（脱敏，无明文查看） |
| `keys:write` | 创建、更新、删除受管推理 API Key（支持多层级权限 `platform` / `tenant` / `resource`，默认禁止未限定域的平台全局密钥） |
| `keys:global` | 可选高危权限（默认不授予）：允许创建未限定资源且 `permission_tier: "platform"`、`group_type: "all"` 的平台级推理密钥 |

## 多层级推理密钥权限与双向隔离

推理密钥按 `permission_tier` 分为三层，所有调度路径（VM 槽位、官方 API Key 渠道 `api_endpoints`、Gemini 环境）均执行**双向归属隔离**：

| 层级 (`permission_tier`) | 归属 (`owner_id`) | 允许调用范围 | 防越权约束 |
|---|---|---|---|
| `platform` | `null`（平台/管理员） | 仅可调用平台自建资源（`owner_user_id IS NULL`） | **禁止**调用任何租户/供应商名下的 VM、官方 API Key 渠道或 Gemini 环境 |
| `tenant` | 非空字符串（租户/供应商 ID） | 可调用该 `owner_id` 名下的全部账号服务（`category: "oauth" \| "api" \| "all"`：含其名下 VM、官方 API 渠道与 Gemini 环境） | **禁止**越权调用平台/管理员资源或其他租户资源；缺少 `owner_id` 时 fail-closed |
| `resource` | `null`（平台）或非空 `owner_id` | 仅可调用归属域内**显式绑定**的非空资源集合（`allowed_vms` / `vm_pool_id` / `allowed_endpoints` / `api_endpoint_id` / `allowed_gemini_envs`） | 创建/更新时校验全部资源归属（越权返回 `403 scope_owner_mismatch`）；未绑定任何资源时 fail-closed |

> 租户/供应商创建的官方 API Key 渠道（`POST /api/integration/v1/api-endpoints` 传入 `owner_user_id`）完全独立于平台池，既不会被管理员/平台密钥调度，也不会暴露给其他租户密钥。

## 端点清单

统一信封：成功 `{ "ok": true, "data": ... }`，失败 `{ "ok": false, "error": { "code": "...", "message": "..." } }`。

| 方法 | 路径 | 所需 Scope | 说明 |
|---|---|---|---|
| `GET` | `/api/integration/v1/ping` | 任意有效令牌 | 连通性与鉴权探活，返回当前令牌名称、已授予 Scopes 与网络策略 |
| `GET` | `/api/integration/v1/overview` | `overview:read` | 系统总览实时指标（别名 `/dashboard`） |
| `GET` | `/api/integration/v1/vms` | `vms:read` | 列出 VM 槽位 |
| `GET` | `/api/integration/v1/vms/:id` | `vms:read` | 获取单个 VM 槽位详情 |
| `POST` | `/api/integration/v1/vms` | `vms:write` | 创建 VM 槽位（仅接受安全白名单参数） |
| `POST` | `/api/integration/v1/vms/:id/start` | `vms:write` | 启动 VM 槽位 |
| `POST` | `/api/integration/v1/vms/:id/stop` | `vms:write` | 停止 VM 槽位 |
| `DELETE` | `/api/integration/v1/vms/:id` | `vms:write` | 删除 VM 槽位 |
| `POST` | `/api/integration/v1/vms/:id/oauth/auth-url` | `credentials:write` | 生成 Anthropic OAuth / Setup Token 授权链接 |
| `POST` | `/api/integration/v1/vms/:id/oauth/exchange` | `credentials:write` | 提交 OAuth 授权码换票 |
| `POST` | `/api/integration/v1/vms/import` | `credentials:write` | 导入账号凭证（Cookie / Setup Token / OAuth JSON / API Key） |
| `GET` | `/api/integration/v1/gemini/environments` | `vms:read` | 列出 Gemini 环境 |
| `POST` | `/api/integration/v1/gemini/environments` | `vms:write` | 创建 Gemini 环境 |
| `DELETE` | `/api/integration/v1/gemini/environments/:id` | `vms:write` | 删除 Gemini 环境 |
| `POST` | `/api/integration/v1/gemini/environments/:id/authorization` | `credentials:write` | 发起 Gemini OAuth 授权 |
| `PUT` | `/api/integration/v1/gemini/environments/:id/authorization` | `credentials:write` | 完成 Gemini OAuth 授权 |
| `GET` | `/api/integration/v1/api-endpoints` | `endpoints:read` | 列出官方 API Key 渠道（支持 `?owner_user_id=` 过滤，脱敏） |
| `POST` | `/api/integration/v1/api-endpoints` | `endpoints:write` | 创建官方 API Key 渠道（支持 `owner_user_id` 归属隔离，不返回上游明文） |
| `PATCH` | `/api/integration/v1/api-endpoints/:id` | `endpoints:write` | 更新官方 API Key 渠道 |
| `DELETE` | `/api/integration/v1/api-endpoints/:id` | `endpoints:write` | 删除官方 API Key 渠道 |
| `POST` | `/api/integration/v1/api-endpoints/:id/keys` | `endpoints:write` | 向渠道追加上游 API Key 条目（不返回明文） |
| `DELETE` | `/api/integration/v1/api-endpoints/:id/keys/:keyId` | `endpoints:write` | 删除渠道内指定上游 API Key 条目 |
| `GET` | `/api/integration/v1/proxies` | `proxies:read` | 列出代理池节点（脱敏） |
| `POST` | `/api/integration/v1/proxies/import` | `proxies:write` | 导入代理节点 |
| `POST` | `/api/integration/v1/proxies/:id/probe` | `proxies:write` | 探测代理连通性 |
| `POST` | `/api/integration/v1/proxies/:id/bind` | `proxies:write` | 绑定代理到 VM |
| `POST` | `/api/integration/v1/proxies/:id/unbind` | `proxies:write` | 解绑代理 |
| `DELETE` | `/api/integration/v1/proxies/:id` | `proxies:write` | 删除代理 |
| `GET` | `/api/integration/v1/api-keys` | `keys:read` | 列出受管推理密钥（脱敏） |
| `POST` | `/api/integration/v1/api-keys` | `keys:write` | 创建受限推理密钥（仅创建时返回明文 `key`） |
| `PATCH` | `/api/integration/v1/api-keys/:id` | `keys:write` | 更新受管推理密钥 |
| `DELETE` | `/api/integration/v1/api-keys/:id` | `keys:write` | 撤销并删除受管推理密钥 |

## 管理员配置与令牌管理（仅面板 `admin` 角色）

以下管理接口仅允许 vm2api 管理员（`admin` 会话或 `VM2API_API_KEY`）调用：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/panel/integration/config` | 读取集成 API 配置与可用 Scope 列表 |
| `PUT` | `/api/panel/integration/config` | 更新 `enabled`、`allow_remote`、`allowed_ips`、`custom_auth_header` |
| `GET` | `/api/panel/integration/tokens` | 列出已签发的集成令牌（脱敏） |
| `POST` | `/api/panel/integration/tokens` | 创建新令牌 `{ name, scopes?, expires_in_days? }`，仅此一次返回明文 `token` |
| `PATCH` | `/api/panel/integration/tokens/:id` | 更新令牌名称、Scopes、启用状态或过期时间 |
| `DELETE` | `/api/panel/integration/tokens/:id` | 吊销并删除令牌 |

## 环境变量（可选）

- `VM2API_INTEGRATION_ENABLED`：`1`/`0` 控制总开关
- `VM2API_INTEGRATION_ALLOW_REMOTE`：`1`/`0` 是否允许非回环地址访问（默认 `0`）
- `VM2API_INTEGRATION_ALLOWED_IPS`：远程模式下允许的 IP 列表（逗号分隔）
- `VM2API_INTEGRATION_AUTH_HEADER`：可选自定义鉴权 Header 名称
- `VM2API_INTEGRATION_TOKEN`：可选环境变量引导令牌（≥24 字符）
- `VM2API_INTEGRATION_SCOPES`：环境变量引导令牌的 Scope 列表（逗号分隔）
