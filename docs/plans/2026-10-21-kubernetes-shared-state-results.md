# Kubernetes 共享状态增量验证（#648，进行中）

日期：2026-10-21。实现提交：`bf9f508dc0f7bb7232a6ed0fd1a0bcdf6e85a5f1`。后续 `f4ff7004530791b877cc7ac27971596628e42d13` 只适配既有测试替身。分支：`codex/kubernetes-control-plane`。关联 Draft PR #651，依赖 #649。

本轮继续实现 #648 的共享准入和一致性要求。不同节点上的多个活动控制面仍未开放，Issue 不满足完成条件。`replicas: 1`、Recreate 和独占锁继续保留。第一阶段的镜像及 k3s 证据不覆盖本轮新增源码，本轮没有部署现有服务。

## 实现与回归

- PG 原子协调 managed API key/user 并发、key RPM、请求数额度和 pending reservation。计费计数与 pending 结算同事务；重复结算和释放幂等。删除执行中 key 不删除其 user 并发占位。授权字段或凭据在认证后变化时拒绝旧请求。
- HTTP/SSE、Claude API/OAuth、Codex Responses/Search 和 WebSocket 的每个推理请求都使用 reservation。握手不占推理容量，同 WebSocket 保持原有串行队列。跨两条 WebSocket 的同 key 并发通过同一准入接口检查。
- 执行后计费倍率读取、结算或后处理异常时保留持久占位。正常响应处理先结算再释放。该行为不等于已实现执行端取消确认；真实 kernel 的异常退出和取消仍需后续 fencing。
- PG 网关 token bucket 使用取锁后的数据库时间，并保持更新时间单调。存储键为摘要，数据库失败不回退内存限流。此时 HTTP 当前表现为服务器错误，不能表述为 429 或 503。
- API endpoint 每次调度及 `/v1/models` 读取前刷新 PG。自动 cooldown 原子保留较晚截止时间；管理员仍可显式清除。
- settings 刷新防止本地乱序查询覆盖新提交。Kubernetes 认证前从共享设置刷新模型和价格缓存，策略缓存刷新不写入默认值、不触发启动迁移。

失败测试先独立提交。关键复现包括：两个 limiter 原先合计放行 6 次，配置容量为 3；Codex 原先绕过 reserve，实际进入后端并返回 503，预期应在准入处返回 429；执行后倍率读取失败曾释放未计费占位，现改为保留 pending，下一请求继续被额度限制。

## 环境与结果

使用专用 PostgreSQL 17.11 测试容器、独立随机 schema、Node.js 22.23.2 和合成上游/请求。未访问现有业务数据库或真实供应商。PG 备份客户端版本为 17.11。

- `bf9f508d`：迁移/备份 31/31 通过。旧 001 快照恢复后补建 002–004，新增会话、准入和 token bucket 表无残留；跨 schema 保护继续通过。
- `bf9f508d`：实际 Node 控制面 HTTP/SSE、managed key、会话/探针/终止及新增共享额度/设置 E2E 共 14/14 通过。12 个并发 SSE 请求争用最后一次额度时只有 1 个成功，结束后 request/quota 计数各为 1，无活动 reservation。
- `bf9f508d`：全量 E2E 28 文件，103 pass、17 fail、1 skip。17 个失败断言逐摘要与原始 `eee8f6e` 相同。
- 首轮全量 unit 在 `bf9f508d` 上为 3367 pass、31 fail、10 skip。24 个新增失败来自旧测试替身缺少 reserve/listRaw/reload 或静态检查仍定位旧调用字符串；`f4ff7004` 已适配，93/93 定向检查通过。未修改行为预期或原始基线断言。
- `f4ff7004`：完整 unit 复验为 291 文件、3390 pass、8 fail、10 skip。7 项与原始基线逐摘要相同。另 1 项终端测试实际返回 `cli_node_missing`、预期 `container_not_ready`；该旧测试读取了宿主机运行中的 `kin-02`。`5abd21d9` 使用已有 inspect 注入接口提供合成状态，保持原断言，19/19 定向测试通过。此后没有再次运行全量 unit，不能声称全量只剩 7 项失败。
- 本轮修改的 31 个 MJS 文件通过 Node 语法检查，Biome 检查通过，`git diff --check` 通过。

脱敏结果见 [验证元数据](evidence/kubernetes/shared-state/verification.json)、[unit 基线断言](evidence/kubernetes/shared-state/baseline-unit.json) 和 [E2E 基线断言](evidence/kubernetes/shared-state/baseline-e2e.json)。

基线断言的具体差异仍然存在。例如 unit 的实际 TTL 为 `1h`、预期 `undefined`；既有 Responses E2E 实际为 400 `protocol_not_allowed`、预期 200。不能将全量回归标记为全部通过。断言比较按原 runner 的逐文件 PG 预加载规则执行，移除空行和调用栈后计算摘要。

## 尚未实现或验证

- 账号/VM 并发及账号 RPM、设备座位、Sticky generation、同会话跨副本顺序。
- AccountQuota、ProxyPool、SchedulingRuntime 的字段级原子写入及旧快照冲突控制。
- routing/VM/凭据文件归属和传播、后台任务唯一执行、全局备份/恢复维护。
- 执行端 owner/epoch、匹配任务的取消/终止证明、占位安全接管。当前 reservation 没有 TTL；控制面死亡后占位保留，不能据此声明自动恢复。
- settings 的轻量修订与增量刷新。当前每次认证读取完整设置，可能传输并复制 models.dev 快照；本轮未做性能测量。
- 两节点活动副本同时推理、HPA、PodDisruptionBudget、滚动更新、缩容和故障接管。

下一步入口与完成条件见 [实施计划](2026-10-21-kubernetes-control-plane.md)。本轮改动在本地提交；推送及 PR 更新仍须遵守用户要求的 push 前确认。
