import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/page-header'
import { SectionSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { GeminiEnvironments } from './gemini-environments'
import { OnboardFlow } from './onboard-flow'
import { VmPackageImportCard } from './vm-package-card'

export function ImportPage() {
  const dash = useQuery(dashboardQueryOptions())
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'admin'
  const requested = useSearch({
    from: '/_authenticated/import',
    select: (search) => search.tab,
  })
  const [selected, setSelected] = useState<{
    requested?: string
    tab: string
  }>()
  const tab =
    selected && selected.requested === requested
      ? selected.tab
      : requested || 'onboard'
  return (
    <PageHeader
      title={VIEW_TITLES.import}
      description='从一台空槽到可调度：建槽、绑出口、导入账号、初装。'
    >
      <Tabs
        value={tab === 'gemini' && !isAdmin ? 'onboard' : tab}
        onValueChange={(tab) => setSelected({ requested, tab })}
        className='max-w-6xl gap-6'
      >
        <TabsList>
          <TabsTrigger value='onboard'>上线一台</TabsTrigger>
          <TabsTrigger value='package'>导入 JSON 包</TabsTrigger>
          {isAdmin ? <TabsTrigger value='gemini'>Gemini</TabsTrigger> : null}
        </TabsList>
        <TabsContent value='onboard'>
          <QueryGate
            loading={dash.isLoading}
            error={dash.error}
            skeleton={
              <SectionSkeleton
                titleWidth='w-28'
                showDescription={false}
                rows={8}
              />
            }
          >
            <OnboardFlow />
          </QueryGate>
        </TabsContent>
        <TabsContent value='package' className='max-w-2xl'>
          <VmPackageImportCard />
        </TabsContent>
        {isAdmin ? (
          <TabsContent value='gemini'>
            <GeminiEnvironments />
          </TabsContent>
        ) : null}
      </Tabs>
    </PageHeader>
  )
}
