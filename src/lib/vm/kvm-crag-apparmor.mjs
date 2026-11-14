import fs from 'node:fs'

let guestScript

/** Inline the current helper so existing overlays do not need cloud-init to run again. */
export function kvmCragAppArmorCommand({ restart = false } = {}) {
  guestScript ??= fs.readFileSync(new URL('../../../docker/kin-kvm/guest/kin-crag-apparmor', import.meta.url), 'utf8')
  return ['python3', '-c', guestScript, ...(restart ? ['--', 'systemctl', 'restart', 'kin-kernel.service'] : [])]
}
