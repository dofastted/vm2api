import fs from 'node:fs'
import { getDb } from '../db/database.mjs'
import { codexCredentialPath, writeCodexAccounts } from '../vm/codex-slot.mjs'
import { flushVmDbSync } from '../vm/vm-db-sync.mjs'
import { refreshCodexAccessToken } from '../protocol/codex-models.mjs'
import {
  credentialGeneration,
  currentRefreshAdmission,
  getSharedCredentialRefresh,
} from './shared-credential-refresh.mjs'

/** Shared authority is the committed credential file, never a VM metadata fallback. */
export async function refreshSharedCodexCredential({
  projectRoot,
  vm,
  db = getDb(),
  refresh = refreshCodexAccessToken,
  fetchImpl,
  proxyUrl,
  timeoutMs,
  expectedGeneration,
}) {
  const readCurrent = async () => {
    const accounts = JSON.parse(fs.readFileSync(codexCredentialPath(projectRoot, vm.id), 'utf8'))?.accounts
    const credential = accounts?.length === 1 ? accounts[0] : null
    if (!credential?.chatgpt_account_id || !credential?.refresh_token)
      throw Object.assign(new Error('shared Codex credential unavailable'), { code: 'codex_credential_unavailable' })
    return { credential, generation: credentialGeneration(credential) }
  }
  const observed = await readCurrent()
  return getSharedCredentialRefresh(db).run(
    {
      platform: 'codex',
      vmId: vm.id,
      accountId: `codex:${observed.credential.chatgpt_account_id}`,
      expectedGeneration: expectedGeneration === undefined ? observed.generation : expectedGeneration,
      admission: currentRefreshAdmission(db),
    },
    {
      readCurrent,
      refresh: async (current) => {
        const value = await refresh({ refreshToken: current.credential.refresh_token, proxyUrl, fetchImpl, timeoutMs })
        return { finished: value?.attemptFinished === true, value }
      },
      publish: async (current, value) => {
        const fresh = await readCurrent()
        if (fresh.generation !== current.generation)
          throw Object.assign(new Error('Codex credential changed during refresh'), {
            code: 'credential_generation_changed',
          })
        writeCodexAccounts(projectRoot, vm.id, [
          {
            ...fresh.credential,
            access_token: value.access_token,
            refresh_token: value.refresh_token || fresh.credential.refresh_token,
            id_token: value.id_token || fresh.credential.id_token,
            expires_at: value.expires_at || fresh.credential.expires_at,
          },
        ])
        await flushVmDbSync()
        return readCurrent()
      },
    },
  )
}
