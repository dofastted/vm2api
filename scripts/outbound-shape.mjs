#!/usr/bin/env node
/**
 * Outbound body structure tool. Prints redacted structure only (no prompt text,
 * ids or secrets).
 *
 *   node scripts/outbound-shape.mjs --shape <body.json>
 *   node scripts/outbound-shape.mjs --diff <a.json> <b.json>
 *   node scripts/outbound-shape.mjs --against-profile 2.1.303 <body.json>
 *   node scripts/outbound-shape.mjs --against-profile 2.1.303 <capture.json> --wire
 *   node scripts/outbound-shape.mjs --make-skeleton <raw.json> > test/fixtures/official-2.1.303-skeleton.json
 *
 * Inputs may be a Messages body, a capture with `{ body }`, or a `.shape.json`
 * produced by this tool. `--wire` needs a CLI capture `{ raw, body, headers }` and adds
 * the final-bytes rules (key order, version, UA, CCH, content-length).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkOfficial303Rules,
  checkOfficial303Wire,
  diffShapes,
  isAllowedSkeletonDiff,
  outboundShape,
} from '../src/lib/protocol/outbound-shape.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKELETONS = { '2.1.303': path.join(ROOT, 'test/fixtures/official-2.1.303-skeleton.json') }

function load(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (doc && typeof doc === 'object' && doc.top_level && doc.markers) return doc
  const body = doc && typeof doc === 'object' && doc.body && typeof doc.body === 'object' ? doc.body : doc
  return outboundShape(body)
}

function loadBody(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  return doc && typeof doc === 'object' && doc.body && typeof doc.body === 'object' ? doc.body : doc
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function main(argv) {
  const [mode, ...rest] = argv
  if (mode === '--shape' && rest[0]) return print(load(rest[0]))
  if (mode === '--make-skeleton' && rest[0]) return print(load(rest[0]))
  if (mode === '--diff' && rest[0] && rest[1]) {
    const diffs = diffShapes(load(rest[0]), load(rest[1]))
    print(diffs)
    return diffs.length ? 1 : 0
  }
  if (mode === '--against-profile' && rest[0] && rest[1]) {
    const skeleton = SKELETONS[rest[0]]
    if (!skeleton) throw new Error(`unknown profile ${rest[0]}`)
    const diffs = diffShapes(JSON.parse(fs.readFileSync(skeleton, 'utf8')), load(rest[1]))
    const problems = checkOfficial303Rules(loadBody(rest[1]))
    const blocking = diffs.filter((diff) => !isAllowedSkeletonDiff(diff))
    const report = { blocking, allowed: diffs.filter(isAllowedSkeletonDiff).map((diff) => diff.path), rules: problems }
    if (rest[2] !== '--wire') {
      print(report)
      return blocking.length || problems.length ? 1 : 0
    }
    report.wire = checkOfficial303Wire(JSON.parse(fs.readFileSync(rest[1], 'utf8')))
    print(report)
    return blocking.length || problems.length || report.wire.some((p) => p.blocking !== false) ? 1 : 0
  }
  process.stderr.write(
    'usage: outbound-shape.mjs --shape <f> | --diff <a> <b> | --against-profile 2.1.303 <f> [--wire] | --make-skeleton <raw>\n',
  )
  return 2
}

process.exitCode = main(process.argv.slice(2)) ?? 0
