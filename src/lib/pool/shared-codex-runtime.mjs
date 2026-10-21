import { getDb } from '../db/database.mjs'
import { SharedExecutionAdmissions } from './shared-execution-admissions.mjs'
import { SharedSessionTurns } from './shared-session-turns.mjs'
import { readCodexAccounts } from '../vm/codex-slot.mjs'
import { normalizeOpenAIQuotaPolicy } from './openai-quota-policy.mjs'

function identityError() {
  return Object.assign(new Error('Shared Codex execution requires exactly one account with chatgpt_account_id'), {
    code: 'codex_account_identity_unavailable',
  })
}

/** Reuses the durable Claude execution ledger and FIFO without process-local capacity authority. */
export class SharedCodexRuntime {
  constructor(db = getDb(), options = {}) {
    this.db = db
    this.admissions = new SharedExecutionAdmissions(db, options)
    this.turns = new SharedSessionTurns(db, options)
  }

  accountId(projectRoot, vm) {
    const accounts = readCodexAccounts(projectRoot, vm.id)
    const id = accounts.length === 1 ? String(accounts[0]?.chatgpt_account_id || '').trim() : ''
    if (!id) throw identityError()
    return `codex:${id}`
  }

  async signals(projectRoot, vms, policy) {
    const signals = new Map()
    for (const vm of vms) {
      let accountId
      try {
        accountId = this.accountId(projectRoot, vm)
      } catch (error) {
        if (error.code === 'codex_account_identity_unavailable') continue
        throw error
      }
      const counts = await this.admissions.getCounts(accountId, vm.id)
      signals.set(vm.id, {
        inFlight: counts.vmInflight,
        rpmCount: counts.rpmCount,
        rpmResetAt: counts.rpmResetAt,
        maxRpm: normalizeOpenAIQuotaPolicy(policy).max_rpm,
      })
    }
    return signals
  }

  async tryReserve(projectRoot, vm, candidate, policy) {
    if (!vm) return null
    const limits = normalizeOpenAIQuotaPolicy(policy)
    const gate = await this.admissions.tryReserve({
      accountId: this.accountId(projectRoot, vm),
      vmId: vm.id,
      accountLimit: limits.max_concurrency,
      vmLimit: candidate.concurrency,
      rpmLimit: limits.max_rpm,
      fableLimit: 0,
      family: 'codex',
    })
    if (!gate.ok) return null
    let releasing = null
    const lease = {
      ...gate,
      uncertain: false,
      released: false,
      markUncertain: async () => {
        if (lease.released) return { uncertain: false }
        lease.uncertain = true
        return gate.markUncertain()
      },
      release: async () => {
        if (lease.released) return { released: true }
        if (lease.uncertain) {
          await lease.markUncertain()
          return { released: false }
        }
        if (releasing) return releasing
        releasing = (async () => {
          try {
            const result = await gate.release()
            if (result.released) lease.released = true
            else await lease.markUncertain()
            return result
          } catch (error) {
            lease.uncertain = true
            throw error
          } finally {
            releasing = null
          }
        })()
        return releasing
      },
    }
    return lease
  }

  async invoke(lease, hop, args) {
    let bound = false
    let completed = false
    try {
      const result = await hop({
        ...args,
        onExecutionStart: async (execution) => {
          await lease.bindExecution(execution)
          bound = true
        },
        onExecutionEnd: async (execution) => {
          await lease.completeExecution(execution)
          completed = execution?.ended === true
          if (!completed) await lease.markUncertain()
        },
      })
      const notStarted = result?.execution?.started === false && result?.execution?.ended === true && !bound
      if ((!bound || !completed || result?.execution?.ended !== true) && !notStarted) {
        await lease.markUncertain()
        if (result) result.executionUncertain = true
      }
      return result
    } catch (error) {
      await lease.markUncertain()
      if (error && typeof error === 'object') error.executionUncertain = true
      throw error
    }
  }
}
