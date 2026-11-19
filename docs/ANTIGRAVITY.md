# Antigravity 接入

Antigravity 使用独立槽位、Google OAuth 和账号模型目录。控制面将 Messages、Chat Completions 与 Responses 请求转换为统一结构，由槽位中的独立运行时访问官方服务；Claude/GPT 的账号凭证、内核和调度执行器不参与此流程。

本节描述已实现的接口和隔离规则。2026-10-22 已在目标云环境以 `gemini-3.8-flash-low` 真实验证三个公共接口的普通/流式生成、system 与历史、工具往返、inline 图片、Responses 续接及取消恢复，并验证槽位重启后仍可生成。账号目录列出的其他模型仍受各自的官方权限与能力限制。

## 部署与启用

1. 创建本机 Docker Antigravity 槽位并绑定独立出口。暂不支持远程节点与 KVM。
2. 点击“绑定凭证 → 生成授权链接”，在本机浏览器完成 Google 授权，再将页面给出的单行授权码粘贴回面板。认证可以在平台接入关闭时执行；不会自动打开 API 调度。
3. 镜像包含经 SHA-512 校验并固定为 1.4.4 的官方 Linux amd64 CLI；首次授权将其放入槽位 `/home/kincli/.local/bin/agy`。默认 `cli_bin: "agy"` 即可。
4. 在槽位测试页、模型页 Antigravity 分区或“设置 → Antigravity”点击“同步账号模型”，读取同一槽位中的官方 `agy models`。管理员同步时新模型自动加入全局目录并启用；全局目录首次写入模型时自动开启 Antigravity API 接入。同步不发送推理请求。
5. 开启所需槽位的调度开关（创建空槽时默认调度关闭）。模型页 Antigravity 分区可逐个启停模型或关闭 API 接入。上游按推理强度拆分的变体（`-minimal` / `-low` / `-medium` / `-high`）会自动折叠为基础模型并汇总可用 `levels`；全局模型目录保留已有模型的禁用、可用 `levels`、显示名称及供应商设置，新增模型不会覆盖这些选择，之后关闭的平台开关也不会被同步重新打开。
6. 直接使用官方基础模型 ID（如 `gemini-4-argon`）调用 API，旧的 `antigravity/` 前缀已废弃并返回 `model_not_supported`。`gemini-*` 默认路由到 Antigravity；同名 Claude / GPT 模型（如 `claude-sonnet-5-5`、`gpt-oss-120b`）在使用 `antigravity` 分组密钥时路由到 Antigravity 槽位，其他密钥分组仍走原平台。
7. 先验收首条生成，再验收历史、工具往返、流式取消、续聊，以及槽位重启后的授权持久化。

官方 CLI 在容器中管理自身的文件凭证存储，凭证保存在持久挂载的 `/home/kincli`。OAuth 管理器只保存公开的认证状态元数据；授权码仅传给该次官方客户端的输入，不写入数据库或日志。

OAuth 会话按操作者、槽位和所属用户隔离，有效期 30 分钟。关闭弹窗、取消、槽位停止/删除、变更所属用户或主控正常退出会清理登录进程；取消不注销既有账号。

## 模型目录与权限

账号目录来自该槽位的 `agy models`，保存在控制面私有目录 `data/antigravity-models/<slot-id>.json`（目录 700、文件 600）。该文件只含模型 ID、显示名称、供应商、更新时间、所属用户和认证版本标记，不含 token。目录不位于 guest 可写的 `run/`，读取拒绝符号链接；账号或所属用户变更后需要重新同步。

普通用户只能同步自己的槽位目录，不会修改全局配置；只有管理员同步会写入全局目录。同步失败保留上次有效目录，但不会发布无效输出。尚未同步的槽位不会被假定支持任意模型。

## API 与调度

| 接口 | 模型命名 | 推理强度参数 |
| --- | --- | --- |
| `POST /v1/messages` | `<基础模型 ID>`（如 `gemini-4-argon`） | `output_config.effort` |
| `POST /v1/chat/completions` | `<基础模型 ID>`（如 `gemini-4-argon`） | `reasoning_effort` |
| `POST /v1/responses` | `<基础模型 ID>`（如 `gemini-4-argon`） | `reasoning.effort` |

公开目录（`/v1/models`）返回基础模型 ID、`reasoning_levels`（取自模型配置的 `levels`：`minimal`、`low`、`medium`、`high`）及 `default_reasoning_level`。未显式传推理强度时，控制面默认选用 `medium`（若该模型不含 `medium` 则取最近可用档位），自动映射到对应上游变体（`<id>-<level>`）与 `thinkingConfig.thinkingLevel`；无档位后缀的模型保持原 ID。若传入模型 `levels` 未包含的推理强度（或对无推理档位的模型传入该参数），在访问上游前返回 HTTP 400 `reasoning_effort_not_supported`。直接传 `-low` / `-high` 等变体后缀或旧 `antigravity/` 前缀均会拒绝。

适配层保留结构化的历史、system 指令、图片、工具定义、工具调用及工具结果；不将这些内容拼接为单个 prompt。无法表示的参数或内容会明确拒绝。模型返回工具调用后，由调用方执行工具，再将结果提交给后续请求；槽位不执行调用方的本地命令或函数。

Gemini 3 及以上模型要求回传的工具调用携带 `thoughtSignature`，否则返回 HTTP 400。适配器在响应中通过 `tool_use.thought_signature`（Chat 为 `tool_calls[].thought_signature`）暴露签名，但标准 Anthropic / OpenAI SDK 会丢弃该字段。因此槽位运行时按工具调用 ID、名称与参数缓存签名 30 分钟（进程内，有条目上限），后续请求缺失签名时自动补回；未命中（过期、换槽位或运行时重启）时，对该轮首个工具调用填入 Google 规定的 `skip_thought_signature_validator`，保证请求可继续，代价是该轮推理上下文连续性减弱。

图片支持 inline base64 与 data URL，远程 URL 图片会明确拒绝。工具与结构化输出的 `strict: true`、`parallel_tool_calls: false` / `disable_parallel_tool_use: true` 暂不支持，会在访问上游前拒绝；不会静默忽略这些约束。Responses `include` 仅接受 `reasoning.encrypted_content`（忽略，推理条目本身已带 summary 与 signature），其他取值返回 400。

暂不支持生成前的 `count_tokens`；生成响应与日志返回上游提供的实际用量。

调度在独立的 Antigravity 账号池中完成，检查：

- 密钥的平台分组、指定槽位或账号池当前成员，以及槽位所属用户。
- 槽位已授权、运行中、支持本机 Docker 并绑定可用出口。
- 管理员全局启用模型、槽位模型策略允许模型，以及该账号已同步的实际可用目录。
- 调度开关、活动时段、独立并发/RPM 限制、等待队列和上游失败冷却。

并发与排队（`routing.antigravity`，设置 → Antigravity）：

| 字段 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `max_sessions` | 1 | 1–20 | 每个槽位同时在飞的请求数，也是槽内 bridge 的并发上限。修改后需在各槽位运维页「重载 Antigravity bridge」，否则推理返回 409 `antigravity_runtime_reload_required` |
| `timeout_ms` | 180000 | 1000–3600000 | 上游连续多久没有新数据就中断，按空闲计时，不限制总时长，超时返回 504 `antigravity_timeout`。Gemini 的工具调用参数要整段生成完才一次下发，写整份文件时可能几分钟没有数据；常有这类长工具调用就调大。修改后同样需要「重载 Antigravity bridge」 |
| `queue_timeout_ms` | 120000 | 1000–300000 | 全部候选槽位满载时的排队上限，超时返回 429 `antigravity_capacity_unavailable`；与 Claude 池的 `pool.fallback_wait_timeout_ms` 无关 |
| `affinity_wait_ms` | 15000 | 0–120000 | 会话绑定的槽位正忙时，先等它空出来的最长时间，超时再换槽；`0` 表示直接换槽 |

上游提示缓存按账号和前缀隔离。粘性键由会话标识（或首条用户消息指纹）加上前缀指纹（模型变体、system、tools、首条消息）组成：同一会话里前缀不同的旁路请求（例如客户端并发发出的标题生成）单独绑定，不会占用或改写主对话的槽位。请求成功后，绑定移到实际服务的槽位，因为最新的缓存前缀在那里。

槽位默认跟随 `max_sessions`。`PATCH /api/panel/vms/:id` 传 `{"max_concurrency": n}` 可把单槽钉到 1–`max_sessions`，传 `null` 恢复跟随；Antigravity 槽位的该接口只接受这一个字段。

错误切换只在尚未向调用方提交输出时进行，避免重复输出。请求取消会中止槽位执行并释放席位。调用日志与 usage 沿用现有日志链路；没有可靠单价的模型保持未计价状态，不伪造费用或 Claude/GPT 配额窗口。

### Responses 续接

`previous_response_id` 使用控制面进程内缓存，默认 TTL 为 30 分钟。缓存按 API 密钥、所属用户和模型隔离，限制条目数量及占用字节；客户端无法通过另一个密钥读取历史。当前密钥和槽位权限仍在后续请求调度时检查。

设置 `store: false` 不保存该次响应供以后续接。缓存过期、超出容量被回收或控制面重启后，旧 ID 将返回 `previous_response_not_found`；它不是持久化会话数据库。调用方应保留自己的完整历史，并在需要时重新提交。

## 面板接口

沿用面板鉴权与所属用户校验；super 角色仅可查看状态和执行已有调度操作，不能 OAuth 或同步模型。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/panel/vms/:id/antigravity/status` | 只读状态；返回认证状态、平台开关、账号模型目录和最近一次额度快照 `quota` |
| `POST /api/panel/vms/:id/antigravity/quota/refresh` | 立即查询账号额度，返回分组与窗口剩余比例 |
| `POST /api/panel/vms/:id/antigravity/oauth/start` | 创建 OAuth 会话，通过轮询取得授权链接 |
| `GET /api/panel/vms/:id/antigravity/oauth/session?session_id=...` | 读取本人的 OAuth 会话状态 |
| `POST /api/panel/vms/:id/antigravity/oauth/complete` | 提交 `{session_id,code}` 给官方客户端 |
| `POST /api/panel/vms/:id/antigravity/oauth/cancel` | 清理登录进程，保留已有凭证 |
| `POST /api/panel/vms/:id/antigravity/models/sync` | 请求体 `{}`，同步当前账号模型；管理员同步同时写入全局目录 |
| `POST /api/panel/vms/:id/schedulable` | `{schedulable:boolean}`，开启前需已确认登录 |
| `POST /api/panel/vms/:id/test-chat` | 测试链接：`{model,prompt,max_tokens?,reasoning_effort?}`，经 `/v1/messages` 固定到该槽位，与 Claude / GPT 槽位相同 |

响应使用 `{ok:true,data:{...}}` 或 `{ok:false,error:{code,message}}`。`authenticated: null` 表示尚未确认登录；`ready` 只表示运行时健康，不能证明真实推理已经成功。

面板文本会话模型在会话内固定，进程上下文不跨运行时重启持久化。修改运行时配置后按提示重启对应槽位以应用；平台关闭仍允许清理旧会话。

### 账号额度

额度来自官方 CLI 1.4.4 `/usage` 所用的 `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`（prod 返回 429/5xx 时改用 daily），请求和 token 刷新均在槽位内完成，不消耗推理额度。返回按模型组划分（如 Gemini、Claude 与 GPT、单模型周限额），每组含 5 小时或周窗口的剩余比例与重置时间。面板显示剩余百分比，不换算为 Claude 的已用比例。

平台接入启用后，控制面每 10 分钟刷新已授权槽位，账号页和槽位卡片也可手动刷新。快照保存在 `data/antigravity-quota/<slot-id>.json`（目录 700、文件 600），只含分组名、窗口、剩余比例和重置时间，与所属用户、授权版本绑定；更换账号或所属用户后旧额度不再显示。查询失败保留上次有效额度并显示失败原因。额度仅用于展示，不参与调度。新增运行时接口后需重启槽位，使 bridge 加载新脚本。

## 运行时与验证

独立运行时通过槽位 Unix socket 与内部 token 接收请求。Linux 控制面默认提供自身 Node 可执行文件；控制面与槽位架构不同或 macOS 开发环境需设置 `KIN_ANTIGRAVITY_NODE_BIN` 为匹配槽位架构和系统库的 Linux Node。

数据面与官方 CLI 1.4.4 的实际流量一致：推理请求发往 `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`，外层为 `{project, requestId, model, userAgent, requestType, request}`，`request` 为 Gemini GenerateContent 结构；`project` 取自同一服务 `loadCodeAssist` 返回的 `cloudaicompanionProject`，并按 token 缓存。请求使用官方 CLI 的 User-Agent，其他客户端标识会被上游拒绝（HTTP 404）。旧的 `aicode.googleapis.com` experience 接口不提供 Gemini 4 Argon，已不再使用。OAuth 凭证的读取与请求均在槽位内，官方 `agy models` 负责刷新凭证；控制面只接收结构化内容与用量。上游协议变更需要同步更新适配器。

测试覆盖请求与流式事件转换、模型目录安全存储、管理员/owner 权限、密钥与账号池隔离、并发及队列、失败切换、取消、usage 和 Responses 续接缓存。生产启用前还需用真实账号验证目标模型的官方上游行为。Claude 的自动凭证刷新、配额探测、定时测试及遥测策略不套用到 Antigravity。
