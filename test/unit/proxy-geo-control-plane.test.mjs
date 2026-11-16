import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GEO_ENDPOINT,
  DEFAULT_GEO_HTTPS_FALLBACK,
  DEFAULT_GEO_V6_IP_ENDPOINT,
  lookupProxyGeo,
  lookupProxyGeoV6,
} from '../../src/lib/vm/proxy-geo.mjs'

const proxy = 'socks5h://issue_user:synthetic_password@127.0.0.1:1080'
const ip = '2001:db8::9'
const payload = (query = ip) => ({
  ok: true,
  json: async () => ({ status: 'success', query, country: 'Japan', countryCode: 'JP', timezone: 'Asia/Tokyo' }),
})

test('normal IPv4 lookup stays on the proxy even with control-plane mode enabled', async () => {
  const calls = []
  const result = await lookupProxyGeo(proxy, {
    ipv6Mode: 'control-plane',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), agent: !!options.agent })
      return payload('203.0.113.9')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.geo.ip, '203.0.113.9')
  assert.deepEqual(calls, [{ url: DEFAULT_GEO_ENDPOINT, agent: true }])
})

test('default mode never falls back to a direct lookup on transport failure', async () => {
  let count = 0
  const result = await lookupProxyGeo(proxy, {
    ipv6Mode: 'proxy',
    fetchImpl: async (_url, options) => {
      count += 1
      assert.ok(options.agent, 'every lookup must go through the proxy')
      throw new Error('read ECONNRESET')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /^geo_transport_error:/)
  // Plain-HTTP attempt plus the HTTPS retry, both on the proxy (#1016).
  assert.equal(count, 2)
})

test('IPv6 fallback verifies authenticated egress, then queries exactly that IP outside the proxy', async () => {
  const calls = []
  const result = await lookupProxyGeo(proxy, {
    ipv6Mode: 'control-plane',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), agent: !!options.agent })
      assert.ok(options.signal)
      if (url === DEFAULT_GEO_ENDPOINT) throw new Error('read ECONNRESET')
      if (url === DEFAULT_GEO_V6_IP_ENDPOINT) return { ok: true, text: async () => `${ip}\n` }
      const endpoint = new URL(url)
      assert.equal(endpoint.hostname, 'ip-api.com')
      assert.equal(decodeURIComponent(endpoint.pathname), `/json/${ip}`)
      assert.equal(endpoint.searchParams.has('query'), false)
      assert.match(endpoint.searchParams.get('fields'), /query/)
      return payload()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.geo.ip, ip)
  assert.deepEqual(
    calls.map((call) => call.agent),
    [true, true, false],
  )
})

test('bad SOCKS credentials cannot cause any control-plane geolocation request', async () => {
  const calls = []
  const result = await lookupProxyGeo(proxy, {
    ipv6Mode: 'control-plane',
    fetchImpl: async (url, options) => {
      calls.push({ url, agent: !!options.agent })
      throw new Error('Socks5 Authentication failed')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /Socks5 Authentication failed/)
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.agent))
})

test('IPv4 and invalid IP probe responses prevent direct metadata lookup', async () => {
  for (const [body, error] of [
    ['203.0.113.9', 'geo_ipv6_got_ipv4'],
    ['invalid', 'geo_ipv6_invalid_ip'],
  ]) {
    let count = 0
    const result = await lookupProxyGeoV6(proxy, {
      lookupMode: 'control-plane',
      fetchImpl: async (_url, options) => {
        count += 1
        assert.ok(options.agent)
        return { ok: true, text: async () => body }
      },
    })
    assert.equal(result.error, error)
    assert.equal(count, 1)
  }
})

test('provider IP must match the verified egress and cannot be replaced unconditionally', async () => {
  for (const [query, error] of [
    ['2001:db8::10', 'geo_ipv6_ip_mismatch'],
    ['203.0.113.9', 'geo_ipv6_got_ipv4'],
    ['', 'geo_ipv6_ip_mismatch'],
  ]) {
    const result = await lookupProxyGeoV6(proxy, {
      lookupMode: 'control-plane',
      fetchImpl: async (url) =>
        url === DEFAULT_GEO_V6_IP_ENDPOINT ? { ok: true, text: async () => ip } : payload(query),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, error)
  }
})

test('equivalent expanded IPv6 response passes identity verification', async () => {
  const result = await lookupProxyGeoV6(proxy, {
    lookupMode: 'control-plane',
    fetchImpl: async (url) =>
      url === DEFAULT_GEO_V6_IP_ENDPOINT
        ? { ok: true, text: async () => ip }
        : payload('2001:0db8:0000:0000:0000:0000:0000:0009'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.geo.ip, ip)
})

test('metadata HTTP failures remain failures after the IPv6 probe succeeds', async () => {
  const result = await lookupProxyGeoV6(proxy, {
    lookupMode: 'control-plane',
    fetchImpl: async (url) =>
      url === DEFAULT_GEO_V6_IP_ENDPOINT ? { ok: true, text: async () => ip } : { ok: false, status: 429 },
  })
  assert.deepEqual(result, { ok: false, error: 'geo_http_429' })
})

test('custom normal geolocation endpoints do not trigger the default-service fallback', async () => {
  let count = 0
  const result = await lookupProxyGeo(proxy, {
    endpoint: 'https://geo.example.test/json',
    ipv6Mode: 'control-plane',
    fetchImpl: async () => {
      count += 1
      throw new Error('timeout')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(count, 1)
})

test('custom IPv6 URL templates receive only the verified IPv6 address', async () => {
  const result = await lookupProxyGeoV6(proxy, {
    lookupMode: 'control-plane',
    geoEndpoint: 'https://geo.example.test/json/{ip}?fields=ip',
    fetchImpl: async (url, options) => {
      if (url === DEFAULT_GEO_V6_IP_ENDPOINT) {
        assert.ok(options.agent)
        return { ok: true, text: async () => ip }
      }
      assert.equal(url, `https://geo.example.test/json/${encodeURIComponent(ip)}?fields=ip`)
      assert.equal(options.agent, undefined)
      return payload()
    },
  })
  assert.equal(result.ok, true)
})

test('IPv6 proxy mode retains the proxy for the IP probe and the metadata query', async () => {
  const calls = []
  const result = await lookupProxyGeoV6(proxy, {
    lookupMode: 'proxy',
    fetchImpl: async (url, options) => {
      calls.push(!!options.agent)
      return url === DEFAULT_GEO_V6_IP_ENDPOINT ? { ok: true, text: async () => ip } : payload()
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [true, true])
})

test('provider errors on the normal proxy path are not masked by IPv6 fallback', async () => {
  let count = 0
  const result = await lookupProxyGeo(proxy, {
    ipv6Mode: 'control-plane',
    fetchImpl: async () => {
      count += 1
      return { ok: false, status: 429 }
    },
  })
  assert.deepEqual(result, { ok: false, error: 'geo_http_429' })
  assert.equal(count, 1)
})

test('invalid lookup mode stops before any network request', async () => {
  const result = await lookupProxyGeoV6(proxy, {
    lookupMode: 'unexpected',
    fetchImpl: async () => assert.fail('no request is expected'),
  })
  assert.deepEqual(result, { ok: false, error: 'geo_ipv6_invalid_lookup_mode' })
})

test('default plain-HTTP lookup retries over HTTPS through the same proxy (#1016)', async () => {
  const calls = []
  const result = await lookupProxyGeo(proxy, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), agent: !!options.agent })
      if (url === DEFAULT_GEO_ENDPOINT) return { ok: false, status: 403 }
      return {
        ok: true,
        json: async () => ({ ip: '203.0.113.9', country_name: 'Japan', country_code: 'JP', timezone: 'Asia/Tokyo' }),
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.geo.ip, '203.0.113.9')
  assert.equal(result.geo.country_code, 'JP')
  assert.deepEqual(calls, [
    { url: DEFAULT_GEO_ENDPOINT, agent: true },
    { url: DEFAULT_GEO_HTTPS_FALLBACK, agent: true },
  ])
})

test('HTTPS fallback failure keeps the original error; custom endpoints are not retried', async () => {
  const failed = await lookupProxyGeo(proxy, { fetchImpl: async () => ({ ok: false, status: 403 }) })
  assert.deepEqual(failed, { ok: false, error: 'geo_http_403' })
  let count = 0
  const custom = await lookupProxyGeo(proxy, {
    endpoint: 'http://geo.example.test/json',
    fetchImpl: async () => {
      count += 1
      return { ok: false, status: 403 }
    },
  })
  assert.equal(custom.ok, false)
  assert.equal(count, 1)
})
