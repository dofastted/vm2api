# Claude 订阅信息

虚拟机列表的账号列显示查询到的套餐和订阅日期。自动续费显示“续费”，明确结束的订阅显示“到期”。接口未返回日期时显示“未知”，不会用 OAuth 令牌有效期或额度重置时间代替。

在虚拟机详情卡或完整详情页的账号页签点击“订阅信息”，输入 Claude 网页的 `sessionKey`（`sk-ant-sid…`），点击“保存并查询”。查询成功且账号、组织与槽位匹配后才保存。可在同一窗口替换、手动刷新或删除查询凭据。

保存需要配置现有的 `VM2API_DB_SECRET` 或 `KIN_DB_SECRET`。凭据使用 AES-256-GCM 加密存储在独立的 `claude_subscriptions` 表中，前端不回显明文。删除查询凭据同时删除该槽位的订阅查询记录，不修改 OAuth 凭据或调度设置。删除虚拟机时数据库自动删除关联记录。

查询通过槽位已有的代理出口，只向 `https://claude.ai` 发送账号核对与订阅详情 GET 请求，不换取 OAuth 凭据，不调用模型。读取面板中的缓存不会触发上游查询。Cookie 失效或访问受限后需手动处理；查询失败保留上次成功的结果和时间，并标记待更新。账号或组织变更后不展示旧账号记录。

当前接口：`GET /api/panel/vms/:id/claude-subscription` 读取脱敏缓存；`PUT` 保存并查询；`POST` 使用已存凭据刷新；`DELETE` 删除。普通用户仅能操作自己的虚拟机；`super` 角色仅可读取缓存。数据表由 PostgreSQL 迁移 `022_claude_subscriptions.sql` 创建。

Claude 的 `subscription_details` 为网页内部接口，其可用性以实际账号权限和响应为准。`sessionKey` 本身仍是网页会话凭据；限定用途由本功能的调用路径保证。
