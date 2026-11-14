#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { cragV2Arch, stageCragV2Tree } from '../src/lib/vm/wrap-cli-runtime.mjs'

export function seedCragFactory(root, imageRoot, { arch = cragV2Arch() } = {}) {
  if (arch !== 'amd64') return { ok: true, seeded: false, reason: 'unsupported_arch' }
  if (String(process.env.KIN_CRAG_V2_ROOT || '').trim()) return { ok: true, seeded: false, reason: 'custom_package' }
  const destination = path.join(root, 'share/crag/kernels/v2', arch)
  // An existing issuer and any downloaded selection belong to the installation.
  if (fs.existsSync(destination)) return { ok: true, seeded: false, reason: 'factory_exists' }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const staged = stageCragV2Tree(path.join(imageRoot, 'kernels/v2', arch), destination)
  if (!staged.ok) throw new Error(staged.code)
  staged.commit()
  return { ok: true, seeded: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/vm2api')
  const imageRoot = path.resolve(process.argv[3] || '/opt/vm2api/image-crag')
  try {
    console.log(JSON.stringify(seedCragFactory(root, imageRoot)))
  } catch (error) {
    console.error(`CRAG factory initialization failed: ${error.message}`)
    process.exitCode = 1
  }
}
