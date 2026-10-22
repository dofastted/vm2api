import { PostgresDatabase } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'

const url = process.env.VM2API_TEST_DATABASE_URL
if (!url || !/_test$/.test(new URL(url).pathname)) throw new Error('dedicated test database required')
const db = new PostgresDatabase({ connectionString: url, schema: process.env.KIN_DATABASE_SCHEMA })
const coordinator = new GlobalMaintenanceCoordinator(db, { ownerId: 'synthetic-killed-owner' })
await coordinator.start()
process.send({ ready: true })
