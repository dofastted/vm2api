import fs from 'node:fs'
import path from 'node:path'
import { isValidVmId } from './vm-file.mjs'

/** Read display metadata only. Antigravity credentials remain with the slot's official CLI. */
export function summarizeAntigravitySlot(projectRoot, vm = {}) {
  const metadata = vm.antigravity || {}
  let auth = null
  if (projectRoot && isValidVmId(vm.id)) {
    try {
      const state = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'vms', vm.id, 'run', 'antigravity-auth.json'), 'utf8'),
      )
      if (state && typeof state === 'object' && !Array.isArray(state)) auth = state
    } catch {}
  }
  const authenticated = typeof auth?.authenticated === 'boolean' ? auth.authenticated : null
  return {
    email:
      authenticated === false
        ? null
        : typeof auth?.email === 'string'
          ? auth.email
          : typeof metadata.email === 'string'
            ? metadata.email
            : null,
    authenticated,
    updated_at: typeof auth?.updated_at === 'number' || typeof auth?.updated_at === 'string' ? auth.updated_at : null,
    has_token: false,
    has_refresh: false,
    credential_storage: 'slot-official-client',
    credential_state:
      authenticated === true ? 'authenticated' : authenticated === false ? 'unauthenticated' : 'unknown',
    experimental: false,
  }
}
