import type { ReactNode } from 'react'
import type { MeResponse } from '@/types/panel-auth'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandMenu } from './command-menu'
import { ConfigDrawer } from './config-drawer'
import { ProfileDropdown } from './profile-dropdown'

const mockAuthState: { user: string; me: MeResponse | null } = {
  user: 'admin',
  me: null,
}

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: <T,>(selector: (state: typeof mockAuthState) => T): T =>
    selector(mockAuthState),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}))

vi.mock('@/components/sign-out-dialog', () => ({
  SignOutDialog: () => null,
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  SheetFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/components/ui/command', () => ({
  CommandDialog: ({
    children,
    title,
    description,
  }: {
    children: ReactNode
    title?: string
    description?: string
  }) => (
    <div data-title={title} data-description={description}>
      {children}
    </div>
  ),
  CommandInput: ({ placeholder }: { placeholder?: string }) => (
    <input placeholder={placeholder} />
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({
    heading,
    children,
  }: {
    heading?: string
    children: ReactNode
  }) => (
    <section data-heading={heading}>
      <h3>{heading}</h3>
      {children}
    </section>
  ),
  CommandItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandSeparator: () => <hr />,
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ open: true, setOpen: vi.fn() }),
}))

vi.mock('@/context/search-provider', () => ({
  useSearch: () => ({ open: true, setOpen: vi.fn() }),
}))

vi.mock('@/context/theme-provider', () => ({
  useTheme: () => ({
    defaultTheme: 'system',
    theme: 'system',
    setTheme: vi.fn(),
    resetTheme: vi.fn(),
  }),
}))

vi.mock('@/context/layout-provider', () => ({
  useLayout: () => ({
    defaultVariant: 'inset',
    variant: 'inset',
    setVariant: vi.fn(),
    defaultCollapsible: 'icon',
    collapsible: 'icon',
    setCollapsible: vi.fn(),
    resetLayout: vi.fn(),
  }),
}))

vi.mock('@/context/direction-provider', () => ({
  useDirection: () => ({
    defaultDir: 'ltr',
    dir: 'ltr',
    setDir: vi.fn(),
    resetDir: vi.fn(),
  }),
}))

afterEach(() => {
  mockAuthState.user = 'admin'
  mockAuthState.me = null
})

describe('P2-02: ProfileDropdown and CommandMenu RBAC filtering', () => {
  it('hides settings, about/update, and users entries in ProfileDropdown for non-admin roles', () => {
    mockAuthState.user = 'alice'
    mockAuthState.me = {
      user: 'alice',
      role: 'user',
      views: ['vm', 'keys', 'logs'],
    }
    const html = renderToStaticMarkup(<ProfileDropdown />)
    expect(html).toContain('alice')
    expect(html).toContain('账号安全')
    expect(html).not.toContain('>设置<')
    expect(html).not.toContain('关于 / 更新')
    expect(html).not.toContain('>用户<')
  })

  it('shows settings and users entries in ProfileDropdown when role views grant access', () => {
    mockAuthState.user = 'root'
    mockAuthState.me = {
      user: 'root',
      role: 'admin',
      views: ['overview', 'settings', 'users'],
    }
    const html = renderToStaticMarkup(<ProfileDropdown />)
    expect(html).toContain('root')
    expect(html).toContain('账号安全')
    expect(html).toContain('>设置<')
    expect(html).toContain('关于 / 更新')
    expect(html).toContain('>用户<')
  })

  it('filters CommandMenu navigation items by me.views and localizes UI copy to Chinese', () => {
    mockAuthState.user = 'alice'
    mockAuthState.me = {
      user: 'alice',
      role: 'user',
      views: ['vm', 'keys'],
    }
    const html = renderToStaticMarkup(<CommandMenu />)
    expect(html).toContain('虚拟机')
    expect(html).toContain('密钥')
    expect(html).not.toContain('设置')
    expect(html).not.toContain('数据库')
    expect(html).toContain('输入命令或搜索页面…')
    expect(html).toContain('未找到匹配结果。')
    expect(html).toContain('界面外观')
    expect(html).toContain('浅色')
    expect(html).toContain('深色')
    expect(html).toContain('跟随系统')
    expect(html).not.toContain('Type a command or search')
    expect(html).not.toContain('No results found')
    expect(html).not.toContain('>Theme<')
  })
})

describe('P3-01: ConfigDrawer Chinese localization and scope clarity', () => {
  it('names ConfigDrawer 界面外观设置 / 恢复默认外观 and avoids English UI strings', () => {
    const html = renderToStaticMarkup(<ConfigDrawer />)
    expect(html).toContain('界面外观设置')
    expect(html).toContain('恢复默认外观')
    expect(html).toContain('不会修改网关系统配置')
    expect(html).toContain('侧栏样式')
    expect(html).toContain('布局方式')
    expect(html).toContain('排版方向')
    expect(html).not.toContain('Theme Settings')
    expect(html).not.toContain('Open theme settings')
    expect(html).not.toContain('Reset all settings')
    expect(html).not.toContain('Left to Right')
  })
})
