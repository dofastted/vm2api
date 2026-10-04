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
    const endpoint = socksEndpoint(u.hostname, u.port || 1080)
    if (!/^socks5h?:$/.test(u.protocol) || !endpoint) throw new Error('invalid SOCKS5 URL')
    const auth = u.username || u.password ? `${u.username}:${u.password}@` : ''
    return `${scheme}://${auth}${endpoint}`
  }
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
    return socksEndpoint(u.hostname, u.port || 1080) || null
  } catch {
    return null
  }
}

/** Keep explicit HTTP(S) exits intact; the legacy serializer remains SOCKS-only. */
export function proxyProtocol(proxy) {
  const value = proxy?.url ? new URL(proxy.url).protocol.slice(0, -1) : proxy?.protocol || proxy?.scheme || 'socks5'
  const scheme = String(value).trim().toLowerCase()
  return scheme === 'socks5h' ? 'socks5' : scheme
}

export function outboundProxyUrl(proxy, socksScheme = 'socks5h') {
  if (!proxy) return ''
  const scheme = proxyProtocol(proxy)
  if (scheme === 'socks5') return socksProxyUrl(proxy, socksScheme)
  if (scheme !== 'http' && scheme !== 'https') throw new Error('unsupported proxy scheme')
  const u = proxy.url ? new URL(proxy.url) : null
  if (u && ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)) throw new Error('invalid proxy URL')
  const endpoint = socksEndpoint(
    u ? u.hostname : proxy.host,
    u ? u.port || (scheme === 'https' ? 443 : 80) : proxy.port,
  )
  if (!endpoint) throw new Error('invalid proxy endpoint')
  const username = u ? decodeURIComponent(u.username) : proxy.username || ''
  const password = u ? decodeURIComponent(u.password) : proxy.password || ''
  const auth = username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : ''
  return `${scheme}://${auth}${endpoint}`
}
