发现 **1 个新增 P2**，未发现新增 P0/P1。

1. **P2：大小写混合的业务 schema 被误判为不存在。**  
   位置：[src/lib/db/database.mjs:273](https://github.com/dofastted/vm2api/blob/48aa2a284ab057c2b525d5426c6e7dd1c74a744d/src/lib/db/database.mjs#L273)。配置校验和数据库构造函数均允许大小写混合名称，迁移也使用双引号保留大小写。但这里将原始名称传给 `to_regnamespace`，该函数会将未加双引号的名称折叠为小写。  
   触发条件：已迁移 schema 为 `review_Mixed`，且不存在 `review_mixed`。两个 CLI 命令均经 `main → createDatabase → verifyCurrentMigrations`，在私有初始化或节点动作前错误返回 `database_migrations_not_current`，导致这类已有部署无法初始化或创建槽位。  
   最小修复：第一个参数改为 `quoteIdentifier(db.schema)`，或通过 `pg_namespace.nspname=$1` 精确查询。  
   主会话复现建议：在隔离 PostgreSQL 17 中，经授权迁移流程创建并升级 `review_Mixed`，配置有效 reader 后执行 `trusted-init`。预期成功；按 HEAD 静态路径会被前置校验拒绝。现有新增测试使用小写 schema，未覆盖此条件。

上一轮两项 P2 的原触发路径已通过静态核对：

- reserved VM ID 在 [scripts/ha-node-bootstrap.mjs:113](https://github.com/dofastted/vm2api/blob/48aa2a284ab057c2b525d5426c6e7dd1c74a744d/scripts/ha-node-bootstrap.mjs#L113) 被拒绝，早于数据库、grant 和节点动作。
- CLI 使用 `verifyMigrations: true`。首次核验早于私有协调 schema 初始化，bootstrap 活动内再次核验。CLI 不再应用业务迁移，默认 server 自动迁移分支保留。

已读取全部 4 个文件增量、相关调用链与测试。已核对事务只读设置、迁移锁与维护锁顺序、已有 schema 拒绝路径、并发路径、回滚及连接池清理；除上述问题，未发现其他可证新增 P0/P1/P2。

审查 HEAD：`48aa2a284ab057c2b525d5426c6e7dd1c74a744d`  
增量基线：`f53e005f4794782b0a8e0b4bb152f68d4a3a7aa0`  
首尾 HEAD 一致，工作区干净。

本轮未运行测试或动态复现。提供的 61/61、k3d 和 ELF 验证结果未独立复验；明示 unsupported 范围未计为缺陷。本结论不构成发布批准。
