# PostgreSQL 迁移实施与验证

日期：2026-10-21。分支：`codex/postgresql-migration`。

运行数据库已改为 PostgreSQL 17。异步数据访问、业务调用链、离线导入、新备份恢复、部署配置和数据库页面已实现。未推送分支，未对现有部署执行数据迁移、配置变更、重启或发布。

原始提交：`eee8f6ecb6ca04455e6edef0c8e498fb3be21f21`。运行代码提交：`6aa877de`，测试隔离提交：`3054bfa0`。完整 SHA 见随附 [验证摘要](evidence/postgresql/verification.json)。后续文档提交不改变被验证的运行代码。

## 实现范围

- `pg.Pool`、原生 `$n` SQL、固定事务连接、savepoint、迁移互斥和校验和。PostgreSQL 建立独立基线；SQLite 的 41 个历史迁移保持原样。
- repository、用户与密钥、请求日志、计费统计、调度、集群、VM 镜像和面板调用均适配异步访问。同步调度使用已初始化的工作集，写入按序排队，维护和退出前排空。面板在写入成功后发送 JSON 响应。
- 64 位累计整数在安全范围内返回 Number，超范围返回精确十进制字符串。已失精的 Number 被拒绝。金额、平均值、比例保留原浮点语义。保留现有合法小数权重和端点优先级。
- 旧 SQLite 通过只读连接取得一致性快照，只在私有副本升级历史版本。空目标检查、逐表摘要、历史表、运行时表、密文、sequence 高水位和完成标记在同一导入事务内处理。
- PG custom dump 使用导出快照，VM/配置文件在相同暂停写入窗口复制。恢复验证文件摘要、路径及数据库对象范围，以单事务恢复本应用 schema，重新加载内存状态。失败保留维护状态和持久标记。
- Compose 支持内置或外部 PostgreSQL。应用角色没有超级用户、建库、建角色或复制权限。两种控制面 Dockerfile 安装 PG 17 客户端。升级在替换旧容器前检查连接、版本、已应用迁移前缀、校验和和旧数据导入标记。

SQLite 只保留在离线迁移、旧备份转换和历史 fixture 中。运行入口不再依赖 SQLite，也不提供双写或降级路径。

VM 数据库记录保留元数据及凭据存在标记。活凭据仍位于既有槽位和 CLI-home 存储中。顶层 JSON 备份及数据库导入不能替代这些目录；切换时必须保留原目录和业务加密密钥。

## 验证结果

测试只使用本任务创建的 PostgreSQL 17.11 和合成数据。没有读取现有部署的连接或业务数据。

| 检查 | 被验证提交 | 实际结果 |
| --- | --- | --- |
| 全量单元测试 | `4ad444d7` | 281 文件；3325 通过、7 失败、10 跳过。2 个失败文件的 7 个断言与原始提交相同 |
| 全量端到端测试 | `3054bfa0` | 26 文件；96 通过、17 失败、1 跳过。11 个失败文件的 17 个断言与原始提交相同，无清理超时 |
| 测试隔离与恢复范围 | `3054bfa0` | 驱动、导入、备份核心/服务/E2E 共 40/40，通过实际恢复确认相邻 schema 的后续写入保留 |
| Node 22 容器兼容性 | `4ad444d7` | 93/93 通过，覆盖驱动、SQLite 导入、大整数、账号额度和重启持久化 |
| 前端测试、构建及格式 | `4ad444d7` | 60 文件、473/473 测试通过；TypeScript/Vite 生产构建和格式检查通过 |
| Go | `4ad444d7` | worker 与 api-kernel 的 race 测试通过 |
| 部署配置 | `4ad444d7` | Python 25/25；PostgreSQL 业务角色的实际认证、DDL 和权限拒绝检查通过 |
| 语法与格式 | `4ad444d7`，末次维护改动另查 | Node source/scripts 语法、Biome、Shell、前端格式及 `git diff --check` 通过 |
| amd64 控制面镜像 | `6aa877de` | 构建通过；实际容器 HTTP、PG 指标、密钥写入、备份和恢复后内存状态检查通过 |

Node 22、前端、Go 和部署检查后的运行代码只增加普通维护提示修正；该修正由最终端到端测试、独立维护时序复现及最终镜像验证覆盖。

全量测试仍有原始提交的失败。独立原始 checkout 使用相同预编译 payload 和测试依赖重跑，并逐项比较测试名称和断言正文。详细清单见 [基线对照](evidence/postgresql/baseline-comparison.json)。没有把这些失败改为跳过或通过，也没有为本次数据库迁移修改相关业务行为。

失败输出示例（两份源码结果相同）：

- `cli-hop-body.test.mjs:34`：实际 `ttl='1h'`，预期 `undefined`。
- `convert-cache-shape.test.mjs:155`：实际 `{type:'ephemeral', ttl:'1h'}`，预期 `{type:'ephemeral'}`。
- `auto-mode.e2e.test.mjs:608`：实际 thinking 包含 `display:'summarized'`，预期对象没有该字段。
- `account-pool-failover.e2e.test.mjs:66`：`TypeError: Cannot read properties of undefined (reading 'account_id')`。

第一次最终 E2E 在 `4ad444d7` 有 12/26 文件失败、94 通过、19 失败、1 跳过。其中两项慢代理场景在绑定结束后立即收到 503。独立复现确认：绑定耗时约 10–16 秒，5 秒启动备份定时器进入维护并等待绑定完成；后继请求短时拒绝，约 52–54 毫秒后恢复 200。禁用自动备份时同链请求全部 200。这两项业务 fixture 已显式禁用无关后台备份；独立自动备份 E2E 仍使用默认开启设置。

后续全量 E2E 的 5 个备份场景全部通过，但文件清理的 `DROP DATABASE` 等待 PostgreSQL 全实例 checkpoint 超过测试文件 90 秒限制。只读采样为 `IPC/CheckpointDone`、无阻塞连接；独立复现主体 487 毫秒、进程清理总耗时约 109 秒。测试现统一使用专用 `_test` 基库内的独立 schema，移除建库/删库及 CI 的 checkpoint 参数调整。生产恢复始终限定 schema。修正后相关 40 场景 9.8 秒结束。

新增回归先于修复独立提交，覆盖异步集群编辑、平台持久化、日志清理、整数精度、面板处理返回值、小数导入、定时探测结果写入，以及备份调度关闭竞态。

测试进程的完整日志保留在本地忽略目录 `.tmp/pg-evidence/`。关键文件为 `unit-final.log`、`e2e-complete.log`、`schema-isolation-final.log`、`node22-final.log`、`image-smoke-final.log` 和 `docker-build-final.log`。摘要和页面对照图随分支提交，不包含连接信息或凭据。

## 镜像与页面证据

最终实际运行镜像 ID：`sha256:d93e36d953db42aa80acd562a2af63cf0a969789d154d063610c0e6e060dc33e`。本地标签：`vm2api:pg-migration-check`。容器内版本为 Node `v22.23.2`、`pg_dump` / `pg_restore` `17.11`。临时容器没有挂载现有数据或宿主 Docker socket，验证结束后删除。

本机没有 buildx。使用旧 builder 时，只在临时 Dockerfile 顶部补 `ARG BUILDPLATFORM=linux/amd64`，其余构建指令与仓库 Dockerfile 相同。首次默认网络的 Go 依赖下载超时；使用 host 构建网络重试成功，未修改依赖版本或现有网络配置。

数据库页面复用既有组件和样式，用合成数据在 1440×900 窗口对照。用户已授权独立 Playwright。

| SQLite 基线 | PostgreSQL 实现 |
| --- | --- |
| ![SQLite](evidence/postgresql/database-sqlite-1440.png) | ![PostgreSQL](evidence/postgresql/database-postgresql-1440.png) |

## 操作入口与限制

部署与切换步骤见 [PostgreSQL 部署说明](../deploy/postgresql.md)。连接和原业务加密密钥通过受控环境提供，不能放到命令参数或报告中。

```sh
npm run db:import:sqlite -- --source <snapshot.db>
npm run db:convert:sqlite-backup -- --source <old.db.gz> --output <new.tar.gz> --vm-dir <vm-snapshot> --config-dir <config-snapshot>
```

导入目标必须为空。转换旧备份使用专用空转换库，不能指向运行库。旧 `.db.gz` 缺少 VM 和配置文件，需要对应快照。目标开始接受新写入后，原 SQLite 不再是可直接切回的最新副本。

ARM64 的 Dockerfile、部署脚本、配置测试和 CI 冒烟入口已更新；本机未执行原生 ARM64 镜像构建及运行。现有环境的数据规模、停服切换、实际槽位凭据、真实外部上游、生产备份恢复和发布均未验证。
