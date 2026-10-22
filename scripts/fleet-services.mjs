import { runFleetUpdate } from '../src/lib/vm/fleet-update.mjs'

const root = process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/vm2api'
const concurrency = Number(process.argv[3] || 4)
const report = await runFleetUpdate(root, {
  action: 'telemetry',
  concurrency,
})
console.log(JSON.stringify(report))
if (report.skipped_count) {
  for (const item of report.items) {
    if (!item.skipped) continue
    const container = item.telemetry?.container || item.id
    console.warn(`[fleet-services] skipped ${item.id}: container unavailable (${container})`)
  }
}
if (report.failed_count) process.exit(1)
