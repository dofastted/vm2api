import './ha-no-host-loader.mjs'
import { registerHooks } from 'node:module'

// Fail closed at legacy I/O entry points while leaving PG, TLS, protocol and
// scheduler implementations intact. The real Go fixture owns its fake Engine.
const denied = new Map([
  ['../../src/lib/oauth/oauth-credentials.mjs', ['readWorkerCredentialFile', 'readSlotCredentialIdentity', 'mirrorWorkerCredentialsToVm', 'writeWorkerCredentialFile', 'ensureOfficialCredentialLink']],
  ['../../src/lib/cluster/docker-remote.mjs', ['sshDocker', 'localDocker', 'dockerRequest', 'dockerJson', 'dockerPing', 'dockerInfo', 'listContainers', 'pullImage', 'ensureImage', 'createAndStartContainer', 'containerAction', 'removeContainer', 'renameContainer', 'containerLogs', 'inspectContainerOrNull', 'createContainerRaw', 'execDetached', 'openExecTty', 'resizeExec', 'inspectExec', 'imagePresent', 'inspectNetworkOrNull', 'createNetwork', 'removeNetwork', 'disconnectContainerFromNetwork', 'connectContainerToNetwork', 'buildImage']],
  ['../../src/lib/cluster/ssh-link.mjs', ['connectSsh', 'forwardOut', 'forwardOutStreamLocal', 'execCollect']],
  ['../../src/lib/cluster/remote-fs.mjs', ['openSftp', 'writeRemoteFile', 'readRemoteFileNoFollow', 'remoteSymlink', 'runRemote']],
].map(([file, names]) => [new URL(file, import.meta.url).href, names]))

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    const names = denied.get(resolved.url)
    if (!names) return resolved
    const original = JSON.stringify(resolved.url + '?ha-flow-original')
    const source = `import fs from 'node:fs'; export * from ${original};
      function deny(name) { fs.appendFileSync(process.env.VM2API_TEST_HOST_BARRIER_FILE,name+'\\n'); throw new Error('HA attempted legacy request I/O: '+name) }
      ${names.map((name) => `export function ${name}() { return deny(${JSON.stringify(name)}) }`).join('\n')}`
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true }
  },
})
