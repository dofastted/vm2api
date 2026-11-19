import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { repairClaudeConfigFromBackup } from '../../src/lib/vm/claude-config-repair.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

const OLD = Date.now() - 60_000

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-claude-config-repair-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, '.claude')
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true })
  return { root, primary: path.join(dir, '.claude.json'), backups: path.join(dir, 'backups') }
}

function write(file, body, mtime = OLD) {
  fs.writeFileSync(file, body, { mode: 0o600 })
  fs.utimesSync(file, mtime / 1000, mtime / 1000)
}

const identity = (n) =>
  `${JSON.stringify({ userID: 'keep-me', numStartups: n, oauthAccount: { emailAddress: 'a@example.test' } })}\n`

test('an empty config is restored from the newest parsable CLI backup, byte for byte', (t) => {
  const h = home(t)
  write(h.primary, '')
  write(path.join(h.backups, '.claude.json.backup.1795050317184'), identity(1))
  write(path.join(h.backups, '.claude.json.backup.1795050631810'), identity(5))
  write(path.join(h.backups, '.claude.json.backup.1795050706838'), '') // newest, but empty
  write(path.join(h.backups, '.claude.json.corrupted.1795050706838'), '')
  const result = repairClaudeConfigFromBackup(h.root)
  assert.deepEqual(result, { repaired: true, backup: '.claude.json.backup.1795050631810' })
  assert.equal(fs.readFileSync(h.primary, 'utf8'), identity(5))
  assert.equal(fs.statSync(h.primary).mode & 0o777, 0o600)
  assert.deepEqual(
    fs.readdirSync(path.dirname(h.primary)).filter((n) => n.includes('.repair.tmp')),
    [],
  )
})

test('truncated JSON counts as unreadable', (t) => {
  const h = home(t)
  write(h.primary, '{"userID":"keep-me","numSt')
  write(path.join(h.backups, '.claude.json.backup.1795050317184'), identity(1))
  assert.equal(repairClaudeConfigFromBackup(h.root).repaired, true)
  assert.equal(JSON.parse(fs.readFileSync(h.primary, 'utf8')).userID, 'keep-me')
})

test('healthy, missing, linked or still-settling configs are never touched', (t) => {
  const h = home(t)
  write(path.join(h.backups, '.claude.json.backup.1795050317184'), identity(1))
  assert.equal(repairClaudeConfigFromBackup(h.root).reason, 'missing')

  write(h.primary, identity(9))
  assert.equal(repairClaudeConfigFromBackup(h.root).reason, 'ok')
  assert.equal(fs.readFileSync(h.primary, 'utf8'), identity(9))

  write(h.primary, '', Date.now())
  assert.equal(repairClaudeConfigFromBackup(h.root).reason, 'settling')
  assert.equal(fs.readFileSync(h.primary, 'utf8'), '')

  fs.rmSync(h.primary)
  fs.symlinkSync(path.join(h.backups, '.claude.json.backup.1795050317184'), h.primary)
  assert.equal(repairClaudeConfigFromBackup(h.root).reason, 'not_regular')
  assert.equal(fs.lstatSync(h.primary).isSymbolicLink(), true)
})

test('without a usable backup nothing is written', (t) => {
  const h = home(t)
  write(h.primary, '')
  write(path.join(h.backups, '.claude.json.backup.1795050317184'), '[]')
  fs.symlinkSync('/etc/hosts', path.join(h.backups, '.claude.json.backup.1795050631810'))
  assert.deepEqual(repairClaudeConfigFromBackup(h.root), { repaired: false, reason: 'no_backup' })
  assert.equal(fs.readFileSync(h.primary, 'utf8'), '')
})

test('a large healthy config is never replaced by an older backup', (t) => {
  const h = home(t)
  const large = `${JSON.stringify({ userID: 'keep-me', projects: { pad: 'x'.repeat(5 * 1024 * 1024) } })}\n`
  write(h.primary, large)
  write(path.join(h.backups, '.claude.json.backup.1795050317184'), identity(1))
  assert.equal(repairClaudeConfigFromBackup(h.root).reason, 'ok')
  assert.equal(fs.statSync(h.primary).size, Buffer.byteLength(large))
})

test('a guest-planted link for the config directory or backups is never followed', (t) => {
  const h = home(t)
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-claude-config-elsewhere-'))
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }))
  fs.mkdirSync(path.join(elsewhere, 'backups'))
  write(path.join(elsewhere, '.claude.json'), '')
  write(path.join(elsewhere, 'backups', '.claude.json.backup.1795050317184'), identity(1))
  fs.rmSync(path.join(h.root, '.claude'), { recursive: true })
  fs.symlinkSync(elsewhere, path.join(h.root, '.claude'))
  assert.equal(repairClaudeConfigFromBackup(h.root).reason, 'missing')
  assert.equal(fs.readFileSync(path.join(elsewhere, '.claude.json'), 'utf8'), '')

  const g = home(t)
  write(g.primary, '')
  fs.rmSync(g.backups, { recursive: true })
  fs.symlinkSync(path.join(elsewhere, 'backups'), g.backups)
  assert.equal(repairClaudeConfigFromBackup(g.root).reason, 'no_backup')
  assert.equal(fs.readFileSync(g.primary, 'utf8'), '')
})

test('writeKernelConfig repairs the CLI config before a cli-node or CRAG start', (t) => {
  for (const dataplane of ['wrap', 'crag']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-config-repair-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const claude = path.join(root, 'vms', 'vm-09', 'cli-home', '.claude')
    fs.mkdirSync(path.join(claude, 'backups'), { recursive: true })
    write(path.join(claude, '.claude.json'), '')
    write(path.join(claude, 'backups', '.claude.json.backup.1795050631810'), identity(5))
    writeKernelConfig(root, { id: 'vm-09', dataplane }, { token: 'tok' })
    const doc = JSON.parse(fs.readFileSync(path.join(claude, '.claude.json'), 'utf8'))
    assert.equal(doc.userID, 'keep-me', dataplane)
    assert.equal(doc.oauthAccount.emailAddress, 'a@example.test', dataplane)
  }
})
