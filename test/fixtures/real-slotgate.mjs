import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function realSlotgate(t) {
  // Keep the incarnation Unix path below the platform sockaddr_un limit.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg2-'))
  const repository = fileURLToPath(new URL('../../', import.meta.url))
  const worker = path.join(root, 'worker')
  fs.cpSync(path.join(repository, 'worker'), worker, { recursive: true })
  const cmd = path.join(worker, 'cmd', 'slotgate-client-fixture')
  fs.mkdirSync(cmd, { recursive: true })
  fs.copyFileSync(fileURLToPath(new URL('./slotgate-client-node.go', import.meta.url)), path.join(cmd, 'main.go'))
  const binary = path.join(root, 'node-fixture')
  let process
  let exited
  t.after(async () => {
    try {
      if (process && process.exitCode == null) {
        process.kill('SIGTERM')
        const timer = setTimeout(() => process.kill('SIGKILL'), 3000)
        try { await exited } finally { clearTimeout(timer) }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  execFileSync('go', ['build', '-buildvcs=false', '-o', binary, './cmd/slotgate-client-fixture'], {
    cwd: worker, env: { ...globalThis.process.env, GOCACHE: '/tmp/vm2api-648-go-cache', GOPROXY: 'off' }, stdio: 'pipe', timeout: 60000,
  })
  const runtime = path.join(root, 'runtime')
  fs.mkdirSync(runtime, { mode: 0o700 })
  const kernelTokenFile = path.join(runtime, 'internal.token')
  fs.writeFileSync(kernelTokenFile, 'synthetic-kernel-internal-token\n', { mode: 0o600 })
  process = spawn(binary, [runtime], { stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(process, 'exit')
  return new Promise((resolve, reject) => {
    let buffer = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error('synthetic slotgate fixture startup timeout')), 5000)
    process.once('error', (error) => { clearTimeout(timer); reject(error) })
    process.once('exit', (code) => { clearTimeout(timer); if (code) reject(new Error(`synthetic slotgate fixture exit ${code}: ${stderr}`)) })
    process.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192) })
    process.stdout.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      try { resolve({ ...JSON.parse(buffer.slice(0, newline)), kernelTokenFile }) } catch (error) { reject(error) }
    })
  })
}
