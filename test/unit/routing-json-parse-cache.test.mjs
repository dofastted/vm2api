import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCrsUnofficialPersona,
  personaModeFromRoutingFile,
  personaOptionsFromRoutingFile,
} from '../../src/lib/identity/crs-persona.mjs'
import { cacheBreakpointsFromRoutingFile, cacheTtlFromRoutingFile } from '../../src/lib/protocol/cache-ttl.mjs'
import { invalidateReadCache, readJsonParsedCached } from '../../src/lib/vm/vm-file.mjs'

function tempRouting(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-cache-'))
  const file = path.join(dir, 'routing.json')
  fs.writeFileSync(file, JSON.stringify(body))
  return { dir, file }
}

test('readJsonParsedCached hot-reloads when bytes change but stat metadata is unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-cache-'))
  const file = path.join(dir, 'routing.json')
  try {
    const first = '{"compatibility":{"persona_inject":"append","_pad":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
    const second = '{"compatibility":{"persona_inject":"rewrite","_pad":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
    assert.equal(Buffer.byteLength(first), Buffer.byteLength(second))
    fs.writeFileSync(file, first)
    const stat = fs.statSync(file)
    assert.equal(personaModeFromRoutingFile(file), 'append')
    fs.writeFileSync(file, second)
    fs.utimesSync(file, stat.atime, stat.mtime)
    const after = fs.statSync(file)
    assert.equal(after.size, stat.size)
    assert.ok(Math.abs(after.mtimeMs - stat.mtimeMs) < 2)
    assert.equal(personaModeFromRoutingFile(file), 'rewrite')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readJsonParsedCached returns isolated clones (mutations do not poison cache)', () => {
  const { dir, file } = tempRouting({ compatibility: { persona_inject: 'append' } })
  try {
    const a = readJsonParsedCached(file)
    a.compatibility.persona_inject = 'mutated'
    const b = readJsonParsedCached(file)
    assert.equal(b.compatibility.persona_inject, 'append')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('per-caller fallbacks stay distinct after parse errors and recovery', () => {
  const { dir, file } = tempRouting({ compatibility: { persona_inject: 'append' } })
  try {
    assert.equal(personaOptionsFromRoutingFile(file).mode, 'append')
    assert.equal(cacheTtlFromRoutingFile(file), '1h')
    fs.writeFileSync(file, '{not-json')
    assert.equal(personaOptionsFromRoutingFile(file).mode, 'rewrite')
    assert.equal(cacheTtlFromRoutingFile(file), '1h')
    assert.equal(cacheBreakpointsFromRoutingFile(file).enabled, true)
    fs.writeFileSync(file, JSON.stringify({ compatibility: { persona_inject: 'none', cache_ttl: '5m' } }))
    invalidateReadCache(file)
    assert.equal(personaOptionsFromRoutingFile(file).mode, 'none')
    assert.equal(cacheTtlFromRoutingFile(file), '5m')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('routing file helpers share one JSON.parse per stable on-disk content', () => {
  const { dir, file } = tempRouting({
    compatibility: {
      persona_inject: 'rewrite',
      persona_preset: 'official',
      cache_ttl: '1h',
    },
  })
  try {
    let parseCalls = 0
    const native = JSON.parse
    JSON.parse = (...args) => {
      parseCalls++
      return native(...args)
    }
    try {
      invalidateReadCache(file)
      personaModeFromRoutingFile(file)
      cacheTtlFromRoutingFile(file)
      cacheBreakpointsFromRoutingFile(file)
      assert.equal(parseCalls, 1)
    } finally {
      JSON.parse = native
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('applyCrsUnofficialPersona reads routing.json once per call', () => {
  const { dir, file } = tempRouting({
    compatibility: { persona_inject: 'append' },
  })
  try {
    let reads = 0
    const native = fs.readFileSync
    fs.readFileSync = (target, ...rest) => {
      if (target === file) reads++
      return native(target, ...rest)
    }
    try {
      invalidateReadCache(file)
      applyCrsUnofficialPersona(
        { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
        { routingFile: file, forceConfigured: true },
      )
      assert.equal(reads, 1)
    } finally {
      fs.readFileSync = native
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
