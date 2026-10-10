/** Unary Compact compatibility over Codex's native remote_compaction_v2 Responses hop. */
export function isCodexCompactPath(pathName) {
  return pathName === '/v1/responses/compact' || pathName === '/responses/compact'
}

export function validateCodexCompact(body) {
  if (typeof body?.input !== 'string' && !Array.isArray(body?.input)) {
    return 'input must be a string or an array containing the full context window'
  }
  if (body.stream === true) return 'responses/compact returns JSON and does not support stream=true'
  if (body.previous_response_id != null) return 'responses/compact requires input, not previous_response_id'
  return null
}

export function prepareCodexCompact(body, headers = {}) {
  const input = [...body.input]
  if (input.at(-1)?.type !== 'compaction_trigger') input.push({ type: 'compaction_trigger' })
  const next = {
    ...body,
    input,
    stream: true,
    store: false,
    tool_choice: 'none',
  }
  if (headers['x-openai-internal-codex-responses-lite'] === 'true') {
    next.reasoning = { ...next.reasoning, context: 'all_turns' }
    next.parallel_tool_calls = false
  }
  return next
}

export function compactHeaders(headers) {
  const features = String(headers['x-codex-beta-features'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return { ...headers, 'x-codex-beta-features': [...new Set([...features, 'remote_compaction_v2'])].join(',') }
}

/** Progress and token usage never prove that a usable compressed window was produced. */
export function createCodexCompactCollector(input) {
  let completed = null
  let failed = false
  const doneItems = []
  return {
    accept(line) {
      if (!line.startsWith('data:')) return
      let event
      try {
        event = JSON.parse(line.slice(5).trim())
      } catch {
        return
      }
      if (['error', 'response.failed', 'response.error', 'response.incomplete'].includes(event.type)) failed = true
      if (event.type === 'response.output_item.done' && event.item) doneItems.push(event.item)
      if (event.type === 'response.completed') completed = event.response
    },
    finish() {
      if (failed || !completed || (completed.status && completed.status !== 'completed')) return null
      const output = Array.isArray(completed.output) && completed.output.length ? completed.output : doneItems
      const compactions = output.filter((item) => item?.type === 'compaction')
      if (
        compactions.length !== 1 ||
        typeof compactions[0].encrypted_content !== 'string' ||
        !compactions[0].encrypted_content
      )
        return null
      // Keep all caller-authored messages; the encrypted item carries assistant/tool state.
      // Preserve every upstream output item and never cut history before compaction succeeds.
      const retained = input.filter(
        (item) => (item?.type === 'message' || !item?.type) && ['user', 'developer', 'system'].includes(item?.role),
      )
      return {
        id: completed.id,
        object: 'response.compaction',
        created_at: completed.created_at,
        output: [...retained, ...output],
        usage: completed.usage,
      }
    },
  }
}
