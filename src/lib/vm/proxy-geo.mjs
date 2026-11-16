/**
 * Proxy exit-node geolocation.
 *
 * The lookup goes *through* the SOCKS5 proxy, so the answer describes the exit
 * IP the upstream actually sees, not the panel host. A local egress row has no
 * proxy URL: the request then leaves over the host default route, which is
 * exactly that row's exit.
 *
 * Endpoint is overridable (`KIN_PROXY_GEO_URL`) because the default is a free
 * plain-HTTP service; `normalizeGeoPayload()` also reads the ipinfo/ipapi field
 * spellings so an override does not need a matching parser.
 *
 * IPv6 egress uses a separate AAAA-only IP probe (`KIN_PROXY_GEO_V6_IP_URL`)
 * plus a geo query for that address. An IPv4 answer from the probe is rejected
 * instead of being stored as IPv6.
 * `KIN_PROXY_GEO_V6_LOOKUP_MODE=control-plane` explicitly permits metadata
 * lookup outside the proxy, but only after its real IPv6 exit was verified.
 * The provider's response must identify that same IPv6 address.
 */
import net from 'node:net'
import { validTimezone } from '../core/timezone.mjs'

export const DEFAULT_GEO_ENDPOINT =
  'http://ip-api.com/json/?fields=status,message,query,country,countryCode,regionName,city,timezone,isp'
/**
 * HTTPS fallback for the plain-HTTP default. Proxies that only allow CONNECT 443
 * reject port 80 (403 / reset). Same exit, so the answer still describes it.
 */
export const DEFAULT_GEO_HTTPS_FALLBACK = 'https://ipapi.co/json/'
export const DEFAULT_GEO_TIMEOUT_MS = 8000
/** Hostname resolves to AAAA only; unreachable over an IPv4-only exit. */
export const DEFAULT_GEO_V6_IP_ENDPOINT = 'https://ipv6.icanhazip.com'
export const DEFAULT_GEO_V6_LOOKUP_ENDPOINT =
  'http://ip-api.com/json/{ip}?fields=status,message,query,country,countryCode,regionName,city,timezone,isp'

function text(value) {
  const s = String(value ?? '').trim()
  return s || null
}

/** Split an `ipapi.co` style `America/New_York` or ipinfo `loc` payload into our shape. */
export function normalizeGeoPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  // ip-api.com reports failures with HTTP 200 + status:"fail".
  if (String(payload.status || '').toLowerCase() === 'fail') {
    return { error: text(payload.message) || 'geo_lookup_failed' }
  }
  const timezone = validTimezone(payload.timezone || payload.time_zone || payload.timeZone)
  const geo = {
    ip: text(payload.query || payload.ip),
    country: text(payload.country || payload.country_name),
    country_code: text(payload.countryCode || payload.country_code || payload.country)?.slice(0, 8) || null,
    region: text(payload.regionName || payload.region || payload.region_name),
    city: text(payload.city),
    isp: text(payload.isp || payload.org || payload.asn),
    timezone: timezone || null,
  }
  if (!geo.ip && !geo.country && !geo.timezone) return null
  return geo
}

export function parsePlaintextIp(body) {
  const ip = text(body)
  if (!ip) return null
  // Some providers append a trailing newline; strip again after text().
  return ip.split(/\s+/)[0] || null
}

function ipv6LookupMode(value) {
  return value || process.env.KIN_PROXY_GEO_V6_LOOKUP_MODE || 'proxy'
}

function sameIpv6Address(left, right) {
  if (!net.isIPv6(left) || !net.isIPv6(right)) return false
  try {
    return new URL(`http://[${left}]/`).hostname === new URL(`http://[${right}]/`).hostname
  } catch {
    return false
  }
}

function geoLookupEndpointForIp(ip, template) {
  const base = String(template || DEFAULT_GEO_V6_LOOKUP_ENDPOINT).trim()
  if (!base) return null
  if (base.includes('{ip}')) return base.replace('{ip}', encodeURIComponent(ip))
  if (base.endsWith('/'))
    return `${base}${encodeURIComponent(ip)}?fields=status,message,query,country,countryCode,regionName,city,timezone,isp`
  if (base.includes('?')) return `${base}&query=${encodeURIComponent(ip)}`
  return `${base}/${encodeURIComponent(ip)}?fields=status,message,query,country,countryCode,regionName,city,timezone,isp`
}

async function fetchThroughProxy(url, proxyUrl, { timeoutMs, fetchImpl, accept } = {}) {
  const timeout = Math.max(1000, Number(timeoutMs) || DEFAULT_GEO_TIMEOUT_MS)
  const { default: nodeFetch } = await import('node-fetch')
  const impl = fetchImpl || nodeFetch
  const opts = { method: 'GET', headers: { accept: accept || 'application/json' } }
  if (proxyUrl) {
    const { createProxyAgent } = await import('./proxy-agent.mjs')
    // Geo describes the proxy exit, so resolve its destination there too.
    // Keep the shared agent factory's explicit SOCKS5 semantics unchanged.
    const geoProxyUrl = String(proxyUrl).replace(/^socks5:/i, 'socks5h:')
    opts.agent = createProxyAgent(geoProxyUrl)
  }
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeout)
  try {
    return await impl(url, opts)
  } catch (error) {
    return { ok: false, error: `geo_transport_error:${String(error?.message || error).slice(0, 120)}` }
  }
}

/**
 * Resolve the exit node's geolocation.
 * @returns {Promise<{ok: true, geo: object} | {ok: false, error: string}>}
 */
export async function lookupProxyGeo(proxyUrl, { endpoint, timeoutMs, fetchImpl, ipv6Mode } = {}) {
  const url = endpoint || process.env.KIN_PROXY_GEO_URL || DEFAULT_GEO_ENDPOINT
  const first = await lookupGeoOnce(url, proxyUrl, { timeoutMs, fetchImpl, ipv6Mode })
  if (first.terminal) {
    const { terminal, ...result } = first
    return result
  }
  if (first.ok || !proxyUrl || url !== DEFAULT_GEO_ENDPOINT) return first
  // A proxy refusing CONNECT 80 answers 403 or drops the tunnel; provider errors (429, bad payload) stay final.
  if (first.error !== 'geo_http_403' && !String(first.error).startsWith('geo_transport_error')) return first
  // Only the built-in plain-HTTP endpoint gets a second try, over HTTPS through the same proxy.
  const second = await lookupGeoOnce(DEFAULT_GEO_HTTPS_FALLBACK, proxyUrl, { timeoutMs, fetchImpl })
  return second.ok ? second : { ok: false, error: first.error }
}

async function lookupGeoOnce(url, proxyUrl, { timeoutMs, fetchImpl, ipv6Mode } = {}) {
  const res = await fetchThroughProxy(url, proxyUrl, {
    timeoutMs,
    fetchImpl,
    accept: 'application/json',
  })
  if (res?.error) {
    // The default service has no IPv6 transport. In the explicitly enabled
    // mode, verify an IPv6 exit before querying metadata over the host route.
    // A bad SOCKS password therefore cannot turn into a successful direct lookup.
    if (proxyUrl && url === DEFAULT_GEO_ENDPOINT && ipv6LookupMode(ipv6Mode) === 'control-plane') {
      return {
        ...(await lookupProxyGeoV6(proxyUrl, { timeoutMs, fetchImpl, lookupMode: 'control-plane' })),
        terminal: true,
      }
    }
    return { ok: false, error: res.error }
  }
  if (!res?.ok) return { ok: false, error: `geo_http_${res?.status || 0}` }
  let payload
  try {
    payload = await res.json()
  } catch (error) {
    return { ok: false, error: `geo_bad_payload:${String(error?.message || error).slice(0, 120)}` }
  }
  const geo = normalizeGeoPayload(payload)
  if (!geo) return { ok: false, error: 'geo_empty_payload' }
  if (geo.error) return { ok: false, error: geo.error }
  return { ok: true, geo }
}

/**
 * Verify the public IPv6 address through the proxy, then look up its geolocation.
 * @returns {Promise<{ok: true, geo: object} | {ok: false, error: string}>}
 */
export async function lookupProxyGeoV6(proxyUrl, { ipEndpoint, geoEndpoint, timeoutMs, fetchImpl, lookupMode } = {}) {
  const mode = ipv6LookupMode(lookupMode)
  if (mode !== 'proxy' && mode !== 'control-plane') return { ok: false, error: 'geo_ipv6_invalid_lookup_mode' }
  const ipUrl = ipEndpoint || process.env.KIN_PROXY_GEO_V6_IP_URL || DEFAULT_GEO_V6_IP_ENDPOINT
  const ipRes = await fetchThroughProxy(ipUrl, proxyUrl, {
    timeoutMs,
    fetchImpl,
    accept: 'text/plain,*/*',
  })
  if (ipRes?.error) return { ok: false, error: ipRes.error }
  if (!ipRes?.ok) return { ok: false, error: `geo_ipv6_http_${ipRes?.status || 0}` }
  let body
  try {
    body = typeof ipRes.text === 'function' ? await ipRes.text() : String(ipRes.body || '')
  } catch (error) {
    return { ok: false, error: `geo_ipv6_bad_ip_payload:${String(error?.message || error).slice(0, 120)}` }
  }
  const ip = parsePlaintextIp(body)
  if (!ip) return { ok: false, error: 'geo_ipv6_empty_ip' }
  if (net.isIPv4(ip)) return { ok: false, error: 'geo_ipv6_got_ipv4' }
  if (!net.isIPv6(ip)) return { ok: false, error: 'geo_ipv6_invalid_ip' }

  const customGeoUrl = geoEndpoint || process.env.KIN_PROXY_GEO_V6_URL
  const geoUrl = customGeoUrl
    ? String(customGeoUrl).replaceAll('{ip}', encodeURIComponent(ip))
    : geoLookupEndpointForIp(ip, DEFAULT_GEO_V6_LOOKUP_ENDPOINT)
  const geoResult = await lookupProxyGeo(mode === 'control-plane' ? '' : proxyUrl, {
    endpoint: geoUrl,
    timeoutMs,
    fetchImpl,
    ipv6Mode: 'proxy',
  })
  if (!geoResult.ok) return geoResult
  const returnedIp = geoResult.geo?.ip
  if (net.isIPv4(returnedIp || '')) return { ok: false, error: 'geo_ipv6_got_ipv4' }
  if (!sameIpv6Address(returnedIp || '', ip)) return { ok: false, error: 'geo_ipv6_ip_mismatch' }
  return { ok: true, geo: { ...geoResult.geo, ip } }
}
