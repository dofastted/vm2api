# Changelog

## Unreleased

- 缓存 TTL 优先级统一：`x-kin-cache-ttl` 头 → 请求断点上显式 `5m`/`1h` → 设置菜单。官方 Claude Code 的无 ttl 断点不再落成隐式 `5m`，改用菜单值；原先官方流量直接跳过 TTL 解析。
- 同一会话（出站 session id）只写一种 TTL：首轮解析结果钉住，空闲超过该 TTL 后才重新解析。中途改菜单不再让同一前缀在 `5m`/`1h` 之间切换。

## 1.3.29 — 2026-09-23

- 修复 native Claude 多轮 prompt cache 只写不读：Node 清理旧断点，CLI 保留当前尾部并为 `messages.length >= 4` 的倒数第二个 user 写入稳定断点。
- 同步 `share/wrap-cli/cli-node` 为双断点修复后的 CLI 二进制；面板选择的 `5m` / `1h` TTL 继续由每轮 native job 统一使用。

已部署机升级：覆盖控制面并重启 Node 一次，再执行 `wrap-cli/sync` 重启槽内 dataplane。不要 `docker rm` 槽。

## 1.3.28 — 2026-09-23

- cli-hop 接受 `claude-opus-5.5`，出站写成 `claude-opus-5-5`。思考用 adaptive，缺省 effort 是 medium。价目按官方 $4 / $20。
- 出站 Claude Code 版本从 `2.1.278` 改为 `2.1.280`。`2.1.278` 会被上游拒成 `claude_code_version_too_old`。
- 去掉 Codex Rotate 插件（`X-Codex-Turn-State` 采集/注入）。官方插件默认关闭，路由缺省对象曾把它当成开启。设置页不再提供开关。

已部署机升级：控制面覆盖后重启 Node 一次，再 `wrap-cli/sync`，让槽内 kernel 读到新的 `cli_version`。`bin/kin-kernel` 本身没变。不要 `docker rm` 槽。

## 1.3.27 — 2026-09-22

- cli-node 补上的无 ttl 断点改成与 Node 已写断点相同的值。没有已有断点时用 `kernel.json` 的 `default_cache_ttl`，再缺省 `1h`。避免 system 的隐式 `5m` 落在后面的 `1h` 前面。ELF 经 UPX 压到 50MB 以内。
- `wrap-cli/sync` 铺完文件后按 `/proc/pid/exe` 结束槽内正在跑的 `cli-node` 和 kernel，再拉起。不再用 `pkill -f`：那条命令的参数里就有同样的路径，shell 先被杀掉，旧进程继续占着旧 inode。

已部署机升级：先更新控制面并重启 Node 一次，再 `wrap-cli/sync`。只换磁盘上的 `cli-node` 不会换掉正在跑的进程。不要 `docker rm` 槽。

## 1.3.25 — 2026-09-22

- OpenAI 号池按权重、会话粘滞和 smart 分数选槽，不再按额度压力排序（#80）
- cli-hop 缓存 TTL 跟设置 → 协议，缺省 **1h**，不再写死 5m。请求头 `x-kin-cache-ttl` 仍可覆盖。空的 kernel `default_cache_ttl` 也回落 1h（#81）
- kernel 重装页可从本仓库 GitHub Release 下载 linux amd64 `kin-kernel`，校验 ELF 后写入并同步所选槽。下载地址只允许 `dofastted/vm2api`，失败或不是合法 ELF 时不写文件（#82）
- `session_slots` 是单槽同时在飞的座位上限；`max_sessions` 仍是不同对话窗口。粘滞账号暂停、等待队列满或预约失败时换到别的 VM。普通 502/503/504 冷却 15 秒并换号；Usage Policy 502 仍暂停该账号 1 小时，`slot_busy` 仍不停车（#83）

已部署机升级：`bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 有变，必须 `wrap-cli/sync` 并重启槽内 dataplane。不要 `docker rm` 槽。

## 1.3.24 — 2026-09-22

- cli-hop 对齐 sub2api 默认：不再改写 messages 上的 `cache_control`，system 断点也保留。只给最后一个非延迟工具补 5m 断点
- 仍钉住 `<total_tokens>`。kernel 继续 `preserve_cache_breakpoints`，不重打断点

已部署机升级：只更新控制面并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.23 — 2026-09-22

- cli-hop 的两个 message 断点都在 Node 打完，最后一条不再剥给 kernel 重打。kernel 收到 `preserve_cache_breakpoints`，不再改断点
- `messages` 里的 `<total_tokens>` 和 `system[]` 一样钉成 2.1.278 的 `15000000`，避免历史 system 提醒改掉已写出的前缀

已部署机升级：只更新控制面并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.22 — 2026-09-22

- cli-hop 把抬进 `system[]` 的 `<total_tokens>` 钉成 Claude Code 2.1.278 的固定 `15000000`。历史里的 `role=system` 不改。下一轮前缀能读到上一轮写下的缓存，不再整段重写
- 控制台日志改为 hub 样式，并带上用量图（#77）
- cli-hop 探测请求里过小的 `max_tokens` 抬到 1024，避免 wrap 把 max_tokens 打满当成失败（#73）

已部署机升级：只更新控制面和前端并重启 Node 一次。不必 `wrap-cli/sync`。不要 `docker rm` 槽。

## 1.3.21 — 2026-09-22

- 原子重写槽内 `kernel.json`、`worker.json`、`internal.token` 时，先把临时文件 chown 成槽 uid 再 `rename`。内容没变也会把已经变成 root 的 `kernel.json` chown 回去。避免控制面写出 `0600` 新 inode 后，槽进程读配置 `Permission denied`，容器 `unless-stopped` 重启循环（#71）
- cli-hop 用这一次请求的 `metadata.user_id` 同时作为 native slot 和 CLI cache key。同一会话的后续轮次读得到上一轮写下的缓存
- `bin/kin-codex-kernel` 转发 `x-codex-primary-reset-after-seconds` 和 `x-codex-secondary-reset-after-seconds`，并上报 `usage_limit_reached`、`upstream_auth`、`upstream_status`。websocket 增加 open timeout 与 keepalive failed

已部署机升级：`bin/kin-kernel` 与 `share/wrap-cli` 有变，必须 `wrap-cli/sync` 并重启槽内 dataplane。不要 `docker rm` 槽。Codex 槽使用新的 `bin/kin-codex-kernel`。

## 1.3.20 — 2026-09-22

- 本机出口即使没有 SOCKS URL 也视为已绑定直连出口；重置、worker reload、Codex kernel 配置与 GPT host hop 不再误判为未绑定
- incomplete 在下游已经 commit 或 transport 异常时同样立即释放全部粘滞会话键，不再占住 session window
- GPT / OpenAI 平台模型不再进入 Claude 蒸馏拦截；Claude 模型仍保留原有 harvest、指纹和思维链提取规则

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.19 — 2026-09-22

- 半截请求不再占会话槽：incomplete 立刻丢掉这次对话键，并马上回收内核槽，不再等 30 秒回收冷却
- `slot_busy` 的 503 不再把账号暂停 1 小时。槽满只回收内核，不再把整号打进冷却后让客户端看到「号池负载过高」
- 官方用量若以百分数 26 写入，按 26% 比较，不再当成 ≥100% 进入冷却。0–1 的真实 rejected（例如 0.84）仍然拦截

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.18 — 2026-09-22

- 没有调用方 session id 时，粘滞只哈希首条 user 的第一段文本。后面的文本块每轮都会变，不再因此新开一个 session 槽
- 同一会话的连续请求留在这一条槽上，消耗的是 RPM 和并发，不是 session 位置

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.17 — 2026-09-22

- Pro 95% 线提前挡住并发：窗口剩余不足 5 个点时不再放进第二条在途请求，避免冲过上游 rejected
- 会话已绑定的槽在 RPM 或并发满时留在原槽排队，不再另开一个会话。Opus 不再进 OpenAI 槽，GPT 也不进 Claude 槽
- 清冷却会清掉磁盘上的可恢复冷却，并把已经打满的 5h/7d 窗口标成过期，列表状态马上刷新。凭证吊销仍保持停用

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.16 — 2026-09-22

- Claude CLI 把 5h 窗口用尽包成 HTTP 502 `You've hit your limit`。这条改为账号额度用尽：冷却到窗口重置，并换到还有额度的账号。普通 500/502/503/504 仍暂停该账号 1 小时且不换槽
- 会话槽已满时，新会话进入等待队列，直到最老的会话空闲。已经绑定的会话仍留在原槽

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.15 — 2026-09-22

- 有调用方 session id 时，粘滞只认这一条。内容指纹、设备号和 envelope 不再把同一条对话拖到别的 VM。已绑定的账号和出站 session 不会被后一次成功改写
- `session_slots` 只数不同的对话，不再用正在飞的请求数占槽
- cli-hop 进内核前写入同一个 `metadata.user_id`
- HTTP 500/502/503/504 暂停该账号调度 1 小时，并把这次请求写入拒答缓存，1 小时后过期。不再因此换槽。响应头超时仍按原逻辑重试；529 仍是 15 秒短冷却

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.14 — 2026-09-22

- 设置 → 协议仍是人设和缓存 TTL 的唯一开关，写在 `routing.json`。保存后把解析结果投影到 Claude 槽 `vms/<id>/run/kernel.json`（`persona_preset`、`system_layout`、`default_cache_ttl`）。kernel 热读该文件，不必重启槽。Codex 槽不写。手改 `kernel.json` 会被下一次投影盖掉
- 保存提示用服务端回读的方案名，并报告热更新了几个槽。`官方完整提示词` 的 `persona_inject` 写回 `official_full`，不再折成 `rewrite`
- 虚拟机环境里保存时区或跟随代理时区，会把 `timezone` 热写进该槽 `kernel.json`。容器环境变量 `TZ` 仍要换容器才变

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.13 — 2026-09-22

- VM 列表状态条显示当前凭证的实际可用性（可用、凭证有效、限制、已过期、无凭证），不再用 7 日请求成功率。调度关但票还活着时显示「凭证有效」
- 列表、卡片和详情的 5h / 7d 用量同时显示该窗口的调用费用合计
- 平台筛选在 Claude 旁增加 OpenAI（GPT）按钮

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.12 — 2026-09-22

- 没有调用方会话时，出站 `session_id` 不再每跳 `randomUUID`。种子是账号、客户端（IP、去掉版本号的 UA、API key）和首条 user 文本
- 同一账号的粘性行复用已保存的 `session_id`。首句被裁短也不重铸；换号才重铸，回到原账号恢复原 id
- 非官方计费头 `cc_prompt_id` 改成同一个 UUID，连续对话不再每次重建 prompt cache

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.3.11 — 2026-09-22

- 拒答缓存命中直接 HTTP 500（`refusal_guard`），蒸馏命中仍返回配置的错误码（默认 403 `distill_blocked`）。两条都在 Codex hop 和 `count_tokens` 之前拦住，请求正文不会进槽
- 蒸馏硬正则补上知识/模型蒸馏和提取思维链（extract/dump chain-of-thought、提取/蒸馏思维链）。官方、0 注入、面板删规则也不放行。化学 distill、单独「思维链 / 请分步解答」仍不拦
- 槽内 `kin-worker` 完整读取 `worker.json` 遥测（env、betas、headers、身份）。文件变更按 mtime 热更新，不必重启进程。事件 beta 对齐 Claude Code 2.1.278 主会话，不再回退 2.1.241
- 初装保存把 `official_cc.inference` 固定为 cli-hop。虚拟机种子页在遥测打开时锁定 DNT 与非必要流量，并标明外部「同步遥测」会在下次换票重新打开本槽遥测

## 1.3.10 — 2026-09-22

- cli-hop 出站只写 `5m`。wrap 的 tools/system 不带 ttl，Anthropic 当成 `5m` 且排在 messages 前面；后面再写 `1h` 会 400。控制台默认仍是 `1h`，但 cli-hop 不把它写到线上。
- 粘性会话按平台分开：同一对话只占一个 VM session 槽，未命中时等待，不再另开第二个会话
- 模型页拆成 Claude 与 GPT 两个池；切换目录在页头，GPT 隐藏 Claude 的 1M 控件，未保存修改要确认后才换池
- 主 Messages 仍是 `claude-cli/2.1.278 (external, sdk-cli)`，不改成 `claude-code`；beta 用 `thinking-binding-controls-2026-08-01` 替换 `advanced-tool-use`。`x-claude-code-compaction` 只在客户端已经发送时转发
- 面板保存 `cache_ttl` 或 `persona_preset` 时重写 Claude `kernel.json`（`default_cache_ttl`、`system_layout`、`cli_version`）。Codex 槽不写
- `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 换为同一份新 ELF：`CLAUDE_CODE_ENTRYPOINT=sdk-cli`，`CLAUDE_CODE_VERSION` 缺省 `2.1.278`，放行 `x-claude-code-*` 条件头，并读取面板写入的 `default_cache_ttl` / `system_layout`。升级必须 `wrap-cli/sync` 并重启槽内 dataplane，不要 `docker rm` 槽
- `share/wrap-cli/cli-node` 换为已打补丁的 Claude Code 包，UPX 5.0.1 从 110MB 压到 28MB。`package.json` 仍是 2.8.4；出站 UA / billing 读 `CLAUDE_CODE_VERSION`，缺省 `2.1.278`
- 部署改为拉预构建镜像：控制面与槽位 OS 镜像随 Release 推到 ghcr，`install.sh` 只下载 compose/.env（不再 clone 仓库），`docker compose pull && up -d`，服务器上不再构建前端与镜像；源码模式用 `--from-source` 或 `docker-compose.build.yml`
- 安装目录不再限定 `/opt/vm2api`：槽容器的 `-v` 源路径由控制面自省自身 Mounts（或 `VM2API_HOST_ROOT`）换算成宿主路径，命名卷同样成立
- 槽位镜像缺失时先 `docker pull` 再用仓内 Dockerfile 兜底构建；启动阶段只拉不构建，冷启动不再被 apt 阻塞
- 首次启动自动补本机出口 `px-local`，并允许本机出口直接启动槽（此前只认带 SOCKS URL 的出口）

## 1.3.9 — 2026-09-21

- cache TTL 现在贯穿请求 header/body、Settings compatibility、Unix socket envelope 与 Rust kernel；请求级 `5m` / `1h` 覆盖不会通过共享 kernel 配置串值，官方 Claude Code 继续保留客户端自有断点
- `VERSION` 成为唯一应用版本源；控制台从运行态 `/api/panel/me` 显示版本，Release 校验 tag，HostDzire 打包自动重建前端，避免旧构建版本漂移
- 蒸馏硬拦截 memory-stage-one / MUST distill / MUST extract durable memory 收割包装（含信封 JSON 外包的收割），官方、0 注入、面板删针也不能放行；单独 `Persistable response items` 仍不是针
- 拒答缓存只记 `stop_reason=refusal` / `content_filter` / refusal 块；wrap `Usage Policy` 文案不再当拒答，也不再剥信封 JSON 指纹（HostDzire 262 条全是正常信封会话误入，hit_count=0）
- wrap Usage Policy 502 仍可 failover，不再映射成 403 `content_filter_refusal` 停换号
- 内核页改名为 **kernel重装**；槽同步优先仓内最新 `bin/kin-kernel`（`KIN_KERNEL_BIN`），不再被旧 wrap 母样本 ELF 盖回去
- 可上传 linux amd64 kernel 二进制替换仓内 kernel，再同步到所选 VM

## 1.3.8 — 2026-09-21

- cli-hop 固定以 5m 写入多轮会话断点，避免 wrap 的 ttl-less 5m 断点后出现 1h 而被上游 400；覆盖 `/v1/chat/completions` 入站转换
- SSE 聚合不再用空 assistant 信封覆盖真实上游错误；同一 session 请求串行，不同 session 继续并发
- 控制面启动后立即核验并修复已启用出口，不再等待下一轮代理池定时探测
- 虚拟机列表行内新增删除入口（列表与网格视图），需键入槽位 ID 确认；活跃槽位仍需先切换活跃
- 槽位命名不再限定 `vm-` 前缀：`vms/*.json` 全部纳入列表、DB 镜像、指纹对齐与备份恢复；`active`/`create`/`import` 与 `-chat` 后缀保留为非法 ID
- 空 cli-hop 终止帧不再提交或视为成功；同一 VM 仅恢复重试一次，避免单请求遍历整个账号池
- 显式 session 作为并发串行与粘性主键；`claude-opus-4-8` 固定走 Anthropic，Fable 无 Max 返回专用 429
- 覆盖安装枚举旧命名 VM，并要求槽内 kernel 同步与重启全部成功后才报告升级完成
- 默认 Session 槽位设置与现有设置行对齐，并同步更新所有未单独覆盖的 Claude VM
- Protocol 人设方案与自定义模板现在会在 Rust cli-hop 请求阶段按全局/每槽解析后实际传给内核

## 1.3.6 — 2026-09-21

- Rust kernel 固定预开 20 个 Claude native CLI session 位
- 新增全局与每槽 `session_slots` 热准入上限，独立于并发、RPM 与 sticky session
- 设置页和 Claude VM 详情支持 Session 槽位配置；Codex 槽保持隐藏
- routing 持久化失败时完整恢复内存运行态，避免半应用配置

## 1.3.5 — 2026-09-21

- Claude Code 身份、User-Agent 与默认 beta 序列同步官方 2.1.278 抓包
- official 请求条件透传 request class、agent type、前序工具耗时与 context compacted 标记
- SSE 聚合保留 `stop_details`、`safeguard_results` 与 `diagnostics`

## 1.3.4 — 2026-09-21

- OpenAI 模型无论入站 chat、messages 还是 responses，hop 都洗到 `/v1/responses`
- 请求日志记录清洗后的 path/protocol；原来的入站协议留在 `hop_meta`
- API 类 OpenAI 上游改为官方 Responses，不再 POST `/v1/chat/completions`

## 1.3.3 — 2026-09-21

- Codex Rotate 插件：采集并注入 `X-Codex-Turn-State`（292/332），设置 → 协议可开关，默认关闭
- OpenAI / Codex 用量保留 `cached_tokens` 与 `cache_write_tokens`，计费和日志不再把上游缓存读成 0
- 面板公开 routing 脱敏 SMTP / Telegram 密钥
- 官方 CCH 按 xxh64 body hash 计算

## 1.3.2 — 2026-09-21

- 控制台左上角在 vm2api 徽标下显示构建版本号
- Vite 从仓库 `VERSION` 注入版本，Docker 前端构建同步复制版本文件

## 1.3.1 — 2026-09-21

整合 VM 列表可视化升级与 1.3.0 网关遗漏修复。

- VM 列表加入 fleet pulse 与用量仪表，重整桌面和移动端信息层级
- 并发预约竞态失败后尝试其他账号，全部繁忙时进入账号等待队列
- thinking-only、缺少 `stop_reason` 或非 assistant envelope 的响应不再误判成功
- 同槽兄弟请求阻止即时回收时，最后一个请求结束后补做 wrap 回收
- 控制台缓存 TTL 仅支持 `5m` / `1h`；请求显式 TTL 覆盖默认值，所有出站断点统一复写
- Compose 默认镜像更新为 `vm2api:1.3.1`

## 1.3.0 — 2026-09-20

- 官方 Claude Code init 同时读取并保留 `~/.claude.json` 与 `CLAUDE_CONFIG_DIR/.claude.json`，不再在身份同步后删除 CLI 生成文件
- routing 配置缺失或损坏时启动显式失败；VM 创建/启动响应不再返回账号、指纹、代理凭据及宿主运行时标识
- 确认发布 kernel 在 `tool_use` 终止帧送达后归还 native slot，连续工具调用可独立恢复

## 1.2.22 — 2026-09-20

修复 Anthropic 工具循环缓存命中固定在约 53.2K，并让一键更新与 Docker 更新自动替换槽内 kernel。

- Node 重写稳定的上一轮 user 断点，并移除当前尾部断点；槽内 kernel 只补当前尾部，不再清除历史 marker
- cli-hop 断点统一为 5m，避免 wrap/kernel 的 5m marker 后出现 1h 而被 Anthropic 拒绝
- `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 同步更新；一键更新默认调用 `wrap-cli/sync`，Docker 更新检测发行 kernel 变化后自动同步所有槽
- 槽同步按文件内容判断，不会因二进制大小相同或旧文件 mtime 更新而跳过；替换和重启 dataplane 均不 `docker rm` 槽

已部署机升级：使用一键更新即可同时更新控制面、模板与槽内 kernel。实测工具循环 `cache_read` 为 `12532 → 14584 → 16636`，不再固定。

## 1.2.21 — 2026-09-20

57K 掉回 53K 不是 TTL。线上所有 `kernel.json` 都是 `system_layout=zero`，wrap 只打 persona，不重打 last+prev user；Node rewrite 的 message 断点到不了 Anthropic。不必 overlay 整份 routing，也不必 `wrap-cli/sync`。

- `resolveCliSystemLayout` 跟 `persona_preset`（`official_full` → identity），不再在缺 routing 时静默写成 zero
- 已有槽位 `kernel.json` 改成 identity 后 `docker restart`（不是 `docker rm`）
- 线上 `cache_ttl` 从误写的 `5m` 改回 `1h`

已部署机升级：覆盖 `src/lib/vm/slot-engine.mjs`，改 `kernel.json` + `routing.json` 的 `cache_ttl`，重启槽容器和 Node 各一次。

## 1.2.20 — 2026-09-20

cli-hop 不再吃 routing 的 `messages=fill`。1.2.19 常量改回 rewrite，但 hop 仍传入线上 fill；入站已有 last-user 标记时 fill 空转，再 drop last 就只剩 ~53k persona。不必换槽内 kernel。

- `prepareCliHopBody` 强制 `messages: rewrite`，并继续关掉 system/tools tail
- 多轮 leftover 是上一条 user，`cache_read` 应随对话增长
- 不要 overlay `routing.json`

已部署机升级：只覆盖 `src/lib/protocol/outbound-attempt.mjs` 并重启 Node 一次。不必 `wrap-cli/sync`。

## 1.2.19 — 2026-09-20

cli-hop 断点回到 1.2.0 rewrite。线上 kernel 是 `system_layout=zero`，不会重打 messages，剥光后 cache_read 就钉在 ~53.2k persona 前缀。不必换槽内 kernel。

- Node 重打最后一条 + 上一条 user，再去掉最后一条 stamp，留给 wrap 打当前 last user
- leftover `role:system` 仍不打断点；tools / system tail 仍关
- 官方和第三方同一套 stamp，conversation 增长后 cache_read 应超过 53.2k

已部署机升级：只覆盖 `src/lib/protocol/outbound-attempt.mjs` 并重启 Node 一次。不要 overlay `routing.json`。不必 `wrap-cli/sync`。

## 1.2.18 — 2026-09-20

连续 session 的 `provider error: Connection error` 是 wrap CLI 本地断流，不是 Anthropic。`message_start` 曾被当成已提交，导致不重试；1.2.17 回收又被 inflight 挡住。不必换槽内 kernel。

- 下游提交改到可见输出或 `message_stop`；只有 `message_start` 的 Connection error 不写给客户端
- 同号重试一次，并 **强制** `docker restart` 回收 wrap（不再被 busy/inflight 短路）
- 客户端代码是 `wrap_connection_error`，不是 `upstream_error`

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.2.17 — 2026-09-20

连续 session 半截后 kernel 槽不释放，下一跳空等 30s 再报 `no free slot`，面板还写成上游错误。不必换槽内 kernel。

- 半截 / Connection error 且没有并列 hop 时回收 wrap（pid1 走 `docker restart`，不是 `docker rm`）
- `slot_busy` 对客户端是 `overloaded_error`，不是 `upstream_error`
- 面板测试文案标明这是 VM 内核槽占满

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。

## 1.2.16 — 2026-09-20

蒸馏针名单回到 1.2.1。今天加的信封收割句是误拦根因。不必换槽内 kernel。

- 去掉 `Persistable response items` / `Memory-stage-one extractor` / `MUST extract` / `MUST distill`，也不再扫 messages 里的 system/developer
- 指纹、`<think>`、contest+harvest 与 1.2.1 相同
- 信封流量仍按 API key 粘 `k{id}:envelope`，避免 403 重试把同一会话拆到多个号

已部署机升级：只更新控制面并重启一次。必须覆盖 `src/config/distill-rules.json`。不必 `wrap-cli/sync`。

## 1.2.15 — 2026-09-20

信封流量不再误拦蒸馏，同一 API key 信封会话粘到一个账号。不必换槽内 kernel。

- `Persistable response items` 只当运输包装，不再单独 `distill_blocked`；收割句、其它 needle、指纹、contest+harvest 仍拦
- conversation 模式下信封请求绑 `k{apiKeyId}:envelope`，忽略每跳不同的 `thread_id` / first-user hash
- `ip` / `session` 模式不改；无信封流量仍走 header / metadata / first-user hash

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1215)

## 1.2.14 — 2026-09-20

第三方 cli-hop 改回 1.2.1 剥光，让 cache_read 随对话增长。不必换槽内 kernel。

- 保留 1.2.12 的 convert 块形状对齐（chat / Messages / responses 升块并保留 `cache_control`）
- unofficial hop 不再 Node rewrite last+prev；官方和第三方都剥光，由 kernel 重打最后一块 + 上一条 user
- 避免 leftover `role:system` 被打上断点，把 `cache_read` 钉在 ~53k persona 前缀

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1214)

## 1.2.13 — 2026-09-20

修正 Compose 镜像名。不必换槽内 kernel。

- `docker-compose.yml` 的 `image` 从错误的 `vm2api:1.2.12,,` 改为 `vm2api:1.2.13`

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1213)

## 1.2.12 — 2026-09-20

第三方 OpenAI 兼容口与 Anthropic Messages 的 cache 断点对齐。不必换槽内 kernel。

- 清洗后 system / messages 升成可挂断点的 text 块，保留 tools 与文本块上的 `cache_control`
- 非官方 cli-hop 改回 Node rewrite（last + 倒数第二个 user），官方仍剥光交给 kernel
- 三种入站协议 stamp 位置一致，避免 `cache_read` 冻在 system 前缀

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1212)

## 1.2.11 — 2026-09-20

控制面调度补齐等待计划、额度受限三态和设置/列表。不必换槽内 kernel。

- 槽满（`ready_slots=0` 且 CLI 在）按 `slot_busy` 等待或改选，不标 `worker_unhealthy`
- 半截 assistant 不再经 `preferLastResult` 变成 HTTP 200
- 等待按账号计数，超时绑 wait plan；hop 吃剩余预算
- 额度用尽 / 429 / 冷却写成 **受限**，不拨操作员调度关；窗口到了自动恢复
- 列表芯片：在池 / 受限 / 关闭调用；设置页露出等待人数和两类超时
- Windows 上 Vite 8 / Vitest 4 能装到 rolldown 的 win32 绑定

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1211)

## 1.2.10 — 2026-09-20

修复 Docker web 构建，并换仓内 `kin-cookie-auth`。不必换槽内 kernel。

- 401 跳登录补上必填 `search`，`tsc -b` 通过，compose 不再卡在 Dockerfile 第 7 步 `pnpm build`
- `kin-cookie-auth` 按 rust cli-hop 2.1.263 对齐 sessionKey 换票请求头（`claude-cli` + stainless，不再用合成 Chrome UA）

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1210)

## 1.2.9 — 2026-09-20

thinking-only 残包不再当 HTTP 200；一键安装与 HTTP 面板登录加固。不必换槽内 kernel。

- `stream:false` 组包未完成不算 committed；只有 thinking / `stop_reason=null` 的假 `verified` 同槽再 hop，拿到正文再 200
- 重试用尽才 502 `incomplete_response`，禁止 `terminal_state=verified` + 空正文
- 槽满（`ready_slots=0`）等空槽，不 `docker restart`，也不往满槽塞请求
- 一键安装：空 `.env` 补默认管理台 `admin` / `123456`（不覆盖已有密码）与随机 API key；缺 `!CHANGELOG.md` 则补上并在 compose 失败时重试
- HTTP 裸 IP 登录：Bearer 写入 localStorage；Cookie `Secure` 跟请求走；401 回登录页，不再摊英文 Missing credentials

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-129)

## 1.2.8 — 2026-09-20

修复 compose build：`.dockerignore` 的 `*.md` 把 `CHANGELOG.md` 挡在构建上下文外，`COPY CHANGELOG.md` 失败。不必换槽内 kernel。

- `.dockerignore` 增加 `!CHANGELOG.md`

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-128)。卡住的 1.2.7 构建可先在仓库根 `.dockerignore` 加一行 `!CHANGELOG.md` 再 `docker compose up -d --build`。

## 1.2.7 — 2026-09-20

控制面：版本检查与一键更新。不必换槽内 kernel。

- `deploy/install.sh`：安装 / 更新 / 检查 / changelog / 状态（参考 sub2api 与 CLIProxyAPI）
- 面板 `GET /api/panel/version`、`GET /api/panel/changelog`、`POST /api/panel/update`；`GET /me` 带 `version`
- 设置页「关于」：当前版本、GitHub 最新 Release、changelog、复制一键命令
- 镜像 COPY `VERSION` / `CHANGELOG.md`；已挂 `docker.sock` 时可由面板拉起宿主机升级助手

已部署机升级：只更新控制面 Node（含 web）并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-127)。

## 1.2.6 — 2026-09-20

控制面：本地出口导入、kernel 探活、Setup Token 额度。不必换槽内 kernel。

- 本地出口绑槽后允许导入 / host hop（空 SOCKS URL 视为直连，不再报未绑定）
- 调度、面板 live credential、VM 详情健康检查打 rust `kernel.sock`，不再探不存在的 `worker.sock`
- Setup Token 写入凭证时把 `inference` 规范成 `user:inference`
- Setup Token Extra 5h/7d 进面板详情；手动额度探测真正 hop
- 额度卡展示剩余百分比与重置时间

已部署机升级：只更新控制面 Node（含 web）并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-126)。

## 1.2.5 — 2026-09-20

仓内预编译 linux amd64 二进制，clone / compose 即可部署，不必在服务器上编 kernel 与 wrap CLI。

- `bin/kin-{kernel,codex-kernel,cookie-auth,egress,worker}` 与 `share/wrap-cli` 进 git；Release 再挂一份 ELF
- 已部署机升级：控制面重启一次 + `POST /api/panel/wrap-cli/sync` 换槽内 CLI（见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-125)）

## 1.2.4 — 2026-09-20

协议页简化 UI。缓存 TTL 默认 1h，可改 5m。

## 1.2.3 — 2026-09-20

控制面：拦截 memory-extractor 收割；创建槽开机失败仍可见；控制台集群/列表改版。

- 非官方 OpenAI chat 冒充 Claude Code、索要 durable-memory JSON 的 payload 在 hop 前拦截
- 创建槽位开机失败改 200 + `start_error`，列表立刻出现 error 行，不再当创建失败
- 集群页改为本机 VPS + 扩展节点拓扑（控制面尚未接入，示意为 RFC 5737）
- 虚拟机列表去掉重复 KPI 卡，筛选/工具收成两行

已部署机升级：只更新控制面 Node（含 web）并重启一次。已在 1.2.2 不必再 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-123)

## 1.2.2 — 2026-09-20

修复缓存问题；换票逻辑更新。

- 额度缓存空刷新不再覆盖仍有效的 reset credits
- sessionKey / 授权码换票改走仓内 `bin/kin-cookie-auth`，控制面不再带过程源码
- 已部署机升级：控制面重启一次 + `POST /api/panel/wrap-cli/sync` 换槽内 kernel（见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-122)）

## 1.2.1 — 2026-09-19

模型测试路径不再因缺 `message_stop` 刷成 api_error。

- wrap JobDone 若未带 `message_stop`，kernel 补发，hop 不再标 incomplete
- cli-hop 剥光 messages 上的 `cache_control`；kernel 按 Claude Code 打最后一块（跳过 thinking）并打上一条 user，避免 tool 循环把 cache_read 钉在 ~45k system 前缀

## 1.2.0 — 2026-09-19

messages 缓存断点对齐 sub2api/Parrot。

- 最后一条 + 仅当 messages≥4 打倒数第二个 user
- cli-hop 丢掉 last 后留下倒数第二个 user，wrap CLI 重打当前 last user，不再重复

## 1.1.9 — 2026-09-19

cli-hop prompt cache restamp；环境时区可自定义；代理出口地理检测。

- 默认 messages 断点 rewrite：重打最后一条 + 上一条，避免 cache_read 冻在 ~43.5k system
- cli-hop 只打 conversation 断点，剥 tools/system 和 last-message 让 wrap CLI 落点，不超 4 断点上限
- 创建槽位和环境设置支持任意 IANA 时区（自定义输入）
- `POST /proxies/geo` · `POST /proxies/:id/geo` 经 SOCKS5 查出口 IP 的国家 / 城市 / 时区
- 绑定代理后槽位默认采用出口时区；手动钉过的时区不被覆盖

## 1.1.8 — 2026-09-19

面板分档配额立刻生效；东京时区；Fable 5.1 官方模型 ID。

- 控制面板 5h/7d、RPM、并发、session 走 live policy；session 占用保持到空闲超时
- 槽位创建支持东京 JST，有效 IANA 时区在创建/指纹/重建时保留
- 内置目录改为 `claude-fable-5-1`，点号 ID 作兼容别名

## 1.1.7 — 2026-09-19

Opus/Sonnet extra-usage 429 与 GPT `/v1/messages` 未绑槽一并修掉。

- wrap/kernel `CLAUDE_CODE_ENTRYPOINT=cli`，订阅 OAuth 不再按 sdk-cli extra usage 429
- HTTP 2xx leftover `stream_incomplete` 不再刷成超时
- GPT 模型打 `/v1/messages` 转到 Codex 槽，回 Anthropic 信封，日志带 `vm_id`

## 1.1.6 — 2026-09-18

同步源仓 wrap 内核：复用槽内 `.claude`，submit 更快起 job。

- wrap 指向凭证父目录，不再写临时 config + dummy OAuth
- `kin_job_start` 先于 extra maps；热路径不再 `await retire_idle`

## 1.1.5 — 2026-09-18

同步源仓内核/后端补丁：wrap Extra 5h 头、slot 回收、官方 max_tokens、GPT 额度 failover。

- wrap `kin_job_done` Extra 5h 头进 trailer；ReadyBlocked 不再 30m 误杀；job 后清 tenant
- 缺 `max_tokens` 填官方 per-model 默认，不覆盖调用方
- GPT `x-codex-*` 入库，5h/7d 调度关，429 最多 4 槽 failover
- 本地与 CI 统一格式：Biome / gofmt / Prettier，全文 LF
- README 恢复详细说明；许可改为非商用开源，商用需书面授权

## 1.1.4 — 2026-09-17

补齐 cli-hop CI 夹具，和源仓 simulated job_error / CONNECT 桥一致。

- simulated CLI 对 `[job_error]` 发 `kin_job_error`，槽可回收
- 补回 `scripts/http_to_socks.py`，适配 `crates/kin-kernel` 布局

## 1.1.3 — 2026-09-17

gateway-worker 对齐源仓：local_cli 走 wrap CLI，不再 HTTP hop 到 Anthropic。

- `provider=local_cli` 启动 MultiplexCli，`/internal/v1/messages` 走 cli-hop
- 去掉 anthropic_api HTTP hop，避免 OAuth extra usage 429

## 1.1.2 — 2026-09-17

仓内携带部署二进制；文档写清运行形态。

- git 带 linux amd64 `bin/kin-{kernel,egress,worker,codex-kernel}` 和 wrap 母样本 `share/wrap-cli`
- Compose 拷到 `./bin` / `./share`，不再在服务器上编 Rust/Go；缺 `kin-os/ubuntu:24.04` 才编槽位 OS
- 入口用 `mv` 替换占用中的 `kin-kernel`，避免 `Text file busy` 重启循环
- 文档：1 个控制面容器 + 每个已启动槽 1 个 `kin-*` 容器，不是父容器多进程

## 1.1.1 — 2026-09-17

补回授权链接换票缺件。

- 补回 `scripts/session-import-cffi.py`（源仓 CookieAuth / Chrome TLS），控制面镜像安装 `curl_cffi`
- 补回官方 Claude Code 常驻脚本 `scripts/official-cc-resident.py`

## 1.1.0 — 2026-09-17

推荐 Docker Compose 部署，并修槽位启动。

- 文档把 Compose 定为生产推荐路径（`/opt/vm2api` + `docker.sock` + host 网络）
- 槽位客户镜像配方进仓：`docker/kin-os/`（`node docker/kin-os/build.mjs`）
- 修复本地出口启动误判 `egress network missing`（inspect 同时返回 `name` 与 `network`）
- 文档要求 `bin/kin-*` 为 **755**：槽 UID 是 `10000+序号`，`700` 会 permission denied
- 标明 Docker Desktop / WSL 下 `127.0.0.1:8787` 可能打不到 host 网络
- 控制面可用 Docker Compose 部署（槽位仍在宿主机引擎）
- 同步源仓运行时补丁：换票后回收 wrap、官方凭证软链、未确认 401 不再当吊销
- 同步源仓 GPT 额度：重置券缓存失败不覆盖、探测带回 `cred_status`

## 1.0.0 — 2026-09-16

首个公开版本。

- Setup Token → Console API，产品面 0 提示词注入
- 推理只走 Rust 内核 + Claude Code 原生 subagent（最大 20）
- 删除 Go HTTP hop；`kin-worker` 只保留 telemetry
- 代理池支持远程 SOCKS5 与本地出口（宿主机 NAT）
- Vite 管理台（`GET /console`），环境变量 admin，无用户管理
- 协议口 `/v1/messages` 及 OpenAI 兼容入口
- GitHub Actions：测试 + `v*` linux amd64 Release
- 文档：技术路线图、部署说明、版本构建

交流：[t.me/VM2API](https://t.me/VM2API)
