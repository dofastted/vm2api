import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { resolveKernelDataplane } from './slot-engine.mjs'

const admissions = new Map()
const lifecycle = new AsyncLocalStorage()

export function configureCragRuntimeAdmission(projectRoot, admission) {
  const key = path.resolve(projectRoot)
  if (admission) admissions.set(key, admission)
  else admissions.delete(key)
}

// The installer, container and native supervisor are nested during one boot.
// Only its own async chain may reuse a reservation, not another call for that VM.
export function withCragRuntimeAdmission(vm, projectRoot, options, start) {
  if (!projectRoot || !vm?.id) return start()
  const admission = admissions.get(path.resolve(projectRoot))
  if (!admission || resolveKernelDataplane(vm, options?.routing) !== 'crag') return start()
  const current = lifecycle.getStore()
  if (current?.active && current.admission === admission && current.id === vm.id) return start()
  return admission(vm, options || {}, async () => {
    const operation = { admission, id: vm.id, active: true }
    try {
      return await lifecycle.run(operation, start)
    } finally {
      operation.active = false
    }
  })
}
