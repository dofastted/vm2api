import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { fmtExpiresAt } from '@/lib/format'
import { subscribeSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { errorMessage } from '@/components/query-gate'
import {
  beginIntent,
  claimReceipt,
  finishIntent,
  getCatalog,
  getOrders,
  payOrder,
  pendingIntent,
  placeOrder,
  purchaseScope,
  sandboxPrice,
  skuLabel,
  type PurchaseIntent,
  type PurchaseOrder,
  type PurchasePlan,
} from './purchase-requests'

export function PurchaseSandbox() {
  const scope = useSyncExternalStore(subscribeSession, purchaseScope, () => '')
  return scope ? <PurchaseSandboxSession key={scope} scope={scope} /> : null
}

export function PurchaseSandboxSession({ scope }: { scope: string }) {
  const catalog = useQuery({
    queryKey: ['panel', 'purchase-sandbox', scope, 'plans'],
    queryFn: ({ signal }) => getCatalog(scope, signal),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  })
  if (catalog.isError) {
    return (
      <div className='mb-4 flex flex-wrap items-center gap-2 text-sm'>
        <p role='alert'>无法读取购买沙箱状态：{errorMessage(catalog.error)}</p>
        <Button
          size='sm'
          variant='outline'
          disabled={catalog.isFetching}
          onClick={() => void catalog.refetch()}
        >
          {catalog.isFetching ? '读取中…' : '重试'}
        </Button>
      </div>
    )
  }
  // No order list, storage reads, or purchase controls until the panel opts in.
  if (catalog.data?.enabled !== true) return null
  return <SandboxOrders scope={scope} plans={catalog.data.plans} />
}

function SandboxOrders({
  scope,
  plans,
}: {
  scope: string
  plans: PurchasePlan[]
}) {
  const client = useQueryClient()
  const ordersKey = ['panel', 'purchase-sandbox', scope, 'orders'] as const
  const list = useQuery({
    queryKey: ordersKey,
    queryFn: ({ signal }) => getOrders(scope, signal),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  })
  const [choice, setChoice] = useState('')
  const [intent, setIntent] = useState<PurchaseIntent | null>(() => {
    try {
      return pendingIntent(scope)
    } catch {
      return null
    }
  })
  const [receipt, setReceipt] = useState<{ id: string; value: string } | null>(
    null
  )
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])

  const selected = plans.find((plan) => plan.sku === (intent?.sku ?? choice))
  const blocked = Boolean(busy) || !list.isSuccess || list.isFetching

  async function act(
    key: string,
    work: (signal: AbortSignal) => Promise<void>
  ) {
    if (active.current || blocked || purchaseScope() !== scope) return
    const controller = new AbortController()
    active.current = controller
    setBusy(key)
    setError('')
    setNotice('')
    try {
      await work(controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted && purchaseScope() === scope)
        setError(errorMessage(cause))
    } finally {
      active.current = null
      if (!controller.signal.aborted && purchaseScope() === scope) setBusy('')
    }
  }

  function showOrder(row: PurchaseOrder) {
    client.setQueryData<PurchaseOrder[]>(ordersKey, (old = []) => {
      if (!old.some((item) => item.id === row.id)) return [row, ...old]
      return old.map((item) => (item.id === row.id ? row : item))
    })
  }

  function create() {
    const sku = intent?.sku ?? selected?.sku
    if (!sku) return
    void act('place', async (signal) => {
      let input: PurchaseIntent
      try {
        input = beginIntent(scope, sku)
      } catch {
        throw new Error(
          '无法保存本次下单请求，尚未提交。请允许浏览器使用会话存储后重试。'
        )
      }
      setIntent(input)
      const row = await placeOrder(scope, signal, input)
      showOrder(row)
      finishIntent(scope)
      setIntent(null)
      setChoice('')
      setNotice('已确认测试订单，可在下方查看。')
    })
  }

  function orderAction(row: PurchaseOrder) {
    if (receipt?.id === row.id) {
      setReceipt(null)
      return
    }
    void act(row.id, async (signal) => {
      if (row.status === 'pending') {
        showOrder(await payOrder(scope, signal, row.id))
        setNotice('模拟付款已确认，可以领取测试收据。')
      } else {
        const value = await claimReceipt(scope, signal, row.id)
        setReceipt({ id: row.id, value })
        setNotice('已显示该订单的测试收据。')
      }
    })
  }

  return (
    <section
      aria-labelledby='sandbox-title'
      className='mb-4 min-w-0 rounded-xl border bg-card p-4 text-card-foreground'
    >
      <h3 id='sandbox-title' className='font-semibold'>
        CRAG 购买沙箱
      </h3>
      <p className='mt-1 text-sm text-muted-foreground'>
        仅供测试，不会实际扣款，也不会签发运行时许可证。
      </p>
      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <label htmlFor='sandbox-sku' className='text-sm font-medium'>
          测试套餐
        </label>
        <Select
          value={intent?.sku ?? choice}
          onValueChange={setChoice}
          disabled={!!intent || !!busy || !plans.length}
        >
          <SelectTrigger
            id='sandbox-sku'
            size='sm'
            className='max-w-full min-w-36'
          >
            <SelectValue placeholder={plans.length ? '选择套餐' : '暂无套餐'} />
          </SelectTrigger>
          <SelectContent>
            {plans.map((plan) => (
              <SelectItem key={plan.sku} value={plan.sku}>
                {skuLabel[plan.sku]}　{sandboxPrice(plan.amount_minor)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size='sm'
          disabled={blocked || (!selected && !intent)}
          onClick={create}
        >
          {busy === 'place' ? '提交中…' : intent ? '重试原订单' : '下测试单'}
        </Button>
      </div>
      {intent && busy !== 'place' ? (
        <p className='mt-2 text-sm text-muted-foreground'>
          上次{skuLabel[intent.sku]}
          订单尚未确认。重试会沿用原请求，不会重复下单。
        </p>
      ) : null}
      <div className='mt-4 flex items-center justify-between gap-2 border-t pt-3'>
        <h4 className='text-sm font-semibold'>我的测试订单</h4>
        <Button
          size='sm'
          variant='ghost'
          disabled={!!busy || list.isFetching}
          onClick={() => {
            setError('')
            setNotice('')
            void list.refetch()
          }}
        >
          <RefreshCw aria-hidden='true' />
          {list.isFetching ? '读取中…' : '刷新订单'}
        </Button>
      </div>
      {list.isError ? (
        <p role='alert' className='text-sm text-destructive'>
          订单读取失败，请刷新订单。{errorMessage(list.error)}
        </p>
      ) : null}
      {error ? (
        <p role='alert' className='my-2 text-sm text-destructive'>
          请求未确认：{error} 请刷新订单或重试。
        </p>
      ) : null}
      <p role='status' className='text-sm text-muted-foreground'>
        {notice ||
          (list.isPending
            ? '正在读取订单…'
            : list.isSuccess && !list.data.length
              ? '暂无测试订单。选择套餐即可下单。'
              : '')}
      </p>
      {list.data?.length ? (
        <ul
          aria-label='测试订单'
          className='mt-1 max-h-80 divide-y overflow-y-auto overscroll-contain'
        >
          {list.data.map((row) => {
            const open = receipt?.id === row.id
            return (
              <li key={row.id} className='py-2'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <div className='min-w-0'>
                    <div className='flex flex-wrap items-baseline gap-x-3 text-sm'>
                      <span className='font-medium'>{skuLabel[row.sku]}</span>
                      <span className='tabular-nums'>
                        {sandboxPrice(row.amount_minor)}
                      </span>
                      <span className='text-muted-foreground'>
                        {row.status === 'paid' ? '已模拟付款' : '待模拟付款'}
                      </span>
                    </div>
                    <div className='mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground'>
                      <span>{fmtExpiresAt(row.created_at * 1000)}</span>
                      <span className='break-all'>订单号 {row.id}</span>
                    </div>
                  </div>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={blocked}
                    onClick={() => orderAction(row)}
                    aria-expanded={row.status === 'paid' ? open : undefined}
                  >
                    {busy === row.id
                      ? '处理中…'
                      : row.status === 'pending'
                        ? '模拟付款'
                        : open
                          ? '收起收据'
                          : '领取 / 查看收据'}
                  </Button>
                </div>
                {open && receipt ? (
                  <div className='mt-2 rounded-md bg-muted px-3 py-2'>
                    <p className='text-xs text-muted-foreground'>
                      测试收据（非许可证）
                    </p>
                    <code className='text-sm break-all select-all'>
                      {receipt.value}
                    </code>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
