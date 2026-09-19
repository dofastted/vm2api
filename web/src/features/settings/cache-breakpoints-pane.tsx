import {
  CACHE_TTL_OPTIONS,
  cacheBreakpointsFromCompat,
  cacheTtlFromCompat,
  detectProxiedOfficialCcFromCompat,
  type CacheTtl,
} from '@/lib/cache-breakpoints'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'

type Compat = Record<string, unknown>

export function CacheBreakpointsPane({
  compat,
  onChange,
}: {
  compat: Compat
  onChange: (next: Compat) => void
}) {
  const cfg = cacheBreakpointsFromCompat(compat)
  const ttl = cacheTtlFromCompat(compat)
  const proxied = detectProxiedOfficialCcFromCompat(compat)

  return (
    <>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>缓存</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingRow label='TTL' desc='1h 按 2× 计费；5m 按 1.25×。'>
            <Select
              value={ttl}
              onValueChange={(v) =>
                onChange({ ...compat, cache_ttl: v as CacheTtl })
              }
            >
              <SelectTrigger className='w-40'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CACHE_TTL_OPTIONS.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>缓存断点</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <p className='text-xs leading-relaxed text-muted-foreground'>
            rust cli-hop 剥 tools / system / messages 上的 cache_control；kernel
            按 Claude Code 重打 conversation 断点。官方入站跳过。关则只剥 last
            user，调用方其余 conversation 断点保留。
          </p>
          <SettingRow label='启用'>
            <Switch
              checked={cfg.enabled}
              onCheckedChange={(on) =>
                onChange({
                  ...compat,
                  cache_breakpoints: { ...cfg, enabled: on },
                })
              }
              aria-label='启用缓存断点'
            />
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>被中转的官方流量</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingRow
            label='识别中转来的官方 Claude Code'
            desc='UA 被换成 Go-http-client，但 body 仍带官方计费块和合法 user_id。命中则整包按官方处理。'
          >
            <Switch
              checked={proxied}
              onCheckedChange={(on) =>
                onChange({ ...compat, detect_proxied_official_cc: on })
              }
              aria-label='识别被中转的官方 Claude Code'
            />
          </SettingRow>
        </CardContent>
      </Card>
    </>
  )
}
