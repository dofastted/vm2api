发现 **4 项 P1 问题**。以下均为源码审查结论，动态复现未执行。未发现有证据支持的 P0。

1. **P1：manual bootstrap 会丢失 `/usage` 重试前的未知执行，并释放 claims。**

   位置：[src/lib/oauth/official-cc-bootstrap.mjs:1554](https://github.com/liubing0806/vm2api/blob/66a580de17670a954638fbfb46fee25740adab78/src/lib/oauth/official-cc-bootstrap.mjs#L1554)。

   触发条件：hello 成功；某次 `/usage` 超时；后续重试取得有效限额；其他辅助操作成功；resident 关闭。

   调用链：`scheduleSharedOfficialCcBootstrap` → `runOfficialCcBootstrap` → `runOfficialCcUsage`。同文件第 759 行在发送 SIGTERM 后立即返回超时，没有等待退出证明。第 1047 行用后一次结果覆盖前一次结果。第 1337 行只根据 hello 和限额数据计算 `ok`。返回对象也没有汇总历史超时。因此，第 1561 行可以判定 terminal，随后释放 VM、后台任务和 activity，而早先的容器内命令仍可能执行。

   最小修复：汇总全部已启动操作的结束证据。遇到未知执行时停止重试，并将未知状态传递到所有 bootstrap 调用者。

   交主会话复现：在隔离测试中令第一次 `/usage` 超时且未确认退出，第二次成功提供限额。检查重试次数，以及 `vm_operations.released_at`、后台任务 `finished_at`。预期应保留未知；当前路径会按成功完成。

2. **P1：package 启动及凭证导入绕过新增 bootstrap 辅助操作检查。**

   位置：[src/lib/admin/panel-routes.mjs:887](https://github.com/liubing0806/vm2api/blob/66a580de17670a954638fbfb46fee25740adab78/src/lib/admin/panel-routes.mjs#L887)、[src/lib/oauth/import-commit.mjs:302](https://github.com/liubing0806/vm2api/blob/66a580de17670a954638fbfb46fee25740adab78/src/lib/oauth/import-commit.mjs#L302)。

   触发条件：hello 和 `/usage` 成功，但 profile、models 或 identity 收集超时。

   调用链：
   - `POST /api/panel/vms/package` → `mutateProxyVms` → `bringUpImportedVm` → 原始 `runOfficialCcBootstrap`。
   - 凭证导入 → `commitImportedOauth` → 原始 `runOfficialCcBootstrap`。

   原始函数在 `official-cc-bootstrap.mjs:1272` 收集 profile/models，在第 1312 行收集 identity，但第 1337 行的 `ok` 不包含这些操作。package 的 `vmEffect` 只检查顶层结果；导入路径只检查 `completed.ok`。新增的 `profile_error`、`models_error` 和辅助调用观察逻辑只存在于调度包装器中。这两条启用路径因此可能释放 claims，并在 HTTP 返回后允许其他管理操作或全局恢复。

   最小修复：让原始 bootstrap 返回统一的执行完成状态，并让三类入口使用同一判定。

   交主会话复现：分别覆盖 package 和凭证导入。令 bootstrap 返回实际可能产生的 `{ok:true,status:{profile_error:'timeout'}}`，检查后续 VM claim 是否仍被拒绝。当前调用者会释放 claim。

3. **P1：正常解绑或删除代理可能永久占用整个代理池。**

   位置：[src/lib/vm/egress.mjs:1079](https://github.com/liubing0806/vm2api/blob/66a580de17670a954638fbfb46fee25740adab78/src/lib/vm/egress.mjs#L1079)、[src/lib/admin/panel-routes.mjs:6252](https://github.com/liubing0806/vm2api/blob/66a580de17670a954638fbfb46fee25740adab78/src/lib/admin/panel-routes.mjs#L6252)。

   触发条件：本地 VM 容器仍存在并连接代理网络；没有执行中的 admission；解绑最后一个绑定，或删除该代理。

   调用链：unbind/delete → 更新代理绑定 → `bindVmProxy(null)` → `stopProxyEgress` → `docker network rm`。`bindVmProxy` 只修改记录（`vm-registry.mjs:573`）；容器由 `vm-runtime.mjs:1090` 接入该网络，解绑路径没有停止或断开容器。网络删除因此会遇到 active endpoints。第 1085 行把这个确定存在的网络判为未知。随后 `proxyEffect` 将 pool 和 VM claims 标为 uncertain，接口返回 502。

   影响：绑定已经移除，但后续代理管理被持久 claim 拒绝。全局维护也会被未完成 claim 拒绝。新增确认逻辑使正常清理成为长期故障。

   最小修复：分开处理 helper 终止和网络回收。仍有已知容器端点时保留网络；需要断开端点时，在现有 claims 内按精确容器身份执行并确认。

   交主会话复现：扩展 panel proxy fixture，让 network inspect 持续返回同一网络 ID，network rm 返回 active endpoints，同时确认 helper 已结束。执行最后一次解绑，检查 502、已清空绑定和未释放 claims。

4. **P1：watchdog 的 bridge-heal 仍绕过共享代理互斥，并丢弃未知结果。**

   位置：[src/lib/transport/kernel-watchdog.mjs:220](https://github.com/liubing0806/vm2api/blob/66a580de17670a954638fbfb46fee25740adab78/src/lib/transport/kernel-watchdog.mjs#L220)、[src/lib/vm/slot-recovery.mjs:625](https://github.com/liubing0806/vm2api/blob/66a580de17670a954638fbfb46fee25740adab78/src/lib/vm/slot-recovery.mjs#L625)。

   这是必要基线调用链中的遗留遗漏，本次新增互斥仍未覆盖。

   触发条件：watchdog 启用；运行中的本地 SOCKS VM 被判断为 helper 不存活。

   调用链：`tick:349` → `healBridgesOffPath` → `createSlotBridgeHealer` → `ensureProxyEgress`。该路径只有 `kernel_bridge_heal` 后台任务，没有 pool claim 或受影响 VM claims。`slot-recovery.mjs:650` 得到失败结果后只记录日志，丢弃 `vmOperationUncertain`；watchdog 第 226 行始终返回 `terminal:true`。

   影响：修复可以与已有 VM operation 或代理配置变更重叠。新增的 egress 身份检查即使返回未知，后台任务也会结束，无法继续阻止维护或重复修复。单活动控制面不能消除同进程中的并发。

   最小修复：首次副作用前取得 pool 和受影响 VM claims，并传递未知结果。

   交主会话复现：预先持有 VM operation，再触发 bridge healer，断言 egress 启动调用次数应为零。另令启动返回 `{ok:false,vmOperationUncertain:true}`，断言后台任务和 activity 应保持未知。

首轮五项核对如下。状态仅代表源码证据，不代表测试通过。

| 首轮项目 | 状态 | 证据与回归 |
|---|---|---|
| NUL 请求日志导致 PG 持久失败 | 原问题已修正 | `request-log.mjs:588` 在 summary 入库前转义全部字符串字段；debug 通过 JSON 序列化写入文本。新增测试覆盖拒绝请求、后续查询和备份，但本轮未运行。 |
| monitor 初始 SQL 先于 activity | 指定路径已修正 | credential、health、usage 配置读取先进入独立 activity；VM schedule 的 discovery 和 prepare 也已包裹。 |
| manual bootstrap 原始 Promise 未独立跟踪 | 跟踪已修正，完成判定仍有遗漏 | `official-cc-bootstrap.mjs:1506` 跟踪原始 job，独立取得 activity 和 VM claim，并纳入 shutdown flush；发现 1、2 仍影响未知执行保留。 |
| package 首次文件写前未取得 VM 互斥 | 首次写入问题已修正 | PUT 在 `panel-routes.mjs:4145` 取得 claims；POST 固定目标 ID，在第 4240 行取得 claims，并检查持久记录及物理 alias，避免改名后越出已持有身份。启动后的问题见发现 2。 |
| proxy 面板入口未取得 pool/VM claim | 主要入口已修正，存在清理回归及旁路 | `mutateProxyVms:676` 先取得 pool claim，再刷新绑定并取得 VM claims。正常清理回归见发现 3；后台旁路见发现 4。 |

本轮核对的提交为 **`66a580de17670a954638fbfb46fee25740adab78`**，增量为 `0ffae4b04c2429f472bef5a42add4a00a1ed7fcc..HEAD`。开始和结束时 HEAD 一致，工作树无改动。

已覆盖共享熔断的事务锁、跨控制面累计、重复结果、代次重置，以及当前执行 hook、job 完成和 admission 释放顺序。按静态调用链未发现额外问题。也检查了 fleet、artifact、metadata 入口的 claims、物理 alias、HTTP 返回后的活动，以及全局维护对未完成业务 claims 的检查。

节点 restricted launch、Claude terminal parser 和 command-status 已检查持久顺序及 fence/ticket 身份约束。文档明确说明 KSG2 尚未接生产客户端和 PG；未将该后续能力或已提交测试规格视为已交付功能。`ControlPlaneLock` 和 `replicas: 1` 均仍保留。

本轮未运行任何测试、服务或外部操作。真实 PG 并发、Docker 端点、远端命令退出及 restore 时序均未动态验证。以上复现步骤交主会话执行，**本报告不批准发布**。
