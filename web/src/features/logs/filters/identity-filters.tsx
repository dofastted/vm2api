import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UsageLogFilterOptions } from '@/types/panel-usage-logs'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usageLogSessionSuggestionsQueryOptions } from '../queries'
import type { LogsFilterState } from '../search'
import { FilterCombobox } from './filter-combobox'

const ALL = '__all__'

function SessionIdInput({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (value: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const draft = value ?? ''
  // 300ms 去抖：每次按键都打后端没有意义，前缀匹配也至少要 2 个字符。
  useEffect(() => {
    const id = setTimeout(() => setTerm(draft.trim()), 300)
    return () => clearTimeout(id)
  }, [draft])
  const suggestions = useQuery({
    ...usageLogSessionSuggestionsQueryOptions(term),
    enabled: open && term.length >= 2,
  })

  return (
    <Popover open={open && draft.trim().length >= 2} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          value={draft}
          placeholder='搜索 Session ID...'
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value.trim() || undefined)
            setOpen(true)
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        className='w-[320px] p-0'
        align='start'
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList className='max-h-[250px] overflow-y-auto'>
            {suggestions.isFetching && !suggestions.data ? (
              <div className='p-2 text-center text-sm text-muted-foreground'>
                加载中...
              </div>
            ) : (
              <CommandEmpty>未找到匹配的 Session ID</CommandEmpty>
            )}
            <CommandGroup>
              {(suggestions.data ?? []).map((id) => (
                <CommandItem
                  key={id}
                  value={id}
                  onSelect={() => {
                    onChange(id)
                    setOpen(false)
                  }}
                  className='cursor-pointer'
                >
                  <span className='flex-1 truncate font-mono text-xs'>
                    {id}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function IdentityFilters({
  isAdmin,
  filters,
  options,
  optionsLoading,
  onChange,
}: {
  isAdmin: boolean
  filters: LogsFilterState
  options: UsageLogFilterOptions | undefined
  optionsLoading: boolean
  onChange: (filters: LogsFilterState) => void
}) {
  const keys = (options?.keys ?? []).filter(
    (key) => !filters.userId || key.userId === filters.userId
  )
  return (
    <div className='grid gap-4 sm:grid-cols-2'>
      {isAdmin ? (
        <div className='space-y-2'>
          <Label>用户</Label>
          <FilterCombobox
            value={filters.userId}
            options={options?.users ?? []}
            allLabel='全部用户'
            searchPlaceholder='搜索用户...'
            emptyLabel='未找到匹配的用户'
            loading={optionsLoading}
            onChange={(userId) =>
              onChange({ ...filters, userId, keyId: undefined })
            }
          />
        </div>
      ) : null}
      <div className='space-y-2'>
        <Label>API 密钥</Label>
        <Select
          value={filters.keyId ?? ALL}
          disabled={optionsLoading}
          onValueChange={(value) =>
            onChange({ ...filters, keyId: value === ALL ? undefined : value })
          }
        >
          <SelectTrigger className='w-full'>
            <SelectValue
              placeholder={optionsLoading ? '加载中...' : '全部密钥'}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部密钥</SelectItem>
            {keys.map((key) => (
              <SelectItem key={key.id} value={key.id}>
                {key.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isAdmin ? (
        <div className='space-y-2'>
          <Label>虚拟机</Label>
          <FilterCombobox
            value={filters.vmId}
            options={options?.vms ?? []}
            allLabel='全部虚拟机'
            searchPlaceholder='搜索虚拟机...'
            emptyLabel='未找到匹配的虚拟机'
            loading={optionsLoading}
            onChange={(vmId) => onChange({ ...filters, vmId })}
          />
        </div>
      ) : null}
      <div className='space-y-2'>
        <Label>Session ID</Label>
        <SessionIdInput
          value={filters.sessionId}
          onChange={(sessionId) => onChange({ ...filters, sessionId })}
        />
      </div>
    </div>
  )
}
