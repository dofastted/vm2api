/**
 * Strict terminal classification for Codex scheduled preheat (#1874 item ③).
 * Manual panel "测试" keeps the legacy ok bit; only preheat renewal uses this.
 */

function completedStatus(result) {
  const status = String(result?.stop_reason || result?.body?.status || '')
    .trim()
    .toLowerCase()
  if (!status) return false
  if (status === 'incomplete' || status === 'failed' || status === 'cancelled') return false
  return status === 'completed'
}

/** Codex Responses hop succeeded only when upstream reports a completed terminal. */
export function isCodexVmTestTerminalSuccess(result) {
  if (!result || result.ok !== true) return false
  return completedStatus(result)
}
