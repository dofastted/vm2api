/**
 * 宿主订阅（按槽位计）相关错误码的唯一文案表。
 *
 * 单独成文件而不是挂在某个组件上：两个面板都要用它，挂在组件文件里会让那个
 * 文件既导出组件又导出常量（`react-refresh/only-export-components`），而且
 * 「谁先 import 谁」会变成一种隐含的主从关系。
 *
 * 同一个错误码只在这里写一句。授权编辑器展开复用本表，只另写本槽授权与设备
 * 授权独有的码 —— 历史上这两处各写一份，`license_payload_key_mismatch` 就曾
 * 在两边措辞不同。
 *
 * 用户侧只有两个数字：「充值可用槽位」与「使用中的槽位」（真正在运行调度的
 * CRAG 内核数）。文案只引用这两个名字，满了就引导继续充值 —— 不要引入第三个
 * 叫法，也不要提及当前不存在的用户动作。
 */
export const cragSubscriptionErrors: Record<string, string> = {
  slot_limit_reached:
    '使用中的槽位已达到充值可用槽位。请继续充值，或先停止其他正在运行的 CRAG 槽。',
  host_subscription_inactive:
    '本机没有有效订阅。请在「订阅 CRAG」充值并兑换后再绑定。',
  host_binding_conflict: '此槽的设备身份与原绑定不一致，未绑定。',
  crag_subscription_target_unready:
    '此槽暂不能绑定订阅。请确认使用可信 CRAG 包，且未绑定其他有效授权。',
  crag_subscription_target_changed: '目标槽或内核已变化，请核对后重试。',
  crag_subscription_sync_pending:
    '上次订阅变更尚未同步。请先点「继续同步」完成，再进行新的绑定或兑换。',
  crag_subscription_authority_unavailable:
    '尚未确认操作结果，请在同一目标槽重试，不必重新购买。',
  payload_key_unknown:
    '授权服务未登记此内核载荷。已到账的槽位会保留，可在兼容槽位使用。',
  payload_key_conflict:
    '内核版本冲突：本槽或此码已绑定另一版 CRAG 内核包，未能换签。请改用原内核版本。',
  license_payload_key_mismatch:
    '注册码对应另一版 CRAG 内核。请复制含载荷 ID 的机器码，向授权方申请匹配当前版本的注册码。',
  redeem_unavailable: '订阅兑换码无效、已过期或已使用，请核对原码。',
  host_redeem_conflict: '此订阅兑换码已在其他宿主机兑换，不能用于本机。',
  not_found: '授权服务找不到当前宿主机的订阅或槽位。',
  auth_forbidden: '授权服务不接受当前宿主机的订阅凭据。',
  host_transfer_cooldown:
    '本机上次注销的时间太近，兑换券还不能再次转移。请等冷却期结束后重试。',
}

/**
 * 「从其他设备迁移」这条路径独有的文案。
 *
 * 和上表分开，是因为同一个码在这里含义不同：`not_found` 在状态刷新时是「找不到
 * 本机订阅」，在这里却是「这个订单号没有登记过兑换券」；`redeem_unavailable` 在
 * 兑换时是「券码无效」，在这里是「这张券与同机其他券共享合并额度、不能单独迁」。
 * 上表按码索引、没有动作维度，装不下这种分歧 —— 覆盖它会让另一条路径说错话。
 *
 * 查不到就回落到上表，所以这里只写确实有分歧的码。
 */
export const cragOrderClaimErrors: Record<string, string> = {
  not_found:
    '没有找到这个订单号对应的兑换券。请核对原订单上的订单号；若这张券是在「按订单号迁移」上线前兑换的，请改用原券码迁移。',
  redeem_unavailable:
    '这张券与原机器上的其他兑换券共享一个合并额度窗口，不能单独迁移。请在原机器上注销整台订阅。',
  request_conflict:
    '这个订单号已登记到另一张兑换券。请保留原订单并联系管理员核对，不要重复兑换。',
}

/**
 * 自助恢复凭据失败后的成因说明（`CragHostStatus.credential_recovery`）。
 *
 * 和上表分开：这些不是某次请求的错误码，而是一个持续存在、只能由运维清除的
 * 状态 —— 授权服务不认本机凭据，而本机又没能自行换回来。不说明的话，面板会
 * 一直显示正常，直到某次兑换莫名失败。
 *
 * 按同一条约定：只陈述事实与可查的线索，不提及当前不存在的用户动作。
 */
export const cragCredentialRecoveryFaults: Record<string, string> = {
  host_id_collision:
    '本机的设备标识与另一台设备相同，授权服务因此不接受本机凭据。常见于从同一镜像克隆、未重置 /etc/machine-id 的 VPS。',
  failed: '本机凭据未能自动换回，授权服务仍不接受。已运行的槽不受影响。',
  not_activated: '本机没有可用于证明归属的授权记录，请先完成兑换。',
}

export type CragOrderActivationRecovery =
  'not_activated' | 'host_id_collision' | 'failed'

const cragOrderActivationAdminErrors: Record<string, string> = {
  host_subscription_inactive:
    '本机宿主订阅未生效或已到期，未能完成目标槽位绑定。请核对本机订阅状态后点「重试自动激活」；请保留 order_id 与 crag-shop-private/receipt.key，不要重复下单。',
  crag_subscription_target_changed:
    '目标槽位、所属用户或已安装的 CRAG 内核包与下单时不一致，自动激活已停止。恢复原目标槽位配置后可点「重试自动激活」，不要重复购买。',
  slot_limit_reached:
    '使用中的槽位已达到充值可用槽位，目标槽位暂未完成绑定。停止其他正在运行的 CRAG 槽或补充额度后，可点「重试自动激活」。',
  host_redeem_conflict:
    '原订单对应的兑换券已绑定其他宿主机，无法应用到本机。请保留 order_id、device_uuid 与 crag-shop-private/receipt.key 核对原订单，不要重复购买。',
  redeem_unavailable:
    '授权服务未接受原订单的兑换券。请保留 order_id 与 crag-shop-private/receipt.key 核对原订单，不要重复购买。',
  host_binding_conflict:
    '目标槽位的设备身份与原绑定记录不一致，自动绑定已停止。请核对目标槽位状态后重试，不要重复购买。',
  payload_key_unknown:
    '授权服务未登记目标槽位当前使用的 CRAG 内核载荷密钥。切换为兼容的受信发行包后可重试原订单，不要重复购买。',
  payload_key_conflict:
    '目标槽位或原兑换记录已绑定另一版 CRAG 内核包。请恢复原内核版本后点「重试自动激活」，不要重复购买。',
  issuer_mismatch:
    '本地 CRAG 发行包签发者与授权服务不一致。恢复匹配的受信发行包后可点「重试自动激活」，不要重复购买。',
  not_found:
    '授权服务未找到对应的宿主订阅或目标记录。请保留 order_id、device_uuid 与 crag-shop-private/receipt.key 核对本机订阅状态，不要重复购买。',
  request_conflict:
    '该订单号在授权服务的登记记录存在冲突，自动激活已停止。请保留 order_id 与 crag-shop-private/receipt.key 核对原订单，不要重复购买。',
  invalid_request:
    '授权服务拒绝了本次自动激活请求参数。确认控制面已升级后可点「重试自动激活」，不要重复购买。',
  shop_admin_required:
    '下单账号当前的管理员权限已变更，自动激活已暂停。恢复管理员权限后可重试原订单，不要重复购买。',
}

export function describeCragOrderActivationFailure({
  errorCode,
  recovery,
  isAdmin,
}: {
  errorCode?: string
  recovery?: CragOrderActivationRecovery
  isAdmin: boolean
}): string {
  if (!errorCode) {
    return isAdmin
      ? '自动激活已暂停。确认原目标可用后，可重试原订单；无需重新购买或兑换。'
      : '自动激活尚未完成，请联系管理员核查原订单；不要重复购买或另行兑换。'
  }
  if (errorCode === 'auth_forbidden') {
    if (!isAdmin) {
      return '授权服务拒绝了宿主机身份与凭据，自动激活已停止。请保留此订单号（order_id）并联系管理员，附上错误码与请求 ID 核对恢复；不要重复下单。'
    }
    if (recovery === 'host_id_collision') {
      return '授权服务拒绝了本机宿主凭据：检测到本机设备标识与另一台机器冲突（常见于克隆镜像未重置 /etc/machine-id）。请妥善保留此订单的 order_id、本机 device_uuid 与数据目录中的 crag-shop-private/receipt.key；不要重复下单，也不要盲目删除 crag-shop-private/receipt.key 或 credential。请附上 order_id、device_uuid 与请求 ID 联系支持核对恢复。'
    }
    if (recovery === 'not_activated') {
      return '授权服务拒绝了本机宿主身份与凭据（本机尚无已签名的宿主授权记录，可能因克隆镜像共用 /etc/machine-id 与其他机器冲突，或重建数据目录后丢失了原宿主凭据）。请妥善保留此订单的 order_id、本机 device_uuid 与数据目录中的 crag-shop-private/receipt.key；不要重复下单，也不要盲目删除 crag-shop-private/receipt.key 或 credential。若有本机原 credential 备份，恢复匹配的宿主凭据后可点「重试自动激活」；否则请附上 order_id、device_uuid 与请求 ID 联系支持核对恢复。'
    }
    return '授权服务拒绝了本机宿主凭据，且自动换回凭据未成功。请妥善保留此订单的 order_id、本机 device_uuid 与数据目录中的 crag-shop-private/receipt.key；不要重复下单，也不要盲目删除 crag-shop-private/receipt.key 或 credential。恢复匹配的宿主凭据后可点「重试自动激活」，或附上 order_id、device_uuid 与请求 ID 联系支持处理。'
  }
  if (!isAdmin) {
    return '自动激活遇到故障已停止，请保留此订单号并联系管理员附上错误码核查原订单；不要重复购买或另行兑换。'
  }
  if (
    Object.prototype.hasOwnProperty.call(
      cragOrderActivationAdminErrors,
      errorCode
    )
  ) {
    return cragOrderActivationAdminErrors[errorCode]
  }
  const known = Object.prototype.hasOwnProperty.call(
    cragSubscriptionErrors,
    errorCode
  )
    ? cragSubscriptionErrors[errorCode]
    : undefined
  return known
    ? `${known} 请保留原订单（order_id 与 crag-shop-private/receipt.key），核对后可点「重试自动激活」，不要重复购买。`
    : '自动激活未完成并已暂停。请保留原订单（order_id 与 crag-shop-private/receipt.key），确认目标与本机订阅正常后可点「重试自动激活」，不要重复购买。'
}
