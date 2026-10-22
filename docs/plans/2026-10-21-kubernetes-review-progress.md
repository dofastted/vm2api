# Kubernetes 独立审查与定向验证（#648，进行中）

本报告前五轮记录单实例基础阶段的固定源码结果，不作为后续 HA 验收。显式 `kubernetes-ha` 和独立双节点部署验证已在后续增量加入，默认 `kubernetes` 清单仍为单实例。已发布的 Draft PR #651 仍为早期提交；后续本地实现尚未推送。

## 全量检查

固定源码 `0ffae4b04c2429f472bef5a42add4a00a1ed7fcc` 在独立源码归档检查：

| 检查 | 文件 | 测试数 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: | ---: |
| unit | 342 | 3932 | 3915 | 7 | 10 |
| E2E | 30 | 127 | 109 | 17 | 1 |

全部失败名称和规范化断言摘要与 `6732a864` 的记录一致。没有将这些失败改为通过或跳过。该全量结果不覆盖之后的源码修复。`6732a864` 的单节点部署镜像也不包含后续增量。

## 独立会话审查

五轮审查均使用单独 Codex CLI 会话和固定 detached worktree。审查会话只读源码、测试、文档与 Git 对象，没有执行测试或访问部署环境。主会话另行动态复现并验证修复。

首轮源码为 `0ffae4b0`，独立会话为 `01a15ee0-3324-7490-928c-8343beb13b5e`。发现 4 项 P1、1 项 P2。对应失败规格和定向修复如下：

| 问题 | 失败规格 | 修复或验证提交 | 定向结果 |
| --- | --- | --- | --- |
| NUL 摘要使 PostgreSQL 日志写入失败 | `97e00cf3` | `1c034cc6` | 工作区日志 unit/E2E 56/56 |
| 后台监控启动后没有有效数据库活动 | `04a016b2` | `f666c923` | 固定提交 96/96 |
| 初始化后台原始 Promise 未单独跟踪 | `3e5b3b1a` | `3304c452` | 固定提交 85/85 |
| 包导入首次文件写入前未取得 VM 互斥 | `2a58a9e9` | `4fed2928` | 固定提交 83/83 |
| 代理面板入口未取得共享池和 VM 操作声明 | `2ebc3f42` | `b9fc7462` | 固定提交 107/107 |

NUL 问题动态复现得到 PostgreSQL `22021`。修复恢复依赖分支已有的摘要转义，debug JSON 保留原始内容。其测试是工作区定向检查，不能称为整个 `1c034cc6` 的独立归档验证。

第二轮源码为 `66a580de17670a954638fbfb46fee25740adab78`，独立会话为 `01a15f03-648a-7d92-bf3d-f4d20d4cf03e`。复核了首轮修复，另发现 4 项 P1：

- 初始化 `/usage` 重试覆盖前一次未知执行。
- 包启动和凭据导入没有统一处理初始化的辅助操作未知结果。
- 已有容器端点的代理网络清理可能长期保留整个代理池声明。
- watchdog bridge 修复没有取得共享代理/VM 互斥，且丢弃未知结果。

这 4 项已完成定向修复：初始化 `d2b62208` 为 118/118；代理清理 `d824fa2a` 为 58/58；watchdog 及协议观察 `befd24d1` 为 72/72。本报告不将定向结果称为最终审查通过。原始发现及静态审查边界见 [首轮报告](evidence/kubernetes/review-progress/independent-review-0ffae4b0.md) 和 [第二轮报告](evidence/kubernetes/review-progress/independent-review-66a580de.md)。

第三轮源码为 `068919906653acf0e6dd0f749f83cb808f9f36f1`，独立会话为 `01a15f1a-0084-78a2-917f-2792725bceea`。审查发现 5 项 P1。嵌套 VM 操作未知结果、手动 Codex 刷新和明确未开始的繁忙拒绝，分别由审查开始后的 `34854048`、`12088dde` 和 `2065da50` 修正。已结束的包初始化普通失败在 `da7700bd` 修正，95/95 通过。worker 内部刷新重试覆盖先前未知结果在 `08a18287` 修正，Go race 与 Node 52/52 定向检查通过。见 [第三轮报告](evidence/kubernetes/review-progress/independent-review-06891990.md)。

第四轮源码为 `08a182870b6334691a114c7b93a0f07032588ff7`，独立会话为 `01a15f31-9c1b-77e1-bbee-e2941606450d`。逐项复核第三轮 5 项指定触发路径已修正，新增 1 项 P1：首次远端目录准备已取得退出码及通道关闭，仍被发布队列和协议标为未知。远端证明传播在 `04dde1cd` 修正，固定源码 94 项通过、2 项平台跳过；协议两处分类和真实准入验证仍在进行。见 [第四轮报告](evidence/kubernetes/review-progress/independent-review-08a18287.md)。

`08a18287` 的后续全量结果：unit 368 文件、4182 项，4159 通过、13 失败、10 跳过；E2E 31 文件、130 项，110 通过、19 失败、1 跳过。原 7 项 unit、17 项 E2E 的规范化断言与 `0ffae4b0` 一致。新增 6 项 unit、2 项 E2E 已分别复现，涉及测试数据库初始化、未启动的内存校验、备份调度拒绝和测试 Docker 隔离。修正提交为 `f011a227`、`68d2b54d`、`43076583`、`f9f396dd`，均有定向检查；仍需新的全量检查。该源码的 Go race 为 190 通过、1 辅助跳过，vet、gofmt、733 文件格式检查和 323 文件语法检查通过。

第五轮源码为 `e9076922a4af1f43840e6f9db8381790c809ee21`。独立会话未发现新增 P0/P1/P2，复核了首次准备已结束和 unknown 优先的释放链。真实 runner、双 PG 连接、请求活动及远端发布相关 103 项中，101 通过、2 项平台跳过。fixture 的发布入口和后端仍受测试控制，不等于整条生产 SSH 调用链验收。见 [第五轮报告](evidence/kubernetes/review-progress/independent-review-e9076922.md)。

该源码全量 unit 为 369 文件、4201 项，4183 通过、8 失败、10 跳过；E2E 为 32 文件、131 项，113 通过、17 失败、1 跳过。原 7 项 unit、17 项 E2E 的规范化断言仍一致。新增 1 项 unit 期待调度发现的维护准入拒绝抛出异常；`60d63596` 更正为验证零发现读取、零回调、零 job、零 claim 且无持久化失败，相关 8 项通过。该源码 Go race 为 190 通过、1 辅助跳过；vet、gofmt、735 文件格式检查、302 个 `src` MJS 语法检查通过。之后的节点发布、命令授权和 HA 接线未包含在该全量结果中。

## 后续固定源码检查

- `f4a685b98f31d467b6a2c8c5a8b7cf7749bf15c5`：watchdog 共享恢复预算、故障准入及相关回归 99/99。
- `bf7615f8be9adf4f569c2a7d802be514a4c58e64`：共享熔断及原准入、面板、备份和重试 142/142。失败次数在 PostgreSQL 累计；半开状态的探测绑定持久 admission；未知结果不随时间释放；旧结果不能覆盖重置后的代次。
- `e1e5d2a9e6cea391fb96aacc6b0757fa3ad0360f`：KSG2 客户端、PG 绑定及相关回归 156/156。实际 Go gate、合成 Unix kernel 与两条 PG 连接验证：正常持久完成后可释放；内部错误仍保留。发送前绑定原 Fence；响应后另取原 ticket 的节点持久完成状态。绑定新 job 与凭据刷新 VM 操作使用同一资源锁。
- `34854048`：私有 PG 节点管理授权及初始 allocate，Node 63/63；Go race 182 通过、1 辅助跳过；Darwin 编译通过。受限节点角色只读授权，操作结束或未知时撤销 grant；未授权管理 RPC 默认拒绝。尚未接真实 VM 创建及节点文件发布。
- `06891990`：共享刷新接线 251/251；`2065da50` 的明确未开始修正 166/166。新增账号互斥持久记录，表数为 42，业务迁移为 18。私有节点授权不属于业务备份恢复范围。
- `c05da6f2`：远端发布原始 Promise 等待，203 通过、2 平台跳过。协议两处补充接线见 `63e641b5`；新的合成测试在此前源码上分别复现继续选择 VM、调度提前开始和发布拒绝被吞。修正后持久准入及两处协议等待的 3 项检查通过。

定向协议检查使用专用测试 PostgreSQL、合成请求、模拟节点或测试自己的子进程。KSG2 集成使用合成 executor 身份，没有调用真实 Docker Engine；它不能证明可信启动或权限隔离。旧 E2E harness 的 mock gateway 仍会创建真实本机 Docker 网络，已在 `f9f396dd` 隔离；此前资源按精确 fixture、network ID、无端点和无 helper 证据核对后，仅删除 10 个测试网络。6 个带业务端点的网络和 3 个固定名网络保留。生产 capability 来源、节点文件发布和管理授权、多节点运行及故障接管仍在实现。旧预编译 payload 继续复用。

结构化统计、日志摘要与边界见 [验证证据](evidence/kubernetes/review-progress/verification.json)。已精确删除 9 个完成检查的 root 工作树或源码副本；另有固定检查脚本自行清理的目录。专用 PostgreSQL 与共享 Go 缓存在后续验证结束前保留。没有修改生产环境。

## HA 增量的独立审查

第六轮审查源码 `a6b67f3b664cb2616cd43aa053f20bcc8fac2f2f`，读取 95 文件增量。发现 1 项 P1、2 项 P2，分别涉及配置刷新重启旧 monitor、Responses 500 回归和旧 attempt 被清理。已用实际 PG/HTTP 复现并修复，见 [第六轮报告](evidence/kubernetes/review-progress/independent-review-a6b67f3b.md)。

第七轮审查源码 `ceb2775221fb73549e542855356073bacf8e54a8`，独立会话 `01a15f94-f885-7b82-b9b0-879ec03faf2d`，读取 79 文件增量。发现 2 项 P2：明确未发送的刷新 grant 占用 generation；派发前取消的非空临时 command ID 导致计费预约保留。已分别通过真实 PG/TLS 和正常 handler 失败规格修复，见 [第七轮报告](evidence/kubernetes/review-progress/independent-review-ceb27752.md)。该轮没有覆盖后来的 bootstrap CLI、恢复扫描监控器和滚动终止修复。

后续同行审查另复现 allocation pin 拒绝的未开始处理，以及扫描进程 SIGKILL 留下 activity 的问题。两项均已完成针对性修复。滚动更新测试还复现了已接受 SSE 的 keep-alive 连接在排空后持续复用。`f53e005f` 修正后，独立进程的完整 SSE 和正常退出检查通过；专用 k3d 的滚动期间 25 次业务请求均为 200，采样可用副本数至少为二。

第八轮审查源码 `f53e005f`，独立会话 `01a15fb1-f02a-7761-9bf2-7cdaa751f3aa`，读取 27 文件增量。新增 2 项 P2：初始化 CLI 接受保留 VM ID，以及节点初始化隐式迁移业务 schema。`48aa2a28` 修正，相关固定源码检查 50/50。见 [第八轮报告](evidence/kubernetes/review-progress/independent-review-f53e005f.md)。

第九轮审查源码 `48aa2a28`，独立会话 `01a15fc4-4eb3-72f3-a643-07fd87e6f797`，复核上述修复。新增混合大小写 schema 被 `to_regnamespace` 折叠小写而错误拒绝的 P2；实际 PG 失败规格 `9ae50abd` 先于一行修复 `ff4e4348`。见 [第九轮报告](evidence/kubernetes/review-progress/independent-review-48aa2a28.md)。

多副本实现、固定源码检查、既有全量失败及运行镜像的具体证据，见 [HA 验证记录](2026-10-22-kubernetes-ha-verification.md)。此处保留早期记录的历史范围，不把早期单实例结果替换为 HA 验收。

第十轮审查源码 `ff4e4348`，独立会话 `01a15fc9-6ab0-7da1-98e3-a3a61d0fe2e9`，确认混合大小写修复，未发现新增可证 P0/P1/P2。主会话的固定归档 CLI/数据库检查为 25/25，779 文件格式检查通过。见 [第十轮报告](evidence/kubernetes/review-progress/independent-review-ff4e4348.md)。
