import fs from 'node:fs'
import { resolveKernelDataplane } from './slot-engine.mjs'
import { isCodexVm } from './vm-kind.mjs'

let kernelCpuScript

export function usesKernelCpuLimit(vm, routing = {}) {
  return !isCodexVm(vm) && resolveKernelDataplane(vm, routing) !== 'crag'
}

export function kernelCpuCommand(argv) {
  const script = readKernelCpuScript()
  return ['/bin/sh', '-c', script, 'kin-kernel-cpu', ...argv]
}

export function kernelCpuCommandMatches(argv, executable) {
  return (
    Array.isArray(argv) &&
    argv[0] === '/bin/sh' &&
    argv[1] === '-c' &&
    typeof argv[2] === 'string' &&
    argv[2].length > 0 &&
    argv[3] === 'kin-kernel-cpu' &&
    (executable ? argv[4] === executable : /(?:^|\/)kin-kernel$/.test(String(argv[4] || '')))
  )
}

function readKernelCpuScript() {
  return (kernelCpuScript ??= fs.readFileSync(
    new URL('../../../docker/kin-kvm/guest/kin-kernel-cpu', import.meta.url),
    'utf8',
  ))
}
