import { createHash, randomBytes } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { verifyGeminiPayload } from '../src/lib/gemini/payload.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

try {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      'public-key': { type: 'string' },
      'release-dir': { type: 'string' },
    },
  })
  if (!values.source || !values['public-key'] || !values['release-dir']) {
    throw new Error(
      'usage: node scripts/issue-gemini-release-code.mjs --source DIR --public-key FILE --release-dir PRIVATE_DIR',
    )
  }
  const source = path.resolve(values.source)
  const manifestBytes = await readFile(path.join(source, 'manifest.json'))
  const { version } = await verifyGeminiPayload(source, await readFile(values['public-key']))
  if (!manifestBytes.equals(await readFile(path.join(source, 'manifest.json')))) {
    throw new Error('Gemini manifest changed during verification')
  }
  const digest = sha256(manifestBytes)
  const dir = path.resolve(values['release-dir'])
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const prefix = path.join(dir, `${version}-${digest}`)
  const codeFile = `${prefix}.code`
  const verifierFile = `${prefix}.json`
  // Publish the secret once; re-running issuance exports the same verifier.
  const stage = await mkdtemp(path.join(dir, '.gemini-issue-'))
  try {
    const candidate = path.join(stage, 'code')
    await writeFile(candidate, `CGG1-${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
    try {
      await link(candidate, codeFile)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const code = (await readFile(codeFile, 'utf8')).trim()
    if (!/^CGG1-[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Invalid saved release code')
    const verifier = JSON.stringify({ manifest_sha256: digest, code_sha256: sha256(code) }) + '\n'
    const verifierStage = path.join(stage, 'verifier')
    await writeFile(verifierStage, verifier, { mode: 0o600 })
    try {
      await link(verifierStage, verifierFile)
    } catch (error) {
      if (error.code !== 'EEXIST' || (await readFile(verifierFile, 'utf8')) !== verifier) throw error
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  console.log(`CRAGGemini ${version}\nCode: ${codeFile}\nHost verifier: ${verifierFile}`)
} catch (error) {
  console.error(error.code || error.message)
  process.exitCode = 1
}
