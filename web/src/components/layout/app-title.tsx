import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { DOCS_URL, REPO_URL } from '@/config/repo'
import { ArrowUpRight, BookOpen, Menu, Sparkles, X } from 'lucide-react'
import { IconGithub } from '@/assets/brand-icons'
import { Logo } from '@/assets/logo'
import {
  RELEASE_CHECK_INTERVAL_MS,
  fetchLatestRelease,
  hasNewerRelease,
  readDismissedRelease,
  writeDismissedRelease,
} from '@/lib/release-check'
import { cn } from '@/lib/utils'
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Button } from '../ui/button'

const CHIP_CLASS =
  'inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-sidebar-foreground/15 bg-sidebar/70 px-2.5 text-[13px] font-medium text-sidebar-foreground shadow-xs outline-hidden transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-sidebar-ring'

const CHIP_LINK_CLASS =
  'cursor-pointer hover:border-primary/45 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'

// 两枚链接按内容分一行且不折行：中文标签被压窄时会逐字竖排；空间不够先缩箭头，再省略文字。
const CHIP_PAIR_CLASS = 'flex-auto justify-center whitespace-nowrap'
const CHIP_PAIR_ARROW_CLASS = 'size-3.5 min-w-0 shrink-[100] opacity-60'

// 版本号单独占一行且不截断：发布号可能带预发布/构建后缀，截断会丢失关键信息。
const VERSION_CHIP_CLASS = 'h-auto min-h-10 gap-2 py-1.5 text-base'

export function AppTitle({ version }: { version?: string }) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem className='rounded-xl border border-primary/25 bg-gradient-to-br from-primary/12 via-primary/[0.03] to-transparent p-2.5 group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-none group-data-[collapsible=icon]:p-0'>
        <div className='flex items-center gap-2'>
          <Link
            to='/overview'
            onClick={() => setOpenMobile(false)}
            aria-label='vm2api 概览'
            className='flex min-w-0 flex-1 items-center gap-2.5 rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring'
          >
            <span className='grid size-10 shrink-0 place-items-center rounded-xl bg-slate-950 text-white shadow-md ring-1 ring-cyan-500/35 group-data-[collapsible=icon]:size-8'>
              <Logo
                aria-hidden
                className='size-5 group-data-[collapsible=icon]:size-4'
              />
            </span>
            <span className='grid min-w-0 leading-tight group-data-[collapsible=icon]:hidden'>
              <span className='truncate text-base font-bold tracking-tight'>
                vm2api
              </span>
              <span className='truncate text-xs text-sidebar-foreground/60'>
                管理台
              </span>
            </span>
          </Link>
          <ToggleSidebar className='group-data-[collapsible=icon]:hidden' />
        </div>
        <div className='mt-2.5 grid gap-1.5 group-data-[collapsible=icon]:hidden'>
          <VersionChip version={version?.replace(/^v/i, '')} />
          <UpdateNotice version={version?.replace(/^v/i, '')} />
          <div className='flex min-w-0 gap-1.5'>
            <a
              href={REPO_URL}
              target='_blank'
              rel='noreferrer'
              title='github.com/dofastted/vm2api'
              className={cn(CHIP_CLASS, CHIP_LINK_CLASS, CHIP_PAIR_CLASS)}
            >
              <IconGithub aria-hidden className='size-4 shrink-0' />
              <span className='truncate'>GitHub</span>
              <ArrowUpRight aria-hidden className={CHIP_PAIR_ARROW_CLASS} />
            </a>
            <a
              href={DOCS_URL}
              target='_blank'
              rel='noreferrer'
              title='项目入门'
              className={cn(CHIP_CLASS, CHIP_LINK_CLASS, CHIP_PAIR_CLASS)}
            >
              <BookOpen aria-hidden className='size-4 shrink-0' />
              <span className='truncate'>文档</span>
              <ArrowUpRight aria-hidden className={CHIP_PAIR_ARROW_CLASS} />
            </a>
          </div>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function VersionChip({ version }: { version?: string }) {
  if (!version) {
    return (
      <span className={cn(CHIP_CLASS, VERSION_CHIP_CLASS)}>
        <span className='size-2 shrink-0 rounded-full bg-sidebar-foreground/30' />
        <span className='font-mono text-sidebar-foreground/60'>版本 —</span>
      </span>
    )
  }
  return (
    <a
      href={`${REPO_URL}/releases/tag/v${version}`}
      target='_blank'
      rel='noreferrer'
      title={`v${version} 发布说明`}
      className={cn(CHIP_CLASS, CHIP_LINK_CLASS, VERSION_CHIP_CLASS)}
    >
      <span className='size-2.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px] shadow-primary/20' />
      <span className='font-mono font-semibold break-all tabular-nums'>
        v{version}
      </span>
      <ArrowUpRight
        aria-hidden
        className='ms-auto size-4 shrink-0 opacity-60'
      />
    </a>
  )
}

function UpdateNotice({ version }: { version?: string }) {
  const [dismissed, setDismissed] = useState(readDismissedRelease)
  const { data: latest } = useQuery({
    queryKey: ['github-latest-release'],
    queryFn: () => fetchLatestRelease(REPO_URL),
    enabled: Boolean(version),
    staleTime: RELEASE_CHECK_INTERVAL_MS,
    refetchInterval: RELEASE_CHECK_INTERVAL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
    retry: false,
  })
  if (!latest || !hasNewerRelease(version, latest, dismissed)) return null
  return (
    <div
      role='status'
      className={cn(
        CHIP_CLASS,
        'border-amber-500/45 bg-amber-500/10 pe-1 text-amber-700 dark:text-amber-300'
      )}
    >
      <a
        href={latest.url}
        target='_blank'
        rel='noreferrer'
        title={`v${latest.version} 发布说明`}
        className='inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-sidebar-ring'
      >
        <Sparkles aria-hidden className='size-4 shrink-0' />
        <span className='truncate'>现在有更新</span>
        <span className='truncate font-mono text-xs opacity-75'>
          v{latest.version}
        </span>
      </a>
      <button
        type='button'
        aria-label='关闭更新提示'
        title='关闭此提示'
        className='grid size-6 shrink-0 cursor-pointer place-items-center rounded-md opacity-70 outline-hidden hover:bg-amber-500/15 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring'
        onClick={() => {
          writeDismissedRelease(latest.version)
          setDismissed(latest.version)
        }}
      >
        <X aria-hidden className='size-3.5' />
      </button>
    </div>
  )
}

function ToggleSidebar({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()
  return (
    <Button
      data-sidebar='trigger'
      data-slot='sidebar-trigger'
      variant='ghost'
      size='icon'
      className={cn(
        'aspect-square size-8 shrink-0 cursor-pointer max-md:scale-125',
        className
      )}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <X className='md:hidden' />
      <Menu className='max-md:hidden' />
      <span className='sr-only'>切换侧栏</span>
    </Button>
  )
}
