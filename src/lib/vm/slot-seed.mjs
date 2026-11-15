/**
 * Single writer for slot seed files.
 * Create / recreate / official init / panel PUT all go through here so
 * leftover script env cannot fight the current standard.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  defaultSeedPolicy,
  buildSlotSettingsEnv,
  isTelemetryEnabled,
  NONESSENTIAL_TRAFFIC_ENV_KEY,
} from '../protocol/seed-policy.mjs'
import { buildKinSeedJson } from '../identity/workstation-profile.mjs'
import { OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import crypto from 'node:crypto'
import { runtimeFileOwner } from '../oauth/oauth-credentials.mjs'

const SEED_FILES = ['settings.json', 'claude.setting', 'kin-seed.json']

function withSeedDirectory(slotDir, create, fn) {
  if (create) fs.mkdirSync(slotDir, { recursive: true, mode: 0o700 })
  const handles = []
  try {
    let fd = fs.openSync(slotDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    handles.push(fd)
    for (const name of ['cli-home', '.claude']) {
      const dir = `/proc/self/fd/${fd}/${name}`
      if (create) {
        try {
          fs.mkdirSync(dir, { mode: 0o700 })
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
      }
      fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      handles.push(fd)
    }
    const result = fn(`/proc/self/fd/${fd}`)
    if (create) fs.fsyncSync(fd)
    return result
  } finally {
    for (const fd of handles.reverse()) fs.closeSync(fd)
  }
}

function readSeedFile(dir, name) {
  let fd
  try {
    fd = fs.openSync(`${dir}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 1 << 20) throw new Error('seed_file_invalid')
    const data = Buffer.alloc(Math.min(stat.size + 1, (1 << 20) + 1))
    const count = fs.readSync(fd, data, 0, data.length, 0)
    if (count > 1 << 20) throw new Error('seed_file_too_large')
    return data.subarray(0, count).toString('utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Owner-mounted bytes only. Missing files remain null; unsafe files fail explicitly. */
export function readLocalSlotSeedFiles(slotDir) {
  try {
    return withSeedDirectory(slotDir, false, (dir) =>
      Object.fromEntries(SEED_FILES.map((name) => [name, readSeedFile(dir, name)])),
    )
  } catch (error) {
    if (error.code === 'ENOENT') return Object.fromEntries(SEED_FILES.map((name) => [name, null]))
    throw error
  }
}

function replaceSeedFile(dir, name, body, vm) {
  const tmp = `${dir}/.seed-${crypto.randomBytes(12).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    fs.writeFileSync(fd, body)
    fs.fchmodSync(fd, 0o600)
    const { uid, gid } = runtimeFileOwner(vm)
    try {
      fs.fchownSync(fd, uid, gid)
    } catch (error) {
      if (process.getuid?.() === 0) throw error
    }
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, `${dir}/${name}`)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try {
      fs.unlinkSync(tmp)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

export function inferProjectRootFromCliHome(homeDir) {
  if (!homeDir) return null
  const home = path.resolve(homeDir)
  if (path.basename(home) !== 'cli-home') return null
  const vms = path.dirname(path.dirname(home))
  if (path.basename(vms) !== 'vms') return null
  return path.dirname(vms)
}

export function writeSlotSeedFiles(
  projectRoot,
  vm,
  seedPolicy = null,
  { existingSettings, replaceEnv = false, cragNativeTelemetry = false } = {},
) {
  if (!projectRoot || !vm?.id) return { wrote: false }
  const pol = defaultSeedPolicy(seedPolicy || vm.seed_policy || {})
  const homeDir = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  const slotDir = path.dirname(homeDir)
  let previousSettings = existingSettings
  if (previousSettings === undefined) {
    const previous = readLocalSlotSeedFiles(slotDir)['settings.json']
    previousSettings = previous === null ? {} : JSON.parse(previous)
  }
  if (!previousSettings || typeof previousSettings !== 'object' || Array.isArray(previousSettings)) {
    throw new Error('seed_settings_invalid')
  }
  const timezone = vm.timezone || vm.fingerprint?.timezone
  const locale = vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8'
  const override =
    pol.settings_json_override && typeof pol.settings_json_override === 'object' ? pol.settings_json_override : {}
  const settings = {
    ...previousSettings,
    ...override,
    env: buildSlotSettingsEnv(pol, {
      timezone,
      locale,
      extra: replaceEnv ? override.env : { ...previousSettings.env, ...override.env },
    }),
    theme: pol.theme || 'dark',
    autoUpdates: false,
    grove_enabled: false,
  }
  if (cragNativeTelemetry && isTelemetryEnabled(pol)) delete settings.env[NONESSENTIAL_TRAFFIC_ENV_KEY]
  const seedDoc = buildKinSeedJson(vm, pol, {
    timezone,
    locale,
    cli_version: OFFICIAL_CLI_VERSION,
  })
  withSeedDirectory(slotDir, true, (dir) => {
    replaceSeedFile(dir, 'settings.json', JSON.stringify(settings, null, 2), vm)
    replaceSeedFile(dir, 'claude.setting', `${pol.claude_setting}\n`, vm)
    replaceSeedFile(dir, 'kin-seed.json', JSON.stringify(seedDoc, null, 2), vm)
  })
  return {
    wrote: true,
    homeDir,
    seed_policy: pol,
    settings,
    claude_setting: pol.claude_setting,
    kin_seed: seedDoc,
  }
}
