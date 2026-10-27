import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClaudeSubscription, Vm } from '@/types/panel-vm'
import { CalendarDays } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  SUBSCRIPTION_ERRORS,
  subscriptionDate,
  subscriptionDateText,
} from '@/features/vm/claude-subscription'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

export function ClaudeSubscriptionButton({ vm }: { vm: Vm }) {
  const [open, setOpen] = useState(false)
  const perms = useVmPerms()
  if (isCodexVm(vm) || !perms.credential) return null
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size='sm' variant='outline'>
          <CalendarDays /> 订阅信息
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Claude 订阅信息</DialogTitle>
          <DialogDescription>
            保存当前账号的网页 sessionKey，用于查询订阅信息。
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <SubscriptionForm
            key={`${vm.id}:${vm.account_uuid}:${vm.org_uuid}`}
            vm={vm}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SubscriptionForm({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [hasInput, setHasInput] = useState(false)
  const path = `/api/panel/vms/${encodeURIComponent(vm.id)}/claude-subscription`
  const queryKey = [
    'panel',
    'vm',
    vm.id,
    'subscription',
    vm.account_uuid,
    vm.org_uuid,
    path,
  ] as const
  const query = useQuery({
    queryKey,
    queryFn: () => api<ClaudeSubscription>(path),
    retry: false,
  })
  const data = query.data || vm.claude_subscription
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }
  const mutation = useMutation({
    mutationFn: (method: 'PUT' | 'POST' | 'DELETE') => {
      const sessionKey =
        method === 'PUT' ? input.current?.value.trim() : undefined
      if (input.current) input.current.value = ''
      setHasInput(false)
      return api<ClaudeSubscription>(path, {
        method,
        body:
          method === 'PUT'
            ? JSON.stringify({ session_key: sessionKey })
            : undefined,
      })
    },
    onSuccess: (_data, method) => {
      toast.success(
        method === 'DELETE' ? '已删除查询凭据和订阅记录' : '已更新订阅信息'
      )
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: refresh,
  })
  const busy = mutation.isPending
  const canSave =
    !!vm.account_uuid && !!vm.org_uuid && data?.encryption_available !== false
  return (
    <div className='space-y-4'>
      <div className='space-y-1 rounded-md border p-3 text-sm'>
        <p>当前套餐：{data?.plan || '未知'}</p>
        <p>{subscriptionDateText(data)}</p>
        <p className='text-xs text-muted-foreground'>
          最近成功查询：
          {data?.fetched_at ? subscriptionDate(data.fetched_at) : '未查询'}
        </p>
        {data?.last_error ? (
          <p role='alert' className='text-xs text-destructive'>
            {SUBSCRIPTION_ERRORS[data.last_error] || '订阅查询失败'}
            ；以上为上次查询结果。
          </p>
        ) : null}
      </div>
      {query.error ? (
        <p role='alert' className='text-sm text-destructive'>
          {query.error.message}
        </p>
      ) : null}
      <div className='space-y-2'>
        <Label htmlFor={`subscription-key-${vm.id}`}>网页 sessionKey</Label>
        <Input
          id={`subscription-key-${vm.id}`}
          ref={input}
          type='password'
          autoComplete='off'
          placeholder={
            data?.configured ? '已保存，输入新值可替换' : 'sk-ant-sid…'
          }
          disabled={busy || !canSave}
          onChange={(event) => setHasInput(!!event.target.value.trim())}
        />
        <p className='text-xs text-muted-foreground'>
          仅用于核对账号和读取订阅信息。保存后不回显。
        </p>
        {data?.encryption_available === false ? (
          <p role='alert' className='text-xs text-destructive'>
            服务端尚未配置数据库加密密钥，暂不能保存。
          </p>
        ) : null}
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          disabled={busy || !hasInput || !canSave}
          onClick={() => mutation.mutate('PUT')}
        >
          {busy && mutation.variables === 'PUT' ? '保存查询中…' : '保存并查询'}
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={busy || !data?.configured}
          onClick={() => mutation.mutate('POST')}
        >
          {busy && mutation.variables === 'POST' ? '查询中…' : '刷新订阅'}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          disabled={busy || !data?.configured}
          onClick={() => mutation.mutate('DELETE')}
        >
          删除查询凭据
        </Button>
      </div>
    </div>
  )
}
