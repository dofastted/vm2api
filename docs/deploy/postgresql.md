# PostgreSQL 17 部署与 SQLite 导入

控制面只使用 PostgreSQL 17。`VM2API_DATABASE_URL` 优先于 `KIN_DATABASE_URL`。连接失败会阻止 HTTP 启动。`VM2API_DB_SECRET` / `KIN_DB_SECRET` 是已有业务字段的加密密钥，导入时必须保留。

## 新安装

运行 `deploy/install.sh` 会为内置 PostgreSQL 生成随机密码。`docker-compose.yml` 中的 `postgres` profile 默认由 `.env.example` 的 `COMPOSE_PROFILES=postgres` 启用。数据存放在 Compose 的 `postgres-data` 卷。初始化脚本创建 `vm2api` 业务角色，该角色拥有应用数据库，且没有超级用户、创建数据库、创建角色或复制权限。bootstrap `postgres` 密码仅在容器入口随机生成，不与业务密码共用，不写入用户配置或日志。新集群的 TCP 认证使用 SCRAM-SHA-256。端口默认仅映射到宿主 `127.0.0.1:55432`，可通过 `VM2API_POSTGRES_PORT` 修改。Compose 需要支持可选 `depends_on.required` 的版本（2.20 及以上）。

手工使用 Compose 时，先在权限为 `0600` 的 `.env` 中填写 `VM2API_POSTGRES_PASSWORD`。控制面的连接 URL 由 Compose 构造；不要把密码放进命令参数或复制到报告。启动命令仍为 `docker compose up -d`。保留 `vms`、配置、数据目录和数据库卷。

外部 PostgreSQL：在 `.env` 中填写 `VM2API_DATABASE_URL`，清空 `COMPOSE_PROFILES`。控制面使用 host 网络，数据库地址应为宿主可访问地址，不能使用 Compose 服务名 `postgres`。业务数据库应由本应用专用；应用登录角色需要管理应用 schema 的表、索引、函数和 sequence，无需超级用户或创建/删除数据库权限。应用默认 schema 为 `public`。

使用 systemd 直接运行 Node.js 时，在 `/etc/vm2api.env` 中配置连接 URL，并安装 PostgreSQL 17 的 `pg_dump`、`pg_restore` 与 `psql`。`docs/deploy/vm2api.service` 是启动示例。两种控制面镜像均已包含本机架构的 PG 17 客户端。

## 已有 SQLite 安装

现有部署的数据迁移和停服应单独安排操作窗口。先在隔离环境演练，保留 SQLite、文件及原业务加密密钥。

1. 停止接收新请求，停止后台任务并排空在途请求、事务和 VM 文件镜像写入。保持源应用停止，直至切换完成。
2. 使用 SQLite 一致性备份或现有备份归档取得源快照。不要只复制仍在写入的 `kin.db` 主文件而遗漏 WAL。保留整个 `vms` 目录（包括 CLI-home）、`src/config`、`data/backups`，以及既有运行槽位的数据和凭据存储。
3. 准备空的专用 PostgreSQL 17 数据库。在受控进程环境中设置目标连接 URL和原业务加密密钥，执行 `npm run db:import:sqlite -- --source <snapshot.db>`。工具将检查结构、只读源文件、导入事务、内容摘要、外键和 sequence，完成后记录 `settings.sqlite_import_done`。
4. 核对导入清单中的逐表结果与业务合计。原样带回对应的 VM、配置和备份目录。旧备份记录中的绝对文件路径需要与实际保留位置一致。
5. 在新镜像中运行 `scripts/check-postgres-upgrade.mjs` 做只读检查，或通过安装/升级脚本执行该检查。源 `kin.db` 存在时必须查到导入完成标记；同时检查 PG 17 及已应用迁移的版本/校验和。已应用集合须为新镜像迁移序列的非空连续前缀，允许后续新迁移尚未应用。缺表、空记录、未知版本、缺口或校验不一致时不替换运行容器。
6. 切换连接配置并启动新版本。通过登录、正常 mock 或授权业务请求、请求日志、账单、重启与备份恢复验证数据。记录运行镜像 digest 及验证的提交 SHA。

目标接受新写入前，可以停用目标并回到仍保留的源环境。目标接受写入后，原 SQLite 已过时。此时直接切回会丢失目标新增数据，应先设计反向数据处理方案。

旧 SQLite `.tar.gz` / `.db.gz` 归档使用 `npm run db:convert:sqlite-backup -- --source <old.tar.gz|old.db.gz> --output <new.tar.gz>` 转换。该命令会先把源数据导入环境连接指向的数据库，所以目标必须是预建的专用空转换库；不得指向运行库。转换库 schema 必须与最后恢复目标一致，通常为 `public`。旧 `.db.gz` 不包含文件，转换时必须通过 `--vm-dir <目录>` 和 `--config-dir <目录>` 提供对应 VM 与配置快照；旧 tar 归档缺少目录时也必须补充。仅凭脱敏数据库镜像不能恢复活凭据。生成的 v2 归档保留 VM/配置文件及摘要，随后才可在线恢复。在线恢复会返回 `legacy_backup_conversion_required`，避免将 SQLite 文件作为 PG dump 执行。

## PostgreSQL 备份与恢复

新归档仍是 `kin-backup-*.tar.gz`。清单 `version=2`，数据库文件为 `db/postgres.dump`，同时包含顶层 VM JSON、顶层配置 JSON、schema 版本和 SHA-256。文件权限为 `0600`。CLI-home、VM 磁盘和槽位凭据目录继续使用原有存储，迁移时单独保留。归档恢复替换顶层 JSON 范围，保留这些子目录和其他非 JSON 文件。

普通备份先短时暂停写入并排空在途任务，在专用事务中导出 PostgreSQL 快照，同时复制 VM 和配置文件。文件复制完成后恢复写入。worker 使用同一个导出快照执行 `pg_dump`，导出事务一直保留到 dump 完成。

恢复校验外层与内部文件摘要，再检查 `pg_restore --list` 对象目录。恢复只允许本应用 schema 中的已支持对象。`pg_restore --clean --if-exists --no-owner --no-privileges` 生成恢复 SQL，`psql --single-transaction --set=ON_ERROR_STOP=1` 在同一事务内删除快照之外的新增表并执行恢复。事务提交后重新执行后续迁移，新增会话表不会保留快照之后的登录状态。存在其他 schema 的依赖时拒绝删除，不使用 `CASCADE`。此过程不创建或删除整个数据库，也不恢复其他角色的所有权或授权。

恢复期间拒绝新增业务写入，后台任务暂停，所有在途操作排空。恢复前自动创建 `pre_restore` 备份。数据库和文件都恢复后，等待内存 store、路由与调度状态重新加载，再退出维护状态。恢复失败会尝试恢复前快照；失败状态持续保持维护。`data/restore-maintenance.json` 在修改数据库/文件前写入，只有恢复和重新加载成功才删除。进程重启发现该文件时会在迁移或 VM 初始化前拒绝普通启动。进程仍运行时，管理员可以通过原恢复接口显式重试。进程退出后，应在停服状态下使用恢复前归档恢复对应 PostgreSQL、VM 与配置快照，验证一致性后才移除此文件并重新启动。不要在原因未查明时直接删除标记。

`pg_restore --list` 是对象目录预检。恢复行为还需在隔离数据库实际演练。PG dump 不含全局角色。新部署使用目标角色拥有恢复对象。

## 本地与 CI 验证

设置专用 `VM2API_TEST_DATABASE_URL`，数据库名必须以 `_test` 结束，且账号不得访问部署数据。Node 测试通过 `test/pg-setup.mjs` 分配隔离 schema。备份恢复和派生网关有各自的隔离目标，测试结束后清理。

```sh
npm run test:unit
npm run test:e2e
npm run test:go
pnpm -C web test
pnpm -C web build
python3 -m unittest discover -s test/deploy -v
```

测试缺少 PostgreSQL 或 PG 17 客户端时应报告失败，不能切回 SQLite。ARM64 镜像冒烟使用临时 Docker 网络及独立 PG 17 容器，不挂载部署凭据或宿主 Docker socket。

只读审计命令使用环境中的连接和应用 schema，强制只读会话。数据检查示例：`node scripts/audit-billing-contract.mjs --database --json`。另外三个 `audit-billing-gaps.mjs`、`audit-billing-openai.mjs`、`audit-fable-week.mjs` 直接查询环境指向的 PG，不再接受 SQLite 路径。
