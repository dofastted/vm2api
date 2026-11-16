# CRAG 支付与鉴权验收

## 职责和信任边界

vm2api 内置的是**商城代理和授权消费端**，不是收款服务。面板把核价、订单状态及领取请求发给固定供应方 `https://crag.fkcodex.com`。同域的 `/shop/*` 由私有 `crag-shop` 负责；支付平台通知它的 `/shop/epay/notify`，不是本地 vm2api。商城验证回调、登记真实交易，再向 `crag-auth` 的 `/v1/integrations/deliveries/callback` 发起 HMAC 签名交付。浏览器 `/shop/return` 只是回跳，不是付款证明。Authority 负责发码、核销和签发权益；vm2api 验证签名、载荷和设备绑定，不签发权限。供应方视角见 CRAG 仓库 `docs/CRAG-PAYMENT-AUTH.md`。

面板买家会话、商城订单收据、Authority 交付 HMAC、宿主订阅凭据是四种不同的凭据。浏览器只持有买家会话；vm2api 在服务端按订单使用收据，在宿主核销时使用另一套宿主凭据。收据主密钥持久化在数据目录 `crag-shop-private/receipt.key`，不随常规数据库备份；要恢复原订单必须同时保留此密钥。不要记录 Cookie、付款表单、支付交易号、收银台会话链接、兑换码、授权凭证或机器码。

## 本地隔离准备

1. 按 [部署说明](DEPLOY.md) 启动官方控制面镜像；复跑本次基线固定 `ghcr.io/dofastted/vm2api:v1.4.104`。用独立容器名、仅本机可达的端口、独立数据目录和 `vms`、`share`，不要复用正在运行的实例。设备授权需要 Linux 私有运行目录；宿主订阅的数据目录需在 Linux 本地文件系统上，且目录属主与控制进程的要求一致，不使用 DrvFS 保存授权。按 Compose 约定挂载宿主 machine-id；不同实例目录并不意味着不同宿主身份。要测试新的宿主权益，使用明确允许绑定的隔离宿主；已有生产订阅时不要拿它试绑。
2. `GET /healthz` 返回 `200`；`POST /api/panel/login` 后用 `GET /api/panel/me` 确认实际版本和管理员身份。以同源管理员会话执行写操作。将 `VM2API_CRAG_SHOP_AUTO_ACTIVATION=0` 用于本次手动验收，确保领码、核销和绑定分开验证。
3. 本次镜像的出厂 CRAG 是 `3.0.7`。通过「内核」页或 `POST /api/panel/kernels/pull` 传 `{"kernel":"crag","tag":"payload-2026.11.15-crag-3.0.8"}` 拉取标准包，从 `GET /api/panel/kernels` 确认 `payload_tag`，不要将协议族 `v2` 当作发行版本。拉取只更新安装缓存。
4. 在隔离实例选择 CRAG v2 数据面，创建 `vm-` 开头、已预装受信签名包、未启动且不可调度的本机 Linux Docker Claude 槽。`GET /api/panel/crag-subscription` 应显示宿主 `ready: true`；买新订阅前确认 `state: unredeemed`，并对指定槽回读 `GET /api/panel/vms/:id/crag-license`，确认尚未授权。设备码另用专用槽，不覆盖既有凭证。不要为准备授权强行启动目标槽。

## 调用顺序

下面路径都在 `/api/panel` 下。这里复跑的是登录后手动领码的购买流程，除公开套餐外，须用真实面板买家会话。当前的免登录设备购买另走 `/crag-shop/device`，只应用已交付订单到本机，不返回兑换码。写操作同源，以 `Content-Type: application/json` 提交 JSON。以 [面板 API](PANEL_API.md#crag-订阅订单) 为完整字段参考。

| 顺序 | 请求 | 预期 |
| --- | --- | --- |
| 1 | `GET /crag-shop/plans` | 核对套餐、金额和 `payment_methods`。列表为空支付方式时停止，不建单。 |
| 2 | `POST /crag-shop/quote`：`{"sku":"c1"}` | 只核价。记录本次 `amount_minor`；`3800` 是历史样例，不是固定售价。 |
| 3 | `POST /crag-shop/orders`：`{"sku":"c1","payment_method":"alipay","request_id":"<新 UUID>","expected_amount_minor":3800}` | 用实际报价替换金额，得到待付订单与 `url` / `data`；保留 `order_id` 和原 `request_id`。建单未知时先查本人订单，再按原参数恢复，不生成新 ID 重试。 |
| 4 | `POST /crag-shop/orders/:id/resume`（需要恢复时）：`{}` | 恢复同一订单表单。浏览器按返回的 `url` 提交原 `data`，由用户在真实收银台核对金额并付款。此时本地面板不需要公网回调端口。 |
| 5 | `GET /crag-shop/orders/:id` | `pending` 等待支付；`paid` 仍要等待发货；`fulfilled` 才进领取。回跳、截图和浏览器提示均不能代替订单状态。 |
| 6 | `POST /crag-shop/orders/:id/claim`：`{}` | 未发货应返回 `409 shop_claim_not_ready`；发货后返回对应订单与原 `CRAGR1`。领取不消耗兑换码，不替用户开槽。 |
| 7 | `POST /crag-subscription/redeem`：`{"redemption_code":"<第 6 步领取的宿主码>"}` | 核销到当前宿主，返回 `200`、`state: active`。不要把商城宿主码当作设备码。 |
| 8 | `POST /vms/:id/crag-license/bind`：`{}` | 签发并绑定目标槽许可，返回槽序号 `seat`。 |
| 9 | `GET /vms/:id/crag-license`、`GET /crag-subscription` | 分别检查 `license.valid: true`、`license.scope: host`、期限，以及宿主已用/可用槽位；`enabled_slots` 是已运行且授权有效的槽数，不等同于已绑定额度。 |

`v1.4.104` 官方镜像中，`POST /vms/:id/crag-license` 的在线路径只核销**设备码**；试填商城宿主码返回 `403 license_redeem_unavailable`，本次未消耗原码。上述第 7–8 步是该版本正确路径。设备码才向槽接口发送 `{"registration_code":"<设备 CRAGR1>"}`，回读 `license.kind: online` 和 `license.valid: true`。两类码前缀相同，不靠前缀辨别。支持 Authority `/v1/device-activation/resolve` 的构建可按类型分流；验收以实际发布镜像为准，不以当前源码替代。若只做无扣费冒烟，停在第 2 步。

统一订阅回归使用隔离宿主上的两槽额度，分别绑定 Docker 与 KVM（可用不同受信 CRAG 发行包）。确认 `available_seats` 依次为 `2 → 1 → 0`，第三槽返回 `slot_limit_reached`；重签已有槽不再扣额度。启动 KVM 后检查来宾健康、`license_valid: true`，以及一次实际推理；仅看到面板绑定成功不算来宾验收通过。

## 本次真实验收（2026-11-15）

| 检查点 | 实测结果 |
| --- | --- |
| 最新稳定面板与目标载荷 | 官方 `v1.4.104`；经面板从出厂 `3.0.7` 拉取签名的 `3.0.8` 标准包。公网 Authority 识别 `3.0.8` 的发行方和载荷 ID。 |
| 独立设备兑换 | 既有设备码真实核销，槽授权回读 `200 valid: true`。 |
| 建单与付款 | `c1`，支付宝实付 ¥38.00（1 个月、1 槽）；付款前领取 `409`，付款后同一订单 `fulfilled`。生产商户账本的真实交易记录和 Authority 的 `issued` 交付关联到同一个码。 |
| 商城宿主码 | 正式镜像设备路径拒绝；按宿主路线领取、核销和绑定后，Authority 记为 `redeemed`，面板回读 `200 valid: true`、`scope: host`、`seat: 1`，已用 `1/1`，到期 `2026-12-15 23:46`（UTC+8）。 |
| 未覆盖 | 微信付款、订单自动激活、生产槽启动和首个模型请求。此处仅证明授权，不能据此宣称运行就绪；独立设备槽曾因没有绑定 SOCKS5 出口而未启动。 |
