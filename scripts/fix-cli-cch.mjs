#!/usr/bin/env node
/** Backport the native CCH repair without upgrading a historical gateway. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const CLI_PATH = 'share/wrap-cli/cli-node'
const REPO = 'dofastted/vm2api'
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// Each payload keeps its original non-CCH bytes; these are not upgrades to the latest CLI.
export const CCH_HOTFIXES = [
  {
    before: '369889d8cc05c6084bb384e330b53541266d40b3abd2dc1042d3afe8c61aea28',
    beforeSize: 27172940,
    sha256: 'ac3403b6df3cd2ba2dae3c86140f69a10bbad9adf664e50852cb38fd3ada49a5',
    size: 27173284,
    asset: 'cli-node-cch-system-only-369889d8',
    releases: ['payload-2026.10.18-cch-sticky'],
  },
  {
    before: '049200f56fb1cf8f56b4704ab6b793d749fd45c13b87e6ed664cef62a3ddc8e3',
    beforeSize: 27173896,
    sha256: 'f96a6aca01dad7cc46969ee3d9f4bc4522711cce31b4b0d135239f996513796b',
    size: 27174008,
    asset: 'cli-node-cch-system-only-049200f5',
    releases: ['payload-2026.10.19-kernel-cli'],
  },
  {
    before: '55efe49e5dbf6cf96fc26535ec5130bbe5af87d51d043b813f289056d744e61d',
    beforeSize: 27174524,
    sha256: '1458ef623ef68d90e0e4ac8091388b4cba4333fd2b3e4e9f1535c4139f630aa2',
    size: 27174548,
    asset: 'cli-node-cch-system-only-55efe49e',
    releases: ['payload-2026.10.19-kernel-cli'],
  },
  {
    before: 'b5054cb8494670354e61f3e0a0f7b2c3b768832c841140a4e22407fec24ab009',
    beforeSize: 27174928,
    sha256: '5d6b33b68d5461bb810befc45d49f0734aa808e722dffd1a1d31bdc2a2c3e6ed',
    size: 27174984,
    asset: 'cli-node-cch-system-only-b5054cb8',
    releases: ['payload-2026.10.19-kernel-cli', 'payload-2026.10.22-computer-linux'],
  },
]

export function planCliCchHotfix(manifest) {
  if (manifest.repo !== REPO) throw new Error('unsupported payload repository')
  const files = manifest.files.filter((file) => file.path === CLI_PATH)
  if (files.length !== 1) throw new Error('expected exactly one Anthropic cli-node entry')
  const file = files[0]
  const fix = CCH_HOTFIXES.find((entry) => entry.before === file.sha256 || entry.sha256 === file.sha256)
  if (!fix || !fix.releases.includes(manifest.release)) throw new Error('unknown CLI payload; refusing replacement')
  const fixed = file.sha256 === fix.sha256
  if (file.size !== (fixed ? fix.size : fix.beforeSize) || file.asset !== (fixed ? fix.asset : 'cli-node'))
    throw new Error('unexpected CLI payload metadata; refusing replacement')
  return { file, fix, fixed }
}

function matches(buf, expected) {
  return buf.length === expected.size && sha256(buf) === expected.sha256
}

export async function repairCliCch({ dest, artifact, check = false }) {
  dest = path.resolve(dest)
  const version = fs.readFileSync(path.join(dest, 'VERSION'), 'utf8').trim()
  const number = /^1\.3\.(\d+)$/.exec(version)?.[1]
  if (!number || Number(number) < 198)
    throw new Error('historical repair requires v1.3.198+ (Node system-only CCH fix #580)')
  const manifestPath = path.join(dest, 'deploy/payload.json')
  const raw = fs.readFileSync(manifestPath)
  const manifest = JSON.parse(raw)
  const { file, fix, fixed } = planCliCchHotfix(manifest)
  const target = path.join(dest, CLI_PATH)
  const local = fs.existsSync(target) ? fs.readFileSync(target) : null
  const localFixed = local && matches(local, fix)
  if (local && !localFixed && !matches(local, { size: fix.beforeSize, sha256: fix.before }))
    throw new Error('installed CLI is not the historical or repaired payload; refusing replacement')
  if (fixed && localFixed) return { changed: false, sha256: fix.sha256 }
  if (check) throw new Error(`CCH repair required for ${version} (${fix.before.slice(0, 8)})`)
  // Serialize repairs and detect drift again after downloading, before either file is replaced.
  const lock = path.join(dest, '.cli-cch-hotfix.lock')
  const fd = fs.openSync(lock, 'wx', 0o600)
  const temporary = `${target}.cch-download-${process.pid}`
  const manifestTemporary = `${manifestPath}.cch-download-${process.pid}`
  try {
    const url = `https://github.com/${REPO}/releases/download/${manifest.release}/${fix.asset}`
    const buf = artifact
      ? fs.readFileSync(artifact)
      : await (async () => {
          const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
          if (!response.ok) throw new Error(`hotfix download returned HTTP ${response.status}`)
          return Buffer.from(await response.arrayBuffer())
        })()
    if (!matches(buf, fix)) throw new Error('hotfix payload failed size/SHA256 verification')
    if (!fs.readFileSync(manifestPath).equals(raw)) throw new Error('payload manifest changed during repair')
    if (local ? !fs.readFileSync(target).equals(local) : fs.existsSync(target))
      throw new Error('installed CLI changed during repair')
    const backup = path.join(dest, `.deploy-bak-cli-cch-${Date.now()}`)
    fs.mkdirSync(backup, { mode: 0o700 })
    fs.writeFileSync(path.join(backup, 'payload.json'), raw, { flag: 'wx', mode: 0o600 })
    if (local) fs.writeFileSync(path.join(backup, 'cli-node'), local, { flag: 'wx', mode: 0o700 })
    Object.assign(file, { asset: fix.asset, size: fix.size, sha256: fix.sha256 })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const previous = local ? fs.statSync(target) : null
    fs.writeFileSync(temporary, buf, { flag: 'wx', mode: previous ? previous.mode & 0o777 : 0o755 })
    fs.writeFileSync(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: fs.statSync(manifestPath).mode & 0o777,
    })
    if (process.getuid?.() === 0) {
      if (previous) fs.chownSync(temporary, previous.uid, previous.gid)
      const manifestStat = fs.statSync(manifestPath)
      fs.chownSync(manifestTemporary, manifestStat.uid, manifestStat.gid)
    }
    // The verified template goes first. An interrupted manifest update can be safely rerun.
    fs.renameSync(temporary, target)
    fs.renameSync(manifestTemporary, manifestPath)
    return { changed: true, sha256: fix.sha256, backup }
  } finally {
    fs.closeSync(fd)
    fs.rmSync(temporary, { force: true })
    fs.rmSync(manifestTemporary, { force: true })
    fs.unlinkSync(lock)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      dest: { type: 'string', default: path.resolve(import.meta.dirname, '..') },
      artifact: { type: 'string' },
      check: { type: 'boolean', default: false },
    },
  })
  const result = await repairCliCch(values)
  console.log(JSON.stringify(result))
  if (result.changed)
    console.log('Template repaired only. Drain and refresh Anthropic slots; never recreate cluster slots.')
}
