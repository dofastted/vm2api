import { isApiError } from '@/lib/api'

/**
 * 错误码 → 补充引导。只收录那些 gateway 原文不足以指导下一步的码。
 *
 * ⚠️ 故意**不收** `credential_mode_unsupported`：它是跨语义复用码，
 * 在「手动初装 400」「刷新凭证 400」下含义完全不同
 * （`官方初装只支持完整 OAuth` vs `Console API Key 不能刷新`），
 * 套一句固定文案必然在其中一处说错。这个码一律透传 gateway 的 message，
 * 并在 UI 上按来源提前禁用按钮，让用户根本触发不到。
 */
const HINTS: Record<string, string> = {
  session_stale_relogin:
    'sessionKey 已失效：请重新登录 claude.ai 取新的 sessionKey 再导入。',
  cloudflare_challenge:
    '被 Cloudflare 拦截：该槽的 SOCKS5 线路已被风控，换一条代理线后重试。',
  import_failed: '导入失败：请确认粘贴的凭证完整无误。',
  proxy_required: '该槽未绑定健康的 SOCKS5，请先分配代理再操作。',
  session_expired: '授权会话已过期：请重新生成授权链接。',
  session_vm_mismatch: '授权会话与当前槽不匹配：请重新生成授权链接。',
  code_required: '请填写回调 code。',
  // 槽内 CLI 喂码超时。gateway 明确要求「不要重新生成」，
  // 而是再打开当前链接取新授权码 —— 别把用户引到「重新生成」按钮上。
  setup_token_timeout:
    '槽内 CLI 等待授权码超时：请再打开当前这条链接取新授权码（须含 # 后半段），不要重新生成。',
  setup_token_invalid_code:
    '授权码不完整或已被用过：请再打开当前链接复制完整授权码，含 # 后半段。',
  cli_node_missing: '该槽没有 cli-node：请先在内核页同步 wrap-cli。',
  setup_token_url_timeout:
    '槽内 CLI 45 秒内没吐出授权链接：确认容器在线与 SOCKS5 可用后重试。',
  bridge_failed: '槽内 SOCKS5→HTTP 桥没起来：检查该槽代理后重试。',
  worker_credential_import_failed:
    '凭证已取得但槽位凭证服务拒绝写入：请检查该槽位内核与容器状态后重试。',
  placement_forbidden: '只有管理员可以指定目标节点。',
  node_not_found: '目标节点不存在：可能已被移除，请刷新后重选。',
  placement_preflight_failed: '目标节点预检未通过：按下方检查项修复后重试。',
  remote_unsupported:
    '远端节点暂不支持该操作（如 GPT / Codex 槽只能建在本机）。',
  kvm_unavailable: '当前宿主或节点无法创建 KVM 虚拟机。',
}

export function importErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = isApiError(error) ? error.code : ''
  const hint = code ? HINTS[code] : ''
  if (!hint) return raw
  return raw ? `${hint}（${raw}）` : hint
}
