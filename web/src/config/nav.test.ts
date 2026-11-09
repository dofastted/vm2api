import { describe, expect, it } from 'vitest'
import { navGroupsFor } from '@/components/layout/data/sidebar-data'
import {
  ROUTE_VIEWS,
  canOpenPath,
  hasPanelView,
  viewForPath,
  type ViewId,
} from './nav'

// Every page file under _authenticated, as the path the router serves.
const PAGE_PATHS = Object.keys(
  import.meta.glob('/src/routes/_authenticated/**/*.tsx')
)
  .map((file) =>
    file.replace('/src/routes/_authenticated', '').replace(/\.tsx$/, '')
  )
  .filter((path) => !path.endsWith('/route'))
  .map((path) => path.replace(/\/index$/, '') || '/')
  .sort()

// Mirror of ROLE_VIEWS in src/lib/admin/panel-acl.mjs.
const PANEL_VIEWS: ViewId[] = [
  'overview',
  'cluster',
  'vm',
  'import',
  'specs',
  'proxies',
  'models',
  'risk',
  'system',
  'keys',
  'api',
  'anthropic',
  'logs',
  'statistics',
  'database',
  'settings',
  'users',
  'wrap',
  'billing',
]
const ROLE_VIEWS: Record<'admin' | 'super' | 'user', ViewId[]> = {
  admin: PANEL_VIEWS,
  super: ['overview', 'cluster', 'logs', 'statistics', 'vm'],
  user: ['vm', 'proxies', 'keys', 'billing', 'logs', 'statistics'],
}

const concrete = (path: string) =>
  path.replace('$id', 'vm-01').replace('$tab', 'about')
const openPages = (views: string[] | null) =>
  PAGE_PATHS.filter((path) => canOpenPath(views, concrete(path)))

describe('route ↔ view table', () => {
  it('finds the page files', () => {
    expect(PAGE_PATHS).toContain('/')
    expect(PAGE_PATHS).toContain('/vm/$id')
    expect(PAGE_PATHS).toContain('/settings/$tab')
    expect(PAGE_PATHS).not.toContain('/route')
  })

  it('assigns every page under _authenticated to a view', () => {
    expect(
      PAGE_PATHS.filter((path) => viewForPath(path) === undefined)
    ).toEqual([])
  })

  it('has no entry without a page', () => {
    const heads = new Set(PAGE_PATHS.map((path) => `/${path.split('/')[1]}`))
    expect(Object.keys(ROUTE_VIEWS).filter((key) => !heads.has(key))).toEqual(
      []
    )
  })

  it('only names views the backend defines', () => {
    const named = Object.values(ROUTE_VIEWS).filter((view) => view !== null)
    expect(named.filter((view) => !PANEL_VIEWS.includes(view))).toEqual([])
    expect([...new Set(named)].sort()).toEqual([...PANEL_VIEWS].sort())
  })

  it('maps every sidebar link through the same table', () => {
    const urls = navGroupsFor(null).flatMap((group) =>
      group.items.map((item) => String(item.url))
    )
    expect(urls.filter((url) => !viewForPath(url))).toEqual([])
  })
})

describe('nested pages follow their parent view', () => {
  it.each([
    ['/vm/vm-01', 'vm'],
    ['/vm/vm-01?tab=usage', 'vm'],
    ['/vm/', 'vm'],
    ['/settings/about', 'settings'],
    ['/settings/', 'settings'],
    ['/', null],
  ] as const)('%s → %s', (path, view) => {
    expect(viewForPath(path)).toBe(view)
  })

  it('leaves unknown paths to the not-found page', () => {
    expect(viewForPath('/nope')).toBeUndefined()
    expect(canOpenPath(ROLE_VIEWS.user, '/nope')).toBe(true)
  })

  it('blocks a child exactly when its parent is blocked', () => {
    for (const views of Object.values(ROLE_VIEWS)) {
      expect(canOpenPath(views, '/vm/vm-01')).toBe(canOpenPath(views, '/vm'))
      expect(canOpenPath(views, '/settings/about')).toBe(
        canOpenPath(views, '/settings')
      )
    }
  })
})

describe('pages each role can open', () => {
  it('admin opens every page', () => {
    expect(openPages(ROLE_VIEWS.admin)).toEqual(PAGE_PATHS)
  })

  it('super opens monitoring and the VM pages only', () => {
    expect(openPages(ROLE_VIEWS.super)).toEqual([
      '/',
      '/cluster',
      '/logs',
      '/overview',
      '/statistics',
      '/vm',
      '/vm/$id',
    ])
  })

  it('user opens its tenant pages only', () => {
    expect(openPages(ROLE_VIEWS.user)).toEqual([
      '/',
      '/billing',
      '/keys',
      '/logs',
      '/proxies',
      '/statistics',
      '/vm',
      '/vm/$id',
    ])
  })

  it('keeps the sidebar and the guard in agreement', () => {
    const all = navGroupsFor(null).flatMap((group) =>
      group.items.map((item) => String(item.url))
    )
    for (const views of Object.values(ROLE_VIEWS)) {
      const shown = navGroupsFor(views).flatMap((group) =>
        group.items.map((item) => String(item.url))
      )
      expect(all.filter((url) => canOpenPath(views, url))).toEqual(shown)
    }
  })

  it('treats a missing view list as unrestricted and an empty one as none', () => {
    expect(openPages(null)).toEqual(PAGE_PATHS)
    expect(openPages([])).toEqual(['/'])
    expect(hasPanelView(['/keys'], 'keys')).toBe(true)
  })
})
