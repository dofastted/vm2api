# PostgreSQL 一键安装、无缝迁移与多级缓存运维指南

vm2api 支持将主数据库从嵌入式 SQLite 迁移至 **PostgreSQL**，并内置借鉴成熟网关架构（sub2api）的 **L1 进程内 LRU/Singleflight + 可选 L2 Redis + Pub/Sub（无 Redis 时自动降级 PG LISTEN/NOTIFY）** 多级缓存与预聚合仪表盘表。

---

## 1. 架构与依赖保障

| 组件 | 作用与依赖保障 |
| --- | --- |
| `postgres:18-alpine` | 主库（显式 `PGDATA=/var/lib/postgresql/data`，仅监听 `127.0.0.1`），通过 Advisory Lock + SHA-256 校验执行 `src/lib/db/pg/pg-migrations/001..004`；默认端口 `5432` 被本机其他服务占用时自动顺延至空闲端口 |
| `redis:8-alpine`（可选） | L2 分布式缓存、Lua 原子余额/窗口计数、Redis `TIME` 并发槽、Pub/Sub 跨实例失效；不可达或禁用（`--no-redis`）时自动 fail-open 降级至 L1 + PG `LISTEN/NOTIFY` |
| 控制面镜像（amd64 / arm64） | `Dockerfile` 与 `deploy/Dockerfile.arm64-control` 均预装 `postgresql-client`（`pg_dump` / `pg_restore` / `psql` / `pg_isready`）及 Node 生产依赖 `pg` + `ioredis` |
| 一键脚本自动补装依赖 | `deploy/install-pg.sh`、`deploy/install.sh`、`deploy/replace-db-to-pg.sh` 自动检测包管理器（`apt` / `dnf` / `yum` / `apk`），在停服前补齐 `git`、`curl`、`python3`、`openssl`、`postgresql-client`、`docker` + Compose 插件；systemd 宿主机模式自动校验 Node >= 22.5 并补装 `pg` / `ioredis`（`npm ci --omit=dev`），无 Docker 时支持 `--pg-runtime native` 原生安装 `postgresql` + `redis-server` |

---

## 2. PostgreSQL 版一键安装 / 存量无缝升级迁移（推荐）

无论全新服务器还是存量 SQLite 部署，统一入口均为 `deploy/install-pg.sh`：

```bash
# 全新服务器：自动补装依赖 + 部署 PostgreSQL 18 + Redis 8 + vm2api
# 存量 SQLite：自动升级控制面 + 补装依赖 + 校验迁移 + 原子切换至 PostgreSQL（不碰运行中的 kin-* 槽位）
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-pg.sh | sudo bash
```

常用参数示例：

```bash
# 对接外部/云端 PostgreSQL 与 Redis（自动跳过本地 PG/Redis 容器，停服前先探针连通性）
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-pg.sh | sudo bash -s -- \
  --database-url "postgresql://vm2api:STRONG_PASS@pg.example.com:5432/vm2api?sslmode=require" \
  --redis-url "redis://:REDIS_PASS@redis.example.com:6379/0"

# 仅使用 L1 + PG LISTEN/NOTIFY（不启动本地 Redis）
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-pg.sh | sudo bash -s -- --no-redis

# 将 PG / Redis 数据直接挂载到独立数据盘（自动启用 docker-compose.local.yml）
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-pg.sh | sudo bash -s -- \
  --pg-data-dir /mnt/data/vm2api-pg \
  --redis-data-dir /mnt/data/vm2api-redis

# 仅做依赖检查或迁移预演（零停机、不写数据）
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-pg.sh | sudo bash -s -- --check-deps
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-pg.sh | sudo bash -s -- --dry-run
```

等价的 `deploy/install.sh` 显式命令：

```bash
# 仅补齐宿主基础、Docker 与 PostgreSQL 客户端依赖
sudo bash /opt/vm2api/deploy/install.sh prepare-deps

# 存量升级且暂保留 SQLite（不会因本机 5432/6379 占用而失败）
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade

# 升级并在完成后自动无缝迁移至 PostgreSQL
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade --auto-migrate
```

---

## 3. 存量 SQLite 独立替换脚本（`deploy/replace-db-to-pg.sh`）

适用于已完成控制面升级、或需要细粒度控制迁移参数的 Docker / 蓝绿 / 宿主机 systemd 部署：

### 3.1 零停机预检

```bash
# 校验并补齐宿主机/Node/镜像依赖
sudo bash /opt/vm2api/deploy/replace-db-to-pg.sh --check-deps

# 完整预演（含磁盘空间、端口冲突、外部库连通性探针，不停止服务）
sudo bash /opt/vm2api/deploy/replace-db-to-pg.sh --dry-run
```

### 3.2 执行替换切换

```bash
# Docker Compose 本地 PG + Redis（自动精确匹配 vm2api-postgres 容器，不误碰同机其他 PG）
sudo bash /opt/vm2api/deploy/replace-db-to-pg.sh

# 宿主机 systemd（无 Docker 时自动使用原生 postgresql + redis-server，或显式 --pg-runtime native）
sudo bash /opt/vm2api/deploy/replace-db-to-pg.sh --mode systemd --pg-runtime native

# 外部云数据库（停服前先做 SELECT 1 认证与连通性探针）
sudo bash /opt/vm2api/deploy/replace-db-to-pg.sh \
  --database-url "postgresql://vm2api:STRONG_PASS@pg.example.com:5432/vm2api?sslmode=require" \
  --no-redis
```

切换过程保证：
1. **停服前完成全部前置校验**：依赖检查/自动补装（`postgresql-client`、`docker`/Compose、systemd 下 Node >= 22.5 + `pg`/`ioredis`、Docker 镜像内 `migrate-sqlite-to-pg.mjs` + `pg`）、端口冲突检测与顺延、目标 PG `SELECT 1` 探针——任何条件不满足都在零停机下安全退出。
2. **绝不触碰运行中的 `kin-*` 槽容器、`vms/` 目录或设备授权**；仅短暂停机 `vm2api` 控制面（兼容普通 Compose、蓝绿与 systemd）。
3. 停服后先对 `kin.db` 做 `WAL checkpoint(TRUNCATE)`，再将原 `kin.db`（含 WAL/SHM）与 `.env` 备份至 `data/backups/pre-pg-migration-<时间戳>/`，原 SQLite 永不删除。
4. 流式分批迁移全部 31 张业务表 + `thinking_signature_owners`，清理 PostgreSQL 禁止的 UTF-8 NUL 字节，重置全部 `BIGSERIAL` 序列并运行 `ANALYZE`。
5. 自动执行 `--verify`（全表行数 + `usage_logs` Token/费用总额 + `users.balance` + `api_keys` 精确核对）与 `--rollup`（预热仪表盘聚合表）。
6. 使用 `--force-recreate` 启动控制面并核验 `/health` 与 `/api/panel/database/metrics` 返回 `engine: "postgres"` 且 `ok: true`；任意环节失败均自动触发 `ERR` 回滚至 SQLite。

### 3.3 仅执行纯数据迁移工具（开发/测试）

```bash
node scripts/migrate-sqlite-to-pg.mjs \
  --sqlite /path/to/kin.db \
  --pg-url "postgresql://vm2api:pass@127.0.0.1:5432/vm2api" \
  --verify --rollup
```

---

## 4. 一键回滚至 SQLite

若切换后需要回退，执行以下命令即可瞬间还原切换前 `.env` / systemd drop-in 并使用 `--no-deps` 切回原 SQLite（PostgreSQL 数据保留不删）：

```bash
sudo bash /opt/vm2api/deploy/install-pg.sh --rollback
# 或
sudo bash /opt/vm2api/deploy/replace-db-to-pg.sh --rollback
# 或
sudo bash /opt/vm2api/deploy/install.sh db-rollback
```

---

## 5. 备份与恢复

- 切换 PostgreSQL 后，面板「数据备份」自动使用 `pg_dump --format=custom`（amd64 与 arm64 控制面镜像及宿主脚本均预装 `postgresql-client`）；若宿主未装 `pg_dump`，自动降级为纯 JS 流式 `kin.pg.ndjson.gz` 逻辑备份。
- 恢复时同样支持 `pg_restore` 与逻辑快照恢复，并在恢复完成后自动失效全部多级缓存。
