/**
 * Egress maintenance entry point, for the deploy flow and for operators.
 *
 * The residue scanner and the reprovision orchestrator deliberately hold no
 * database and no control-plane knowledge, so something has to supply the live
 * proxy/VM set and the helper-rebuild callbacks. This is that something.
 *
 *   node scripts/egress-maintenance.mjs verify
 *   node scripts/egress-maintenance.mjs sweep                 # dry by default
 *   node scripts/egress-maintenance.mjs sweep --apply
 *   node scripts/egress-maintenance.mjs reprovision           # dry by default
 *   node scripts/egress-maintenance.mjs reprovision --apply
 *   node scripts/egress-maintenance.mjs rollback --snapshot=DIR
 *
 *   --root=PATH   install directory (default /opt/kin-gateway)
 *   --force       act on an incomplete live set; see the refusal it bypasses
 *   --json        machine-readable output
 *
 * Exit code is non-zero when the action refused, failed, or left residue, so a
 * deploy script can branch on it.
 */
import path from 'node:path'
import { ProxyPool } from '../src/lib/vm/proxy-pool.mjs'
import { listVms } from '../src/lib/vm/vm-registry.mjs'
import { ensureProxyEgress, proxyEgressReady } from '../src/lib/vm/egress.mjs'
import { reprovision } from '../src/lib/vm/egress-reprovision.mjs'
import {
  collectLiveSet,
  maintenanceExecutors,
  reprovisionEgress,
  sweepEgress,
  verifyEgress,
} from '../src/lib/vm/egress-maintenance.mjs'

const argv = process.argv.slice(2)
const action = argv.find((a) => !a.startsWith('-')) || 'verify'
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const projectRoot = value('root') || '/opt/kin-gateway'
const dataDir = path.join(projectRoot, 'data')
const apply = flag('apply')
const force = flag('force')
const asJson = flag('json')

const live = collectLiveSet({
  projectRoot,
  dataDir,
  listVms,
  openPool: ({ dataDir: dir }) => new ProxyPool({ dataDir: dir }),
})
const execs = maintenanceExecutors()

function render(result) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const { lines, phases, feasibility, ...rest } = result
  console.log(JSON.stringify(rest, null, 2))
  for (const c of feasibility || []) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
  for (const p of phases || []) console.log(`  ${p.ok ? 'ok  ' : 'FAIL'} ${p.name}: ${p.detail}`)
  for (const line of lines || []) console.log(`  ${line}`)
}

/** Non-zero whenever an operator or a deploy script should stop and look. */
function exitCodeOf(result) {
  if (result.refused) return 2
  if (result.failed?.length) return 1
  if (result.aborted) return 1
  if (result.ok === false) return 1
  // A real pass that left residue behind, or could not prove it did not.
  if (result.action !== 'reprovision' && result.clean === false) return 1
  if (result.action === 'verify' && !result.clean) return 1
  return 0
}

let result
switch (action) {
  case 'verify':
    result = verifyEgress({ projectRoot, live, ...execs })
    break
  case 'sweep':
    result = sweepEgress({ projectRoot, live, ...execs, apply, force })
    break
  case 'reprovision':
  case 'rollback':
    result = await reprovisionEgress({
      projectRoot,
      live,
      ...execs,
      apply: action === 'rollback' ? true : apply,
      force,
      target: action === 'rollback' ? 'snapshot' : 'pool',
      snapshotDir: value('snapshot'),
      ensureProxyEgress,
      proxyEgressReady,
      reprovision,
    })
    break
  default:
    console.error(`unknown action: ${action}`)
    console.error('expected one of: verify, sweep, reprovision, rollback')
    process.exit(64)
}

if (!live.complete) {
  console.error(`[warn] live set incomplete: ${live.reason}`)
}
render(result)
process.exit(exitCodeOf(result))
