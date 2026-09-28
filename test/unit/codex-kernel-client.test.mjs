import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { codexKernelPaths, withCodexKernelExec } from '../../src/lib/transport/codex-kernel-client.mjs'
import { writeCodexKernelConfig } from '../../src/lib/transport/codex-kernel-supervisor.mjs'
import fs from 'node:fs'
import os from 'node:os'

test('codex kernel socket is not worker.sock', () => {
  const exec = {
    homeDir: '/tmp/vms/vm-codex/cli-home',
    vm: { id: 'vm-codex', runtime: {} },
  }
  const paths = codexKernelPaths(exec)
  assert.equal(paths.socketPath, path.join('/tmp/vms/vm-codex/run', 'codex-kernel.sock'))
  const remapped = withCodexKernelExec(exec)
  assert.match(remapped.vm.runtime.worker_socket, /codex-kernel\.sock$/)
})

test('writeCodexKernelConfig writes bound SOCKS proxy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  const vm = { id: 'vm-codex', proxy: { url: 'socks5://127.0.0.1:1080' } }
  const written = writeCodexKernelConfig(root, vm, {
    token: 'secret',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    proxyRequired: true,
  })
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_required, true)
  assert.equal(cfg.proxy_url, 'socks5h://127.0.0.1:1080')
  assert.equal(cfg.socket_path, written.socketPath)
  assert.equal(cfg.internal_token, 'secret')
  assert.equal(cfg.max_request_bytes, 32 * 1024 * 1024)
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeCodexKernelConfig fail-closes proxy_required without a URL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  const written = writeCodexKernelConfig(
    root,
    { id: 'vm-codex' },
    { token: 'secret', proxyUrl: '', proxyRequired: true },
  )
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_required, true)
  assert.equal(cfg.proxy_url, '')
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeCodexKernelConfig treats local egress as a direct exit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  const written = writeCodexKernelConfig(
    root,
    { id: 'vm-codex', proxy: { id: 'px-local', scheme: 'local', host: 'local', port: 0 } },
    { token: 'secret', proxyUrl: 'socks5h://127.0.0.1:1080', proxyRequired: true },
  )
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_required, false)
  assert.equal(cfg.proxy_url, '')
  fs.rmSync(root, { recursive: true, force: true })
})
