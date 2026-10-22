import { getDb, withTransaction } from '../database.mjs'

export class GatewayRateBucketsRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  async allow(bucketHash, { capacity, refillPerSec }) {
    return withTransaction(this.db, async () => {
      await this.db
        .prepare(`
        INSERT INTO gateway_rate_buckets (bucket_hash, tokens, updated_at)
        VALUES ($1, $2, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
        ON CONFLICT (bucket_hash) DO NOTHING
      `)
        .run(bucketHash, capacity)
      const bucket = await this.db
        .prepare(`
        SELECT tokens, updated_at FROM gateway_rate_buckets WHERE bucket_hash = $1 FOR UPDATE
      `)
        .get(bucketHash)
      // Read the shared clock after taking the row lock, including time spent waiting.
      const { now: databaseNow } = await this.db
        .prepare('SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now')
        .get()
      const now = Math.max(databaseNow, bucket.updated_at)
      const tokens = Math.min(capacity, bucket.tokens + (Math.max(0, now - bucket.updated_at) / 1000) * refillPerSec)
      const allowed = tokens >= 1
      await this.db
        .prepare('UPDATE gateway_rate_buckets SET tokens = $2, updated_at = $3 WHERE bucket_hash = $1')
        .run(bucketHash, allowed ? tokens - 1 : tokens, now)
      return allowed
    })
  }
}
