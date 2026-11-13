import net from 'node:net'

/** Socket hosts are unbracketed; reject malformed authorities rather than guessing. */
export function normalizeSocksHost(value) {
  let host = String(value || '').trim()
  if (!host) return ''
  if (host.startsWith('[') && host.endsWith(']') && net.isIPv6(host.slice(1, -1))) {
    host = host.slice(1, -1)
  }
  if (net.isIPv6(host)) {
    try {
      return new URL(`socks5://[${host}]`).hostname.slice(1, -1)
    } catch {
      return ''
    }
  }
  if (/[\s\[\]:/@?#\\]/.test(host)) return ''
  return host
}

export function socksEndpoint(host, port) {
  const normalized = normalizeSocksHost(host)
  const n = Number(port)
  if (!normalized || !Number.isInteger(n) || n < 1 || n > 65535) return ''
  return `${net.isIPv6(normalized) ? `[${normalized}]` : normalized}:${n}`
}

/** URL serialization is independent of policy, so disabled records can still be edited/copied. */
/**
 * `scheme` picks socks5 vs socks5h for SOCKS rows only; an HTTP proxy row
 * (scheme 'http' or an http:// url) always serializes as http://.
 */
export function socksProxyUrl(proxy, scheme = 'socks5h') {
  if (!proxy) return ''
  if (proxy.url) {
    const u = new URL(proxy.url)
    const http = u.protocol === 'http:'
    const endpoint = socksEndpoint(u.hostname, u.port || (http ? 80 : 1080))
    if ((!http && !/^socks5h?:$/.test(u.protocol)) || !endpoint) throw new Error('invalid proxy URL')
    const auth = u.username || u.password ? `${u.username}:${u.password}@` : ''
    return `${http ? 'http' : scheme}://${auth}${endpoint}`
  }
  const endpoint = socksEndpoint(proxy.host, proxy.port)
  if (!endpoint) return ''
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : ''
  return `${String(proxy.scheme || '').toLowerCase() === 'http' ? 'http' : scheme}://${auth}${endpoint}`
}

export function socksProxyFamily(proxy) {
  let host = proxy?.host
  if (proxy?.url) {
    try {
      host = new URL(proxy.url).hostname
    } catch {
      return 0
    }
  }
  return net.isIP(normalizeSocksHost(host))
}

export function socksProxyEndpoint(proxy) {
  if (proxy?.host && proxy?.port) return socksEndpoint(proxy.host, proxy.port) || null
  if (!proxy?.url) return null
  try {
    const u = new URL(proxy.url)
    return socksEndpoint(u.hostname, u.port || (u.protocol === 'http:' ? 80 : 1080)) || null
  } catch {
    return null
  }
}
