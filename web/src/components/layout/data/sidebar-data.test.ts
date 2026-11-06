import { describe, expect, it } from 'vitest'
import { homePathFor, navGroupsFor } from './sidebar-data'

describe('sidebar permissions', () => {
  it('does not treat an explicit empty view list as unrestricted', () => {
    expect(navGroupsFor([])).toEqual([])
  })

  it('shows only routes named by the panel capability list', () => {
    const groups = navGroupsFor(['overview', 'logs'])
    const urls = groups.flatMap((group) => group.items.map((item) => item.url))

    expect(urls).toEqual(['/overview', '/logs'])
  })

  it('keeps the monitoring pages together in hub order', () => {
    // A stale `usage` capability from an older server must not resurrect the removed page.
    const groups = navGroupsFor([
      'usage',
      'logs',
      'statistics',
      'overview',
      'vm',
    ])

    expect(groups[0].title).toBe('监控')
    expect(groups[0].items.map((item) => item.url)).toEqual([
      '/overview',
      '/statistics',
      '/logs',
    ])
    expect(groups[1].items.map((item) => item.url)).toEqual(['/vm'])
  })

  it('lands each role on 总览, else 虚拟机, else its first page', () => {
    expect(homePathFor(null)).toBe('/overview')
    expect(homePathFor(['overview', 'cluster', 'logs', 'vm'])).toBe('/overview')
    expect(homePathFor(['vm', 'proxies', 'keys', 'logs'])).toBe('/vm')
    expect(homePathFor(['keys', 'logs'])).toBe('/logs')
    expect(homePathFor(['billing'])).toBe('/welcome')
    expect(homePathFor([])).toBe('/welcome')
  })
})
