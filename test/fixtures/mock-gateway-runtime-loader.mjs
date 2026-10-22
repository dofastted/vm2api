import { registerHooks } from 'node:module'

if (process.env.KIN_CRS_MOCK !== '1') throw new Error('mock gateway runtime requires KIN_CRS_MOCK=1')

const mocked = new Set([
  '../../src/lib/vm/egress.mjs',
  '../../src/lib/vm/proxy-geo.mjs',
  '../../src/lib/cluster/docker-remote.mjs',
].map((file) => new URL(file, import.meta.url).href))
const fixture = new URL('./mock-gateway-runtime.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    return mocked.has(resolved.url) ? { ...resolved, url: fixture } : resolved
  },
})
