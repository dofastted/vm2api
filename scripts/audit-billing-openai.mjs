import { openAuditDb } from './audit-db.mjs'

const db = await openAuditDb()
const rows = (sql) => db.prepare(sql).all()

try {
  const out = {
    openai_chat: await rows(`
    SELECT stream, status, final_state, error_code,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      ROUND((total_cost)::numeric,6) AS cost, substr(user_agent,1,50) AS ua, model, stop_reason
    FROM usage_logs WHERE protocol = 'openai.chat'
    ORDER BY created_at DESC LIMIT 40
  `),
    openai_python: await rows(`
    SELECT stream, status, final_state, error_code,
      input_tokens, output_tokens, ROUND((total_cost)::numeric,6) AS cost, model, via
    FROM usage_logs WHERE user_agent ILIKE 'OpenAI/%'
    ORDER BY created_at DESC
  `),
    openai_ok_null: await rows(`
    SELECT COUNT(*) AS n, SUM(stream) AS streams,
      SUM(CASE WHEN final_state = 'incomplete' THEN 1 ELSE 0 END) AS incomplete,
      SUM(CASE WHEN final_state = 'verified' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) AS with_err
    FROM usage_logs
    WHERE protocol ILIKE 'openai%' AND status BETWEEN 200 AND 299 AND input_tokens IS NULL
  `),
    openai_ok_with_tok: await rows(`
    SELECT COUNT(*) AS n, SUM(stream) AS streams,
      SUM(COALESCE(input_tokens,0)) AS in_tok,
      SUM(COALESCE(output_tokens,0)) AS out_tok,
      SUM(COALESCE(cache_read_tokens,0)) AS cache_read,
      ROUND((SUM(COALESCE(total_cost,0)))::numeric,6) AS cost
    FROM usage_logs
    WHERE protocol ILIKE 'openai%' AND status BETWEEN 200 AND 299 AND input_tokens IS NOT NULL
  `),
    stream_ok_null: await rows(`
    SELECT protocol, COUNT(*) AS n, error_code, final_state
    FROM usage_logs
    WHERE stream = 1 AND status BETWEEN 200 AND 299 AND input_tokens IS NULL
    GROUP BY protocol, error_code, final_state
    ORDER BY n DESC
  `),
    vm_test_anywhere: await rows(`
    SELECT COUNT(*) AS n FROM usage_logs
    WHERE user_agent ILIKE '%kin-console-test%' OR path ILIKE '%test-chat%'
  `),
  }

  console.log(JSON.stringify(out, null, 2))
} finally {
  await db.close()
}
