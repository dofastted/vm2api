本增量未发现可证的新增 P0/P1/P2。上一轮 P1 在指定的首次 prepare 失败场景下，源码已修正。动态行为未验证，本审查不批准发布。

已核对 HEAD 为 `e9076922a4af1f43840e6f9db8381790c809ee21`，增量基线为 `08a182870b6334691a114c7b93a0f07032588ff7`。审查前后工作区均干净。

**上一轮 P1 复核**

- **完成证明范围正确。** `execCollect` 等待 channel close 后返回；`runRemote` 仅为安全整数非零退出码附加 `remoteCommandEnded`。只有首次 `prepareRemoteDir` 失败，且两种 uncertainty 标记均无矛盾时，才附加 `publicationFinished`。后续 SFTP 错误不会经过该赋值处。[ssh-link.mjs:149](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/cluster/ssh-link.mjs#L149)、[remote-fs.mjs:115](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/cluster/remote-fs.mjs#L115)、[remote-slot-files.mjs:95](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/cluster/remote-slot-files.mjs#L95)
- **unknown 不会被完成标记覆盖。** queue 保留矛盾标记；supervisor 等待所有 publication，并优先抛出 unknown 失败；protocol 两处均检查完成标记及 uncertainty。[remote-slot-files.mjs:231](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/cluster/remote-slot-files.mjs#L231)、[supervisor.mjs:825](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/transport/rust-kernel-supervisor.mjs#L825)、[protocol.mjs:1082](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/protocol/handle-protocol.mjs#L1082)、[protocol.mjs:1362](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/protocol/handle-protocol.mjs#L1362)
- **资源释放链符合该场景。** fleet sync 失败发生在 API key 预约之前。touch 的确定准备失败发生在真实 FailoverRunner 调用后端之前，不会标记执行未知，`finally` 会等待释放执行预约。protocol 正常返回错误结果后释放 key；HTTP 外层转换异常为响应，再等待响应及持久化完成请求活动。unknown 分支仍保留对应资源。[runner.mjs:956](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/pool/failover-runner.mjs#L956)、[runner.mjs:1166](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/pool/failover-runner.mjs#L1166)、[runner.mjs:1306](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/pool/failover-runner.mjs#L1306)、[protocol.mjs:485](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/protocol/handle-protocol.mjs#L485)、[server.mjs:1242](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/server.mjs#L1242)、[server.mjs:1452](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/server.mjs#L1452)

**其他已覆盖项**

- 内存非法值及 KVM 校验在 Docker I/O 前返回 `vmOperationNotStarted`；Standalone 异常路径不再无条件访问数据库而覆盖原错误。[memory.mjs:180](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/vm/docker-slot-memory.mjs#L180)、[panel-routes.mjs:656](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/admin/panel-routes.mjs#L656)
- schedule 仅忽略 discovery 回调开始前的维护准入拒绝；已 admitted 的错误仍向上传播并记录 failure。[vm-test-schedule.mjs:380](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/src/lib/admin/vm-test-schedule.mjs#L380)
- Codex unit 新增数据库初始化入口、异步等待及 SQL 读回，没有放宽原断言。harness 的 loader 仅在测试子进程加载；策略函数继续引用源码，Docker/egress 使用替身，geo 返回不可用。[harness.mjs:122](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/test/harness.mjs#L122)、[mock-runtime.mjs:1](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/test/fixtures/mock-gateway-runtime.mjs#L1)
- DNS helper 使用独立临时目录，清理按该 fixture 的代理配置和执行收据确认身份。[egress.test.mjs:543](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/test/unit/egress.test.mjs#L543)

**未验证边界**

本轮未运行测试或任何服务。六个 publication 场景使用真实 runner 和共享预约，但发布入口、scheduler、后端及活动完成动作仍由 fixture 控制，不能作为整条生产调用链的动态证明。[fixture:25](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/test/fixtures/protocol-publication.mjs#L25)、[fixture:204](https://github.com/liubing0806/vm2api/blob/e9076922a4af1f43840e6f9db8381790c809ee21/test/fixtures/protocol-publication.mjs#L204)

主会话若补动态证据，应使用临时测试数据库及合成 SSH/SFTP，连接未替换的发布入口，分别验证：

1. 首次 prepare 非零退出并 close：SFTP、模型调用均为零，预约释放、请求活动完成。
2. 缺失 close、后续 SFTP 失败或完成标记与 unknown 矛盾：资源保留。
3. 多节点“确定失败＋unknown”：等待全部结果，聚合结果保持 unknown。

`ControlPlaneLock`、`replicas: 1`、`Recreate` 均保留。本结论不覆盖其他 worktree 的 Go publish/new grant，也不证明高可用或生产能力已启用。