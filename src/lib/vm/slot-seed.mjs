/**
 * Single writer for slot seed files.
 * Create / recreate / official init / panel PUT all go through here so
 * leftover script env cannot fight the current standard.
 */
import fs from 'node:fs'
import path from 'node:path'
import { defaultSeedPolicy, buildSlotSettingsEnv } from '../protocol/seed-policy.mjs'
import { buildKinSeedJson } from '../identity/workstation-profile.mjs'
import { OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import { syncWorkerTelemetry } from './vm-runtime.mjs'

export function inferProjectRootFromCliHome(homeDir) {
  if (!homeDir) return null
  const home = path.resolve(homeDir)
  if (path.basename(home) !== 'cli-home') return null
  const vms = path.dirname(path.dirname(home))
  if (path.basename(vms) !== 'vms') return null
  return path.dirname(vms)
}

export function writeSlotSeedFiles(projectRoot, vm, seedPolicy = null) {
  if (!projectRoot || !vm?.id) return { wrote: false }
  const pol = defaultSeedPolicy(seedPolicy || vm.seed_policy || {})
  const homeDir = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  const claudeDir = path.join(homeDir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 })
  const timezone = vm.timezone || vm.fingerprint?.timezone
  const locale = vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8'
  const override =
    pol.settings_json_override && typeof pol.settings_json_override === 'object' ? pol.settings_json_override : {}
  const settings = {
    ...override,
    env: buildSlotSettingsEnv(pol, {
      timezone,
      locale,
      extra: override.env,
    }),
    theme: pol.theme || 'dark',
    autoUpdates: false,
    grove_enabled: false,
  }
  const seedDoc = buildKinSeedJson(vm, pol, {
    timezone,
    locale,
    cli_version: OFFICIAL_CLI_VERSION,
  })
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2))
  fs.writeFileSync(path.join(claudeDir, 'claude.setting'), `${pol.claude_setting}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(claudeDir, 'kin-seed.json'), JSON.stringify(seedDoc, null, 2))
  let telemetry = { wrote: false }
  try {
    telemetry = syncWorkerTelemetry({ ...vm, seed_policy: pol }, projectRoot)
  } catch {}
  return {
    wrote: true,
    homeDir,
    seed_policy: pol,
    settings,
    claude_setting: pol.claude_setting,
    kin_seed: seedDoc,
    telemetry,
  }
}
