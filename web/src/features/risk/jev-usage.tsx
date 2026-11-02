import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Fold } from './blocks'
import { usageMoney } from './jev-usage-format'

type Counts = {
  requests: number
  successful: number
  input_tokens: number
  output_tokens: number
  unknown_usage_requests: number
  estimated_cost_nano_usd: number
  unknown_cost_requests: number
}
type Cursor = { created_at: string; id: string }
type UsageRow = {
  id: string
  created_at: string
  request_id: string
  model: string
  key_fingerprint: string
  http_status: number | null
  outcome: string
  duration_ms: number
  input_tokens: number | null
  output_tokens: number | null
  estimated_cost_nano_usd: number | null
}
type KeyUsage = {
  masked_key: string
  number: number
  key_fingerprint: string
  retired: boolean
  requests: number
  successful: number
  estimated_cost_nano_usd: number
  unknown_cost_requests: number
  status: string
  last_request_at: string | null
  last_http_status: number | null
}
const keyStatus: Record<string, string> = {
  normal: '正常请求',
  insufficient_balance: '余额不足',
  auth_error: '鉴权失败',
  rate_limited: '请求限流',
  request_error: '请求异常',
  unrequested: '未请求',
  paused: '已暂停',
}
type UsagePage = {
  keys: KeyUsage[]
  started_at: string | null
  day: string
  total: Counts
  today: Counts
  rows: UsageRow[]
  has_more: boolean
  next_cursor: Cursor | null
  storage_errors_since_start: number
}
const tokens = (value: number | null) =>
  value === null ? '未返回' : value.toLocaleString('zh-CN')
const time = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
const QUERY_KEY = ['panel', 'jev-usage'] as const

export function JevUsagePanel({
  defaultOpen = false,
}: { defaultOpen?: boolean } = {}) {
  const client = useQueryClient()
  const query = useInfiniteQuery({
    queryKey: QUERY_KEY,
    initialPageParam: null as Cursor | null,
    queryFn: ({ pageParam, signal }) => {
      const qs = new URLSearchParams({ limit: '50' })
      if (pageParam) {
        qs.set('cursor_created_at', pageParam.created_at)
        qs.set('cursor_id', pageParam.id)
      }
      return api<UsagePage>(`/api/panel/jev-usage?${qs}`, { signal })
    },
    getNextPageParam: (page) =>
      page.has_more ? (page.next_cursor ?? undefined) : undefined,
    maxPages: 5,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })
  const summary = query.data?.pages[0]
  const keyLabels = new Map(
    summary?.keys.map((key) => [key.key_fingerprint, key.masked_key])
  )
  const rows = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.rows) ?? []).map((row) => [
        row.id,
        row,
      ])
    ).values(),
  ]
  return (
    <Fold
      title='JEV 使用记录'
      defaultOpen={defaultOpen}
      meta={
        summary
          ? `今日 ${tokens(summary.today.requests)} 次 · 累计 ${usageMoney(summary.total.estimated_cost_nano_usd)}`
          : undefined
      }
    >
      <div className='space-y-4'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <p className='text-xs text-muted-foreground'>
            实际调用返回或失败后记录；缓存命中不算新调用。这里只记录本系统用量，不是账户余额或官方账单。
            {summary?.started_at
              ? `从 ${time(summary.started_at)} 起记录；此前未保存的历史用量无法补回。`
              : '仅从用量记录功能启用后统计。'}
          </p>
          <Button
            size='sm'
            variant='outline'
            disabled={query.isFetching}
            onClick={() => void client.resetQueries({ queryKey: QUERY_KEY })}
          >
            刷新用量
          </Button>
        </div>
        {query.isPending && (
          <p className='text-sm text-muted-foreground'>读取用量记录…</p>
        )}
        {query.isError && (
          <p role='alert' className='text-sm text-destructive'>
            用量读取失败，不能据此显示为零用量。
          </p>
        )}
        {summary && (
          <>
            <section
              className='space-y-3 rounded-md border p-4'
              aria-label='当前 Key 用量'
            >
              <h3 className='text-sm font-medium'>当前 Key · 已消耗估算费用</h3>
              <p className='text-xs text-muted-foreground'>
                按当前已保存明细统计（30 天保留策略），金额为
                USD，不是剩余余额。余额暂不可查询；未返回费用的请求不计入估算。状态依据最近请求，不能代表实时余额。
              </p>
              <div className='overflow-x-auto'>
                <table className='w-full min-w-[680px] text-left text-xs'>
                  <thead>
                    <tr className='border-b'>
                      <th className='p-2'>Key / 脱敏标识</th>
                      <th className='p-2'>已消耗估算 · USD</th>
                      <th className='p-2'>请求状态</th>
                      <th className='p-2'>调用 / 成功</th>
                      <th className='p-2'>费用未知</th>
                      <th className='p-2'>最近请求 · 北京</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.keys.map((key) => (
                      <tr key={key.number} className='border-b'>
                        <td className='p-2'>
                          Key {key.number}
                          <br />
                          <span className='font-mono'>{key.masked_key}</span>
                        </td>
                        <td className='p-2'>
                          {key.requests === 0
                            ? '暂无记录'
                            : usageMoney(
                                key.unknown_cost_requests === key.requests
                                  ? null
                                  : key.estimated_cost_nano_usd
                              )}
                        </td>
                        <td className='p-2'>
                          {keyStatus[key.status] ?? '未知状态'}
                          {key.last_http_status
                            ? ` · ${key.last_http_status}`
                            : ''}
                          {key.retired ? '（已暂停轮询）' : ''}
                        </td>
                        <td className='p-2'>
                          {tokens(key.requests)} / {tokens(key.successful)}
                        </td>
                        <td className='p-2'>
                          {tokens(key.unknown_cost_requests)} 次
                        </td>
                        <td className='p-2'>
                          {key.last_request_at
                            ? time(key.last_request_at)
                            : '暂无记录'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {summary.keys.length === 0 && (
                <p className='text-xs text-muted-foreground'>
                  当前未配置 Key。
                </p>
              )}
            </section>
            <div className='grid grid-cols-2 gap-3 text-sm lg:grid-cols-4'>
              <div>
                <div className='text-muted-foreground'>今日调用 · 北京时间</div>
                <strong>{tokens(summary.today.requests)}</strong>
              </div>
              <div>
                <div className='text-muted-foreground'>累计实际调用 / 成功</div>
                <strong>
                  {tokens(summary.total.requests)} /{' '}
                  {tokens(summary.total.successful)}
                </strong>
              </div>
              <div>
                <div className='text-muted-foreground'>
                  累计已报告输入 / 输出 tokens
                </div>
                <strong>
                  {tokens(summary.total.input_tokens)} /{' '}
                  {tokens(summary.total.output_tokens)}
                </strong>
              </div>
              <div>
                <div className='text-muted-foreground'>
                  已知用量费用估算 · USD
                </div>
                <strong>
                  {usageMoney(summary.total.estimated_cost_nano_usd)}
                </strong>
              </div>
            </div>
            <p className='text-xs text-muted-foreground'>
              {tokens(summary.total.unknown_usage_requests)} 次未完整返回用量，
              {tokens(summary.total.unknown_cost_requests)}{' '}
              次费用未知。未知不等于免费；估算使用本版本内置的 2026-10-25
              公开单价，不含其他系统或组织的用量。
            </p>
            {summary.storage_errors_since_start > 0 && (
              <p role='alert' className='text-sm text-destructive'>
                本进程发生 {summary.storage_errors_since_start}{' '}
                次记录存储异常，统计可能不完整。
              </p>
            )}
            <div className='max-h-96 overflow-auto'>
              <table className='w-full min-w-[680px] text-left text-xs'>
                <thead>
                  <tr className='border-b'>
                    <th className='p-2'>时间 · 北京</th>
                    <th className='p-2'>Key 脱敏标识</th>
                    <th className='p-2'>模型</th>
                    <th className='p-2'>结果</th>
                    <th className='p-2'>输入 / 输出</th>
                    <th className='p-2'>估算 USD</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className='border-b'
                      title={
                        row.request_id ? `请求 ${row.request_id}` : undefined
                      }
                    >
                      <td className='p-2 whitespace-nowrap'>
                        {time(row.created_at)}
                      </td>
                      <td className='p-2 font-mono'>
                        {row.key_fingerprint
                          ? keyLabels.has(row.key_fingerprint)
                            ? keyLabels.get(row.key_fingerprint)
                            : '已移除的 Key'
                          : '无密钥'}
                      </td>
                      <td className='p-2'>{row.model || '未返回'}</td>
                      <td className='p-2'>
                        {row.http_status ?? '网络失败'} ·{' '}
                        {row.outcome === 'success' ? '完成' : '未完成'}
                        <br />
                        {row.duration_ms} ms
                      </td>
                      <td className='p-2 whitespace-nowrap'>
                        {tokens(row.input_tokens)} / {tokens(row.output_tokens)}
                      </td>
                      <td className='p-2'>
                        {usageMoney(row.estimated_cost_nano_usd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length && (
                <p className='py-5 text-sm text-muted-foreground'>
                  目前没有已保存的实际调用记录；这不代表启用前没有使用。
                </p>
              )}
            </div>
            <p className='text-xs text-muted-foreground'>
              明细按 30 天保留策略有界清理，累计汇总保留。只保存 Key
              指纹，不保存密钥、客户正文或模型响应正文；进程结束前尚未完成或未落盘的调用无法恢复。
            </p>
            {query.hasNextPage && (
              <Button
                size='sm'
                variant='outline'
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                加载更早用量
              </Button>
            )}
          </>
        )}
      </div>
    </Fold>
  )
}
