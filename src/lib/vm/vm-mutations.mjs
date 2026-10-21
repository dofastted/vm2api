import path from 'node:path'
import { isValidVmId, withVmLock } from './vm-file.mjs'
import { physicalContainerName } from './vm-physical-target.mjs'

/** Acquire the complete target set before a batch can change any VM. */
export function withVmMutations(projectRoot, ids, callback, { operations, kind = 'mutation' } = {}) {
  const ordered = [...new Set(ids)]
  for (const id of ordered) {
    if (!isValidVmId(id))
      throw Object.assign(new Error('invalid VM operation ID'), { code: 'invalid_vm_operation', status: 400 })
  }
  ordered.sort((a, b) => physicalContainerName(a).localeCompare(physicalContainerName(b)) || a.localeCompare(b))
  const handles = new Map()
  let entered = false
  const acquire = (index) => {
    if (index === ordered.length) {
      entered = true
      return callback(handles)
    }
    const id = ordered[index]
    return withVmLock(
      path.join(projectRoot, 'vms', `${id}.json`),
      async (operation) => {
        handles.set(id, operation)
        try {
          return await acquire(index + 1)
        } catch (error) {
          // Nothing was sent or written when a later target refused its claim.
          if (!entered) error.vmOperationNotStarted = true
          throw error
        } finally {
          handles.delete(id)
        }
      },
      { operations, vmId: id, kind },
    )
  }
  return acquire(0)
}
