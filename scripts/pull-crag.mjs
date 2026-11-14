#!/usr/bin/env node
import path from 'node:path'
import { updateCrag } from './update-crag.mjs'

// A separate entry point also fails closed when a newer installer is used with
// an older deployment: it cannot silently fall back to the full slot updater.
const root = path.resolve(process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/vm2api')
try {
  console.log(JSON.stringify(await updateCrag(root, { tag: process.argv[3] || '', pullOnly: true })))
} catch (error) {
  console.error(`CRAG pull failed: ${error.message}; no slots were installed or restarted`)
  process.exitCode = 1
}
