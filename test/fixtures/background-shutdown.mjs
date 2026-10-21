import fs from 'node:fs'
import path from 'node:path'
import { getDb, getActivityCoordinator } from '../../src/lib/db/database.mjs'
import { getSharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'

const directory = process.env.VM2API_SYNTHETIC_BACKGROUND_DIRECTORY
if (directory) {
  let checking = false
  const timer = setInterval(async () => {
    if (checking) return
    checking = true
    let db
    try {
      db = getDb()
      if (!(await getActivityCoordinator(db)?.isReady())) {
        checking = false
        return
      }
    } catch {
      checking = false
      return
    }
    clearInterval(timer)
    getSharedBackgroundTasks(db).run({ taskKey: 'synthetic-shutdown-background', executionId: 'one' }, async () => {
      fs.writeFileSync(path.join(directory, 'started'), '1')
      await new Promise((resolve) => {
        const release = setInterval(() => {
          if (!fs.existsSync(path.join(directory, 'release'))) return
          clearInterval(release)
          resolve()
        }, 10)
      })
      await db.query("INSERT INTO settings(key,value) VALUES ('synthetic-background-ended','true')")
      return { terminal: true }
    }).catch((error) => fs.writeFileSync(path.join(directory, 'error'), error.code || error.name))
  }, 10)
}
