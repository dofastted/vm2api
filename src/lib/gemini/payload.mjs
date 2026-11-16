import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const AGY_SHA256 = '39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43'
const GEMINI_PAYLOAD_VERSION = '0.3.0-rc.1'
const FILES = new Map([
  ['craggemini', 0o755],
  ['libagy_bridge.so', 0o644],
  ['agy', 0o755],
])

function reject(code) {
  throw Object.assign(new Error(code), { code })
}

async function openRegular(filename, limit) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size < 1 || info.size > limit) reject('gemini_payload_invalid_file')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readSmall(filename, limit) {
  const handle = await openRegular(filename, limit)
  try {
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead === 0 || bytesRead > limit) reject('gemini_payload_invalid_file')
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function readSignedGeminiManifest(source, publicKey) {
  const key = createPublicKey(publicKey)
  const manifestBytes = await readSmall(path.join(source, 'manifest.json'), 8192)
  const signature = await readSmall(path.join(source, 'manifest.sig'), 64)
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, manifestBytes, key, signature)) {
    reject('gemini_payload_invalid_signature')
  }
  let manifest
  try {
    manifest = JSON.parse(manifestBytes)
  } catch {
    reject('gemini_payload_invalid_manifest')
  }
  if (
    manifest?.schema !== 1 ||
    manifest.platform !== 'linux-amd64' ||
    manifest.version !== GEMINI_PAYLOAD_VERSION ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== FILES.size
  ) {
    reject('gemini_payload_invalid_manifest')
  }
  const pending = new Set(FILES.keys())
  for (const file of manifest.files) {
    if (
      !pending.delete(file?.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > 512 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      (file.name === 'agy' && file.sha256 !== AGY_SHA256)
    ) {
      reject('gemini_payload_invalid_manifest')
    }
  }
  return { manifest, manifestBytes, signature }
}

async function checkMember(source, file, destination) {
  const handle = await openRegular(path.join(source, file.name), file.size)
  const digest = createHash('sha256')
  let bytes = 0
  try {
    const input = handle.createReadStream({ autoClose: false })
    if (destination) {
      await pipeline(
        input,
        new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length
            if (bytes > file.size) return done(new Error('gemini_payload_member_mismatch'))
            digest.update(chunk)
            done(null, chunk)
          },
        }),
        createWriteStream(path.join(destination, file.name), { flags: 'wx', mode: FILES.get(file.name) }),
      )
    } else {
      for await (const chunk of input) {
        bytes += chunk.length
        if (bytes > file.size) reject('gemini_payload_member_mismatch')
        digest.update(chunk)
      }
    }
    if (bytes !== file.size || digest.digest('hex') !== file.sha256) reject('gemini_payload_member_mismatch')
  } finally {
    await handle.close()
  }
}

export async function verifyGeminiPayload(source, publicKey) {
  const { manifest } = await readSignedGeminiManifest(source, publicKey)
  for (const file of manifest.files) await checkMember(source, file)
  return manifest
}

export async function installGeminiPayload(source, destination, publicKey) {
  if (process.platform !== 'linux' || process.arch !== 'x64') reject('gemini_payload_unsupported_host')
  const { manifest, manifestBytes, signature } = await readSignedGeminiManifest(source, publicKey)
  const parent = path.dirname(destination)
  await mkdir(parent, { recursive: true, mode: 0o755 })
  const staging = await mkdtemp(path.join(parent, '.gemini-payload-'))
  try {
    for (const file of manifest.files) await checkMember(source, file, staging)
    for (const [name, contents] of [
      ['manifest.json', manifestBytes],
      ['manifest.sig', signature],
    ]) {
      const metadata = await open(path.join(staging, name), 'wx', 0o644)
      try {
        await metadata.writeFile(contents)
        await metadata.chmod(0o644)
      } finally {
        await metadata.close()
      }
    }
    for (const [name, mode] of FILES) await chmod(path.join(staging, name), mode)
    await chmod(staging, 0o755)
    await rename(staging, destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return manifest.version
}
