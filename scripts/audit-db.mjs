/** Shared read-only PostgreSQL connection for the four audit commands. */
import pg from 'pg'
import { quoteIdentifier, resolveDatabaseUrl } from '../src/lib/db/database.mjs'

export async function openAuditDb() {
  const schema = process.env.VM2API_DATABASE_SCHEMA || process.env.KIN_DATABASE_SCHEMA || 'public'
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('invalid database schema')
  const client = new pg.Client({
    connectionString: resolveDatabaseUrl(),
    options: `-c default_transaction_read_only=on -c search_path=${quoteIdentifier(schema)},pg_catalog -c timezone=UTC`,
    types: {
      getTypeParser(oid, format) {
        if (format !== 'binary' && (oid === 20 || oid === 1700))
          return (value) => {
            const number = Number(value)
            return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : value
          }
        return pg.types.getTypeParser(oid, format)
      },
    },
  })
  try {
    await client.connect()
  } catch {
    throw new Error('PostgreSQL audit connection failed')
  }
  const query = async (sql, params) => {
    try {
      return await client.query(sql, params)
    } catch (error) {
      throw new Error(`PostgreSQL audit query failed (${error.code || 'database_error'})`)
    }
  }
  return {
    prepare: (sql) => ({
      all: async (...params) => (await query(sql, params)).rows,
      get: async (...params) => (await query(sql, params)).rows[0],
    }),
    close: () => client.end(),
  }
}
