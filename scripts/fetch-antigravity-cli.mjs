#!/usr/bin/env node
/** Pinned official Linux CLI; OAuth remains inside the slot's official client. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ANTIGRAVITY_CLI_RELEASE = Object.freeze({
  version: '1.4.4',
  url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.4-4783783166214144/linux-x64/cli_linux_x64.tar.gz',
  sha512:
    '7ce149d350344c1046c7b59b6659bcc5d659f351bf3a07c6c085887d93427ceb89d927752e4ccd0844b53ffb91d33d6a49f72835ceb276c7cffdd13cfb8023b8',
})

export async function fetchAntigravityCli(dest) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-agy-'))
  try {
    const response = await fetch(ANTIGRAVITY_CLI_RELEASE.url, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok) throw new Error(`Official CLI download failed: HTTP ${response.status}`)
    const archive = Buffer.from(await response.arrayBuffer())
    if (crypto.createHash('sha512').update(archive).digest('hex') !== ANTIGRAVITY_CLI_RELEASE.sha512)
      throw new Error('Official Antigravity CLI checksum mismatch')
    const file = path.join(temporary, 'cli.tar.gz')
    fs.writeFileSync(file, archive, { mode: 0o600 })
    execFileSync('tar', ['-xzf', file, '-C', temporary, 'antigravity'])
    fs.mkdirSync(dest, { recursive: true })
    fs.copyFileSync(path.join(temporary, 'antigravity'), path.join(dest, 'agy'))
    fs.chmodSync(path.join(dest, 'agy'), 0o755)
    fs.writeFileSync(path.join(dest, 'version'), ANTIGRAVITY_CLI_RELEASE.version + '\n')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--dest')
  if (index < 0 || !process.argv[index + 1]) throw new Error('--dest is required')
  await fetchAntigravityCli(path.resolve(process.argv[index + 1]))
}
