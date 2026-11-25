import React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, ChevronRight, Laptop, Moon, Sun } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { useSearch } from '@/context/search-provider'
import { useTheme } from '@/context/theme-provider'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { navGroupsFor } from './layout/data/sidebar-data'
import { ScrollArea } from './ui/scroll-area'

export function CommandMenu() {
  const navigate = useNavigate()
  const { setTheme } = useTheme()
  const { open, setOpen } = useSearch()
  const views = useAuthStore((s) => s.me?.views)
  const navGroups = navGroupsFor(views)

  const runCommand = React.useCallback(
    (command: () => unknown) => {
      setOpen(false)
      command()
    },
    [setOpen]
  )

  return (
    <CommandDialog
      modal
      open={open}
      onOpenChange={setOpen}
      title='页面搜索与快捷命令'
      description='搜索可访问的页面或切换界面主题'
    >
      <CommandInput placeholder='输入命令或搜索页面…' />
      <CommandList>
        <ScrollArea type='hover' className='h-72 pe-1'>
          <CommandEmpty>未找到匹配结果。</CommandEmpty>
          {navGroups.map((group) => (
            <CommandGroup key={group.title} heading={group.title}>
              {group.items.map((navItem, i) => {
                if (navItem.url)
                  return (
                    <CommandItem
                      key={`${navItem.url}-${i}`}
                      value={navItem.title}
                      onSelect={() => {
                        runCommand(() => navigate({ to: navItem.url }))
                      }}
                    >
                      <div className='flex size-4 items-center justify-center'>
                        <ArrowRight className='size-2 text-muted-foreground/80' />
                      </div>
                      {navItem.title}
                    </CommandItem>
                  )

                return navItem.items?.map((subItem, i) => (
                  <CommandItem
                    key={`${navItem.title}-${subItem.url}-${i}`}
                    value={`${navItem.title}-${subItem.url}`}
                    onSelect={() => {
                      runCommand(() => navigate({ to: subItem.url }))
                    }}
                  >
                    <div className='flex size-4 items-center justify-center'>
                      <ArrowRight className='size-2 text-muted-foreground/80' />
                    </div>
                    {navItem.title} <ChevronRight /> {subItem.title}
                  </CommandItem>
                ))
              })}
            </CommandGroup>
          ))}
          {navGroups.length > 0 ? <CommandSeparator /> : null}
          <CommandGroup heading='界面外观'>
            <CommandItem
              value='浅色 主题 外观'
              onSelect={() => runCommand(() => setTheme('light'))}
            >
              <Sun /> <span>浅色</span>
            </CommandItem>
            <CommandItem
              value='深色 暗色 主题 外观'
              onSelect={() => runCommand(() => setTheme('dark'))}
            >
              <Moon className='scale-90' />
              <span>深色</span>
            </CommandItem>
            <CommandItem
              value='跟随系统 主题 外观'
              onSelect={() => runCommand(() => setTheme('system'))}
            >
              <Laptop />
              <span>跟随系统</span>
            </CommandItem>
          </CommandGroup>
        </ScrollArea>
      </CommandList>
    </CommandDialog>
  )
}
