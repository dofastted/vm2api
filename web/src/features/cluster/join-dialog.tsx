import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseNodeHost, type ClusterNode } from '@/features/cluster/model'

export function JoinVpsDialog({
  open,
  onOpenChange,
  onJoin,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onJoin: (node: ClusterNode) => boolean
}) {
  const [host, setHost] = useState('')
  const [label, setLabel] = useState('')
  const parsed = parseNodeHost(host)
  const hostBad = host.trim().length > 0 && !parsed

  useEffect(() => {
    if (!open) {
      setHost('')
      setLabel('')
    }
  }, [open])

  function submit() {
    if (!parsed) {
      toast.error('填 IP 或主机名，不要带协议、路径或账密')
      return
    }
    const added = onJoin({
      id: `remote-${parsed}-${Date.now()}`,
      role: 'remote',
      label: label.trim() || parsed,
      host: parsed,
      link: 'none',
      latencyMs: null,
      vmCount: null,
      credCount: null,
      onlineCredCount: null,
      spendUsd: null,
      synthetic: true,
    })
    if (!added) return
    toast.success('已写入本页示意。控制面尚未接入，刷新后不会保留。')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>接入 VPS</DialogTitle>
        </DialogHeader>
        <div className='space-y-3'>
          <p className='text-sm text-muted-foreground'>
            填这台机器的 IP
            或主机名。集群控制面还没接上，现在只是把节点画进页面。
          </p>
          <div className='space-y-1.5'>
            <Label htmlFor='cluster-host'>地址</Label>
            <Input
              id='cluster-host'
              autoFocus
              autoComplete='off'
              spellCheck={false}
              placeholder='203.0.113.12 或 vps.example.net:8443'
              value={host}
              aria-invalid={hostBad || undefined}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
            {hostBad ? (
              <p className='text-xs text-red-3'>
                只要主机名或 IP，可带端口。不要写 https:// 或 user:pass@。
              </p>
            ) : null}
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='cluster-label'>备注</Label>
            <Input
              id='cluster-label'
              autoComplete='off'
              spellCheck={false}
              placeholder='可选，如 sg-2'
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!parsed}>
            接入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
