import { useEffect, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export const STATUS_BAR_ITEMS = [
  ['label', '状态'],
  ['bar', '健康'],
  ['proxy', '代理'],
] as const

export type StatusBarKey = (typeof STATUS_BAR_ITEMS)[number][0]
export type StatusBarShow = Record<StatusBarKey, boolean>

const STORAGE_KEY = 'kin.vm.status-bar'

const DEFAULT_SHOW: StatusBarShow = {
  label: true,
  bar: true,
  proxy: true,
}

function normalize(raw: Partial<StatusBarShow> | null): StatusBarShow {
  const next: StatusBarShow = {
    label: raw?.label ?? DEFAULT_SHOW.label,
    bar: raw?.bar ?? DEFAULT_SHOW.bar,
    proxy: raw?.proxy ?? DEFAULT_SHOW.proxy,
  }
  if (!next.label && !next.bar && !next.proxy) next.label = true
  return next
}

function readShow(): StatusBarShow {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SHOW
    return normalize(JSON.parse(raw) as Partial<StatusBarShow>)
  } catch {
    return DEFAULT_SHOW
  }
}

export function useStatusBarShow() {
  const [show, setShow] = useState<StatusBarShow>(readShow)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(show))
  }, [show.label, show.bar, show.proxy])

  function toggle(key: StatusBarKey, next: boolean) {
    setShow((prev) => normalize({ ...prev, [key]: next }))
  }

  return { show, toggle }
}

export function StatusBarOptions({
  show,
  onToggle,
}: {
  show: StatusBarShow
  onToggle: (key: StatusBarKey, next: boolean) => void
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          className='h-7 gap-1 px-1.5 text-xs font-medium text-muted-foreground'
          title='配置状态栏显示'
          aria-label='配置状态栏显示'
        >
          <SlidersHorizontal className='size-3.5' />
          显示
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='w-40'>
        <DropdownMenuLabel>状态栏显示</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {STATUS_BAR_ITEMS.map(([key, label]) => (
          <DropdownMenuCheckboxItem
            key={key}
            checked={show[key]}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(value) => onToggle(key, value === true)}
          >
            {label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
