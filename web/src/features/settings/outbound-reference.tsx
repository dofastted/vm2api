import { useQuery } from '@tanstack/react-query'
import type { PersonaPreset } from '@/types/panel-routing'
import { Compass } from 'lucide-react'
import { personaPresetLabel } from '@/lib/persona-template'
import { Badge } from '@/components/ui/badge'
import { outboundProfileQueryOptions } from './queries'
import { PaneSection } from './scheduler-controls'

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className='grid gap-1 py-2 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3'>
      <dt className='text-xs text-muted-foreground'>{label}</dt>
      <dd className='font-mono text-xs break-all'>{value}</dd>
    </div>
  )
}

/** 只读：已保存的全局提示词档实际发出的版本与请求头。槽位覆盖见槽位详情。 */
export function OutboundReference() {
  const query = useQuery(outboundProfileQueryOptions())
  const profile = query.data?.profile

  return (
    <PaneSection
      icon={Compass}
      title='当前出站参照'
      desc='只读，按已保存的全局提示词档列出。结构规则见 system提示词页；缓存 TTL、CCH、thinking 显示以上面的开关为准。'
      aside={profile ? <Badge>{profile.cli_version}</Badge> : null}
    >
      {query.isError ? (
        <p role='alert' className='text-sm text-destructive'>
          读取失败：{query.error.message}
        </p>
      ) : !profile ? (
        <p className='text-sm text-muted-foreground'>读取中…</p>
      ) : (
        <dl className='divide-y'>
          <Row
            label='提示词档'
            value={`${personaPresetLabel(profile.preset as PersonaPreset)}（${profile.preset}）`}
          />
          <Row label='User-Agent' value={profile.user_agent} />
          <Row label='cc_entrypoint' value={profile.cc_entrypoint} />
          <Row
            label='billing'
            value={`cc_version=${profile.cli_version}.<fingerprint>; cc_entrypoint=${profile.cc_entrypoint}`}
          />
          <Row
            label={`anthropic-beta（OAuth · ${profile.beta_sample_model}）`}
            value={profile.anthropic_beta}
          />
        </dl>
      )}
    </PaneSection>
  )
}
