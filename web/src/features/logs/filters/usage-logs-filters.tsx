import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, Network, Server, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usageLogFilterOptionsQueryOptions } from '../queries'
import type { LogsFilterState } from '../search'
import { ActiveFiltersDisplay } from './active-filters-display'
import { FilterSection } from './filter-section'
import { IdentityFilters } from './identity-filters'
import { QuickFiltersBar } from './quick-filters-bar'
import { RequestFilters } from './request-filters'
import { StatusFilters } from './status-filters'
import { TimeFilters } from './time-filters'

/**
 * 草稿 / 应用模型（hub `UsageLogsFilters`）：所有控件、快捷预设、chip 移除
 * 只改本地草稿，点「应用筛选」才写入 URL。
 */
export function UsageLogsFilters({
  isAdmin,
  filters,
  onApply,
  onReset,
}: {
  isAdmin: boolean
  filters: LogsFilterState
  onApply: (filters: LogsFilterState) => void
  onReset: () => void
}) {
  const [draft, setDraft] = useState(filters)
  useEffect(() => setDraft(filters), [filters])
  const options = useQuery(usageLogFilterOptionsQueryOptions())
  const optionsLoading = options.isLoading

  const identityCount =
    (isAdmin && draft.userId ? 1 : 0) +
    (draft.keyId ? 1 : 0) +
    (isAdmin && draft.vmId ? 1 : 0) +
    (draft.sessionId ? 1 : 0)
  const requestCount =
    (draft.model ? 1 : 0) +
    (draft.mismatch ? 1 : 0) +
    (draft.endpoint ? 1 : 0) +
    (draft.protocol ? 1 : 0)
  const statusCount =
    (draft.statusCode != null || draft.excludeStatus200 ? 1 : 0) +
    ((draft.minRetry ?? 0) > 0 ? 1 : 0) +
    (draft.errorClass ? 1 : 0)

  return (
    <div className='space-y-4'>
      <QuickFiltersBar filters={draft} onChange={setDraft} />
      <ActiveFiltersDisplay
        isAdmin={isAdmin}
        filters={draft}
        options={options.data}
        onRemove={setDraft}
        onClearAll={() => {
          setDraft({})
          onReset()
        }}
      />
      <div className='grid gap-4 lg:grid-cols-2'>
        <FilterSection
          title='时间范围'
          description='按日期和时间筛选'
          icon={Clock}
          defaultOpen
          activeCount={draft.startTime != null || draft.endTime != null ? 1 : 0}
        >
          <TimeFilters filters={draft} onChange={setDraft} />
        </FilterSection>
        <FilterSection
          title='身份信息'
          description={
            isAdmin ? '按用户、密钥、虚拟机和会话筛选' : '按密钥和会话筛选'
          }
          icon={User}
          defaultOpen
          activeCount={identityCount}
        >
          <IdentityFilters
            isAdmin={isAdmin}
            filters={draft}
            options={options.data}
            optionsLoading={optionsLoading}
            onChange={setDraft}
          />
        </FilterSection>
        <FilterSection
          title='请求参数'
          description='按模型、端点、协议筛选'
          icon={Network}
          activeCount={requestCount}
        >
          <RequestFilters
            filters={draft}
            options={options.data}
            optionsLoading={optionsLoading}
            onChange={setDraft}
          />
        </FilterSection>
        <FilterSection
          title='状态信息'
          description='按状态码、重试次数和错误类筛选'
          icon={Server}
          activeCount={statusCount}
        >
          <StatusFilters
            filters={draft}
            statusCodes={options.data?.statusCodes ?? []}
            onChange={setDraft}
          />
        </FilterSection>
      </div>
      <div className='flex flex-wrap items-center gap-2 pt-2'>
        <p className='w-full text-xs text-muted-foreground'>
          单项修改需应用；清空全部立即生效
        </p>
        <Button type='button' onClick={() => onApply(draft)}>
          应用筛选
        </Button>
        <Button
          type='button'
          variant='outline'
          onClick={() => {
            setDraft({})
            onReset()
          }}
        >
          重置
        </Button>
      </div>
    </div>
  )
}
