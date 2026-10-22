# 独立合成节点 fixture

此 fixture 仅验证 PostgreSQL 授权、真实 Go KSG2 pinned TLS、Unix 合成 kernel、正常控制面协议及持久完成记录的接线。Docker Engine 是本地 HTTP 假服务，不创建真实容器，不运行真实 provider 或闭源模型 payload。`/status` 的响应计数不是节点完成证明；完成证明仍须读取 Go Authority 的原 command journal。

用 Node 22.23.2 运行：

```sh
node test/fixtures/ha-node-launcher.mjs /absolute/path/task-config.json
```

配置文件必须是当前用户所有的 0600 普通文件，禁止符号链接。固定字段为：

```json
{
  "connectionString": "postgresql://TASK_TEST_USER:TASK_TEST_PASSWORD@TASK_TEST_PG/TASK_test",
  "schema": "test_ha_648_task",
  "listen": "10.249.248.1:0"
}
```

数据库名必须以 `_test` 结尾。schema 必须是普通 PostgreSQL 标识符，且以 `test_` 开头或包含 `648`。监听地址仅允许 `127.0.0.1` 或本任务明确指定的 k3d 网桥宿主地址 `10.249.248.1`；不接受通配地址或其他 LAN 地址。调用者先确认后者确为本任务网桥。端口 `0` 表示内核分配。Go fixture 保留给定地址和端口，不替换成 loopback。

launcher 生成合成凭据，经独立 PG grant 完成 allocate、初始文件发布和 fake Engine launch，并通过 `VmsRepo` 写入 metadata。所有出站节点管理调用都使用真实 Go PG 受限 authorizer。标准输出只有一行：资源 manifest 的绝对路径。manifest 的 `parametersFile` 指向 0600 的连接参数文件，其中包含 application schema、数据库连接、固定 trust 文件、VM metadata、原 launch receipt、Unix socket 和本地控制 URL。这些私有文件不能作为公开日志。节点 token 和 PG 密码不写入标准输出。

控制 URL 只监听宿主 `127.0.0.1`，提供：

| 请求 | 作用 |
| --- | --- |
| `GET /status` | 返回 `active`、`peak`、`responded`、`healthCalls` 及仅含原 request ID/状态/模式的观测记录。 |
| `POST /pause` | 后续 messages 请求进入等待，保持 Unix 连接，不返回终态。 |
| `POST /resume` | 原等待请求继续返回响应，不生成新的执行 ID。 |
| `POST /mode`，body `{"mode":"sse"}` | 完整正常 Claude SSE，四个主 usage 计数明确；默认模式。 |
| `POST /mode`，body `{"mode":"json"}` | 完整正常 Claude JSON，四个主 usage 计数明确。 |
| `POST /mode`，body `{"mode":"error"}` | 返回 502 内部 provider 错误；不能作为正常终止证明。 |
| `POST /mode`，body `{"mode":"truncated"}` | 返回缺失字节的 SSE/HTTP body；不能作为正常终止证明。 |

`/mode` 修改尚未返回响应的请求采用的模式。可先 pause，发起两个请求，从 status 确认 `active >= 2` 后选择响应模式。用于 controller 崩溃实验时，保持 fixture 存活，先终止本任务 controller，再 resume 原 kernel 响应。该计数用于合成测试时序，不能替代 Go 持久 command 状态。

停止顺序：先停止本任务 controller/Pod，再向 manifest 中的 launcher PID 发送 SIGTERM。launcher 关闭自己的控制和 Unix 监听，终止自己的 Go 子进程，删除生成的临时源码、副本二进制、配置和 trust 文件，并删除自身受限 PG role、node authority 和 maintenance 私有 schema。应用 schema/VM metadata 属于调用者，用于保留本任务结果，不由 launcher 删除。manifest 留作无凭据的清理证据；只有精确检查剩余目录、role 和私有 schema 均为空时才标记 `cleaned`。

本工具不创建 Docker/k3d/Kubernetes 资源，不执行 SSH/SFTP，不迁移真实节点权限，不能单独作为生产 HA 验收。
