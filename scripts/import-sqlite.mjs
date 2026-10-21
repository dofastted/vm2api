import { parseArgs } from 'node:util'
import { createDatabase } from '../src/lib/db/database.mjs'
import { importSqlite } from '../src/lib/db/sqlite-import.mjs'
const { values } = parseArgs({ options: { source: { type: 'string' } } })
if (!values.source) throw new Error('usage: npm run db:import:sqlite -- --source <consistent-snapshot.db>')
const db = await createDatabase({ allowLegacySource: true })
try {
  const manifest = await importSqlite({ source: values.source, db })
  console.log(JSON.stringify({ ok: true, source_sha256: manifest.source_sha256, tables: manifest.tables }))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await db.close()
}
