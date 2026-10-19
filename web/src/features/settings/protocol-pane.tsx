import {
  SESSION_IDLE_TTL_SECONDS_DEFAULT,
  SESSION_IDLE_TTL_SECONDS_MAX,
  SESSION_IDLE_TTL_SECONDS_MIN,
} from '@/types/panel-routing'
import { Check, Clock3, Database, Hash, ShieldCheck } from 'lucide-react'
import {
  cacheTtlFromCompat,
  detectProxiedOfficialCcFromCompat,
} from '@/lib/cache-breakpoints'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import {
  cachedMicrocompactEnabledFromCompat,
  cchEnabledFromCompat,
  sessionIdleTtlFromInference,
} from './protocol-authority'
import { ChipGroup, PaneSection, StepperSetting } from './scheduler-controls'

type Block = Record<string, unknown>

/** Mirrors `hasClaudeCodeClientHeaders` + body checks in src/lib/identity/claude-code-only.mjs. */
const CLAUDE_CODE_FINGERPRINT: [string, string][] = [
  ['UA', 'claude-cli/x.y.z'],
  ['x-app', 'cli'],
  ['anthropic-beta', 'claude-code-20250219'],
  ['Stainless SDK', 'x-stainless-lang: js'],
  ['会话头', '= user_id.session_id'],
  ['system', '官方计费块 / 身份行'],
  ['计费块', 'cc_version = UA 版本'],
]

export function ProtocolPane({
  compat,
  inference,
  onCompatChange,
  onInferenceChange,
}: {
  compat: Block
  inference: Block
  onCompatChange: (next: Block) => void
  onInferenceChange: (patch: Block) => void
}) {
  const strict = compat.claude_code_only === true
  const relay = detectProxiedOfficialCcFromCompat(compat)
  const cch = cchEnabledFromCompat(compat)
  const cachedMicrocompact = cachedMicrocompactEnabledFromCompat(compat)
  return (
    <div className='space-y-4'>
      <PaneSection
        icon={ShieldCheck}
        title='入站准入'
        desc='谁能调用 Claude。GPT 准入在 OpenAI 页。'
        aside={
          <Badge variant={strict ? 'default' : 'secondary'}>
            {strict ? 'Claude 仅限 Claude Code' : 'Claude 不限客户端'}
          </Badge>
        }
      >
        <div className='divide-y'>
          <SettingRow
            label='仅允许 Claude Code 家族请求'
            desc='其余一律 403 claude_code_only，不选号、不上游。'
          >
            <Switch
              checked={strict}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, claude_code_only: on })
              }
              aria-label='仅允许 Claude Code 家族请求'
            />
          </SettingRow>
          <SettingRow
            label='识别中转来的官方 Claude Code'
            desc={
              relay
                ? 'UA 被改写但系统里有官方计费块的请求按官方处理，准入也放行。计费块被丢掉时，还要官方 system 和合法 user_id。'
                : '已关：只认直连 Claude Code，中转流量按第三方处理。'
            }
          >
            <Switch
              checked={relay}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, detect_proxied_official_cc: on })
              }
              aria-label='识别中转来的官方 Claude Code'
            />
          </SettingRow>
          <SettingRow
            label='官方 Claude Code 家族透传'
            desc={
              compat.official_cc_passthrough === true
                ? '开：直连和被识别为中转的官方家族保留入站 system，不套用当前提示词档。'
                : '关：官方家族也套用协议里的 system 档。打开后才透传。'
            }
          >
            <Switch
              checked={compat.official_cc_passthrough === true}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, official_cc_passthrough: on })
              }
              aria-label='官方 Claude Code 家族透传'
            />
          </SettingRow>
        </div>
        <div
          className={cn(
            'space-y-3 pt-3 transition-opacity duration-200',
            !strict && 'opacity-55'
          )}
        >
          <p className='text-xs text-muted-foreground'>
            {strict ? '直连放行须同时满足' : '开启后直连放行须同时满足'}
          </p>
          <ul className='grid gap-x-4 gap-y-1.5 sm:grid-cols-2'>
            {CLAUDE_CODE_FINGERPRINT.map(([name, value]) => (
              <li key={name} className='flex min-w-0 items-start gap-2 text-xs'>
                <Check
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    strict ? 'text-primary' : 'text-muted-foreground'
                  )}
                  aria-hidden
                />
                <span className='min-w-0'>
                  <span className='font-medium'>{name}</span>{' '}
                  <span className='font-mono break-all text-muted-foreground'>
                    {value}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className='text-xs leading-5 text-muted-foreground'>
            OpenAI 格式入口与健康探测一律拒绝。count_tokens 只验请求头；CLI
            自身的 quota 探测须是固定原样。面板测试与内部探测不受影响。
          </p>
        </div>
      </PaneSection>
      <PaneSection
        icon={Database}
        title='提示词缓存'
        desc='设置默认缓存写入时长，保持现有断点布局。'
      >
        <SettingRow
          label='默认缓存写入 TTL'
          desc='请求头、请求显式 TTL 与会话锁定值优先；system 模板中的显式 TTL 不变。'
        >
          <ChipGroup
            label='默认缓存写入 TTL'
            value={cacheTtlFromCompat(compat)}
            options={[
              ['5m', '5 分钟（5m）'],
              ['1h', '1 小时（1h）'],
            ]}
            onChange={(cache_ttl) => onCompatChange({ ...compat, cache_ttl })}
          />
        </SettingRow>
        <p className='text-xs leading-5 text-muted-foreground'>
          保存后作为新会话和自有缺省标记的
          TTL。已有会话锁定值不变，官方透传仍保留调用方断点及缺失 TTL。
        </p>
      </PaneSection>
      <PaneSection
        icon={Hash}
        title='CCH 统一附加'
        desc='出站 billing 的 cch。开启后改写已有摘要，不区分试用或订阅。'
      >
        <SettingRow
          label='强制附加 CCH'
          desc={
            cch
              ? '开：已有五位摘要也按最终请求重算。保存后热写入各槽 kernel.json，不重启 CLI。'
              : '关：固定发送 cch=00000;（5 个 0），不计算摘要。'
          }
        >
          <Switch
            checked={cch}
            onCheckedChange={(on) =>
              onCompatChange({ ...compat, cch_enabled: on })
            }
            aria-label='强制附加 CCH'
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Database}
        title='缓存编辑压缩'
        desc='官方 cached microcompact。当前构建没有 cache-editing 实现，打开后请求会失败。'
      >
        <SettingRow
          label='启用 cached microcompact'
          desc={
            cachedMicrocompact
              ? '开：请求返回 cached_microcompact_unavailable，不会静默跳过。保存后热写入 kernel.json。'
              : '关：不调用 cache editing。当前构建不支持时必须保持关闭。'
          }
        >
          <Switch
            checked={cachedMicrocompact}
            onCheckedChange={(on) =>
              onCompatChange({ ...compat, cached_microcompact_enabled: on })
            }
            aria-label='启用 cached microcompact'
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Clock3}
        title='原生 sticky 槽'
        desc='kernel 里 CLI 槽空闲回收。不是流空闲超时，也不是粘性页的账号绑定 TTL。'
      >
        <StepperSetting
          id='inference-session-idle-ttl'
          label='槽空闲超时'
          desc='从最后一次任务完成开始计时，活动请求不回收。保存后热生效，不重启内核。'
          value={sessionIdleTtlFromInference(inference)}
          min={SESSION_IDLE_TTL_SECONDS_MIN}
          max={SESSION_IDLE_TTL_SECONDS_MAX}
          unit='秒'
          fallback={SESSION_IDLE_TTL_SECONDS_DEFAULT}
          onChange={(value) =>
            onInferenceChange({ session_idle_ttl_seconds: value })
          }
        />
      </PaneSection>
    </div>
  )
}
