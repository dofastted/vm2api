import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseChangelog,
  changelogSince,
  compareSemver,
  normalizeTag,
  parseReleaseTag,
  imageTagFor,
  readLocalVersion,
  loadChangelog,
  publicRelease,
  buildUpdateStatus,
  startHostUpgrade,
  hostUpgradeDeployment,
  readHostUpgradeStatus,
  upgradeCommand,
  clearReleaseCache,
  INSTALL_SCRIPT_URL,
} from '../../src/lib/admin/release.mjs'

const FIXTURE = `# Changelog

## Unreleased

- draft note

## 1.2.7 — 2026-09-21

控制面一键更新。

- 一键脚本
- 面板更新检查

## 1.2.6 — 2026-09-20

控制面：本地出口导入。不必换槽内 kernel。

- 本地出口绑槽后允许导入
- 已部署机升级：只更新控制面 Node

## 1.2.5 — 2026-09-20

仓内预编译。

- 已部署机升级：控制面重启一次 + \`POST /api/panel/wrap-cli/sync\` 换槽内 CLI
`

function dockerFixture(root, { job = null, runError = null, containerized = true } = {}) {
  const calls = []
  const container = {
    Id: 'old-control-plane',
    Name: '/custom-control',
    State: { Running: true },
    Config: {
      Hostname: 'control-host',
      Labels: {
        'com.docker.compose.project': 'custom-stack',
        'com.docker.compose.service': 'vm2api',
        'com.docker.compose.project.working_dir': root,
        'com.docker.compose.project.config_files': `${root}/docker-compose.yml,${root}/docker-compose.override.yml`,
      },
    },
  }
  return {
    calls,
    container,
    options: {
      dockerBin: '/fake/docker',
      sock: path.join(root, 'VERSION'),
      containerized,
      hostname: 'control-host',
      env: { VM2API_CONTAINER_NAME: 'custom-control' },
      async execFileImpl(cmd, args, opts) {
        calls.push({ cmd, args, opts })
        if (args[0] === 'inspect') {
          if (args.at(-1) === 'vm2api-upgrade-custom-stack') {
            if (!job) throw new Error('No such container')
            return { stdout: JSON.stringify(job) }
          }
          return { stdout: JSON.stringify(container) }
        }
        if (args[0] === 'run' && runError) throw new Error(runError)
        return { stdout: 'helper-id\n' }
      },
    },
  }
}

const releaseFetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v1.2.7', body: '' }) })

test('parseChangelog reads Keep-a-Changelog headings and wrap-cli flag', () => {
  const entries = parseChangelog(FIXTURE)
  assert.equal(entries[0].version, 'unreleased')
  assert.equal(entries[1].version, '1.2.7')
  assert.equal(entries[1].date, '2026-09-21')
  assert.equal(entries[1].title, '控制面一键更新。')
  assert.deepEqual(entries[1].bullets, ['一键脚本', '面板更新检查'])
  assert.equal(entries[2].needs_wrap_cli_sync, false)
  assert.equal(entries[3].needs_wrap_cli_sync, true)
})

test('changelogSince returns only newer released versions', () => {
  const newer = changelogSince(parseChangelog(FIXTURE), '1.2.6')
  assert.deepEqual(
    newer.map((e) => e.version),
    ['1.2.7'],
  )
  assert.equal(changelogSince(parseChangelog(FIXTURE), '1.2.7').length, 0)
})

test('compareSemver orders dotted triples', () => {
  assert.equal(compareSemver('1.2.7', '1.2.6'), 1)
  assert.equal(compareSemver('v1.2.6', '1.2.6'), 0)
  assert.equal(compareSemver('1.1.9', '1.2.0'), -1)
  assert.equal(normalizeTag('1.2.6'), 'v1.2.6')
})

test('readLocalVersion prefers VERSION file over package.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-'))
  try {
    fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.6\n')
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '0.0.1' }))
    assert.equal(readLocalVersion(tmp), '1.2.6')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('loadChangelog reads the warehouse CHANGELOG.md', () => {
  const entries = loadChangelog(path.resolve(import.meta.dirname, '../..'))
  assert.ok(entries.length >= 3)
  assert.equal(
    entries.some((e) => e.version === '1.2.6'),
    true,
  )
  assert.equal(
    entries.some((e) => e.version === '1.0.0'),
    true,
  )
})

test('buildUpdateStatus reports an available GitHub release and the one-click command', async () => {
  clearReleaseCache()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-'))
  try {
    fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.6\n')
    fs.writeFileSync(path.join(tmp, 'CHANGELOG.md'), FIXTURE)
    const status = await buildUpdateStatus({
      projectRoot: tmp,
      cacheMs: 0,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          tag_name: 'v1.2.7',
          name: 'vm2api v1.2.7',
          html_url: 'https://github.com/dofastted/vm2api/releases/tag/v1.2.7',
          published_at: '2026-09-21T00:00:00Z',
          body: '一键更新',
        }),
      }),
    })
    assert.equal(status.current, '1.2.6')
    assert.equal(status.latest, '1.2.7')
    assert.equal(status.update_available, true)
    assert.equal(status.changelog[0].version, '1.2.7')
    assert.match(status.upgrade_command, new RegExp(INSTALL_SCRIPT_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(status.upgrade_command, /upgrade --version v1\.2\.7/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    clearReleaseCache()
  }
})

test('buildUpdateStatus stays on current when GitHub is unreachable', async () => {
  clearReleaseCache()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-'))
  try {
    fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.6\n')
    fs.writeFileSync(path.join(tmp, 'CHANGELOG.md'), FIXTURE)
    const status = await buildUpdateStatus({
      projectRoot: tmp,
      cacheMs: 0,
      fetchImpl: async () => {
        throw new Error('network down')
      },
    })
    assert.equal(status.current, '1.2.6')
    assert.equal(status.latest, '1.2.6')
    assert.equal(status.update_available, false)
    assert.equal(status.source_error, 'network down')
    assert.equal(status.changelog[0].version, '1.2.7')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    clearReleaseCache()
  }
})

test('startHostUpgrade without confirm only returns the command', async () => {
  clearReleaseCache()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-'))
  try {
    fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.6\n')
    fs.writeFileSync(path.join(tmp, 'CHANGELOG.md'), FIXTURE)
    const result = await startHostUpgrade({
      projectRoot: tmp,
      confirm: false,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ tag_name: 'v1.2.7', body: '' }),
      }),
      spawnImpl() {
        throw new Error('should not spawn')
      },
    })
    assert.equal(result.status, 200)
    assert.equal(result.data.started, false)
    assert.equal(result.data.target, 'v1.2.7')
    assert.equal(result.data.command, upgradeCommand('v1.2.7'))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    clearReleaseCache()
  }
})

test('startHostUpgrade launches a Docker-managed helper for the actual Compose deployment', async () => {
  clearReleaseCache()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-'))
  try {
    fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.6\n')
    fs.writeFileSync(path.join(tmp, 'CHANGELOG.md'), FIXTURE)
    const docker = dockerFixture(tmp)
    const result = await startHostUpgrade({
      ...docker.options,
      projectRoot: tmp,
      confirm: true,
      fetchImpl: releaseFetch,
    })
    assert.equal(result.status, 202)
    assert.equal(result.data.started, true)
    const run = docker.calls.find((call) => call.args[0] === 'run')
    assert.ok(run.args.includes('--detach'))
    assert.ok(run.args.includes('vm2api-upgrade-custom-stack'))
    assert.ok(run.args.includes('docker:27-cli'))
    assert.ok(!run.args.includes('--rm'), 'keep failure status and logs after exit')
    assert.deepEqual(run.args.slice(run.args.indexOf('panel-upgrade') + 1), [
      tmp,
      'custom-stack',
      'custom-control',
      'old-control-plane',
      'v1.2.7',
      process.arch === 'arm64' ? 'arm64' : 'amd64',
      `${tmp}/docker-compose.yml`,
      `${tmp}/docker-compose.override.yml`,
    ])
    assert.equal(result.data.upgrade.state, 'running')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    clearReleaseCache()
  }
})

test('publicRelease ignores malformed GitHub payloads', () => {
  assert.equal(publicRelease(null), null)
  assert.equal(publicRelease({ tag_name: 'nightly' }), null)
  assert.equal(publicRelease({ tag_name: 'v1.2.7; rm -rf /' }), null)
  assert.equal(publicRelease({ tag_name: 'v1.2.7' }).version, '1.2.7')
})

test('VERSION is the only application release version source', () => {
  const root = path.resolve(import.meta.dirname, '../..')
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim()
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
  const vite = fs.readFileSync(path.join(root, 'web', 'vite.config.ts'), 'utf8')

  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.equal(Object.hasOwn(pkg, 'version'), false)
  assert.equal(Object.hasOwn(lock, 'version'), false)
  assert.equal(Object.hasOwn(lock.packages[''], 'version'), false)
  assert.doesNotMatch(compose, /image:\s*vm2api:[^\s]+/)
  assert.doesNotMatch(vite, /__APP_VERSION__|readFileSync/)
})

test('startHostUpgrade rejects non-semver targets', async () => {
  const result = await startHostUpgrade({
    confirm: true,
    version: 'v1.2.6; touch /tmp/pwned',
    spawnImpl() {
      throw new Error('should not spawn')
    },
  })
  assert.equal(result.status, 400)
  assert.equal(result.error.code, 'invalid_version')
})

test('release tags carry an optional architecture suffix that is cleaned and recognized', () => {
  assert.deepEqual(parseReleaseTag('v1.2.7'), { version: '1.2.7', tag: 'v1.2.7', arch: '' })
  assert.deepEqual(parseReleaseTag('1.2.7-aarch64'), { version: '1.2.7', tag: 'v1.2.7', arch: 'arm64' })
  assert.deepEqual(parseReleaseTag('v1.2.7-X86_64'), { version: '1.2.7', tag: 'v1.2.7', arch: 'amd64' })
  assert.equal(parseReleaseTag('v1.2.7-riscv64'), null)
  assert.equal(parseReleaseTag('v1.2.7-arm64; rm -rf /'), null)
  assert.equal(normalizeTag('v1.2.7-arm64'), 'v1.2.7')
  assert.equal(imageTagFor('v1.2.7', 'x64'), 'v1.2.7')
  assert.equal(imageTagFor('v1.2.7-arm64', 'arm64'), 'v1.2.7-arm64')
  assert.equal(imageTagFor('v1.2.7', 'aarch64'), 'v1.2.7-arm64')
  assert.equal(imageTagFor('v1.2.7', 'ppc64'), '')
})

test('startHostUpgrade rejects a suffix for another architecture before spawning', async () => {
  const result = await startHostUpgrade({
    confirm: true,
    version: 'v1.2.7-amd64',
    arch: 'arm64',
    spawnImpl() {
      throw new Error('should not spawn')
    },
  })
  assert.equal(result.status, 400)
  assert.equal(result.error.code, 'arch_mismatch')
})

test('ARM64 host upgrade passes its architecture and the running override to the helper', async () => {
  clearReleaseCache()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-'))
  try {
    fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.6\n')
    fs.writeFileSync(path.join(tmp, 'CHANGELOG.md'), FIXTURE)
    const docker = dockerFixture(tmp)
    docker.container.Config.Labels['com.docker.compose.project.config_files'] =
      `${tmp}/docker-compose.yml,${tmp}/docker-compose.arm64.yml`
    const result = await startHostUpgrade({
      ...docker.options,
      projectRoot: tmp,
      confirm: true,
      version: 'v1.2.7-arm64',
      arch: 'arm64',
      fetchImpl: releaseFetch,
    })
    assert.equal(result.status, 202)
    assert.equal(result.data.target, 'v1.2.7')
    const run = docker.calls.find((call) => call.args[0] === 'run')
    assert.deepEqual(run.args.slice(-3), ['arm64', `${tmp}/docker-compose.yml`, `${tmp}/docker-compose.arm64.yml`])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    clearReleaseCache()
  }
})

test('native Node cannot claim to upgrade itself by launching an unrelated Compose stack', async () => {
  clearReleaseCache()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-'))
  try {
    fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.6\n')
    const docker = dockerFixture(tmp, { containerized: false })
    const result = await startHostUpgrade({
      ...docker.options,
      projectRoot: tmp,
      confirm: true,
      fetchImpl: releaseFetch,
    })
    assert.equal(result.status, 409)
    assert.equal(result.error.code, 'host_upgrade_required')
    assert.equal(docker.calls.length, 0)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    clearReleaseCache()
  }
})

test('self discovery rejects another container and config files outside the mounted project', async () => {
  const docker = dockerFixture(import.meta.dirname)
  docker.options.sock = import.meta.filename
  docker.container.Config.Hostname = 'another-host'
  assert.equal(await hostUpgradeDeployment(docker.options), null)
  docker.container.Config.Hostname = 'control-host'
  docker.container.Config.Labels['com.docker.compose.project.config_files'] = '/elsewhere/compose.yml'
  assert.equal(await hostUpgradeDeployment(docker.options), null)
})

test('helper startup failures are returned instead of upgrade_started', async () => {
  clearReleaseCache()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-'))
  try {
    fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.6\n')
    const docker = dockerFixture(tmp, { runError: 'registry unavailable' })
    const result = await startHostUpgrade({
      ...docker.options,
      projectRoot: tmp,
      confirm: true,
      fetchImpl: releaseFetch,
    })
    assert.equal(result.status, 502)
    assert.equal(result.error.code, 'upgrade_start_failed')
    assert.equal(result.data.started, false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    clearReleaseCache()
  }
})

test('running helper blocks a duplicate update and exited helpers expose their actual outcome', async () => {
  clearReleaseCache()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-'))
  try {
    fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.6\n')
    const job = { Config: { Labels: { 'vm2api.upgrade.target': 'v1.2.7' } }, State: { Status: 'running' } }
    const docker = dockerFixture(tmp, { job })
    const result = await startHostUpgrade({
      ...docker.options,
      projectRoot: tmp,
      confirm: true,
      fetchImpl: releaseFetch,
    })
    assert.equal(result.status, 409)
    assert.equal(result.error.code, 'upgrade_in_progress')
    assert.ok(!docker.calls.some((call) => call.args[0] === 'run' || call.args[0] === 'rm'))
    job.State = { Status: 'exited', ExitCode: 1 }
    const failed = await readHostUpgradeStatus(docker.options)
    assert.equal(failed.state, 'failed')
    assert.equal(failed.exit_code, 1)
    assert.equal(failed.log_command, 'docker logs vm2api-upgrade-custom-stack')
    job.State.ExitCode = 0
    assert.equal((await readHostUpgradeStatus(docker.options)).state, 'succeeded')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    clearReleaseCache()
  }
})
