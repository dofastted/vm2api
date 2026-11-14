import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import { fmtNum, fmtUsd } from '@/lib/format'
import type { VmKind } from '@/lib/vm-kind'
import { useVmIndex } from '@/hooks/use-vm-index'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { TableSkeleton } from '@/components/page-skeletons'
import { SlotIdentity } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { StatCard } from '@/components/stat-card'
import { billingQueryOptions } from '@/features/billing/queries'
import { emptyTotals, splitBilling } from './split'

type PlatformFilter = 'all' | VmKind

export function BillingPage() {
  const [groupBy, setGroupBy] = useState<'vm' | 'key'>('vm')
  const [platform, setPlatform] = useState<PlatformFilter>('all')
  const q = useQuery(billingQueryOptions(groupBy))
  const { vms } = useVmIndex()
  const items = q.data?.items || []

  const split = useMemo(
    () => splitBilling(items, groupBy, vms),
    [groupBy, items, vms]
  )

  const visible = split.rows.filter((item) => {
    if (groupBy !== 'vm' || platform === 'all') return true
    return item.kind === platform
  })
  const totals =
    groupBy === 'vm' && platform !== 'all'
      ? platform === 'codex'
        ? split.gpt
        : split.claude
      : q.data?.totals || emptyTotals()

  return (
    <PageHeader
      title={VIEW_TITLES.billing}
      extra={
        <div className='flex flex-wrap gap-2'>
          <Button
            size='sm'
            variant={groupBy === 'vm' ? 'default' : 'outline'}
            onClick={() => setGroupBy('vm')}
          >
            按虚拟机
          </Button>
          <Button
            size='sm'
            variant={groupBy === 'key' ? 'default' : 'outline'}
            onClick={() => {
              setGroupBy('key')
              setPlatform('all')
            }}
          >
            按密钥
          </Button>
          {groupBy === 'vm' ? (
            <>
              <Button
                size='sm'
                variant={platform === 'all' ? 'default' : 'outline'}
                onClick={() => setPlatform('all')}
              >
                全部
              </Button>
              <Button
                size='sm'
                variant={platform === 'claude' ? 'default' : 'outline'}
                onClick={() => setPlatform('claude')}
              >
                Claude
              </Button>
              <Button
                size='sm'
                variant={platform === 'codex' ? 'default' : 'outline'}
                onClick={() => setPlatform('codex')}
              >
                GPT
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      <QueryGate
        loading={q.isLoading}
        error={q.error}
        skeleton={<TableSkeleton rows={8} columns={6} />}
      >
        <div className='mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
          <StatCard label='请求' value={fmtNum(totals.requests || 0)} />
          <StatCard label='成功' value={fmtNum(totals.ok || 0)} />
          <StatCard label='失败' value={fmtNum(totals.fail || 0)} />
          <StatCard label='费用' value={fmtUsd(totals.cost_usd || 0)} />
        </div>
        {groupBy === 'vm' ? (
          <div className='mb-4 grid gap-3 sm:grid-cols-2'>
            <StatCard
              label='Claude 费用'
              value={fmtUsd(split.claude.cost_usd)}
              hint={`${fmtNum(split.claude.requests)} 请求`}
            />
            <StatCard
              label='GPT 费用'
              value={fmtUsd(split.gpt.cost_usd)}
              hint={`${fmtNum(split.gpt.requests)} 请求`}
            />
          </div>
        ) : null}
        {visible.length === 0 ? (
          <EmptyState reason='暂无计费数据' />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{groupBy === 'vm' ? '账号' : '密钥'}</TableHead>
                <TableHead>请求</TableHead>
                <TableHead>成功</TableHead>
                <TableHead>失败</TableHead>
                <TableHead>输入 token</TableHead>
                <TableHead>输出 token</TableHead>
                <TableHead>费用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((item) => {
                const id =
                  groupBy === 'vm' ? item.row.vm_id : item.row.api_key_id
                return (
                  <TableRow key={id || 'none'}>
                    <TableCell>
                      {groupBy === 'vm' && id ? (
                        <Link
                          to='/vm/$id'
                          params={{ id }}
                          className='inline-flex min-w-0 hover:underline'
                        >
                          <SlotIdentity vm={item.vm} vmId={id} />
                        </Link>
                      ) : (
                        id || '—'
                      )}
                    </TableCell>
                    <TableCell>{fmtNum(item.row.requests)}</TableCell>
                    <TableCell>{fmtNum(item.row.ok)}</TableCell>
                    <TableCell>{fmtNum(item.row.fail)}</TableCell>
                    <TableCell>{fmtNum(item.row.tokens_in)}</TableCell>
                    <TableCell>{fmtNum(item.row.tokens_out)}</TableCell>
                    <TableCell>{fmtUsd(item.row.cost_usd)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </QueryGate>
    </PageHeader>
  )
}
