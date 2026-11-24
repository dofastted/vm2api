# PostgreSQL 迁移与多级缓存运维指南

vm2api 支持将主数据库从嵌入式 SQLite 迁移至 **PostgreSQL**，并内置借鉴成熟网关架构（sub2api）的 **L1 进程内 LRU/Singleflight + 可选 L2 Redis + Pub/Sub（无 Redis 时自动降级 PG LISTEN/NOTIFY）** 多级缓存与预聚合仪表盘表。

---

## 1. 架构概览

| 组件 | 作用 |
| --- | --- |
| `postgres:18-alpine` | 主库（显式 `PGDATA=/var/lib/postgresql/data`，仅监听 `127.0.0.1`），通过 Advisory Lock + SHA-256 校验执行 `src/lib/db/pg/pg-migrations/001..004` |
| `redis:8-alpine`（可选） | L2 分布式缓存、Lua 原子余额/窗口计数、Redis `TIME` 并发槽、Pub/Sub 跨实例失效；不可达或未配置时自动 fail-open 降级至 L1 + PG `LISTEN/NOTIFY` |
| 异步原生池 + 兼容桥接 | 面板重查询（`/usage-logs`、`/statistics`、`/dashboard`）与 `write-behind` 批写入走原生异步 `pg.Pool` 与后台读线程池，不阻塞主事件循环；全部既有 Repo 通过 SSOT 兼容层平滑运行 |
| 预聚合表与 Outbox | `usage_dashboard_hourly` / `usage_dashboard_daily` 增量聚合 + `scheduler_outbox` / `auth_cache_invalidation_outbox` |

---

## 2. 全新安装（默认 PostgreSQL + Redis）

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash
```

- `deploy/install.sh` 会自动生成强随机 `POSTGRES_PASSWORD` 与 `REDIS_PASSWORD`，并将 `postgres`、`redis` 绑定至 `127.0.0.1`。
- 若希望把 PG / Redis 数据直接落盘到宿主机目录（方便数据盘隔离或备份），可叠加 `docker-compose.local.yml`：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

- 如需对接云端/托管 PostgreSQL 与 Redis（如 Supabase、AWS RDS、Neon、自建高可用集群），在 `.env` 配置：

```env
VM2API_DB_DRIVER=postgres
DATABASE_URL=postgresql://user:password@pg.example.com:5432/vm2api?sslmode=require
REDIS_URL=redis://:password@redis.example.com:6379/0
```

然后使用 `docker compose up -d --no-deps vm2api` 仅启动控制面即可。

---

## 3. 存量 SQLite 平滑替换至 PostgreSQL

升级既有部署时，`deploy/install.sh upgrade` 检测到已有 `data/kin.db` 且未配置 PostgreSQL 时，会**保留 `VM2API_DB_DRIVER=sqlite` 防止误启空库**。准备好后执行替换脚本：

### 3.1 预检（不中断任何服务）

```bash
sudo bash /opt/vm2api/deploy/replace-db-to-pg.sh --dry-run
```

### 3.2 一键替换（支持 Docker Compose 与宿主机 systemd）

```bash
# 本地内置 PostgreSQL + Redis（默认）
sudo bash /opt/vm2api/deploy/install.sh db-migrate

# 或直接调用替换脚本，支持外部云数据库：
sudo bash /opt/vm2api/deploy/replace-db-to-pg.sh \
  --database-url "postgresql://vm2api:STRONG_PASS@pg.example.com:5432/vm2api?sslmode=require" \
  --redis-url "redis://:REDIS_PASS@redis.example.com:6379/0"

# 仅使用 L1 + PG LISTEN/NOTIFY（不部署 Redis）：
sudo bash /opt/vm2api/deploy/replace-db-to-pg.sh --no-redis
```

切换过程保证：
1. **绝不触碰运行中的 `kin-*` 槽容器、`vms/` 目录或设备授权**；仅短暂停机 `vm2api` 控制面。
2. 迁移前自动将原 `kin.db`（含 WAL/SHM）与 `.env` 备份至 `data/backups/pre-pg-migration-<时间戳>/`，原 SQLite 永不删除。
3. 流式分批迁移全部 31 张业务表 + `thinking_signature_owners`，自动清理 PostgreSQL 不允许的 UTF-8 NUL 字节，重置全部 `BIGSERIAL` 序列，运行 `ANALYZE`。
4. 自动执行 `--verify`（全表行数 + `usage_logs` Token/费用总额 + `users.balance` + `api_keys` 精确核对）与 `--rollup`（预热仪表盘聚合表）。
5. 启动控制面并核验 `/health` 与 `/api/panel/database/metrics` 返回 `engine: "postgres"` 且 `ok: true`。

### 3.3 仅执行纯数据迁移工具（开发/测试）

```bash
node scripts/migrate-sqlite-to-pg.mjs \
  --sqlite /path/to/kin.db \
  --pg-url "postgresql://vm2api:pass@127.0.0.1:5432/vm2api" \
  --verify --rollup
```

---

## 4. 一键回滚至 SQLite

若切换后需要回退，执行以下命令即可瞬间还原切换前 `.env` / systemd 配置并切回原 SQLite（PostgreSQL 数据保留不删）：

```bash
sudo bash /opt/vm2api/deploy/replace-db-to-pg.sh --rollback
# 或
sudo bash /opt/vm2api/deploy/install.sh db-rollback
```

---

## 5. 备份与恢复

- 切换 PostgreSQL 后，面板「数据备份」自动使用 `pg_dump --format=custom`（容器镜像已预装 `postgresql-client`）；若宿主未装 `pg_dump`，自动降级为纯 JS 流式 `kin.pg.ndjson.gz` 逻辑备份。
- 恢复时同样支持 `pg_restore` 与逻辑快照恢复，并在恢复完成后自动失效全部多级缓存。
