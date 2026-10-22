发现 **2 项新增 P2**，未发现可证的新增 P0/P1。

1. **P2：CLI 接受保留 VM ID，创建后导致整个 HA catalog 不可用。**  
   [scripts/ha-node-bootstrap.mjs:111](https://github.com/dofastted/vm2api/blob/f53e005f4794782b0a8e0b4bb152f68d4a3a7aa0/scripts/ha-node-bootstrap.mjs#L111) 仅检查字符格式，允许 `active`、`create`、`*-chat` 等现有保留名称。三个节点操作成功后，这些 ID 会写入 `vms`。随后 [ha-vm-catalog.mjs:26](https://github.com/dofastted/vm2api/blob/f53e005f4794782b0a8e0b4bb152f68d4a3a7aa0/src/lib/vm/ha-vm-catalog.mjs#L26) 因 `isValidVmId()` 拒绝记录而清空 catalog；[server.mjs:1373](https://github.com/dofastted/vm2api/blob/f53e005f4794782b0a8e0b4bb152f68d4a3a7aa0/src/server.mjs#L1373) 每次业务请求都会刷新，因此影响已有正常槽位的请求。  
   最小修复：配置校验同时调用现有 `isValidVmId()`，在任何节点操作前拒绝。  
   主会话合成复现：将 bootstrap fixture 的 `vm.id` 改为 `active`，完成 `slot-create` 后调用 `HaVmCatalog.refresh()`，检查 `ha_vm_catalog_unavailable`。修复后应在签发 grant 前拒绝，且节点调用数为零。

2. **P2：`trusted-init` 隐式迁移业务 schema，超出 private DDL 范围。**  
   [scripts/ha-node-bootstrap.mjs:360](https://github.com/dofastted/vm2api/blob/f53e005f4794782b0a8e0b4bb152f68d4a3a7aa0/scripts/ha-node-bootstrap.mjs#L360) 调用 `createDatabase()`，经 [database.mjs:277](https://github.com/dofastted/vm2api/blob/f53e005f4794782b0a8e0b4bb152f68d4a3a7aa0/src/lib/db/database.mjs#L277) 执行并提交全部待应用业务迁移。reader 角色检查发生在此后。目标 schema 落后时，即使命令随后返回 `bootstrap_reader_invalid`，业务表和迁移记录也已经改变；不存在的 schema 还会被自动创建。  
   最小修复：CLI 使用不自动迁移的连接初始化，只读核验业务迁移版本，不满足前提则拒绝，再执行授权的 private DDL。  
   主会话合成复现：在任务专用 DB 建立仅应用到 `020` 的 schema，配置不存在的 reader，执行 `trusted-init`；检查失败后 `021` 及其业务字段是否已提交。

已完整读取 27 个文件的增量，并核对相关 grant、私有 SQL、节点 reader 锁、owner lifetime、epoch、计费父锁、扫描恢复及 server/Kustomize 调用链。上轮两项 P2 的修复约束在源码中可见，其余审查范围未发现可证新增 P0/P1/P2。

审查 SHA：`f53e005f4794782b0a8e0b4bb152f68d4a3a7aa0`；基线：`ceb2775221fb73549e542855356073bacf8e54a8`。开始与结束时工作区均干净。

以上为静态结论，合成复现未执行。未修改文件、运行测试或服务，也未访问网络、数据库、容器或其他 worktree。新镜像 K8s keepalive 复验及实际 provider RT 刷新仍未验证。本审查不构成发布批准。
