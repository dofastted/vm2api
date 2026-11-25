import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AboutPane } from './about-pane'
import {
  changelogQueryOptions,
  versionQueryOptions,
  type ReleaseStatus,
} from './queries'

function renderStatus(overrides: Partial<ReleaseStatus>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(versionQueryOptions().queryKey, {
    current: '1.3.179',
    current_tag: 'v1.3.179',
    latest: '1.3.179',
    latest_tag: 'v1.3.179',
    update_available: false,
    check_status: 'ok',
    html_url: '',
    published_at: null,
    name: null,
    notes: '',
    needs_wrap_cli_sync: false,
    upgrade_command: '',
    check_command: '',
    repo: 'dofastted/vm2api',
    source_error: null,
    changelog: [],
    ...overrides,
  })
  client.setQueryData(changelogQueryOptions().queryKey, {
    current: '1.3.179',
    current_tag: 'v1.3.179',
    entries: [],
  })
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(AboutPane))
    )
  } finally {
    client.clear()
  }
}

describe('release check display', () => {
  it('never labels a failed check as up to date (including older API responses)', () => {
    const html = renderStatus({ source_error: 'github_http_503' })
    expect(html).not.toContain('已是最新')
    expect(html).toContain('检查失败')
  })

  it('does not advertise a cached update or enable upgrade when refresh failed', () => {
    const html = renderStatus({
      source_error: 'offline',
      update_available: true,
      latest_tag: 'v1.3.180',
    })
    expect(html).not.toContain('有更新')
    expect(html).not.toContain('已是最新')
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*从面板发起/
    )
  })

  it('continues to show successful up-to-date and newer-release results', () => {
    expect(renderStatus({})).toContain('已是最新')
    expect(
      renderStatus({ update_available: true, latest_tag: 'v1.3.180' })
    ).toContain('有更新')
  })

  it('describes cluster slot refresh with kin-worker / kin-egress instead of obsolete Go telemetry', () => {
    const html = renderStatus({})
    expect(html).toContain('kin-worker / kin-egress')
    expect(html).not.toContain('Go 遥测')
  })
})
