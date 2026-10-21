import { openAuditDb } from './audit-db.mjs'

const db = await openAuditDb()

try {
  const acc = await db
    .prepare(`
  SELECT vm_id,
         extra::jsonb #>> '{unified,7d,utilization}' AS u7,
         extra::jsonb #>> '{unified,7d,status}' AS s7,
         extra::jsonb #>> '{unified,7d_oi,utilization}' AS uoi,
         extra::jsonb #>> '{unified,7d_oi,status}' AS soi,
         extra::jsonb #>> '{unified,5h,utilization}' AS u5
  FROM accounts
`)
    .all()

  const logs = await db
    .prepare(`
  SELECT
    CASE
      WHEN model ILIKE '%fable%' OR upstream_model ILIKE '%fable%' THEN 'fable'
      WHEN model ILIKE '%opus%' OR upstream_model ILIKE '%opus%' THEN 'opus'
      WHEN model ILIKE '%sonnet%' OR upstream_model ILIKE '%sonnet%' THEN 'sonnet'
      WHEN model ILIKE '%haiku%' OR upstream_model ILIKE '%haiku%' THEN 'haiku'
      ELSE 'other'
    END AS fam,
    COUNT(*) AS n,
    ROUND((SUM(COALESCE(total_cost,0)))::numeric,4) AS cost,
    SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0)) AS toks
  FROM usage_logs
  WHERE created_at >= to_char(now() AT TIME ZONE 'UTC' - interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  GROUP BY fam
  ORDER BY cost DESC
`)
    .all()

  console.log(JSON.stringify({ quota: acc, last7d_by_family: logs }, null, 2))
} finally {
  await db.close()
}
