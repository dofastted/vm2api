/** Shared timezone validation for slot startup and workstation fingerprints. */
export const US_TIMEZONES = Object.freeze([
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
])
export const DEFAULT_TIMEZONE = 'America/Los_Angeles'

export function validTimezone(value) {
  const timezone = String(value || '').trim()
  // Intl also accepts numeric offsets on newer Node versions; TZ needs a named zone.
  if (!timezone || /^[+-]/.test(timezone)) return ''
  try {
    // Intl accepts case-insensitive input; Linux TZ paths are case-sensitive.
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone
  } catch {
    return ''
  }
}

export function normalizeTimezone(value) {
  return validTimezone(value) || DEFAULT_TIMEZONE
}
