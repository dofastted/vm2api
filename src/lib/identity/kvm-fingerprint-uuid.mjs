import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { coerceRfc4122Uuid, isRfc4122Uuid } from './rfc4122-uuid.mjs'

function splitSmbios(body) {
  const parts = []
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] === ',' && body[i + 1] === ',') {
      cur += ','
      i++
      continue
    }
    if (body[i] === ',') {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += body[i]
  }
  parts.push(cur)
  return parts
}

function coalesceBrokenCommaParts(parts) {
  const merged = []
  for (const part of parts) {
    if (!part.includes('=') && merged.length > 0) {
      merged[merged.length - 1] += `,${part}`
    } else {
      merged.push(part)
    }
  }
  return merged
}

function joinSmbios(parts) {
  return parts.map((part) => String(part).replaceAll(',', ',,')).join(',')
}

function uuidFromQemuSmbiosArgs(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  let uuid = ''
  let type1 = ''
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '-uuid' && lines[i + 1] && !lines[i + 1].startsWith('-')) uuid = lines[++i]
    else if (lines[i] === '-smbios' && lines[i + 1]?.startsWith('type=1,')) type1 = lines[++i]
  }
  const fields = {}
  for (const part of splitSmbios(type1)) {
    const eq = part.indexOf('=')
    if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return String(fields.uuid || uuid || '').trim()
}

function setType1Uuid(type1Line, uuid) {
  const body = type1Line.startsWith('type=1,') ? type1Line.slice('type=1,'.length) : type1Line
  const parts = body ? coalesceBrokenCommaParts(splitSmbios(body)) : []
  let found = false
  const next = parts.map((part) => {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq) === 'uuid') {
      found = true
      return `uuid=${uuid}`
    }
    return part
  })
  if (!found) next.push(`uuid=${uuid}`)
  return `type=1,${joinSmbios(next)}`
}

export function patchQemuSmbiosArgsUuid(text, uuid) {
  const raw = String(text ?? '')
  const lines = raw.split(/\r?\n/)
  const out = []
  let hasUuidFlag = false
  let type1Patched = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '-uuid') {
      hasUuidFlag = true
      out.push(line)
      const next = lines[i + 1]
      if (next != null && !String(next).trim().startsWith('-')) {
        out.push(uuid)
        i++
      } else {
        out.push(uuid)
      }
      continue
    }
    if (trimmed === '-smbios') {
      out.push(line)
      const next = lines[i + 1]
      if (next != null && String(next).trim().startsWith('type=1,')) {
        out.push(setType1Uuid(String(next).trim(), uuid))
        type1Patched = true
        i++
      }
      continue
    }
    out.push(line)
  }
  let joined = out.join('\n')
  if (!hasUuidFlag) {
    joined = joined.trimEnd()
    joined = joined ? `-uuid\n${uuid}\n${joined}\n` : `-uuid\n${uuid}\n`
  } else if (!type1Patched) {
    joined = joined.trimEnd()
    joined = `${joined}\n-smbios\n${setType1Uuid('type=1,', uuid)}\n`
  }
  if (!joined.endsWith('\n')) joined += '\n'
  return joined
}

/**
 * kin-computer may leave uuid empty on redacted DMI profiles; persist a valid RFC4122 value
 * before linuxComputer() acceptance and before QEMU reads qemu-smbios.args.
 */
export function repairKvmFingerprintUuid(dir) {
  const identPath = path.join(dir, 'identity.json')
  const smbiosPath = path.join(dir, 'qemu-smbios.args')
  if (!fs.existsSync(identPath) || !fs.existsSync(smbiosPath)) return false
  let data
  try {
    data = JSON.parse(fs.readFileSync(identPath, 'utf8'))
  } catch {
    return false
  }
  const fromArgs = uuidFromQemuSmbiosArgs(fs.readFileSync(smbiosPath, 'utf8'))
  const uuid = coerceRfc4122Uuid(String(data.uuid || fromArgs || '').trim())
  let changed = false
  if (!isRfc4122Uuid(String(data.uuid || '').trim())) {
    data.uuid = uuid
    if (
      data.hardware &&
      typeof data.hardware === 'object' &&
      !isRfc4122Uuid(String(data.hardware.hardware_uuid || '').trim())
    ) {
      data.hardware.hardware_uuid = uuid
    }
    atomicWriteJson(identPath, data, { mode: 0o600 })
    changed = true
  }
  const argsText = fs.readFileSync(smbiosPath, 'utf8')
  const patched = patchQemuSmbiosArgsUuid(argsText, uuid)
  if (patched !== argsText) {
    fs.writeFileSync(smbiosPath, patched, 'utf8')
    changed = true
  }
  return changed
}
