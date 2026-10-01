import { SocksProxyAgent } from 'socks-proxy-agent'
import { normalizeSocksHost } from './socks-address.mjs'

/** Keep URL authorities bracketed, but pass an unbracketed host to the SOCKS socket. */
export function createSocksProxyAgent(proxyUrl, options) {
  const agent = new SocksProxyAgent(proxyUrl, options)
  // socks-proxy-agent 10.1.0 retains WHATWG URL.hostname's IPv6 brackets.
  // Compatibility for TooTallNate/proxy-agents#437 / #452; safe after an upstream fix.
  const host = normalizeSocksHost(agent.proxy.host)
  if (!host) throw new Error('invalid SOCKS proxy host')
  agent.proxy.host = host
  return agent
}
