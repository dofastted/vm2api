import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_QUEUE_KEEPALIVE_DELAY_MS,
  QUEUE_KEEPALIVE_DELAY_MAX_MS,
  inboundBodyLimit,
  maxRequestBytes,
  queueKeepaliveDelayMs,
  readRoutingConfigFile,
  routingConfigFile,
  resolveStreamIdleTimeoutMs,
  streamIdleTimeoutMs,
} from '../../src/lib/core/config.mjs'

function withEnv(key, value, fn) {
  const prev = process.env[key]
  if (value == null) delete process.env[key]
  else process.env[key] = value
  try {
    return fn()
  } finally {
    if (prev == null) delete process.env[key]
    else process.env[key] = prev
  }
}

test('routingConfigFile prefers KIN_ROUTING_FILE then src/config/routing.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-file-'))
  try {
    withEnv('KIN_ROUTING_FILE', '', () => {
      assert.equal(routingConfigFile(root), path.join(root, 'src', 'config', 'routing.json'))
    })
    withEnv('KIN_ROUTING_FILE', '/tmp/custom-routing.json', () => {
      assert.equal(routingConfigFile(root), '/tmp/custom-routing.json')
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readRoutingConfigFile reads src/config and ignores project/config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-read-'))
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src', 'config'), { recursive: true })
    fs.writeFileSync(path.join(root, 'config', 'routing.json'), JSON.stringify({ stale: true }))
    fs.writeFileSync(
      path.join(root, 'src', 'config', 'routing.json'),
      JSON.stringify({ compatibility: { persona_preset: 'official_full' } }),
    )
    withEnv('KIN_ROUTING_FILE', '', () => {
      const doc = readRoutingConfigFile(root)
      assert.equal(doc.stale, undefined)
      assert.equal(doc.compatibility.persona_preset, 'official_full')
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readRoutingConfigFile fails when the file is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-missing-'))
  try {
    withEnv('KIN_ROUTING_FILE', '', () => {
      assert.throws(() => readRoutingConfigFile(root), /Routing config .*not found/)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('streamIdleTimeoutMs prefers the panel value, then the caller fallback', () => {
  withEnv('KIN_STREAM_IDLE_TIMEOUT', '', () => {
    assert.equal(streamIdleTimeoutMs(), 180_000)
    assert.equal(streamIdleTimeoutMs({ failover: {} }, 2000), 2000)
    assert.equal(streamIdleTimeoutMs({ failover: { stream_idle_timeout_ms: 900_000 } }, 2000), 900_000)
    assert.equal(streamIdleTimeoutMs({ failover: { stream_idle_timeout_ms: 'bad' } }), 180_000)
    assert.equal(streamIdleTimeoutMs({ failover: { stream_idle_timeout_ms: 1 } }), 30_000)
  })
  withEnv('KIN_STREAM_IDLE_TIMEOUT', '240000', () => {
    assert.equal(streamIdleTimeoutMs(null), 240_000)
  })
})

test('resolveStreamIdleTimeoutMs cascades panel, cfg.limits, env, then 180s default', () => {
  withEnv('KIN_STREAM_IDLE_TIMEOUT', '', () => {
    assert.equal(resolveStreamIdleTimeoutMs({ failover: {} }, { limits: {} }), 180_000)
    assert.equal(
      resolveStreamIdleTimeoutMs(
        { failover: { stream_idle_timeout_ms: 600_000 } },
        { limits: { stream_idle_timeout_ms: 2000 } },
      ),
      600_000,
    )
    assert.equal(resolveStreamIdleTimeoutMs({ failover: {} }, { limits: { stream_idle_timeout_ms: 90_000 } }), 90_000)
  })
  withEnv('KIN_STREAM_IDLE_TIMEOUT', '420000', () => {
    assert.equal(resolveStreamIdleTimeoutMs({ failover: {} }, { limits: {} }), 420_000)
    assert.equal(
      resolveStreamIdleTimeoutMs({ failover: {} }, { limits: { stream_idle_timeout_ms: Number.NaN } }),
      420_000,
    )
  })
})

test('resolveStreamIdleTimeoutMs avoids hardcoded 180k when cfg.limits is unset but env is set', () => {
  withEnv('KIN_STREAM_IDLE_TIMEOUT', '600000', () => {
    const cfg = { limits: { max_body_bytes: 1 } }
    assert.equal(resolveStreamIdleTimeoutMs({ failover: {} }, cfg), 600_000)
  })
})

test('queueKeepaliveDelayMs stays under the Cloudflare window', () => {
  withEnv('KIN_QUEUE_KEEPALIVE_DELAY', '', () => {
    assert.equal(queueKeepaliveDelayMs(null), DEFAULT_QUEUE_KEEPALIVE_DELAY_MS)
    assert.equal(queueKeepaliveDelayMs({ failover: {} }, 15_000), 15_000)
    assert.equal(queueKeepaliveDelayMs({ failover: { queue_keepalive_delay_ms: 0 } }, 15_000), 0)
    assert.equal(queueKeepaliveDelayMs({ failover: { queue_keepalive_delay_ms: 45_000 } }), 45_000)
    assert.equal(
      queueKeepaliveDelayMs({ failover: { queue_keepalive_delay_ms: 200_000 } }),
      QUEUE_KEEPALIVE_DELAY_MAX_MS,
    )
    assert.equal(queueKeepaliveDelayMs({ failover: { queue_keepalive_delay_ms: -1 } }, 15_000), 15_000)
  })
  withEnv('KIN_QUEUE_KEEPALIVE_DELAY', '25000', () => {
    assert.equal(queueKeepaliveDelayMs({ failover: {} }), 25_000)
    assert.equal(queueKeepaliveDelayMs({ failover: { queue_keepalive_delay_ms: 5000 } }), 5_000)
  })
})

test('maxRequestBytes uses the panel MiB value and clamps it', () => {
  assert.equal(maxRequestBytes(null), 32 * 1024 * 1024)
  assert.equal(maxRequestBytes({ failover: {} }, 1024), 1024)
  assert.equal(maxRequestBytes({ failover: { max_request_mib: 64 } }), 64 * 1024 * 1024)
  assert.equal(maxRequestBytes({ failover: { max_request_mib: 1 } }), 8 * 1024 * 1024)
  assert.equal(maxRequestBytes({ failover: { max_request_mib: 512 } }), 128 * 1024 * 1024)
  assert.equal(maxRequestBytes({ failover: { max_request_mib: 'nope' } }, 2048), 2048)
  assert.equal(inboundBodyLimit({}, 128 * 1024 * 1024), 32 * 1024 * 1024)
  assert.equal(inboundBodyLimit({ failover: { max_request_mib: 'invalid' } }, 128 * 1024 * 1024), 32 * 1024 * 1024)
  assert.equal(inboundBodyLimit({}, 1024), 1024)
  assert.equal(inboundBodyLimit({ failover: { max_request_mib: 64 } }, 128 * 1024 * 1024), 64 * 1024 * 1024)
  assert.equal(inboundBodyLimit({ failover: { max_request_mib: 128 } }, 32 * 1024 * 1024), 32 * 1024 * 1024)
})

test('readRoutingConfigFile identifies invalid JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-invalid-'))
  try {
    fs.mkdirSync(path.join(root, 'src', 'config'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'config', 'routing.json'), '{invalid')
    withEnv('KIN_ROUTING_FILE', '', () => {
      assert.throws(() => readRoutingConfigFile(root), /Routing config .*invalid JSON/)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
