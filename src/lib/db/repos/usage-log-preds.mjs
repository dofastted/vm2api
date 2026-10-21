/**
 * SQL predicates over `usage_logs` shared by every reader (legacy request-log
 * repo, scrolling log view, statistics). Columns are unqualified: callers query
 * `usage_logs` without joins and resolve display names separately.
 */

import { ignoredErrorSqlList, slaOkErrorSqlList } from '../../admin/error-class.mjs'
import { addInteger } from '../integers.mjs'

const IGNORED_CODES_SQL = ignoredErrorSqlList()
const SLA_OK_CODES_SQL = slaOkErrorSqlList()

export const ERROR_PRED = `(status >= 400 OR (error_code IS NOT NULL AND error_code != '' AND error_code NOT IN (${IGNORED_CODES_SQL})))`
export const SUCCESS_PRED = `(status < 400 AND (error_code IS NULL OR error_code = '' OR error_code IN (${IGNORED_CODES_SQL})))`
const SLA_OK_PRED = `(status = 429 OR (error_code IS NOT NULL AND error_code != '' AND error_code IN (${SLA_OK_CODES_SQL})))`
export const SLA_SUCCESS_PRED = `(${SUCCESS_PRED} OR ${SLA_OK_PRED})`
export const SLA_ERROR_PRED = `(${ERROR_PRED} AND NOT (${SLA_OK_PRED}))`

// After migration 037 every row stores disjoint input. Prompt (cache hit
// denominator) is the input-side total; total tokens also include output.
export const PROMPT_TOKENS_SQL =
  'COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)'
export const TOTAL_TOKENS_SQL =
  'COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)'

export function totalTokens(row = {}) {
  return [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens].reduce(
    (sum, value) => addInteger(sum, value),
    0,
  )
}

/** Rows a panel `user` owns: own user_id, one of their live keys, or served by a slot they owned at the time. */
export function ownerPred(ownerUserId, offset = 0) {
  const id = String(ownerUserId || '').trim()
  if (!id) return { sql: '', params: [] }
  return {
    sql: `(user_id = $${offset + 1} OR COALESCE(api_key_id, '') IN (SELECT id FROM api_keys WHERE user_id = $${offset + 2} AND deleted_at IS NULL) OR vm_owner_user_id = $${offset + 3})`,
    params: [id, id, id],
  }
}
