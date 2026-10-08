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
 */
import net from 'node:net'
import { validTimezone } from '../core/timezone.mjs'

export const DEFAULT_GEO_ENDPOINT =
  'http://ip-api.com/json/?fields=status,message,query,country,countryCode,regionName,city,timezone,isp'
export const DEFAULT_GEO_TIMEOUT_MS = 8000
/** Hostname resolves to AAAA only; unreachable over an IPv4-only exit. */
export const DEFAULT_GEO_V6_IP_ENDPOINT = 'https://ipv6.icanhazip.com'
export const DEFAULT_GEO_V6_LOOKUP_ENDPOINT =
  'http://ip-api.com/json/?fields=status,message,query,country,countryCode,regionName,city,timezone,isp'

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

function geoLookupEndpointForIp(ip, template) {
  const base = String(template || DEFAULT_GEO_V6_LOOKUP_ENDPOINT).trim()
  if (!base) return null
  if (base.includes('{ip}')) return base.replace('{ip}', encodeURIComponent(ip))
  if (base.endsWith('/')) return `${base}${encodeURIComponent(ip)}?fields=status,message,query,country,countryCode,regionName,city,timezone,isp`
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
    opts.agent = createProxyAgent(proxyUrl)
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
export async function lookupProxyGeo(proxyUrl, { endpoint, timeoutMs, fetchImpl } = {}) {
  const url = endpoint || process.env.KIN_PROXY_GEO_URL || DEFAULT_GEO_ENDPOINT
  const res = await fetchThroughProxy(url, proxyUrl, {
    timeoutMs,
    fetchImpl,
    accept: 'application/json',
  })
  if (res?.error) return { ok: false, error: res.error }
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
 * Resolve the exit node's public IPv6 address and geolocation through the proxy.
 * @returns {Promise<{ok: true, geo: object} | {ok: false, error: string}>}
 */
export async function lookupProxyGeoV6(proxyUrl, { ipEndpoint, geoEndpoint, timeoutMs, fetchImpl } = {}) {
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

  const geoUrl =
    geoEndpoint ||
    process.env.KIN_PROXY_GEO_V6_URL ||
    geoLookupEndpointForIp(ip, DEFAULT_GEO_V6_LOOKUP_ENDPOINT)
  const geoResult = await lookupProxyGeo(proxyUrl, { endpoint: geoUrl, timeoutMs, fetchImpl })
  if (!geoResult.ok) return geoResult
  const geo = { ...geoResult.geo, ip }
  if (geo.ip && net.isIPv4(geo.ip)) return { ok: false, error: 'geo_ipv6_got_ipv4' }
  if (geo.ip && !net.isIPv6(geo.ip)) return { ok: false, error: 'geo_ipv6_invalid_ip' }
  return { ok: true, geo }
}
