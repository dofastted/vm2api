import { registerHooks } from 'node:module'

const effects = new Map([
  ['../../src/lib/vm/egress.mjs', ['ensureProxyEgress', 'ensureLocalProxyEgress', 'startProxyEgress', 'stopProxyEgress']],
  ['../../src/lib/vm/vm-db-sync.mjs', ['initVmDbSync']],
  ['../../src/lib/vm/vm-runtime.mjs', ['refreshSlotGuestBinDir']],
  ['../../src/lib/cluster/node-egress-socks.mjs', ['startNodeEgressSocks']],
  ['../../src/lib/cluster/placement.mjs', ['nodeSession']],
].map(([file, names]) => [new URL(file, import.meta.url).href, names]))

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    const names = effects.get(resolved.url)
    if (!names) return resolved
    const original = JSON.stringify(resolved.url + '?ha-original')
    const source = `import fs from 'node:fs'; export * from ${original};
      function deny(name) { fs.appendFileSync(process.env.VM2API_TEST_HOST_BARRIER_FILE, name+'\\n'); throw new Error('HA attempted legacy host effect: '+name) }
      ${names.map((name) => `export function ${name}() { return deny(${JSON.stringify(name)}) }`).join('\n')}`
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true }
  },
})
