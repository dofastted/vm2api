/** Explicit full-lifecycle scopes for tests that exercise coordinated SQL, rather than repository-only fixtures. */
import { getActivityCoordinator, registerActivityCoordinator } from '../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../src/lib/db/global-maintenance.mjs'

export async function withDatabaseActivities(databases, callback) {
  const gates = []
  for (const db of new Set(databases)) {
    let coordinator = getActivityCoordinator(db)
    if (!coordinator) {
      coordinator = new GlobalMaintenanceCoordinator(db)
      await coordinator.start()
      registerActivityCoordinator(db, coordinator)
    }
    const state = await coordinator.getState()
    if (db.bootstrapActivity) {
      await coordinator.acknowledgeEpoch(state.epoch)
      await db.bootstrapActivity.complete({ ended: true, reason: 'test_database_initialized' })
    } else {
      await coordinator.acknowledgeEpoch(state.epoch)
    }
    gates.push(await coordinator.admit({ kind: 'test' }))
  }
  let ended = false
  try {
    const run = (index) => (index === gates.length ? callback() : gates[index].run(() => run(index + 1)))
    const value = await run(0)
    ended = true
    return value
  } finally {
    await Promise.all(gates.map((gate) => gate.complete({ ended, reason: ended ? 'test_completed' : 'test_failed' })))
  }
}
