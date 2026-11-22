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
