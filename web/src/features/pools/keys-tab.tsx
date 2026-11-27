import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ApiKeyItem } from '@/types/panel-keys'
import type { PoolBindingMode, SchedulerPool } from '@/types/panel-pools'
import { KeyRound, Plus, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatusMark } from '@/components/status-mark'
import { keyStatusTone, maskApiKeyItem } from '@/features/keys/key-format'
import { apiKeysQueryOptions } from '@/features/keys/queries'
import { SCHEDULER_POOLS_KEY } from './queries'

function keyAllowedPoolIds(item: ApiKeyItem): string[] {
  const set = new Set<string>(item.allowed_pool_ids || [])
  const def = item.default_pool_id || item.vm_pool_id
  if (def) set.add(def)
  return [...set]
}

export function PoolKeysTab({ pool }: { pool: SchedulerPool }) {
  const qc = useQueryClient()
  const keysQ = useQuery(apiKeysQueryOptions())
  const allKeys = useMemo(() => keysQ.data?.keys || [], [keysQ.data?.keys])

  const [bindOpen, setBindOpen] = useState(false)
  const [selectedKeyId, setSelectedKeyId] = useState('')
  const [asDefault, setAsDefault] = useState(true)
  const [bindingMode, setBindingMode] = useState<PoolBindingMode>('strict_pool')

  const boundKeys = useMemo(() => {
    const byId = new Map<
      string,
      {
        id: string
        name: string
        masked: string
        status: string
        isDefault: boolean
        bindingMode: PoolBindingMode
        maxConcurrency: number
        rpm: number
        item?: ApiKeyItem
      }
    >()

    for (const k of pool.bound_keys || []) {
      byId.set(k.api_key_id, {
        id: k.api_key_id,
        name: k.name || k.api_key_id,
        masked: k.key_prefix || k.api_key_id,
        status: k.status || 'active',
        isDefault: Boolean(k.is_default),
        bindingMode: k.pool_binding_mode || 'strict_pool',
        maxConcurrency: Number(k.max_concurrency || 0),
        rpm: Number(k.rpm || 0),
      })
    }

    for (const item of allKeys) {
      const def = item.default_pool_id || item.vm_pool_id
      const allowed = keyAllowedPoolIds(item)
      if (def === pool.id || allowed.includes(pool.id)) {
        byId.set(item.id, {
          id: item.id,
          name: item.name || 'default',
          masked: maskApiKeyItem(item),
          status: item.status || 'active',
          isDefault: def === pool.id,
          bindingMode: item.pool_binding_mode || 'strict_pool',
          maxConcurrency: Number(item.max_concurrency || 0),
          rpm: Number(item.rpm || 0),
          item,
        })
      }
    }

    return [...byId.values()]
  }, [pool.bound_keys, pool.id, allKeys])

  const unboundKeys = useMemo(() => {
    const boundIds = new Set(boundKeys.map((k) => k.id))
    return allKeys.filter((k) => !boundIds.has(k.id))
  }, [allKeys, boundKeys])

  const invalidateAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: apiKeysQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: SCHEDULER_POOLS_KEY }),
      qc.invalidateQueries({ queryKey: ['panel', 'scheduler-pools', pool.id] }),
    ])
  }

  const bindMut = useMutation({
    mutationFn: async () => {
      const key = allKeys.find((k) => k.id === selectedKeyId)
      if (!key) throw new Error('请选择要绑定的 API 密钥')
      const nextAllowed = [...new Set([...keyAllowedPoolIds(key), pool.id])]
      const nextDefault = asDefault
        ? pool.id
        : key.default_pool_id || key.vm_pool_id || pool.id
      return api(`/api/panel/api-keys/${encodeURIComponent(key.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          default_pool_id: nextDefault,
          vm_pool_id: nextDefault,
          allowed_pool_ids: nextAllowed,
          pool_binding_mode: bindingMode,
        }),
      })
    },
    onSuccess: async () => {
      toast.success('已绑定 API 密钥到本分组池')
      setBindOpen(false)
      setSelectedKeyId('')
      await invalidateAll()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const unbindMut = useMutation({
    mutationFn: async (keyId: string) => {
      const key = allKeys.find((k) => k.id === keyId)
      const remaining = key
        ? keyAllowedPoolIds(key).filter((id) => id !== pool.id)
        : []
      const nextDefault =
        key && (key.default_pool_id || key.vm_pool_id) !== pool.id
          ? (key.default_pool_id ?? key.vm_pool_id ?? null)
          : (remaining[0] ?? null)
      return api(`/api/panel/api-keys/${encodeURIComponent(keyId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          default_pool_id: nextDefault,
          vm_pool_id: nextDefault,
          allowed_pool_ids: remaining,
          pool_binding_mode: remaining.length
            ? (key?.pool_binding_mode ?? 'strict_pool')
            : 'legacy_scope',
        }),
      })
    },
    onSuccess: async () => {
      toast.success('已解绑密钥')
      await invalidateAll()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h3 className='text-sm font-semibold'>绑定 API 密钥</h3>
          <p className='text-xs text-muted-foreground'>
            所有通过默认池或允许池授权访问「{pool.name}」的 API
            密钥（严格绑定遵循 Fail-Closed，停用或空池返 403）。
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button asChild size='sm' variant='outline'>
            <Link to='/keys'>前往密钥管理</Link>
          </Button>
          <Button
            size='sm'
            onClick={() => {
              setSelectedKeyId(unboundKeys[0]?.id || '')
              setAsDefault(true)
              setBindingMode('strict_pool')
              setBindOpen(true)
            }}
            disabled={unboundKeys.length === 0}
          >
            <Plus className='size-3.5' />
            绑定密钥
          </Button>
        </div>
      </div>

      {boundKeys.length === 0 ? (
        <div className='rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground'>
          <KeyRound className='mx-auto mb-2 size-6 opacity-50' />
          暂无 API 密钥绑定到此分组池。
        </div>
      ) : (
        <div className='rounded-xl border bg-card'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>Key 前缀</TableHead>
                <TableHead>绑定关系</TableHead>
                <TableHead>绑定模式</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>限制</TableHead>
                <TableHead className='text-right'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {boundKeys.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className='font-medium'>{row.name}</TableCell>
                  <TableCell className='font-mono text-xs'>
                    {row.masked}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.isDefault ? 'default' : 'outline'}>
                      {row.isDefault ? '默认池' : '允许池'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        row.bindingMode === 'strict_pool'
                          ? 'secondary'
                          : 'outline'
                      }
                      className='font-mono text-[11px]'
                    >
                      {row.bindingMode === 'strict_pool'
                        ? 'strict_pool'
                        : 'legacy_scope'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {row.item ? (
                      <StatusMark tone={keyStatusTone(row.item)} />
                    ) : (
                      <Badge variant='outline'>{row.status}</Badge>
                    )}
                  </TableCell>
                  <TableCell className='text-xs text-muted-foreground'>
                    {row.maxConcurrency
                      ? `${row.maxConcurrency} 并发`
                      : '并发不限'}{' '}
                    · {row.rpm ? `RPM ${row.rpm}` : 'RPM 不限'}
                  </TableCell>
                  <TableCell className='text-right'>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive'
                      disabled={unbindMut.isPending}
                      onClick={() => unbindMut.mutate(row.id)}
                    >
                      <Unlink className='size-3.5' />
                      解绑
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={bindOpen} onOpenChange={setBindOpen}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>绑定 API 密钥到「{pool.name}」</DialogTitle>
            <DialogDescription>
              将已有密钥加入本池授权列表；推荐启用 strict_pool 确保 Fail-Closed
              隔离。
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-1.5'>
              <Label htmlFor='bind-key-select'>选择密钥</Label>
              <Select value={selectedKeyId} onValueChange={setSelectedKeyId}>
                <SelectTrigger id='bind-key-select'>
                  <SelectValue placeholder='选择一个 API 密钥' />
                </SelectTrigger>
                <SelectContent>
                  {unboundKeys.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.name || k.id} · {maskApiKeyItem(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='bind-mode-select'>池绑定模式</Label>
              <Select
                value={bindingMode}
                onValueChange={(v) => setBindingMode(v as PoolBindingMode)}
              >
                <SelectTrigger id='bind-mode-select'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='strict_pool'>
                    strict_pool（严格绑定 · Fail-Closed）
                  </SelectItem>
                  <SelectItem value='legacy_scope'>
                    legacy_scope（兼容旧作用域）
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className='flex cursor-pointer items-center gap-2 text-xs'>
              <Checkbox
                checked={asDefault}
                onCheckedChange={(v) => setAsDefault(v === true)}
              />
              同时设为该密钥的默认分组池（default_pool_id）
            </label>
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => setBindOpen(false)}
            >
              取消
            </Button>
            <Button
              type='button'
              disabled={!selectedKeyId || bindMut.isPending}
              loading={bindMut.isPending}
              onClick={() => bindMut.mutate()}
            >
              确认绑定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
