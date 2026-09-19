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
 */
import { validTimezone } from '../core/timezone.mjs'

export const DEFAULT_GEO_ENDPOINT =
  'http://ip-api.com/json/?fields=status,message,query,country,countryCode,regionName,city,timezone,isp'
export const DEFAULT_GEO_TIMEOUT_MS = 8000

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

/**
 * Resolve the exit node's geolocation.
 * @returns {Promise<{ok: true, geo: object} | {ok: false, error: string}>}
 */
export async function lookupProxyGeo(proxyUrl, { endpoint, timeoutMs, fetchImpl } = {}) {
  const url = endpoint || process.env.KIN_PROXY_GEO_URL || DEFAULT_GEO_ENDPOINT
  const timeout = Math.max(1000, Number(timeoutMs) || DEFAULT_GEO_TIMEOUT_MS)
  const { default: nodeFetch } = await import('node-fetch')
  const impl = fetchImpl || nodeFetch
  const opts = { method: 'GET', headers: { accept: 'application/json' } }
  if (proxyUrl) {
    const { SocksProxyAgent } = await import('socks-proxy-agent')
    opts.agent = new SocksProxyAgent(proxyUrl)
  }
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeout)
  let res
  try {
    res = await impl(url, opts)
  } catch (error) {
    return { ok: false, error: `geo_transport_error:${String(error?.message || error).slice(0, 120)}` }
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
