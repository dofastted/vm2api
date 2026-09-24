import type { VmBillingModelRow } from '@/types/panel-vm'
import { fmtNum, fmtUsd } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/** 计费档位标签；标准档返回空数组。 */
function billingBandLabels(row: VmBillingModelRow): string[] {
  const out: string[] = []
  if (row.service_tier === 'fast') out.push('Fast')
  else if (row.service_tier === 'flex') out.push('Flex')
  else if (row.service_tier) out.push(row.service_tier)
  if (row.speed === 'fast') out.push('Fast mode')
  if (Number(row.long_context) === 1) out.push('长上下文')
  return out
}

/** 按模型 × 计费档位的官方价费用拆分（累计）。 */
export function VmCostByModel({ rows }: { rows?: VmBillingModelRow[] }) {
  if (!rows?.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-sm'>按模型费用</CardTitle>
        <p className='text-xs text-muted-foreground'>
          官方价 · 累计 · 按计费档位拆分
        </p>
      </CardHeader>
      <CardContent className='overflow-x-auto'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>模型</TableHead>
              <TableHead>档位</TableHead>
              <TableHead className='text-right'>请求</TableHead>
              <TableHead className='text-right'>输入 / 输出</TableHead>
              <TableHead className='text-right'>缓存 读 / 写</TableHead>
              <TableHead className='text-right'>费用</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const labels = billingBandLabels(row)
              const unpriced = Number(row.unpriced_requests || 0)
              return (
                <TableRow
                  key={`${row.model}|${row.service_tier ?? ''}|${row.speed ?? ''}|${row.long_context ?? 0}`}
                >
                  <TableCell className='font-mono text-xs'>
                    {row.model}
                  </TableCell>
                  <TableCell>
                    {labels.length ? (
                      <span className='flex flex-wrap gap-1'>
                        {labels.map((l) => (
                          <Badge key={l} variant='outline'>
                            {l}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className='text-xs text-muted-foreground'>
                        标准
                      </span>
                    )}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {fmtNum(row.requests)}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {fmtNum(row.input_tokens)} / {fmtNum(row.output_tokens)}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {fmtNum(row.cache_read_tokens)} /{' '}
                    {fmtNum(row.cache_creation_tokens)}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {fmtUsd(row.total_cost, 2)}
                    {unpriced > 0 ? (
                      <div className='text-xs text-[color:var(--status-caution)]'>
                        {fmtNum(unpriced)} 笔未估价
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
