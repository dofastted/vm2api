# Gemini 宿主机候选

Linux amd64 的 vm2api 一键安装和升级默认准备 Gemini（Antigravity CLI）。管理员在「导入 → Gemini」激活并创建宿主环境，再从「虚拟机」页管理账号。该组件不创建 VM、Docker 槽或 VM 调度记录。Docker 控制面通过只读挂载的 Unix socket 目录连接宿主服务；不支持 ARM64 或远端集群。

## 默认安装与激活

1. 在有 `systemd` 的 Linux amd64 宿主运行一键安装或升级。Ubuntu 24.04 等 apt 宿主会自动补齐缺少的 `nodejs`、`python3` 和 Gemini 网络、沙箱工具；其他发行版请按安装器提示准备依赖。安装器按 [`deploy/payload.json`](../deploy/payload.json) 下载固定的 CRAGGemini 运行产物和公钥，再直接从 Google 下载 `agy 1.5.9`。校验大小、SHA-256 和 Ed25519 签名后，原子安装到 `share/gemini/current`。默认路径无需手工下载、放公钥或创建兑换校验文件。
2. 面板显示「已安装，等待兑换」后，在「导入 → Gemini → 兑换 CRAGGemini」或「订阅 CRAG」输入 `CGG1-…`。激活绑定到宿主安装的清单；错误码不会解锁，服务重启保留激活。明文码不入库、不持久化。激活不代替 Google 授权，也不会自动把账号加入调度。
3. Google OAuth 和交互终端还需要 `ip`、`nft`、`setpriv`、支持非特权用户命名空间的 `bwrap`、`openvt`（kbd）、vm2api 自带的 `kin-egress`、IPv4 转发和绑定的 SOCKS5 代理。OAuth 推理依赖可分配的 Linux 虚拟控制台；预留服务配置中的 UID/GID 区间与 `198.18.252.0/27`，不要为此开放直连或调整全局转发策略。
4. 安装器不覆盖已有载荷（包括旧 `rc.1`），也不覆盖 `/etc/vm2api` 的手工信任设置。自管载荷仍可使用 `prepare-gemini --gemini-payload-source DIR`，并在 `/etc/vm2api/gemini-ed25519.pub` 配置该载荷的受信公钥；已有手工兑换校验配置仍适用。载荷源目录及其父路径须由 root 所有且不可由非 root 写入，不可放在 `/tmp`。
5. `--no-start` 跳过服务及默认载荷准备。Gemini 失败不阻断控制面安装或升级。可在面板「设置 → Gemini」复制单独安装命令，或运行已安装版本的 `sudo bash /opt/vm2api/deploy/install.sh prepare-gemini`（自定义安装目录需替换路径），用 `journalctl -u vm2api-gemini.service` 查原因。独立 Node 网关须加入 `vm2api` 组并重启以访问 `/run/vm2api-gemini/control.sock`；已有自定义 unit 要先迁移，避免争用 socket。
6. 第 2 步的授权码在发行机对已签名、已解包的载荷签发：

   ```sh
   node scripts/issue-gemini-release-code.mjs --source /path/to/signed-payload \
     --public-key /path/to/trusted-public-key --release-dir /path/to/private-release-records
   ```

   同一签名清单在同一私有发行目录只生成一个授权码。保留 `.code` 文件并私下交付授权码；仅将对应 `.json` 校验配置以 root 所有、`0600` 权限安装到宿主 `/etc/vm2api/gemini-release.json`，不提交明文授权码，也不要把签发私钥放到部署机。更换校验配置不会沿用旧版激活。

## 导入与验收边界

- 在面板为环境选平台所有的可用 IPv4 SOCKS5 节点。宿主服务使用独立 UID、文件系统隔离和独立网络命名空间；`agy` 无直连规则，只有 `kin-egress` 可向选定 SOCKS5 的地址和端口建立出站连接。首版不接直连、HTTP 代理或域名型代理端点。
- **Google OAuth**：打开 CLI 生成的官方链接，回填授权码或完整回调链接。完整链接的 `state` 必须匹配当前授权尝试。CLI 持有凭据；不在面板填写 Google 密码、访问令牌或刷新令牌。尝试最多 5 分钟；停用或删除可取消等待中的授权。
- **启动 Gemini**：从已完成 Google 授权的账号详情打开 `agy` 终端，沿用该账号的隔离 HOME 和 SOCKS5 代理。终端仅在启动阶段把 CLI 的 Google OAuth 菜单视为需要重新授权；会话中的同名文本正常显示，不改变账号授权状态。终端使用计划模式启动，关闭终端即结束进程；不创建 VM，不启用公共推理或计费。反代须为该终端透传 WebSocket，见 [nginx 终端配置](nginx-shell.md)。
- **Antigravity Tools 账号文件**：在「导入 → Gemini」选择一个账号 JSON 文件、填写环境名称并绑定平台代理。面板只发送访问令牌及其 Unix 秒过期时间；不上传刷新令牌、账号名或配额快照。宿主经该代理向 Google 验证账号身份和 Code Assist 权限，成功后才保存凭据并显示账号、模型与额度。过期后重新进行 Google 授权；此方式不启用 OAuth 推理。
- **Gemini API Key**：经绑定代理调用 Google 模型列表验证凭据，再以仅宿主服务可读的权限保存。模型列表不是推理验收；该凭据通道不返回账号邮箱、订阅或按模型使用配额。
- **虚拟机 → Gemini → 详情 → 代理**：可查看、测通或换绑 IPv4 SOCKS5。测通请求只检查能否经绑定代理连接 Google，不发送账号凭据。换绑会清除已有模型和账号数据快照，不删除登录；授权、CLI 终端或测试运行时不得换绑。
- **详情 → 测试**：先拉取模型，再选择模型发送单条纯文本。OAuth 使用隔离的官方 `agy models` 发现模型；推理时为该回合启动 CRAGGemini 原生 worker，并在空闲 Linux VT 上启动同一私有 HOME 中的 `agy` TUI，由 `LD_PRELOAD` 原生输入桥接收请求、经 worker 返回 Gemini SSE。API Key 只把目录中声明支持 `generateContent` 的模型加入测试列表，并直接调用 Google `generateContent`。请求只用当前账号及绑定代理，不切换账号、不回落直连。测试不计入 vm2api 密钥扣费，但可能消耗 Google 侧用量；真实 VT/TUI 验收需要 Linux amd64 宿主。
- 各种导入方式都在 VM 页显示环境、代理绑定、授权状态、载荷版本和可读取的数据。「刷新数据」经绑定代理读取 Google 响应：OAuth 按可用权限读取账号、项目、订阅、模型、配额及 Credits，API Key 读取模型。展开 OAuth 账号可看共享额度的 5 小时和每周窗口、使用比例、剩余比例和重置时间；共享窗口未返回仍可看逐模型额度。两类读数不叠加，未返回比例不显示为零，旧数据标明读取失败后的快照时间。额度和 Credits 不代表本地调用量或费用。凭据失效时需重新授权或导入；尚未启用 OAuth 自动续票。宿主服务的状态目录不纳入 VM 包或面板备份。
- OAuth 授权、拉取模型和推理是不同检查。Google 若拒绝当前账号所在地区的 Antigravity 调用，测试返回 `gemini_location_unsupported`，不会触发重新授权、换号或换代理；不要把有模型列表当作推理就绪。
- 可使用非 root 账号运行 `bash test/deploy/gemini-host-egress-smoke.sh /absolute/path/kin-egress`，在一次性 Linux 命名空间用 `iptables` 模拟 Docker 的默认转发丢弃策略，检查选定 SOCKS5 的透明转发、转发器退出后失败和网络清理。该测试不访问 Google 或主机代理池。
- 有签名产物时，可在带 Node 和 Python 的一次性 Linux amd64 容器内以 root 运行 `bash test/deploy/gemini-host-install-smoke.sh /path/to/signed-payload /path/to/public-key`。断网烟测覆盖验签、传统手工安装、默认预装后锁定、拒绝无效兑换码和激活重启持久化。
- 原生 worker 和 `agy` 必须在同一个沙箱 PID 命名空间和 `/proc` 内运行，以便 worker 用 Unix socket 对端 PID 核对 `agy` 的控制台与二进制摘要。可在有空闲 VT、装有 `openvt`、`bwrap`、`setpriv` 的一次性 Linux amd64 客机内断网运行 `sudo python3 -B test/deploy/gemini-host-native-launch-smoke.py /path/to/verified-payload`，验证真实 launcher 握手及模拟上游回合完成。

## 使用专用密钥调度

激活内核后，用 Gemini API Key 或通过官方 CLI 完成 Google OAuth，再在账号「详情 → 测试」拉取模型并试聊。用账号文件导入的短期凭据只能查看已验证的账号数据，不能调度推理；需完成官方 CLI OAuth 后再拉取模型。

管理员创建的 Gemini 专用密钥可以通过 `GET /v1/models` 查询模型，并使用已授权且已拉取该模型的 Google OAuth 环境。协议入口包括 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google `generateContent` / `streamGenerateContent`，以及兼容旧客户端的 `/v1/gemini/sessions/:id`。

当前原生适配只接受每回合一条纯文本 user 输入；system、历史对话、工具、多模态及 Gemini generation settings 会明确拒绝。CRAGGemini 原生 worker 内部使用 SSE，但面向 JSON 请求的公开协议先等完整回合后再生成对应 JSON；流式端点以 SSE 帧返回完整回合，不承诺首 token 延迟流式。Google API 错误和 OpenAI/Anthropic 错误按各自协议形状映射。

OAuth 环境仍由 Gemini host 管理 token、HOME 和代理绑定；请求进入复用的 `PoolScheduler` 账号平衡、in-flight 并发预留和 unit-circuit 状态。每个环境同时只接受一个原生回合；繁忙时在其他符合模型和代理条件的环境中选择。一次回合一旦由 CRAGGemini host 接受，后续推理失败不自动重放到另一账号；客户端应按错误码决定是否重试。每个环境使用自身已绑定 SOCKS5 与独立网络命名空间；模型白名单及 Gemini API key 限额照常执行。

### 管理员诊断接口

前缀 `/api/panel/gemini/environments/:id`，使用面板管理员鉴权。下面列出响应的 `data` 字段；错误使用 `error.code` 和 `error.message`。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `POST /proxy/probe` | 无 | `ok`、`latency_ms`，失败附 `code` |
| `PUT /proxy` | `{proxy_id}` | 环境视图 |
| `POST /models` | 无 | 环境视图，含 `models` 和 `models_discovered` |
| `POST /test-chat` | `{model,prompt}`，限现拉模型和 4096 UTF-8 字节提示词 | `{run_id}` |
| `GET /test-chat/:run_id` | 无 | `{state,text,usage?,error?}`，状态为 `running`、`completed` 或 `failed` |
| `DELETE /test-chat/:run_id` | 无 | `{cancelled:true}` |

`run_id` 绑定环境，结果只在宿主内存短暂保留。这不是公开模型网关，不接收工具、多轮历史或多模态请求。上游未返回计数时不推算用量。

## 协议适配与原生边界

| 设计项 | vm2api 行为 |
| --- | --- |
| 入口与额度 | Gemini 会话使用独立入口，不与 Claude、Codex 或 API 直连混合调度。额度按共享组展示 5 小时和每周窗口，逐模型读数单列。 |
| 协议适配 | 请求先归一化再派发到官方 `agy` 的原生桥，只接受桥明确支持的字段与能力。 |

内部适配器 [`native-turn.mjs`](../src/lib/gemini/native-turn.mjs) 把 Gemini `streamGenerateContent` 请求体、Anthropic Messages、OpenAI Chat Completions 和 Responses 的单条文本输入收敛为 `{ request_id, stream: true, body: { model, contents } }`，保留文本顺序和空白。由受信服务端选定固定模型和每回合独立的 `kernel.sock`，经 `/internal/v1/messages` 调用 CRAGGemini worker；worker 的 `native.sock` 与 `LD_PRELOAD` 桥接到 `agy` TUI 原生输入队列。历史由原生会话持有，不接收外部历史、系统指令、工具、生成参数、多模态或非流式选项；不支持的字段明确拒绝，不静默丢弃。适配器保留原生 Gemini SSE，不把首个 HTTP 200 当作回合成功，也不自动重试。

宿主解析 Gemini SSE 时同时接受顶层 `candidates`／`usageMetadata` 和 Code Assist 的 `response` 包装；无有效结束帧仍按失败处理。Unix socket 回归覆盖包装帧的文本、结束原因与用量。CRAGGemini 独立 worker 的真实 OAuth 验证不等于 vm2api 验收：还需将含 Code Assist 捕获修复的签名载荷接入 vm2api，再从网关端发起真实 OAuth 回合。
