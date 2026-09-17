#!/usr/bin/env node
/** Build host-local kin-os slot images via the host Docker engine. */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const images = [
  { tag: 'kin-os/ubuntu:24.04', dir: 'ubuntu-24.04' },
  { tag: 'kin-os/debian:12', dir: 'debian-12' },
  { tag: 'kin-os/arch:latest', dir: 'archlinux' },
  { tag: 'kin-os/fedora:41', dir: 'fedora-41' },
]
const args = process.argv.slice(2)
const force = args.includes('--force')
const only = args.filter((a) => a !== '--force')

function imageExists(tag) {
  return spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0
}

for (const img of images) {
  if (only.length && !only.some((arg) => img.tag.includes(arg) || img.dir.includes(arg))) continue
  if (!force && imageExists(img.tag)) {
    console.log(`vm2api: skip existing ${img.tag}`)
    continue
  }
  const ctx = path.join(root, img.dir)
  const r = spawnSync('docker', ['build', '-t', img.tag, ctx], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
}
