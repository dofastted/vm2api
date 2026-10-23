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
export function socksProxyUrl(proxy, scheme = 'socks5h') {
  if (!proxy) return ''
  if (proxy.url) {
    const u = new URL(proxy.url)
    const endpoint = socksEndpoint(u.hostname, u.port || proxyDefaultPort(u.protocol))
    if (!/^(socks5h?|https?):$/.test(u.protocol) || !endpoint) throw new Error('invalid proxy URL')
    if (u.protocol === 'http:' || u.protocol === 'https:') scheme = u.protocol.slice(0, -1)
    const auth = u.username || u.password ? `${u.username}:${u.password}@` : ''
    return `${scheme}://${auth}${endpoint}`
  }
  if (proxy.scheme === 'http' || proxy.scheme === 'https') scheme = proxy.scheme
  if (proxy.scheme && !['socks5', 'socks5h', 'http', 'https'].includes(proxy.scheme))
    throw new Error('invalid proxy scheme')
  const endpoint = socksEndpoint(proxy.host, proxy.port)
  if (!endpoint) return ''
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : ''
  return `${scheme}://${auth}${endpoint}`
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
    return socksEndpoint(u.hostname, u.port || proxyDefaultPort(u.protocol)) || null
  } catch {
    return null
  }
}

function proxyDefaultPort(protocol) {
  return protocol === 'http:' ? 80 : protocol === 'https:' ? 443 : 1080
}
