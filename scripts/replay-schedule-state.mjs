#!/usr/bin/env node
/**
 * Dry-run the four-state schedule migration on a vms/ snapshot and print what
 * changes. Reads only; nothing is written.
 *
 *   node scripts/replay-schedule-state.mjs --project <dir>   # <dir>/vms/*.json
 *   node scripts/replay-schedule-state.mjs --project <dir> --json
 */
import fs from 'node:fs'
import path from 'node:path'
import { migrateScheduleRecord, resolveSlotState } from '../src/lib/pool/schedule-state.mjs'

function arg(name) {
  const at = process.argv.indexOf(name)
  return at > 0 ? process.argv[at + 1] : null
}

const project = arg('--project')
if (!project) {
  console.error('usage: node scripts/replay-schedule-state.mjs --project <dir> [--json]')
  process.exit(2)
}
const dir = path.join(project, 'vms')
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.json') && name !== 'active.json')
  .sort()

/** The three-state verdict the panel showed before this change (record fields only). */
function legacyState(vm) {
  const reason = String(vm.schedule_disabled_reason || '')
  const leftoverQuota = vm.schedule_manual !== true && /^(quota_5h|quota_7d)/.test(reason)
  if (vm.schedulable === false && !leftoverQuota) return 'off'
  if (leftoverQuota) return 'restricted'
  return 'on'
}

const rows = []
for (const name of files) {
  let vm
  try {
    vm = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
  } catch {
    continue
  }
  if (!vm?.id) continue
  const before = legacyState(vm)
  const copy = structuredClone(vm)
  migrateScheduleRecord(copy)
  const after = resolveSlotState({ vm: copy })
  rows.push({
    id: vm.id,
    legacy_reason: vm.schedule_disabled_reason || null,
    before,
    after: after.schedule_state,
    reason: after.unschedulable_reason || after.restriction_reason || null,
    // 受限 is derived live from quota / cooldown; a record-only replay cannot see it.
    changed: before !== after.schedule_state && !(before === 'restricted' && after.schedule_state === 'on'),
  })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const changed = rows.filter((row) => row.changed)
  for (const row of rows) {
    const mark = row.changed ? '*' : ' '
    console.log(
      `${mark} ${row.id.padEnd(12)} ${String(row.legacy_reason || '-').padEnd(32)} ${row.before.padEnd(10)} -> ${row.after}${row.reason ? ` (${row.reason})` : ''}`,
    )
  }
  const unknown = rows.filter((row) => row.reason === 'legacy_unknown')
  console.log(`\n${rows.length} slots, ${changed.length} change state, ${unknown.length} legacy_unknown to confirm`)
  console.log('受限 is computed live (quota, cooldown, circuit); this replay only reads vm records.')
}
