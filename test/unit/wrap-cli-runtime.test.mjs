import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  WRAP_CLI_BIN,
  WRAP_CLI_FILES,
  CC_NODE_BIN,
  captureWrapSample,
  inspectLinuxAmd64Elf,
  inspectWrapCliDir,
  makeWrapSample,
  materializeCragV2,
  describeCragV2Package,
  materializeResolvedKernel,
  materializeSlotDataplane,
  materializeWrapCli,
  replaceKernelBinary,
  inspectKernelChanges,
  syncWrapSample,
  wrapCliHomeDir,
  wrapCliTemplateDir,
} from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { listVms } from '../../src/lib/vm/vm-registry.mjs'

const prevKernelBin = process.env.KIN_KERNEL_BIN

before(() => {
  delete process.env.KIN_KERNEL_BIN
})

after(() => {
  if (prevKernelBin == null) delete process.env.KIN_KERNEL_BIN
  else process.env.KIN_KERNEL_BIN = prevKernelBin
})

function seedTemplate(root) {
  const src = path.join(root, 'share', 'wrap-cli')
  fs.mkdirSync(src, { recursive: true })
  for (const name of [...WRAP_CLI_FILES, 'kin-kernel']) {
    fs.writeFileSync(path.join(src, name), name)
    fs.chmodSync(path.join(src, name), 0o644)
  }
  return src
}

function fakeElf64Amd64(payload = 'host-kernel') {
  const extra = Buffer.from(String(payload))
  const buf = Buffer.alloc(64 + extra.length)
  buf[0] = 0x7f
  buf[1] = 0x45
  buf[2] = 0x4c
  buf[3] = 0x46
  buf[4] = 2
  buf[5] = 1
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(62, 18)
  extra.copy(buf, 64)
  return buf
}

test('materializeWrapCli copies both CLIs into slot home', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-'))
  try {
    seedTemplate(project)
    const vm = { id: 'vm-13' }
    const result = materializeWrapCli(project, vm)
    assert.equal(result.ok, true)
    const dest = wrapCliHomeDir(project, 'vm-13')
    assert.equal(result.dest, dest)
    assert.equal(fs.existsSync(path.join(dest, WRAP_CLI_BIN)), true)
    assert.equal(fs.readFileSync(path.join(dest, CC_NODE_BIN), 'utf8'), 'cc-node')
    assert.equal(fs.existsSync(path.join(dest, 'kin-kernel')), true)
    const mode = fs.statSync(path.join(dest, WRAP_CLI_BIN)).mode & 0o111
    assert.ok(mode !== 0)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('crag materialize copies the crag kernel and cc-node', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-crag-cc-'))
  try {
    seedTemplate(project)
    fs.mkdirSync(path.join(project, 'share', 'crag'), { recursive: true })
    fs.writeFileSync(path.join(project, 'share', 'crag', 'kin-kernel'), 'crag-kernel')
    const result = materializeSlotDataplane(project, { id: 'vm-13' }, 'crag')
    assert.equal(result.ok, true)
    const dest = wrapCliHomeDir(project, 'vm-13')
    assert.equal(fs.readFileSync(path.join(dest, 'kin-kernel.bin'), 'utf8'), 'crag-kernel')
    assert.equal(fs.readFileSync(path.join(dest, CC_NODE_BIN), 'utf8'), 'cc-node')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})
test('crag inspection reports a change and sync marks the kernel for restart', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-crag-change-'))
  try {
    seedTemplate(project)
    const crag = path.join(project, 'share', 'crag', 'kin-kernel')
    fs.mkdirSync(path.dirname(crag), { recursive: true })
    fs.writeFileSync(crag, 'crag-kernel')
    const vm = { id: 'vm-13', dataplane: 'crag' }
    assert.equal(syncWrapSample(project, [vm]).items[0].kernel_changed, true)
    const dest = path.join(wrapCliHomeDir(project, 'vm-13'), 'kin-kernel.bin')
    const before = fs.readFileSync(dest)
    fs.writeFileSync(crag, 'crag-kernel-next')
    const checked = inspectKernelChanges(project, [vm])
    assert.equal(checked.changed_count, 1)
    assert.deepEqual(fs.readFileSync(dest), before)
    const synced = syncWrapSample(project, [vm])
    assert.equal(synced.items[0].kernel_changed, true)
    assert.equal(fs.readFileSync(dest, 'utf8'), 'crag-kernel-next')
    assert.equal(syncWrapSample(project, [vm]).items[0].kernel_changed, false)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('materializeWrapCli does not recopy identical wrap files', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-skip-'))
  try {
    seedTemplate(project)
    materializeWrapCli(project, { id: 'vm-13' })
    const cli = path.join(wrapCliHomeDir(project, 'vm-13'), WRAP_CLI_BIN)
    const wrapper = path.join(wrapCliHomeDir(project, 'vm-13'), 'kin-kernel')
    const cliM = fs.statSync(cli).mtimeMs
    const wrapM = fs.statSync(wrapper).mtimeMs
    materializeWrapCli(project, { id: 'vm-13' })
    assert.equal(fs.statSync(cli).mtimeMs, cliM)
    assert.equal(fs.statSync(wrapper).mtimeMs, wrapM)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('materializeWrapCli replaces same-size stale kernel payload', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-kernel-update-'))
  try {
    const template = seedTemplate(project)
    assert.equal(materializeWrapCli(project, { id: 'vm-13' }).ok, true)
    const source = path.join(template, 'kin-kernel')
    const dest = path.join(wrapCliHomeDir(project, 'vm-13'), 'kin-kernel.bin')
    fs.writeFileSync(source, 'new-kernel')
    fs.writeFileSync(dest, 'old-kernel')
    const timestamp = new Date(Date.now() + 60_000)
    fs.utimesSync(dest, timestamp, timestamp)

    const updated = materializeWrapCli(project, { id: 'vm-13' })
    assert.equal(updated.ok, true)
    assert.equal(updated.kernel_changed, true)
    assert.equal(fs.readFileSync(dest, 'utf8'), 'new-kernel')
    assert.equal(materializeWrapCli(project, { id: 'vm-13' }).kernel_changed, false)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('kernel inspection reports a change without writing the slot', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-inspect-'))
  try {
    const template = seedTemplate(project)
    const vm = { id: 'vm-13' }
    assert.equal(materializeWrapCli(project, vm).ok, true)
    const dest = path.join(wrapCliHomeDir(project, 'vm-13'), 'kin-kernel.bin')
    const before = fs.readFileSync(dest)
    fs.writeFileSync(path.join(template, 'kin-kernel'), 'replacement-kernel')
    const checked = inspectKernelChanges(project, [vm])
    assert.equal(checked.changed_count, 1)
    assert.deepEqual(fs.readFileSync(dest), before)
    const synced = syncWrapSample(project, [vm])
    assert.equal(synced.items[0].kernel_changed, true)
    assert.equal(fs.readFileSync(dest, 'utf8'), 'replacement-kernel')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})
test('cli-node inspection reports a change without writing the slot', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-node-'))
  try {
    const template = seedTemplate(project)
    const vm = { id: 'vm-13' }
    assert.equal(materializeWrapCli(project, vm).ok, true)
    const dest = path.join(wrapCliHomeDir(project, 'vm-13'), 'cli-node')
    const before = fs.readFileSync(dest)
    fs.writeFileSync(path.join(template, 'cli-node'), 'replacement-cli')
    const checked = inspectKernelChanges(project, [vm])
    assert.equal(checked.changed_count, 1)
    assert.deepEqual(fs.readFileSync(dest), before)
    const synced = syncWrapSample(project, [vm])
    assert.equal(synced.items[0].kernel_changed, true)
    assert.equal(fs.readFileSync(dest, 'utf8'), 'replacement-cli')
    assert.equal(inspectKernelChanges(project, [vm]).changed_count, 0)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})
test('a failed kernel restart stays pending until the next sync', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-pending-'))
  try {
    seedTemplate(project)
    const vm = { id: 'vm-13', kernel_restart_pending: 'kernel_restart_failed' }
    assert.equal(materializeWrapCli(project, vm).ok, true)
    const checked = inspectKernelChanges(project, [vm])
    assert.equal(checked.changed_count, 1)
    const synced = syncWrapSample(project, [vm])
    assert.equal(synced.items[0].kernel_changed, true)
    delete vm.kernel_restart_pending
    assert.equal(inspectKernelChanges(project, [vm]).changed_count, 0)
    assert.equal(syncWrapSample(project, [vm]).items[0].kernel_changed, false)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('materializeWrapCli installs glibc wrapper over kernel.bin', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-wrap-'))
  try {
    seedTemplate(project)
    const dest = wrapCliHomeDir(project, 'vm-10')
    const result = materializeWrapCli(project, { id: 'vm-10' })
    assert.equal(result.ok, true)
    const wrapper = fs.readFileSync(path.join(dest, 'kin-kernel'), 'utf8')
    assert.match(wrapper, /glibc239/)
    // Job watchdog follows kernel.json idle_timeout_seconds unless env already set it.
    // The kernel reads the unprefixed JOB_IDLE_SECS.
    assert.match(wrapper, /if \[ -z "\$JOB_IDLE_SECS" \]/)
    assert.match(wrapper, /"idle_timeout_seconds"/)
    assert.match(wrapper, /export JOB_IDLE_SECS=/)
    assert.doesNotMatch(wrapper, /KIN_JOB_IDLE_SECS/)
    assert.equal(fs.existsSync(path.join(dest, 'kin-kernel.bin')), true)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('captureWrapSample promotes a proven slot into share/wrap-cli', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-promote-'))
  try {
    seedTemplate(project)
    assert.equal(materializeWrapCli(project, { id: 'vm-05' }).ok, true)
    fs.writeFileSync(path.join(wrapCliHomeDir(project, 'vm-05'), WRAP_CLI_BIN), 'proven-cli\n')
    const captured = captureWrapSample(project, { id: 'vm-05' })
    assert.equal(captured.ok, true)
    const sample = fs.readFileSync(path.join(wrapCliTemplateDir(project), WRAP_CLI_BIN), 'utf8')
    assert.equal(sample, 'proven-cli\n')
    const meta = JSON.parse(fs.readFileSync(path.join(wrapCliTemplateDir(project), 'SAMPLE.json'), 'utf8'))
    assert.equal(meta.source_vm, 'vm-05')
    const synced = syncWrapSample(project, [{ id: 'vm-10' }])
    assert.equal(synced.ok, true)
    assert.equal(synced.ok_count, 1)
    assert.equal(fs.readFileSync(path.join(wrapCliHomeDir(project, 'vm-10'), WRAP_CLI_BIN), 'utf8'), 'proven-cli\n')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('legacy VM ids are included in fleet wrap synchronization', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-legacy-vm-'))
  try {
    seedTemplate(project)
    const vmDir = path.join(project, 'vms')
    fs.mkdirSync(vmDir, { recursive: true })
    fs.writeFileSync(path.join(vmDir, 'active.json'), JSON.stringify({ active_vm: 'legacy-slot' }))
    fs.writeFileSync(path.join(vmDir, 'legacy-slot.json'), JSON.stringify({ id: 'legacy-slot', name: 'legacy-slot' }))
    fs.writeFileSync(path.join(vmDir, 'vm-01.json'), JSON.stringify({ id: 'vm-01', name: 'vm-01' }))
    const synced = syncWrapSample(project, listVms(project))
    assert.equal(synced.ok, true)
    assert.deepEqual(synced.items.map((item) => item.id).sort(), ['legacy-slot', 'vm-01'])
    assert.equal(
      fs.readFileSync(path.join(wrapCliHomeDir(project, 'legacy-slot'), 'kin-kernel.bin'), 'utf8'),
      'kin-kernel',
    )
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('materializeWrapCli replaces a busy dest via unlink', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-busy-'))
  try {
    seedTemplate(project)
    const dest = wrapCliHomeDir(project, 'vm-13')
    fs.mkdirSync(dest, { recursive: true })
    const cli = path.join(dest, WRAP_CLI_BIN)
    fs.writeFileSync(cli, 'old-cli')
    fs.chmodSync(cli, 0o755)
    const fd = fs.openSync(cli, 'r')
    try {
      const result = materializeWrapCli(project, { id: 'vm-13' })
      assert.equal(result.ok, true, result.error)
      assert.equal(fs.readFileSync(path.join(dest, WRAP_CLI_BIN), 'utf8'), WRAP_CLI_BIN)
    } finally {
      fs.closeSync(fd)
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('makeWrapSample builds share/wrap-cli without a VM', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-make-'))
  try {
    seedTemplate(project)
    const made = makeWrapSample(project)
    assert.equal(made.ok, true, made.error)
    const meta = JSON.parse(fs.readFileSync(path.join(wrapCliTemplateDir(project), 'SAMPLE.json'), 'utf8'))
    assert.equal(meta.source, 'manual')
    assert.match(fs.readFileSync(path.join(wrapCliTemplateDir(project), 'kin-kernel'), 'utf8'), /glibc239/)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('materializeWrapCli fails when the template is missing', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-missing-'))
  try {
    const result = materializeWrapCli(project, { id: 'vm-01' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'wrap_cli_template_missing')
    assert.equal(fs.existsSync(wrapCliHomeDir(project, 'vm-01')), false)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('inspectWrapCliDir requires kernel payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-bad-'))
  try {
    fs.writeFileSync(path.join(dir, WRAP_CLI_BIN), 'x')
    const missing = inspectWrapCliDir(dir)
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'wrap_cli_incomplete')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('wrapCliTemplateDir prefers KIN_WRAP_CLI_ROOT', () => {
  const prev = process.env.KIN_WRAP_CLI_ROOT
  process.env.KIN_WRAP_CLI_ROOT = '/opt/kin-gateway/share/wrap-cli'
  try {
    assert.equal(wrapCliTemplateDir('/tmp/project'), '/opt/kin-gateway/share/wrap-cli')
  } finally {
    if (prev == null) delete process.env.KIN_WRAP_CLI_ROOT
    else process.env.KIN_WRAP_CLI_ROOT = prev
  }
})

test('materializeWrapCli prefers KIN_KERNEL_BIN over sample kernel', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-configured-'))
  const prev = process.env.KIN_KERNEL_BIN
  try {
    seedTemplate(project)
    const host = path.join(project, 'host-kernel')
    fs.writeFileSync(host, 'host-kernel')
    process.env.KIN_KERNEL_BIN = host
    assert.equal(materializeWrapCli(project, { id: 'vm-13' }).ok, true)
    assert.equal(fs.readFileSync(path.join(wrapCliHomeDir(project, 'vm-13'), 'kin-kernel.bin'), 'utf8'), 'host-kernel')
  } finally {
    if (prev == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = prev
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('materializeWrapCli falls back to project bin/kin-kernel', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-bundled-'))
  try {
    seedTemplate(project)
    fs.mkdirSync(path.join(project, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(project, 'bin', 'kin-kernel'), 'bundled-kernel')
    assert.equal(materializeWrapCli(project, { id: 'vm-13' }).ok, true)
    assert.equal(
      fs.readFileSync(path.join(wrapCliHomeDir(project, 'vm-13'), 'kin-kernel.bin'), 'utf8'),
      'bundled-kernel',
    )
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('makeWrapSample overlays configured kernel onto the sample', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-make-host-'))
  const prev = process.env.KIN_KERNEL_BIN
  try {
    seedTemplate(project)
    const host = path.join(project, 'host-kernel')
    fs.writeFileSync(host, 'host-kernel')
    process.env.KIN_KERNEL_BIN = host
    const made = makeWrapSample(project)
    assert.equal(made.ok, true, made.error)
    assert.equal(fs.readFileSync(path.join(wrapCliTemplateDir(project), 'kin-kernel.bin'), 'utf8'), 'host-kernel')
  } finally {
    if (prev == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = prev
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('inspectLinuxAmd64Elf accepts linux amd64 ELF64', () => {
  assert.equal(inspectLinuxAmd64Elf(fakeElf64Amd64()).ok, true)
  assert.equal(inspectLinuxAmd64Elf(Buffer.from('not-elf')).ok, false)
  const wrongMachine = fakeElf64Amd64()
  wrongMachine.writeUInt16LE(3, 18)
  assert.equal(inspectLinuxAmd64Elf(wrongMachine).code, 'kernel_not_amd64')
})

test('replaceKernelBinary writes sample and project bin kernel', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-upload-'))
  try {
    seedTemplate(project)
    const elf = fakeElf64Amd64('uploaded-kernel')
    const replaced = replaceKernelBinary(project, elf)
    assert.equal(replaced.ok, true, replaced.error)
    assert.equal(replaced.kernel.source, 'configured')
    assert.ok(fs.readFileSync(path.join(project, 'share', 'wrap-cli', 'kin-kernel.bin')).equals(elf))
    assert.ok(fs.readFileSync(path.join(project, 'bin', 'kin-kernel')).equals(elf))
    const meta = JSON.parse(fs.readFileSync(path.join(wrapCliTemplateDir(project), 'SAMPLE.json'), 'utf8'))
    assert.equal(meta.source, 'upload')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('replaceKernelBinary rejects non-ELF payloads', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-cli-bad-elf-'))
  try {
    seedTemplate(project)
    const replaced = replaceKernelBinary(project, Buffer.alloc(64, 0x41))
    assert.equal(replaced.ok, false)
    assert.equal(replaced.code, 'kernel_not_elf')
    assert.equal(fs.existsSync(path.join(project, 'bin', 'kin-kernel')), false)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

function sha256(body) {
  return crypto.createHash('sha256').update(body).digest('hex')
}

function seedV2Package(project, { worker = 'worker\n' } = {}) {
  const useArch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch
  const dir = path.join(project, 'share', 'crag', 'kernels', 'v2', useArch)
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  const workerBody = Buffer.from(worker)
  const pkg = Buffer.from('{}\n')
  fs.writeFileSync(path.join(dir, 'bin', 'crag-kernel-worker.mjs'), workerBody)
  fs.writeFileSync(path.join(dir, 'package.json'), pkg)
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      family: 'crag',
      version: 'v2',
      arch: useArch,
      entrypoint: 'bin/crag-kernel-worker.mjs',
      node_version: 'v24.0.0',
      capabilities: ['official_full', 'zero', 'cancel', 'telemetry', 'unix_socket_envelope'],
      sha256: {
        'bin/crag-kernel-worker.mjs': sha256(workerBody),
        'package.json': sha256(pkg),
      },
    }),
  )
  return dir
}

test('omitted crag version stays on the legacy ELF even when a v2 package exists', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-crag-legacy-pin-'))
  const prev = process.env.KIN_CRAG_V2_ROOT
  try {
    seedTemplate(project)
    const v2 = seedV2Package(project)
    process.env.KIN_CRAG_V2_ROOT = v2
    fs.mkdirSync(path.join(project, 'share', 'crag'), { recursive: true })
    fs.writeFileSync(path.join(project, 'share', 'crag', 'kin-kernel'), 'crag-kernel')
    const result = materializeSlotDataplane(project, { id: 'vm-13', dataplane: 'crag' }, 'crag')
    assert.equal(result.ok, true)
    const dest = wrapCliHomeDir(project, 'vm-13')
    assert.equal(fs.readFileSync(path.join(dest, 'kin-kernel.bin'), 'utf8'), 'crag-kernel')
    assert.equal(fs.existsSync(path.join(dest, 'crag-v2')), false)
  } finally {
    if (prev == null) delete process.env.KIN_CRAG_V2_ROOT
    else process.env.KIN_CRAG_V2_ROOT = prev
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('one VM can switch cli-node to CRAG v2 and back without deleting cli-node', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-crag-v2-switch-'))
  try {
    seedTemplate(project)
    seedV2Package(project)
    const node = path.join(project, 'node-bin')
    fs.writeFileSync(node, 'node-bytes')
    const dest = wrapCliHomeDir(project, 'vm-13')
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'cli-node'), 'keep-cli')
    const vm = { id: 'vm-13', dataplane: 'crag', crag_kernel_version: 'v2' }
    const laid = materializeResolvedKernel(project, vm, { nodeBin: node })
    assert.equal(laid.ok, true)
    assert.equal(laid.kernel_changed, true)
    assert.equal(laid.kernel_version, 'v2')
    assert.equal(fs.readFileSync(path.join(dest, 'cli-node'), 'utf8'), 'keep-cli')
    assert.equal(fs.readFileSync(path.join(dest, 'kin-kernel.bin'), 'utf8'), 'node-bytes')
    assert.match(fs.readFileSync(path.join(dest, 'kin-kernel'), 'utf8'), /crag-v2\/bin\/crag-kernel-worker\.mjs/)
    assert.equal(materializeResolvedKernel(project, vm, { nodeBin: node }).kernel_changed, false)
    const back = materializeResolvedKernel(project, { id: 'vm-13', dataplane: 'wrap' })
    assert.equal(back.ok, true)
    assert.equal(fs.existsSync(path.join(dest, 'cli-node')), true)
    assert.doesNotMatch(fs.readFileSync(path.join(dest, 'kin-kernel'), 'utf8'), /crag-v2/)
    assert.notEqual(fs.readFileSync(path.join(dest, 'kin-kernel.bin'), 'utf8'), 'node-bytes')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('CRAG v2 rejects a bad package and a non-local slot without replacing cli-node', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-crag-v2-reject-'))
  try {
    const dir = seedV2Package(project)
    const manifestPath = path.join(dir, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.sha256['bin/crag-kernel-worker.mjs'] = '0'.repeat(64)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    const dest = wrapCliHomeDir(project, 'vm-13')
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'cli-node'), 'keep-cli')
    const bad = materializeCragV2(project, { id: 'vm-13', crag_kernel_version: 'v2' }, { nodeBin: process.execPath })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'crag_v2_hash_mismatch')
    assert.equal(fs.readFileSync(path.join(dest, 'cli-node'), 'utf8'), 'keep-cli')
    assert.equal(fs.existsSync(path.join(dest, 'crag-v2')), false)
    const remote = materializeCragV2(project, { id: 'vm-remote', node_id: 'node-1' })
    assert.equal(remote.code, 'crag_v2_unsupported_placement')
    assert.equal(fs.existsSync(wrapCliHomeDir(project, 'vm-remote')), false)
    const kvm = materializeCragV2(project, { id: 'vm-kvm', runtime: { type: 'kvm' } })
    assert.equal(kvm.code, 'crag_v2_unsupported_placement')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('describeCragV2Package reports a verified staged tree and a missing package', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-crag-v2-describe-'))
  const prev = process.env.KIN_CRAG_V2_ROOT
  delete process.env.KIN_CRAG_V2_ROOT
  try {
    const missing = describeCragV2Package(project)
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'crag_v2_package_missing')
    const dir = seedV2Package(project)
    const found = describeCragV2Package(project)
    assert.equal(found.ok, true)
    assert.equal(found.path, dir)
    assert.equal(found.version, 'v2')
    assert.equal(found.arch, process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch)
  } finally {
    if (prev == null) delete process.env.KIN_CRAG_V2_ROOT
    else process.env.KIN_CRAG_V2_ROOT = prev
    fs.rmSync(project, { recursive: true, force: true })
  }
})
