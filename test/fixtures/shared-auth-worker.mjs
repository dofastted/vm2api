import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { generateCodexAuthUrl, exchangeCodexAuthCode } from '../../src/lib/oauth/codex-oauth.mjs'
import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'

process.once('message', async ({ operation, args }) => {
  try {
    const db = await openDatabase()
    let result
    if (operation === 'issueCodex') result = await generateCodexAuthUrl(args)
    else if (operation === 'exchangeCodex' || operation === 'claimCodexForever') {
      await exchangeCodexAuthCode({ ...args, fetchImpl: async () => {
        if (operation === 'claimCodexForever') {
          process.send({ event: 'provider_started' })
          await new Promise(() => {})
        }
        return { status: 200, json: async () => ({ access_token: 'synthetic', refresh_token: 'synthetic' }) }
      } })
      result = { exchanged: true }
    } else {
      const manager = new ClusterManager({ repo: { db }, dataDir: '/tmp' })
      manager.links.set('node-a', { state: 'ready', client: {} })
      result = operation === 'issueShell' ? await manager.issueShellTicket('node-a') : {
        accepted: await manager.consumeShellTicket(args.ticket, args.nodeId),
      }
    }
    process.send({ result })
  } catch (error) {
    process.send({ error: error.code || 'child_failed' })
  } finally {
    await closeDatabase()
    process.disconnect()
  }
})
