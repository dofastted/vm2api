/**
 * The only telemetry read. Matches `isTelemetryEnabled` in
 * `src/lib/protocol/seed-policy.mjs`: on iff `telemetry_disabled === false`.
 * `seed_policy.disable_nonessential_traffic` and `do_not_track` are legacy
 * `kin-seed.json` mirrors (actual `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
 * in `settings.json` is governed by `routing.telemetry.disable_nonessential_traffic`).
 * Missing the field means off, same as `defaultSeedPolicy`.
 */
export function telemetryEnabled(
  policy: Record<string, unknown> | null | undefined
): boolean {
  return policy?.telemetry_disabled === false
}

export type TelemetrySeedFlags = {
  telemetry_disabled: boolean
  disable_nonessential_traffic: boolean
  do_not_track: boolean
}

/** Write-side mirrors. Do not read these to decide whether telemetry is on. */
export function telemetrySeedFlags(enabled: boolean): TelemetrySeedFlags {
  return {
    telemetry_disabled: !enabled,
    disable_nonessential_traffic: enabled,
    do_not_track: !enabled,
  }
}
