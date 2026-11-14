export type ProxyScheme = 'socks5' | 'http'

/** 网关只认 socks5 / http；其余（含旧数据缺省）都按 SOCKS5 显示。 */
export function proxySchemeOf(scheme?: string | null): ProxyScheme {
  return String(scheme || '').toLowerCase() === 'http' ? 'http' : 'socks5'
}

export function proxySchemeText(scheme?: string | null): string {
  return proxySchemeOf(scheme) === 'http' ? 'HTTP' : 'SOCKS5'
}
