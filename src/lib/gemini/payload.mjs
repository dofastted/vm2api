import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants, createWriteStream, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const AGY_SHA256 = '39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43'
export const CRAG_GEMINI_PRODUCT = 'craggemini'
const PAYLOAD_DOMAIN = Buffer.from('CRAG-PAYLOAD-V1\0')
const GEMINI_PAYLOAD_VERSIONS = new Set(['0.3.0-rc.1', '0.3.0-rc.2', '0.3.0-rc.3', '0.3.0'])
const LEGACY_FILES = new Map([
  ['craggemini', 0o755],
  ['libagy_bridge.so', 0o644],
  ['agy', 0o755],
])
const CRAG_REQUIRED_FILES = new Map([
  ['craggemini', 0o755],
  ['craggemini.payload.enc', 0o644],
  ['libagy_bridge.so', 0o644],
  ['crag-license-public.pem', 0o644],
  ['agy', 0o755],
])
const CRAG_OPTIONAL_FILES = new Map([
  ['LICENSES.txt', 0o644],
  ['unpack-note.md', 0o644],
])
const HEX64 = /^[a-f0-9]{64}$/

function reject(code) {
  throw Object.assign(new Error(code), { code })
}

function rawEd25519Bytes(key) {
  if (key.asymmetricKeyType !== 'ed25519') reject('gemini_payload_invalid_signature')
  const bytes = Buffer.from(key.export({ format: 'jwk' }).x, 'base64url')
  if (bytes.length !== 32) reject('gemini_payload_invalid_signature')
  return bytes
}

function decodeBase64Url(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) reject('gemini_payload_invalid_manifest')
  const bytes = Buffer.from(value, 'base64url')
  if ((expectedLength != null && bytes.length !== expectedLength) || bytes.toString('base64url') !== value) {
    reject('gemini_payload_invalid_manifest')
  }
  return bytes
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

function isCragEncryptedManifest(manifest) {
  return manifest?.family === 'crag' && manifest?.encrypted === true
}

function parseCragGeminiManifest(manifest, expectedPublicKey) {
  const key = createPublicKey(expectedPublicKey)
  const expectedPubBytes = rawEd25519Bytes(key)
  const expectedIssuerId = createHash('sha256').update(expectedPubBytes).digest('hex')

  if (
    manifest?.family !== 'crag' ||
    manifest.encrypted !== true ||
    manifest.runtime !== 'native' ||
    manifest.entrypoint !== 'craggemini' ||
    manifest.arch !== 'amd64' ||
    typeof manifest.software_version !== 'string' ||
    !/^[a-zA-Z0-9.-]{1,64}$/.test(manifest.software_version)
  ) {
    reject('gemini_payload_invalid_manifest')
  }

  const auth = manifest.authorization
  if (
    !auth ||
    typeof auth !== 'object' ||
    auth.scheme !== 'ed25519-x25519-v1' ||
    auth.product !== CRAG_GEMINI_PRODUCT ||
    typeof auth.public_key !== 'string' ||
    typeof auth.public_key_id !== 'string'
  ) {
    reject('gemini_payload_invalid_manifest')
  }
  const manifestPubBytes = decodeBase64Url(auth.public_key, 32)
  const manifestIssuerId = createHash('sha256').update(manifestPubBytes).digest('hex')
  if (
    auth.public_key_id !== manifestIssuerId ||
    !manifestPubBytes.equals(expectedPubBytes) ||
    manifestIssuerId !== expectedIssuerId
  ) {
    reject('gemini_payload_invalid_signature')
  }

  const payload = manifest.payload
  if (
    !payload ||
    typeof payload !== 'object' ||
    payload.path !== 'craggemini.payload.enc' ||
    payload.format !== 'CRAGV2E1' ||
    payload.algorithm !== 'aes-256-gcm' ||
    !HEX64.test(payload.key_id || '') ||
    !HEX64.test(payload.plaintext_sha256 || '') ||
    !HEX64.test(payload.ciphertext_sha256 || '') ||
    typeof payload.signature !== 'string'
  ) {
    reject('gemini_payload_invalid_manifest')
  }

  const statement = {
    product: CRAG_GEMINI_PRODUCT,
    format: payload.format,
    algorithm: payload.algorithm,
    key_id: payload.key_id,
    plaintext_sha256: payload.plaintext_sha256,
    ciphertext_sha256: payload.ciphertext_sha256,
  }
  const sigBytes = decodeBase64Url(payload.signature, 64)
  if (!verify(null, Buffer.concat([PAYLOAD_DOMAIN, Buffer.from(JSON.stringify(statement))]), key, sigBytes)) {
    reject('gemini_payload_invalid_signature')
  }

  const shaMap = manifest.sha256
  if (!shaMap || typeof shaMap !== 'object' || Array.isArray(shaMap)) {
    reject('gemini_payload_invalid_manifest')
  }
  const names = Object.keys(shaMap)
  const files = []
  for (const [requiredName, mode] of CRAG_REQUIRED_FILES) {
    if (!Object.hasOwn(shaMap, requiredName)) reject('gemini_payload_invalid_manifest')
    const digest = shaMap[requiredName]
    if (!HEX64.test(digest || '')) reject('gemini_payload_invalid_manifest')
    if (requiredName === 'agy' && digest !== AGY_SHA256) reject('gemini_payload_invalid_manifest')
    if (requiredName === 'craggemini.payload.enc' && digest !== payload.ciphertext_sha256) {
      reject('gemini_payload_invalid_manifest')
    }
    files.push({ name: requiredName, sha256: digest, mode })
  }
  for (const name of names) {
    if (CRAG_REQUIRED_FILES.has(name)) continue
    if (!CRAG_OPTIONAL_FILES.has(name) || !HEX64.test(shaMap[name] || '')) {
      reject('gemini_payload_invalid_manifest')
    }
    files.push({ name, sha256: shaMap[name], mode: CRAG_OPTIONAL_FILES.get(name) })
  }

  return {
    manifest,
    files,
    version: manifest.software_version,
    authority: {
      product: CRAG_GEMINI_PRODUCT,
      publicKey: key,
      publicKeyBytes: expectedPubBytes,
      issuerId: expectedIssuerId,
      payloadKeyId: payload.key_id,
      softwareVersion: manifest.software_version,
    },
  }
}

export async function readSignedGeminiManifest(source, publicKey) {
  const manifestBytes = await readSmall(path.join(source, 'manifest.json'), 65536)
  let manifest
  try {
    manifest = JSON.parse(manifestBytes)
  } catch {
    reject('gemini_payload_invalid_manifest')
  }
  if (isCragEncryptedManifest(manifest)) {
    const parsed = parseCragGeminiManifest(manifest, publicKey)
    return {
      mode: 'crag_subscription',
      manifest: parsed.manifest,
      manifestBytes,
      signature: null,
      files: parsed.files,
      version: parsed.version,
      authority: parsed.authority,
    }
  }

  const key = createPublicKey(publicKey)
  const signature = await readSmall(path.join(source, 'manifest.sig'), 64)
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, manifestBytes, key, signature)) {
    reject('gemini_payload_invalid_signature')
  }
  if (
    manifest?.schema !== 1 ||
    manifest.platform !== 'linux-amd64' ||
    !GEMINI_PAYLOAD_VERSIONS.has(manifest.version) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== LEGACY_FILES.size
  ) {
    reject('gemini_payload_invalid_manifest')
  }
  const pending = new Set(LEGACY_FILES.keys())
  const files = []
  for (const file of manifest.files) {
    if (
      !pending.delete(file?.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > 512 * 1024 * 1024 ||
      !HEX64.test(file.sha256) ||
      (file.name === 'agy' && file.sha256 !== AGY_SHA256)
    ) {
      reject('gemini_payload_invalid_manifest')
    }
    files.push({ ...file, mode: LEGACY_FILES.get(file.name) })
  }
  return { mode: 'legacy_release', manifest, manifestBytes, signature, files, version: manifest.version }
}

async function checkMember(source, file, destination) {
  const maxBytes = file.size ?? 512 * 1024 * 1024
  const handle = await openRegular(path.join(source, file.name), maxBytes)
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
            if (bytes > maxBytes) return done(new Error('gemini_payload_member_mismatch'))
            digest.update(chunk)
            done(null, chunk)
          },
        }),
        createWriteStream(path.join(destination, file.name), {
          flags: 'wx',
          mode: file.mode ?? LEGACY_FILES.get(file.name),
        }),
      )
    } else {
      for await (const chunk of input) {
        bytes += chunk.length
        if (bytes > maxBytes) reject('gemini_payload_member_mismatch')
        digest.update(chunk)
      }
    }
    if ((file.size != null && bytes !== file.size) || digest.digest('hex') !== file.sha256) {
      reject('gemini_payload_member_mismatch')
    }
  } finally {
    await handle.close()
  }
}

export async function verifyCragGeminiPayload(source, publicKey) {
  const parsed = await readSignedGeminiManifest(source, publicKey)
  if (parsed.mode !== 'crag_subscription') reject('gemini_payload_invalid_manifest')
  const bundledPem = await readSmall(path.join(source, 'crag-license-public.pem'), 4096)
  if (!rawEd25519Bytes(createPublicKey(bundledPem)).equals(parsed.authority.publicKeyBytes)) {
    reject('gemini_payload_invalid_signature')
  }
  for (const file of parsed.files) await checkMember(source, file)
  return { ...parsed.manifest, version: parsed.version, authority: parsed.authority }
}

export async function verifyGeminiPayload(source, publicKey) {
  const parsed = await readSignedGeminiManifest(source, publicKey)
  if (parsed.mode === 'crag_subscription') {
    const bundledPem = await readSmall(path.join(source, 'crag-license-public.pem'), 4096)
    if (!rawEd25519Bytes(createPublicKey(bundledPem)).equals(parsed.authority.publicKeyBytes)) {
      reject('gemini_payload_invalid_signature')
    }
  }
  for (const file of parsed.files) await checkMember(source, file)
  return parsed.mode === 'crag_subscription' ? { ...parsed.manifest, version: parsed.version } : parsed.manifest
}

export async function installGeminiPayload(source, destination, publicKey) {
  if (process.platform !== 'linux' || process.arch !== 'x64') reject('gemini_payload_unsupported_host')
  const parsed = await readSignedGeminiManifest(source, publicKey)
  if (parsed.mode === 'crag_subscription') {
    const bundledPem = await readSmall(path.join(source, 'crag-license-public.pem'), 4096)
    if (!rawEd25519Bytes(createPublicKey(bundledPem)).equals(parsed.authority.publicKeyBytes)) {
      reject('gemini_payload_invalid_signature')
    }
  }
  const parent = path.dirname(destination)
  await mkdir(parent, { recursive: true, mode: 0o755 })
  const staging = await mkdtemp(path.join(parent, '.gemini-payload-'))
  try {
    for (const file of parsed.files) await checkMember(source, file, staging)
    const metadataFiles = [['manifest.json', parsed.manifestBytes]]
    if (parsed.signature) metadataFiles.push(['manifest.sig', parsed.signature])
    for (const [name, contents] of metadataFiles) {
      const metadata = await open(path.join(staging, name), 'wx', 0o644)
      try {
        await metadata.writeFile(contents)
        await metadata.chmod(0o644)
      } finally {
        await metadata.close()
      }
    }
    for (const file of parsed.files) await chmod(path.join(staging, file.name), file.mode)
    await chmod(staging, 0o755)
    await rename(staging, destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return parsed.version
}

export function readCragGeminiPackageAuthority(payloadDir, expectedPublicKeyPem = null) {
  const manifestPath = path.join(payloadDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!isCragEncryptedManifest(manifest)) reject('gemini_payload_invalid_manifest')
  const pem = expectedPublicKeyPem ?? readFileSync(path.join(payloadDir, 'crag-license-public.pem'))
  const parsed = parseCragGeminiManifest(manifest, pem)
  return parsed.authority
}
