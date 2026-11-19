import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

for (const separateCragRelease of [true, false]) {
  test(`clean payload download ${separateCragRelease ? 'uses CRAG release only for CRAG paths' : 'supports a single-release manifest'}`, async (t) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-payload-'))
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
    const paths = [
      'bin/kin-worker',
      'share/crag/kin-kernel',
      'share/crag/kernels/v2/amd64/crag-v2',
      'dist/crag-v2-licensed-amd64.tar.gz',
      'share/crag-other/helper',
      'dist/another-package.tar.gz',
    ]
    const payloads = new Map()
    const files = paths.map((filePath, index) => {
      const release = separateCragRelease && (filePath.startsWith('share/crag/') || index === 3) ? 'crag' : 'generic'
      const asset = `asset-${index}`
      const bytes = Buffer.from(`${release} binary payload ${index}`)
      payloads.set(`/${release}/${asset}`, bytes)
      return {
        path: filePath,
        asset,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      }
    })
    const manifest = path.join(scratch, 'payload.json')
    fs.writeFileSync(
      manifest,
      JSON.stringify({ release: 'generic', ...(separateCragRelease ? { crag_release: 'crag' } : {}), files }),
    )
    const server = http.createServer((req, res) => {
      const bytes = payloads.get(req.url)
      res.writeHead(bytes ? 200 : 404)
      res.end(bytes || 'wrong release')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise((resolve) => server.close(resolve)))
    const dest = path.join(scratch, 'empty-destination')
    const run = (args) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.join(root, 'scripts/fetch-payload.mjs'), '--manifest', manifest, '--dest', dest, ...args],
          {
            env: {
              ...process.env,
              VM2API_PAYLOAD_BASE_URL: `http://127.0.0.1:${server.address().port}`,
              NODE_USE_ENV_PROXY: '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stderr = ''
        child.stdout.resume()
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.on('error', reject)
        child.on('close', (status) => resolve({ status, stderr }))
      })
    const downloaded = await run([])
    assert.equal(downloaded.status, 0, downloaded.stderr)
    for (const file of files) {
      const actual = fs.readFileSync(path.join(dest, file.path))
      assert.equal(actual.length, file.size, file.path)
      assert.equal(crypto.createHash('sha256').update(actual).digest('hex'), file.sha256, file.path)
    }
    const checked = await run(['--check'])
    assert.equal(checked.status, 0, checked.stderr)
  })
}
