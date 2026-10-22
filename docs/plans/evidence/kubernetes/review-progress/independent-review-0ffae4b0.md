发现 **4 项 P1、1 项 P2**。以下结论来自静态调用链；复现步骤交由主会话执行，本轮未运行。

**1. P1：NUL 字符可使请求日志失败，并持续阻断面板查询和备份**

位置：[src/lib/admin/request-log.mjs:588](https://github.com/liubing0806/vm2api/blob/0ffae4b04c2429f472bef5a42add4a00a1ed7fcc/src/lib/admin/request-log.mjs#L588)

- **触发条件**：日志模式为 normal 或 debug，已认证请求的 `model` 包含 JSON 转义字符 `\u0000`。
- **现象及影响**：PostgreSQL 拒绝写入包含 NUL 的文本。错误随后被进程级持久化状态保留，后续面板 GET 和备份持续失败。Kubernetes 模式还会留下不确定活动记录。
- **依据**：`src/lib/protocol/handle-protocol.mjs:631`、`:632` 将原始模型名写入日志字段，`:583` 注册响应结束后的持久化。候选删除了 BASE 中的 NUL 转义，直接执行日志插入。`src/lib/db/pending-writes.mjs:10` 保留首次错误，`:19` 在每次 flush 时重抛。`src/lib/admin/panel-routes.mjs:1226` 的面板 GET 必经该 flush。`src/server.mjs:1243` 同样调用它，并在失败后将活动标记为不确定。
- **建议最小修复**：恢复摘要字符串字段的 NUL 转义，保留调试正文的原始 JSON 内容。恢复本次删除的对应回归测试。
- **最小复现**：使用隔离测试数据库和模拟推理发送 `model: "invalid\u0000model"`。随后查询请求日志、API key 列表并创建备份。检查日志插入错误及后续 flush 持续失败。BASE 中已删除的 `NUL-containing rejected requests preserve panel queries and backups` 测试可直接作为复现依据。

**2. P1：后台监控在取得活动准入前查询数据库，启动后无法正常执行**

位置：[src/lib/oauth/credential-refresh-monitor.mjs:117](https://github.com/liubing0806/vm2api/blob/0ffae4b04c2429f472bef5a42add4a00a1ed7fcc/src/lib/oauth/credential-refresh-monitor.mjs#L117)、[src/lib/admin/vm-test-schedule.mjs:660](https://github.com/liubing0806/vm2api/blob/0ffae4b04c2429f472bef5a42add4a00a1ed7fcc/src/lib/admin/vm-test-schedule.mjs#L660)

- **触发条件**：Kubernetes 模式正常完成启动，随后启动监控或触发定时器。
- **现象及影响**：凭据刷新、健康探测和用量探测在进入实际任务前失败。定时测试调度器的初次加载失败，因而不会安装后续发现定时器。
- **依据**：`src/server.mjs:1704` 先完成 bootstrap 活动，`:1709` 才调用定时测试调度器的 `start()`。凭据监控在调用 `sharedTasks.run()` 前执行 `routing.refresh()`；健康监控的 `src/lib/admin/health-probe.mjs:826`、用量监控的 `src/lib/oauth/usage-probe-monitor.mjs:316` 存在相同顺序。调度器在 `:660` 直接读取计划，`:712` 也在任务准入前刷新设置。这些查询进入 `src/lib/db/database.mjs:93` 后，由 `src/lib/db/global-maintenance.mjs:371` 拒绝已关闭或缺失的活动作用域，错误码为 `maintenance_activity_closed`。
- **建议最小修复**：后台入口在首次数据库访问前取得独立活动准入。覆盖计划发现、配置刷新和 cron 回调的准备阶段。
- **最小复现**：在合成 fixture 中初始化共享路由和协调器，完成初始化活动。退出该活动作用域后调用上述监控的执行方法及 `VmTestScheduleRunner.start()`。回调使用计数器代替外部操作。检查执行前的 `maintenance_activity_closed`，以及回调计数仍为零。测试不能一直包在 `withDatabaseActivities()` 内，否则会掩盖问题。

**3. P1：手动 Claude Code 初始化任务未被排空跟踪，可在恢复后继续产生副作用**

位置：[src/lib/admin/panel-routes.mjs:3960](https://github.com/liubing0806/vm2api/blob/0ffae4b04c2429f472bef5a42add4a00a1ed7fcc/src/lib/admin/panel-routes.mjs#L3960)

- **触发条件**：调用 `POST /api/panel/vms/:id/official-cc-bootstrap`，任务停留在异步 CLI 或用量请求中。HTTP 响应结束后再执行备份恢复。
- **现象及影响**：任务仍在执行时，请求活动已被标记完成。恢复可以越过该任务，旧任务随后继续修改恢复后的 VM 文件或重新加载槽位。
- **依据**：接口调用 `scheduleOfficialCcBootstrap()` 后立即响应。`src/lib/oauth/official-cc-bootstrap.mjs:1468` 将任务保存到本地 `running` Map，但没有建立独立活动、后台任务声明或 VM 操作声明。`src/server.mjs:1251` 对没有执行记录的请求判定为结束；`:1677` 的维护监控列表和 `:1689` 的 flush 均不等待这个 Map。任务后续在 `src/lib/oauth/official-cc-bootstrap.mjs:1304` 写入指纹，在 `:1328` 调用会写文件并重新加载槽位的遥测初始化。
- **建议最小修复**：为排队任务建立独立活动和 VM 操作声明，保持到任务、持久化及远端结束确认全部完成。维护排空必须等待这些任务。
- **最小复现**：使用合成槽位及假的 Docker、CLI，将 `runTurn` 暂停在 deferred Promise。模拟接口完成并结束请求活动。此时申请维护，检查它是否错误地成功排空。模拟恢复 VM 文件后释放 Promise，检查旧任务是否继续写入文件或调用 reload。

**4. P1：包更新接口绕过 VM 互斥，可在执行占用期间改写凭据**

位置：[src/lib/admin/panel-routes.mjs:3992](https://github.com/liubing0806/vm2api/blob/0ffae4b04c2429f472bef5a42add4a00a1ed7fcc/src/lib/admin/panel-routes.mjs#L3992)、[src/lib/vm/vm-package.mjs:678](https://github.com/liubing0806/vm2api/blob/0ffae4b04c2429f472bef5a42add4a00a1ed7fcc/src/lib/vm/vm-package.mjs#L678)

- **触发条件**：目标 VM 或其物理别名存在未释放执行准入，另一个请求调用 `PUT /api/panel/vms/:id/package`。
- **现象及影响**：接口没有先拒绝占用，而是改写 VM 配置和凭据。后续代理绑定即使拒绝操作，前面的文件修改也已经发生。
- **依据**：接口直接调用 `commitVmPackage()`，没有经过 `mutateVms()` 或 `withVmLock()`。该函数在 `:678` 写 VM 文件，`:688` 写凭据；凭据写入函数位于 `:486`。代理处理直到 `:696` 才执行。接口成功后还可在 `src/lib/admin/panel-routes.mjs:4006` 直接重新加载槽位。以上路径均未查询执行准入，也未取得 VM 操作声明。
- **建议最小修复**：从首次文件修改前取得现有 VM 操作声明，并保持到凭据、代理、运行时更新和持久化结束。占用拒绝必须发生在任何写入前。
- **最小复现**：扩展 `test/unit/panel-vm-shared-mutations.test.mjs` 的 fixture。先为合成 VM 建立执行准入，再提交包含不同合成凭据的包更新，并设置 `packageImportBringUp: false`。断言应返回占用错误且文件不变；当前调用顺序会先改写文件。再使用物理别名重复该场景。

**5. P2：代理管理接口未取得新增要求的 VM 操作声明，空闲状态也会失败**

位置：[src/lib/admin/panel-routes.mjs:5957](https://github.com/liubing0806/vm2api/blob/0ffae4b04c2429f472bef5a42add4a00a1ed7fcc/src/lib/admin/panel-routes.mjs#L5957)、[src/lib/vm/proxy-pool.mjs:518](https://github.com/liubing0806/vm2api/blob/0ffae4b04c2429f472bef5a42add4a00a1ed7fcc/src/lib/vm/proxy-pool.mjs#L518)

- **触发条件**：Kubernetes 模式下，通过正常面板接口给空闲 VM 绑定代理，或修改已经绑定 VM 的代理。
- **现象及影响**：底层抛出 `vm_mutation_claim_required`。正常代理绑定和配置修改失败。该错误没有被面板包装器处理，HTTP 层会返回 500。
- **依据**：代理池在 `src/lib/vm/proxy-pool.mjs:450` 强制校验当前回调持有的 VM 操作声明，`:518` 拒绝未覆盖的目标。面板的绑定 `:5957`、代理编辑 `:5796`、配置更新 `:5753` 都直接调用代理池，没有先取得声明。`src/lib/admin/panel-routes.mjs:6142` 的错误处理列表不包含该错误码。
- **建议最小修复**：面板入口根据权威绑定集合取得现有 VM 操作声明，再调用代理池，并保持到相关运行时副作用结束。保留底层集合复核。
- **最小复现**：使用实际 `ProxyPool` 和合成 VM，确保没有执行占用或 VM 操作声明。通过 `createPanelHandler()` 调用代理绑定接口。检查其抛出 `vm_mutation_claim_required`。已有 `test/unit/proxy-vm-mutations.test.mjs:40` 覆盖了底层拒绝条件，但没有覆盖面板入口取得声明的过程。

**未验证范围与审查边界**

- 已核对 HEAD 为 `0ffae4b04c2429f472bef5a42add4a00a1ed7fcc`，基线为 `fcd568c92f50103fb3f9694de7dbffc3f238c764`。工作树无未提交改动。
- 重点静态追踪了共享准入、执行释放、会话队列、维护恢复、后台任务、认证一次性状态、VM 物理别名、代理 revision 和管理接口副作用。
- 未逐行穷尽全部 256 个改动文件。未执行测试、启动服务或访问外部环境。上述复现结果仍需主会话动态确认。
- 未独立验证内核二进制内部的执行终止语义。
- 本轮未发现可证实的 P0。未将保留 `ControlPlaneLock`、单副本部署或尚未启用的 node authority/KSG2 后续能力列为缺陷。本审查不构成发布批准。
