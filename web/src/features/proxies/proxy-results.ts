export type Outcome = {
  level: 'success' | 'warning' | 'info' | 'error'
  text: string
}

type SlotResult = { ok?: boolean; error?: unknown } | null | undefined

function reasonOf(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const nested = rec.error
    if (nested && nested !== value) return reasonOf(nested)
    return String(rec.message || rec.code || '')
  }
  return String(value)
}

/** 绑定后网关会停调度并重载槽位；重载失败时槽位保持停调度，不能报成功。 */
export function bindOutcome(done: string, worker: SlotResult): Outcome {
  if (worker && worker.ok === false) {
    const reason = reasonOf(worker.error)
    return {
      level: 'warning',
      text: `${done}，但槽位重载失败${reason ? `（${reason}）` : ''}，该槽已停止调度，修好后需手动恢复调度`,
    }
  }
  return { level: 'success', text: done }
}

export type ProxyEditResult = {
  workers?: { vm_id: string; ok: boolean; error?: string | null }[]
  egress?: { ok?: boolean; error?: string | null } | null
}

export function editOutcome(data: ProxyEditResult): Outcome {
  const problems: string[] = []
  const failed = (data.workers || []).filter((w) => !w.ok)
  if (failed.length) {
    problems.push(
      `${failed.length} 台槽位重载失败：${failed.map((w) => w.vm_id).join('、')}`
    )
  }
  if (data.egress && data.egress.ok === false) {
    const reason = reasonOf(data.egress.error)
    problems.push(`出口转发重启失败${reason ? `（${reason}）` : ''}`)
  }
  if (!problems.length) {
    const count = data.workers?.length || 0
    return {
      level: 'success',
      text: count ? `已保存，已自动更新 ${count} 台槽位配置` : '已保存',
    }
  }
  return { level: 'warning', text: `已保存，但${problems.join('；')}` }
}

export type ProbeAllResult = {
  ok?: boolean
  error?: string
  total?: number
  results?: { ok?: boolean }[]
}

export function probeAllOutcome(data: ProbeAllResult): Outcome {
  if (data.ok === false) {
    if (data.error === 'probe_in_progress') {
      return { level: 'info', text: '上一轮探测还没结束，稍后刷新看结果' }
    }
    return { level: 'error', text: data.error || '探测失败' }
  }
  const rows = data.results || []
  const ok = rows.filter((r) => r.ok).length
  return {
    level: 'success',
    text: `代理探测完成 ${ok}/${data.total ?? rows.length}`,
  }
}

export function disableConfirmText(bound: number): string {
  return bound
    ? `禁用后，绑在这条代理上的 ${bound} 台槽位会全部停止调度，重新启用代理后才恢复。确认禁用？`
    : '禁用后这条代理不再接新槽位。确认禁用？'
}

export function deleteConfirmText(bound: number): string {
  return bound
    ? `删除后，绑在这条代理上的 ${bound} 台槽位会解绑并停止调度，要重新绑定代理才能恢复。确认删除？`
    : '删除这条代理？'
}
