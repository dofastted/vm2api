import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { installGeminiPayload, verifyGeminiPayload } from '../src/lib/gemini/payload.mjs'

try {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      dest: { type: 'string' },
      'public-key': { type: 'string' },
      check: { type: 'boolean' },
    },
  })
  if (!values.source || !values['public-key'] || (values.check ? values.dest : !values.dest)) {
    throw new Error(
      'usage: node scripts/install-gemini-payload.mjs --source DIR --public-key FILE (--dest DIR | --check)',
    )
  }
  const key = await readFile(values['public-key'])
  const version = values.check
    ? (await verifyGeminiPayload(path.resolve(values.source), key)).version
    : await installGeminiPayload(path.resolve(values.source), path.resolve(values.dest), key)
  console.log(`Gemini payload ${version} ${values.check ? 'verified' : 'installed'}`)
} catch (error) {
  console.error(error.code || error.message)
  process.exitCode = 1
}
