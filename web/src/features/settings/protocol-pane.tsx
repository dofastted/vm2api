import {
  SESSION_IDLE_TTL_SECONDS_DEFAULT,
  SESSION_IDLE_TTL_SECONDS_MAX,
  SESSION_IDLE_TTL_SECONDS_MIN,
} from '@/types/panel-routing'
import {
  Brain,
  Check,
  Clock3,
  Database,
  Scaling,
  ShieldCheck,
} from 'lucide-react'
import {
  cacheTtlFromCompat,
  detectProxiedOfficialCcFromCompat,
} from '@/lib/cache-breakpoints'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { OutboundReference } from './outbound-reference'
import {
  cchEnabledFromCompat,
  ccEntrypointFromCompat,
  cragDropForeignThinkingFromCompat,
  cragDropForeignThinkingToCompat,
  sessionIdleTtlFromInference,
  thinkingDisplayFromCompat,
} from './protocol-authority'
import { ChipGroup, PaneSection, StepperSetting } from './scheduler-controls'

type Block = Record<string, unknown>

/** Mirrors BLOCKABLE_CLIENTS in src/lib/identity/blocked-clients.mjs. */
const BLOCKABLE_CLIENTS: [string, string, string][] = [
  ['openclaw', 'OpenClaw', 'system 自述 OpenClaw 或带 mcp__openclaw__ 工具'],
]

/** Mirrors `verifyOfficialClaudeCode` in src/lib/identity/official-cc-verifier.mjs. */
const CLAUDE_CODE_FINGERPRINT: [string, string][] = [
  ['UA 语法', 'claude-cli/x.y.z (external, <ep>)'],
  ['请求头', 'x-app + 8 项 Stainless JS + browser-access'],
  ['会话与身份', '非零 64-hex device_id + UUIDv4 session_id'],
  ['anthropic-beta', 'claude-code-20250219（辅助子类型除外）'],
  ['计费块', '首块锚定 fp3 摘要一致、拒绝 cch=00000'],
  ['工具白名单', '区分大小写官方 PascalCase / mcp__'],
  ['system 与克隆', '官方身份前缀，排除第三方仿冒/克隆'],
]

function autoCompactWindowValue(value: unknown) {
  const tokens = Number(value)
  if (tokens === 200_000 || tokens === 500_000 || tokens === 1_000_000)
    return String(tokens)
  return 'model'
}

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
  const countTokens = compat.count_tokens === true
  const relay = detectProxiedOfficialCcFromCompat(compat)
  const cch = cchEnabledFromCompat(compat)
  const blockedClients =
    compat.blocked_clients &&
    typeof compat.blocked_clients === 'object' &&
    !Array.isArray(compat.blocked_clients)
      ? (compat.blocked_clients as Record<string, unknown>)
      : {}
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
            desc={
              strict
                ? '第三方客户端一律 403，返回“请使用 Claude 官方客户端”，不选号、不上游。'
                : '已关：第三方客户端放行，其 system 自动搬进首条 user，避开上游「Third-party apps」计费拒绝。'
            }
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
                ? 'UA 被改写时须通过锚定计费块 fp3 校验（拒绝 cch=00000）、官方 system、官方工具白名单与克隆排除；非桌面/SDK 入口或计费块缺失时还需非零 user_id。'
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
                ? '开：通过严格官方校验的直连与中转请求保留入站 system，不套用当前提示词档；含外来 system 块或非官方工具时不透传。'
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
          {BLOCKABLE_CLIENTS.map(([id, label, signature]) => {
            const on = blockedClients[id] === true
            return (
              <SettingRow
                key={id}
                label={`拦截 ${label}`}
                desc={
                  on
                    ? `开：识别为 ${label}（${signature}）的 Claude 请求在选号之前一律 403。注意这发生在第三方 system 搬移之前，等于主动放弃一条本来能成功的请求。`
                    : `已关（推荐）：${label} 按普通请求放行。它追加的 system 块会被搬到首个 user 轮次后正常服务，不会因第三方应用判定被上游拒绝。`
                }
              >
                <Switch
                  checked={on}
                  onCheckedChange={(next) =>
                    onCompatChange({
                      ...compat,
                      blocked_clients: { ...blockedClients, [id]: next },
                    })
                  }
                  aria-label={`拦截 ${label}`}
                />
              </SettingRow>
            )
          })}
          <SettingRow
            label='开放 count_tokens 入口'
            desc={
              countTokens
                ? '开：POST /v1/messages/count_tokens 与面板按槽位的计数探测可用。只算 token，不绑定 sticky、不计费。'
                : '已关：上述两个入口返回 404。实现一直在，这个开关只决定是否放行。'
            }
          >
            <Switch
              checked={countTokens}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, count_tokens: on })
              }
              aria-label='开放 count_tokens 入口'
            />
          </SettingRow>
        </div>
        <div className='space-y-3 pt-3'>
          <p className='text-xs text-muted-foreground'>
            {strict
              ? '官方流量判定、官方透传与「仅允许 Claude Code」共用同一套严格校验，直连须同时满足'
              : '官方流量判定与官方透传始终执行严格校验（开启「仅允许 Claude Code」后同样适用），直连须同时满足'}
          </p>
          <ul className='grid gap-x-4 gap-y-1.5 sm:grid-cols-2'>
            {CLAUDE_CODE_FINGERPRINT.map(([name, value]) => (
              <li key={name} className='flex min-w-0 items-start gap-2 text-xs'>
                <Check
                  className='mt-0.5 size-3.5 shrink-0 text-primary'
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
            未通过校验的伪装请求按第三方处理（system 搬移、工具名加 mcp__
            前缀，开启「仅允许 Claude Code」时直接 403）。OpenAI
            格式入口与健康探测不判官方；count_tokens 与 CLI quota
            探测须符合固定官方形态。面板测试与内部探测不受影响。
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
        icon={Database}
        title='出站入口'
        desc='billing 的 cc_entrypoint 和出站 UA 用同一个值。调用方自带的 billing 不改。'
      >
        <SettingRow
          label='cc_entrypoint'
          desc='仅作用于 cli-node / cli-hop 请求头改写（完整 CRAG v2 原生 CLI 槽不使用该覆盖）。保存后写入各 Claude 槽 kernel.json，cli-node 下次请求读取。'
        >
          <ChipGroup
            label='cc_entrypoint'
            value={ccEntrypointFromCompat(compat)}
            options={[
              ['sdk-cli', 'sdk-cli'],
              ['cli', 'cli'],
            ]}
            onChange={(cc_entrypoint) =>
              onCompatChange({ ...compat, cc_entrypoint })
            }
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Brain}
        title='thinking 显示'
        desc='调用方打开 thinking 却要求隐藏时，出站改成返回摘要。计费不变。'
      >
        <SettingRow
          label='隐藏的 thinking 改为返回摘要'
          desc={
            thinkingDisplayFromCompat(compat) === 'summarized'
              ? '开：omitted、updates，以及默认隐藏的模型上没写 display 的请求，出站改成 summarized。'
              : '关：保留调用方的 display。updates 仍只在出站 beta 声明时保留，否则降成 omitted。'
          }
        >
          <Switch
            checked={thinkingDisplayFromCompat(compat) === 'summarized'}
            onCheckedChange={(on) =>
              onCompatChange({
                ...compat,
                thinking_display: on ? 'summarized' : 'passthrough',
              })
            }
            aria-label='隐藏的 thinking 改为返回摘要'
          />
        </SettingRow>
        <SettingRow
          label='CRAG 丢弃外来 thinking'
          desc={
            cragDropForeignThinkingFromCompat(compat) === 'all'
              ? '全部：不是本账号签发的块都丢（含签名无记录的）。签名记录不完整时（清库、记录开始前的老会话）会误丢本账号 thinking 并让提示缓存失效。'
              : cragDropForeignThinkingFromCompat(compat) === 'foreign_only'
                ? '仅他账号：只丢明确记在别账号名下的块；签名无记录的保留，换槽后不必先撞一次签名 400。'
                : '关：原样重放调用方历史，等上游回 thinking 签名 400 再修。'
          }
        >
          <ChipGroup
            label='CRAG 丢弃外来 thinking'
            value={cragDropForeignThinkingFromCompat(compat)}
            options={[
              ['off', '关'],
              ['foreign_only', '仅他账号'],
              ['all', '全部'],
            ]}
            onChange={(mode) =>
              onCompatChange({
                ...compat,
                crag_drop_foreign_thinking: cragDropForeignThinkingToCompat(
                  mode as 'off' | 'foreign_only' | 'all'
                ),
              })
            }
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Scaling}
        title='Auto compact 窗口'
        desc='默认跟随请求模型。显式值替换模型窗口，请求里的 CLAUDE_CODE_AUTO_COMPACT_WINDOW 仍优先。'
      >
        <SettingRow
          label='窗口'
          desc='跟随模型时，以模型目录（model catalog）中各模型的默认上下文窗口为准（含默认 1M 的 4.6 / 4.7 / 5.x / Fable / Mythos 等模型）。'
        >
          <ChipGroup
            label='Auto compact 窗口'
            value={autoCompactWindowValue(compat.auto_compact_window)}
            options={[
              ['model', '跟随模型'],
              ['200000', '200K'],
              ['500000', '500K'],
              ['1000000', '1M'],
            ]}
            onChange={(value) =>
              onCompatChange({
                ...compat,
                auto_compact_window: value === 'model' ? null : Number(value),
              })
            }
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Clock3}
        title='CCH 统一附加'
        desc='仅作用于 cli-node / cli-hop 出站 billing 的 cch 改写（完整 CRAG v2 槽由原生 CLI 自行生成）。开启后缺失也补，不区分试用或订阅。'
      >
        <SettingRow
          label='强制附加 CCH'
          desc={
            cch
              ? '开：cli-node / cli-hop 出站补齐 cch；试用号缺失也写。保存后热写入各槽 kernel.json，不重启 CLI。'
              : '关：cli-node / cli-hop 固定发送 cch=00000;（5 个 0），不计算摘要。'
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
        icon={Clock3}
        title='原生 sticky 槽'
        desc='仅控制 cli-node / cli-hop 原生 CLI 槽的空闲进程回收（完整 CRAG v2 槽不按此项回收空闲会话）。不是流空闲超时，也不是粘性页的账号绑定 TTL。'
      >
        <StepperSetting
          id='inference-session-idle-ttl'
          label='槽空闲超时'
          desc='从最后一次任务完成开始计时，活动请求不回收；完整 CRAG v2 槽不按此项回收。保存后热生效，不重启内核。'
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
      <OutboundReference />
    </div>
  )
}
