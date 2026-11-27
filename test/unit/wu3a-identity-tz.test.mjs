import '../fixtures/kin-computer-test-env.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  OFFICIAL_SLOT_CWD,
  buildOfficialContinuationText,
  officialSlotCwd,
} from '../../src/lib/identity/official-cc-system-2.1.241.mjs'
import {
  assignComputerFingerprint,
  ensureDockerSlotPasswdFiles,
  ensureSlotComputer,
  fingerprintDir,
  pushLiveSlotTimezoneSync,
  rememberComputer,
  renderSlotPasswdGroupContent,
  slotComputerRuntimeEtcDir,
  slotComputerSystemEtcDir,
  syncSlotIdentityTimezoneAndPreset,
} from '../../src/lib/identity/slot-computer.mjs'
import {
  applyGeneratedFingerprint,
  generateWorkstationFingerprint,
  takenFingerprintKeys,
} from '../../src/lib/identity/workstation-fingerprint.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { syncVmTimezoneFromProxy } from '../../src/lib/vm/proxy-timezone.mjs'
import { isValidSlotUsername } from '../../src/lib/vm/slot-identity.mjs'
import { persistVmTimezone } from '../../src/lib/vm/vm-registry.mjs'

test('workstation-fingerprint tracks taken usernames and preserves optional username/guest uid/gid', () => {
  const taken = takenFingerprintKeys([
    { id: 'vm-1', fingerprint: { hostname: 'h1', device_id: 'd1', guest_machine_id: 'm1', username: 'mchen84' } },
    { id: 'vm-2', fingerprint: { hostname: 'h2', device_id: 'd2', guest_machine_id: 'm2', username: 'dwalsh22' } },
  ])
  assert.equal(taken.username.has('mchen84'), true)
  assert.equal(taken.username.has('dwalsh22'), true)

  const takenExcept = takenFingerprintKeys([{ id: 'vm-1', fingerprint: { username: 'mchen84' } }], { exceptId: 'vm-1' })
  assert.equal(takenExcept.username.has('mchen84'), false)

  const base = generateWorkstationFingerprint({ id: 'vm-legacy', kernel: 'ubuntu-24.04' })
  const legacyApplied = applyGeneratedFingerprint({}, base)
  assert.equal('username' in legacyApplied, false)
  assert.equal('guest_uid' in legacyApplied, false)
  assert.equal('guest_gid' in legacyApplied, false)

  const newApplied = applyGeneratedFingerprint({}, { ...base, username: 'mchen84', guest_uid: 1000, guest_gid: 1000 })
  assert.equal(newApplied.username, 'mchen84')
  assert.equal(newApplied.guest_uid, 1000)
  assert.equal(newApplied.guest_gid, 1000)
})

test('assignComputerFingerprint assigns random username, custom-erofs 1000:1000, and avoids taken usernames', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu3a-assign-'))
  try {
    const dockerVm = { id: 'vm-wu3a-docker', kernel: 'crag-debian13', runtime: { type: 'docker' } }
    const fpDocker = assignComputerFingerprint(root, dockerVm)
    assert.equal(isValidSlotUsername(fpDocker.username), true)
    assert.equal(fpDocker.guest_uid, undefined)
    assert.equal(fpDocker.guest_gid, undefined)

    const kvmCustomVm = { id: 'vm-wu3a-kvm-custom', kernel: 'crag-debian13', runtime: { type: 'kvm' } }
    const fpKvmCustom = assignComputerFingerprint(root, kvmCustomVm)
    assert.equal(isValidSlotUsername(fpKvmCustom.username), true)
    assert.equal(fpKvmCustom.guest_uid, 1000)
    assert.equal(fpKvmCustom.guest_gid, 1000)

    // Collision avoidance: pass first generated username as taken for a fresh slot with same seed
    const vmCollide = { id: 'vm-wu3a-collide', kernel: 'crag-debian13', runtime: { type: 'docker' } }
    const first = assignComputerFingerprint(root, vmCollide)
    fs.rmSync(fingerprintDir(root, vmCollide.id), { recursive: true, force: true })
    const second = assignComputerFingerprint(root, vmCollide, {
      taken: {
        hostname: new Set(),
        device_id: new Set(),
        guest_machine_id: new Set(),
        username: new Set([first.username]),
      },
    })
    assert.notEqual(second.username, first.username)
    assert.equal(isValidSlotUsername(second.username), true)

    // Legacy slot without username: rememberComputer never backfills username/guest_uid/gid
    // even when computer.created === true (e.g. first startVm after missing kvm/fingerprint dir).
    const legacyByHost = {
      id: 'vm-wu3a-legacy-host',
      kernel: 'crag-debian13',
      runtime: { type: 'kvm' },
      fingerprint: { hostname: 'oldhost', guest_machine_id: 'a'.repeat(32) },
    }
    const vmHostPath = path.join(root, 'vms', `${legacyByHost.id}.json`)
    fs.mkdirSync(path.dirname(vmHostPath), { recursive: true })
    fs.writeFileSync(vmHostPath, `${JSON.stringify(legacyByHost, null, 2)}\n`, 'utf8')
    rememberComputer(root, legacyByHost, {
      hostname: 'newhost',
      guest_machine_id: 'b'.repeat(32),
      username: 'mchen84',
      created: true,
    })
    assert.equal(legacyByHost.fingerprint.username, undefined)
    assert.equal(legacyByHost.fingerprint.guest_uid, undefined)
    assert.equal(legacyByHost.fingerprint.guest_gid, undefined)
    const diskLegacyHost = JSON.parse(fs.readFileSync(vmHostPath, 'utf8'))
    assert.equal(diskLegacyHost.fingerprint.username, undefined)
    assert.equal(diskLegacyHost.fingerprint.guest_uid, undefined)
    assert.equal(diskLegacyHost.fingerprint.guest_gid, undefined)

    const legacyByDevice = {
      id: 'vm-wu3a-legacy-dev',
      kernel: 'crag-debian13',
      runtime: { type: 'kvm' },
      fingerprint: { device_id: 'c'.repeat(64) },
    }
    rememberComputer(root, legacyByDevice, {
      hostname: 'newhost2',
      guest_machine_id: 'd'.repeat(32),
      username: 'dwalsh22',
      created: true,
    })
    assert.equal(legacyByDevice.fingerprint.username, undefined)
    assert.equal(legacyByDevice.fingerprint.guest_uid, undefined)
    assert.equal(legacyByDevice.fingerprint.guest_gid, undefined)

    // Fresh record with no hostname/device_id/username may backfill cleanly.
    const blankVm = {
      id: 'vm-wu3a-blank',
      kernel: 'crag-debian13',
      runtime: { type: 'kvm' },
      fingerprint: {},
    }
    rememberComputer(root, blankVm, {
      hostname: 'freshhost',
      guest_machine_id: 'e'.repeat(32),
      username: 'kpatel42',
      created: true,
    })
    assert.equal(blankVm.fingerprint.username, 'kpatel42')
    assert.equal(blankVm.fingerprint.guest_uid, 1000)
    assert.equal(blankVm.fingerprint.guest_gid, 1000)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('renderSlotPasswdGroupContent and ensureDockerSlotPasswdFiles strip kincli/999/987 and enforce 0644', () => {
  const rendered = renderSlotPasswdGroupContent({
    username: 'mchen84',
    uid: 10005,
    gid: 987,
    homeDir: '/home/mchen84',
    basePasswd: [
      'root:x:0:0:root:/root:/bin/bash',
      'kincli:x:999:987::/home/kincli:/bin/bash',
      'stale:x:10005:10005::/home/stale:/bin/bash',
    ].join('\n'),
    baseGroup: ['root:x:0:', 'kincli:x:987:', 'sudo:x:27:kincli,root'].join('\n'),
  })
  assert.equal(rendered.passwd.includes('kincli'), false)
  assert.equal(rendered.passwd.includes(':999:'), false)
  assert.equal(rendered.passwd.includes('stale'), false)
  assert.equal(rendered.passwd.includes('mchen84:x:10005:987::/home/mchen84:/bin/bash'), true)
  assert.equal(rendered.group.includes('kincli'), false)
  assert.equal(rendered.group.includes('mchen84:x:987:'), true)
  assert.equal(rendered.group.includes('sudo:x:27:root'), true)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu3a-passwd-'))
  try {
    const vm = { id: 'vm-pw-1', fingerprint: { username: 'mchen84' } }
    const out = ensureDockerSlotPasswdFiles(root, vm, { uid: 10005, gid: 987 })
    assert.equal(out.dir, slotComputerRuntimeEtcDir(root, vm.id))
    assert.equal(fs.existsSync(path.join(out.dir, 'shadow')), false)
    assert.equal(fs.readFileSync(out.passwdPath, 'utf8').includes('mchen84:x:10005:987::/home/mchen84:/bin/bash'), true)
    assert.equal(fs.readFileSync(out.groupPath, 'utf8').includes('mchen84:x:987:'), true)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(out.passwdPath).mode & 0o777, 0o644)
      assert.equal(fs.statSync(out.groupPath).mode & 0o777, 0o644)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('exit proxy timezone change syncs vms/<id>.json, 10-slot-preset.json, timezone, and TZif localtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu3a-tz-'))
  try {
    const pool = new ProxyPool({
      dataDir: root,
      geoLookup: async () => ({ ok: true, geo: { ip: '203.0.113.55', country: 'Japan', timezone: 'Asia/Tokyo' } }),
    })
    pool.stopScheduler()
    const proxyId = pool.importLines('1.2.3.4:1080').items[0].id
    pool.bind(proxyId, 'vm-tz-1')

    const vm = {
      id: 'vm-tz-1',
      status: 'running',
      kernel: 'crag-debian13',
      timezone: 'America/Los_Angeles',
      locale: 'en_US.UTF-8',
      runtime: { type: 'docker' },
      proxy: { id: proxyId },
      fingerprint: { timezone: 'America/Los_Angeles', username: 'mchen84' },
    }
    ensureSlotComputer(root, vm)
    fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', 'vm-tz-1.json'), `${JSON.stringify(vm, null, 2)}\n`, 'utf8')

    const etcDir = slotComputerSystemEtcDir(root, vm.id)
    const ltPath = path.join(etcDir, 'localtime')
    const tzPath = path.join(etcDir, 'timezone')
    const presetPath = path.join(etcDir, 'claude-code', 'managed-settings.d', '10-slot-preset.json')
    const beforeLtInode = fs.existsSync(ltPath) ? fs.statSync(ltPath).ino : null

    const synced = await syncVmTimezoneFromProxy(root, pool, 'vm-tz-1')
    assert.deepEqual(synced, { ok: true, applied: true, timezone: 'Asia/Tokyo', reason: null })

    // 1. vms/<id>.json
    const diskVm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-tz-1.json'), 'utf8'))
    assert.equal(diskVm.timezone, 'Asia/Tokyo')
    assert.equal(diskVm.fingerprint.timezone, 'Asia/Tokyo')
    assert.equal(diskVm.timezone_source, 'proxy_geo')

    // 2. 10-slot-preset.json
    const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'))
    assert.equal(preset.env.TZ, 'Asia/Tokyo')
    assert.equal(preset.env.LANG, 'en_US.UTF-8')
    assert.equal(preset.env.LC_ALL, 'en_US.UTF-8')
    assert.equal(preset.env.CLAUDE_CODE_ATTRIBUTION_HEADER, undefined)

    // 3. system/etc/timezone
    assert.equal(fs.readFileSync(tzPath, 'utf8'), 'Asia/Tokyo\n')

    // 4. system/etc/localtime (TZif binary matching /usr/share/zoneinfo/Asia/Tokyo + inode preserved)
    if (fs.existsSync('/usr/share/zoneinfo/Asia/Tokyo')) {
      const expected = fs.readFileSync('/usr/share/zoneinfo/Asia/Tokyo')
      const actual = fs.readFileSync(ltPath)
      assert.equal(actual.subarray(0, 4).toString('ascii'), 'TZif')
      assert.equal(Buffer.compare(actual, expected), 0)
      if (beforeLtInode !== null && process.platform !== 'win32') {
        assert.equal(fs.statSync(ltPath).ino, beforeLtInode, 'localtime update must preserve inode for Docker RO bind')
      }
    }

    // Manual persistVmTimezone also syncs all 4 places
    const manualSummary = persistVmTimezone(root, 'vm-tz-1', 'Europe/London', { source: 'manual' })
    assert.ok(manualSummary)
    assert.equal(fs.readFileSync(tzPath, 'utf8'), 'Europe/London\n')
    assert.equal(JSON.parse(fs.readFileSync(presetPath, 'utf8')).env.TZ, 'Europe/London')

    // Direct sync reports restart_recommended_for_tz for running Docker slot
    const direct = syncSlotIdentityTimezoneAndPreset(
      root,
      { ...diskVm, status: 'running' },
      { timezone: 'America/New_York' },
    )
    assert.equal(direct.ok, true)
    assert.equal(direct.restart_recommended_for_tz, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pushLiveSlotTimezoneSync sends valid sync_preset_tz RPC over KVM agent socket', {
  skip: process.platform === 'win32',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu3a-rpc-'))
  const kvmDir = path.join(root, 'vms', 'vm-kvm-tz', 'kvm')
  fs.mkdirSync(kvmDir, { recursive: true })
  const token = 'a'.repeat(64)
  fs.writeFileSync(path.join(kvmDir, '.agent-token'), `${token}\n`, { mode: 0o600 })
  const sockPath = path.join(kvmDir, 'agent.sock')

  const received = []
  const server = net.createServer((conn) => {
    let buf = ''
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const req = JSON.parse(buf.slice(0, nl))
      received.push(req)
      conn.end(
        `${JSON.stringify({ id: req.id, ok: true, result: { updated: ['managed_preset', 'timezone', 'localtime'] } })}\n`,
      )
    })
  })
  await new Promise((resolve) => server.listen(sockPath, resolve))

  try {
    const vm = {
      id: 'vm-kvm-tz',
      status: 'running',
      kernel: 'crag-debian13',
      timezone: 'Asia/Tokyo',
      locale: 'en_US.UTF-8',
      runtime: { type: 'kvm' },
      fingerprint: { username: 'mchen84' },
    }
    const fileSync = syncSlotIdentityTimezoneAndPreset(root, vm)
    const rpc = await pushLiveSlotTimezoneSync(root, vm, fileSync)
    assert.equal(rpc.ok, true)
    assert.equal(received.length, 1)
    assert.equal(received[0].op, 'sync_preset_tz')
    assert.equal(received[0].params.timezone, 'Asia/Tokyo')
    assert.equal(received[0].params.preset_name, '10-slot-preset.json')
    assert.ok(received[0].params.preset_b64)
    assert.match(received[0].params.preset_sha256, /^[0-9a-f]{64}$/)
    if (fs.existsSync('/usr/share/zoneinfo/Asia/Tokyo')) {
      assert.ok(received[0].params.localtime_b64)
      assert.match(received[0].params.localtime_sha256, /^[0-9a-f]{64}$/)
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('officialSlotCwd and buildOfficialContinuationText parameterize slot home while keeping default', () => {
  assert.equal(OFFICIAL_SLOT_CWD, '/home/kincli')
  assert.equal(officialSlotCwd(), '/home/kincli')
  assert.equal(officialSlotCwd({ fingerprint: {} }), '/home/kincli')
  assert.equal(officialSlotCwd({ fingerprint: { username: 'mchen84' } }), '/home/mchen84')

  const text = buildOfficialContinuationText({ timezone: 'Asia/Tokyo' }, [], {
    vm: { fingerprint: { username: 'mchen84' } },
  })
  assert.equal(text.includes('/home/mchen84/.claude/projects/-home-mchen84/memory/'), true)
  assert.equal(text.includes('/home/kincli/.claude/projects/-home-kincli/memory/'), false)
})
