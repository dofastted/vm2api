import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow } from '@/components/setting-row'

type PoolPaneProps = {
  pool: Record<string, unknown>
  failover: Record<string, unknown>
  onPoolChange: (next: Record<string, unknown>) => void
  onFailoverChange: (next: Record<string, unknown>) => void
}

export function PoolPane(props: PoolPaneProps) {
  const { pool, failover, onPoolChange, onFailoverChange } = props
  return (
    <Card>
      <CardHeader>
        <CardTitle>账号池</CardTitle>
        <p className='text-xs text-muted-foreground'>
          只调度 Claude VM。三态是开 / 受限 /
          关。操作员开关只拨开或关；额度、429、冷却和熔断写成受限，窗口或探测成功后自动恢复，不会拨成调度关。
        </p>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow
          label='策略'
          desc='只作用于 Claude VM。同优先级里先取最低负载，再按这里的方式挑选。'
        >
          <Select
            value={String(pool.strategy || 'weighted-round-robin')}
            onValueChange={(strategy) => onPoolChange({ ...pool, strategy })}
          >
            <SelectTrigger className='w-56'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='weighted-round-robin'>平滑 WRR</SelectItem>
              <SelectItem value='round-robin'>轮询</SelectItem>
              <SelectItem value='lru'>LRU</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label='同 VM 重试'
          desc='空响应或可重试错误时，换号前在同一台 Claude VM 上再试的次数'
        >
          <Input
            className='w-24'
            type='number'
            min={0}
            max={5}
            value={Number(failover.max_same_account_retries ?? 1)}
            onChange={(event) =>
              onFailoverChange({
                ...failover,
                max_same_account_retries: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow label='同 VM 重试间隔' desc='毫秒，默认 500'>
          <Input
            className='w-24'
            type='number'
            min={0}
            value={Number(failover.same_account_retry_delay_ms ?? 500)}
            onChange={(event) =>
              onFailoverChange({
                ...failover,
                same_account_retry_delay_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='熔断失败次数'
          desc='同一台 Claude VM 连续 5xx 达到该次数后打开熔断，529 和 401 不计入'
        >
          <Input
            className='w-24'
            type='number'
            min={1}
            max={20}
            value={Number(pool.circuit_failure_threshold ?? 3)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                circuit_failure_threshold: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='熔断打开时长'
          desc='毫秒。到期后只放行 1 个探测请求，默认 30000'
        >
          <Input
            className='w-24'
            type='number'
            min={1000}
            value={Number(pool.circuit_open_ms ?? 30000)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                circuit_open_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='切号上限'
          desc='单次请求失败转移时最多切换的 Claude VM 数'
        >
          <Input
            className='w-24'
            type='number'
            value={Number(failover.max_account_switches ?? 10)}
            onChange={(event) =>
              onFailoverChange({
                ...failover,
                max_account_switches: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow label='总尝试' desc='含重试在内的总尝试上限'>
          <Input
            className='w-24'
            type='number'
            value={Number(failover.max_total_attempts ?? 12)}
            onChange={(event) =>
              onFailoverChange({
                ...failover,
                max_total_attempts: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='每账号等待人数'
          desc='max_waiters_per_account，默认 32'
        >
          <Input
            className='w-24'
            type='number'
            min={1}
            value={Number(pool.max_waiters_per_account ?? 32)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                max_waiters_per_account: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='粘性等待超时'
          desc='毫秒，范围 1000–120000，默认 45000'
        >
          <Input
            className='w-24'
            type='number'
            min={1000}
            max={120000}
            value={Number(pool.sticky_wait_timeout_ms ?? 45000)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                sticky_wait_timeout_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='回退等待超时'
          desc='毫秒，范围 1000–120000，默认 30000'
        >
          <Input
            className='w-24'
            type='number'
            min={1000}
            max={120000}
            value={Number(pool.fallback_wait_timeout_ms ?? 30000)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                fallback_wait_timeout_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='总重试时限'
          desc='毫秒，整请求 failover 上限，默认 120000'
        >
          <Input
            className='w-24'
            type='number'
            min={1000}
            value={Number(failover.total_retry_deadline_ms ?? 120000)}
            onChange={(event) =>
              onFailoverChange({
                ...failover,
                total_retry_deadline_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow label='401 冷却' desc='OAuth 401 后该账号退出调度的时长'>
          <Select
            value={String(failover.oauth_401_cooldown_ms ?? 120000)}
            onValueChange={(cooldownMs) =>
              onFailoverChange({
                ...failover,
                oauth_401_cooldown_ms: Number(cooldownMs),
              })
            }
          >
            <SelectTrigger className='w-56'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='30000'>30 秒</SelectItem>
              <SelectItem value='120000'>2 分钟</SelectItem>
              <SelectItem value='300000'>5 分钟</SelectItem>
              <SelectItem value='600000'>10 分钟</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label='流式交付'>
          <Select
            value={String(failover.delivery_mode || 'realtime')}
            onValueChange={(deliveryMode) =>
              onFailoverChange({
                ...failover,
                delivery_mode: deliveryMode,
              })
            }
          >
            <SelectTrigger className='w-56'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='realtime'>realtime</SelectItem>
              <SelectItem value='verified'>verified</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </CardContent>
    </Card>
  )
}
