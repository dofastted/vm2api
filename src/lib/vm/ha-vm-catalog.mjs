import { VmsRepo } from '../db/repos/vms-repo.mjs'
import { stripCredentialSecrets } from '../oauth/oauth-credentials.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { isValidVmId } from './vm-file.mjs'

function unavailable() {
  return Object.assign(new Error('HA VM catalog is unavailable'), { code: 'ha_vm_catalog_unavailable', status: 503 })
}

/** HA metadata is a read projection of PostgreSQL. Node credentials never live here. */
export class HaVmCatalog {
  constructor(db) {
    this.repo = new VmsRepo(db)
    this.records = null
    this.pending = Promise.resolve()
  }

  refresh() {
    const read = async () => {
      try {
        const rows = await this.repo.list()
        const next = new Map()
        for (const row of rows) {
          const vm = row.vm
          if (!vm || vm.id !== row.id || !isValidVmId(vm.id)) throw unavailable()
          // This HA preset serves ordinary Claude Docker slots only.
          if (isCodexVm(vm) || isKvmRuntime(vm)) continue
          next.set(vm.id, { ...vm, claude: stripCredentialSecrets(vm.claude || {}) })
        }
        this.records = next
      } catch (error) {
        this.records = null
        throw error
      }
    }
    // Serialize discovery so a slow older SELECT cannot replace a newer snapshot.
    this.pending = this.pending.then(read, read)
    return this.pending
  }

  get(id) {
    if (!this.records) throw unavailable()
    return structuredClone(this.records.get(id) || null)
  }

  list() {
    if (!this.records) throw unavailable()
    return structuredClone([...this.records.values()])
  }
}

let bound = null

export function bindHaVmCatalog(catalog) {
  bound = catalog
}

export function haVmCatalog() {
  if (!bound) throw unavailable()
  return bound
}
