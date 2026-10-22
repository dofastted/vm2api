import type { OpenAIQuotaPolicy } from '@/types/panel-vm'
import { Fingerprint, ShieldCheck, Waypoints } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { OpenaiQuotaSection } from './openai-quota-section'
import { ChipGroup, PaneSection } from './scheduler-controls'

type Block = Record<string, unknown>
type Transport = 'prefer_websocket' | 'http'

const DEFAULT_USER_AGENT = 'codex_cli_rs/0.160.0 (linux x86_64)'
const TRANSPORT_OPTIONS: [Transport, string][] = [
  ['prefer_websocket', '优先 WebSocket'],
  ['http', '仅 HTTP'],
]

function asBlock(value: unknown): Block {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Block)
    : {}
}

function codexClient(codex: Block, key: string) {
  const clients = asBlock(codex.clients)
  return clients[key] === 'allow'
}

export function OpenaiPane({
  websocket,
  codex,
  onWebsocketChange,
  onCodexChange,
  saving = false,
  pending = false,
}: {
  websocket: Block
  codex: Block
  onWebsocketChange: (next: Block) => void
  onCodexChange: (next: Block) => void
  saving?: boolean
  pending?: boolean
}) {
  const routeOn = codex.enabled !== false
  const globalWs = asBlock(websocket).enabled !== false
  const gptWs = asBlock(codex.websocket).enabled !== false
  const wsLive = globalWs && gptWs
  const features = asBlock(codex.client_features)
  const analytics = asBlock(codex.analytics)
  const convert = asBlock(codex.convert)
  const transport: Transport =
    codex.upstream_transport === 'http' ? 'http' : 'prefer_websocket'
  const quota = asBlock(codex.quota) as Partial<OpenAIQuotaPolicy>
  const responsesOn =
    asBlock(asBlock(codex.protocols)['openai.responses']).enabled !== false

  const update = (patch: Block) => onCodexChange({ ...codex, ...patch })
  const setClient = (key: string, allow: boolean) =>
    update({
      clients: {
        ...asBlock(codex.clients),
        [key]: allow ? 'allow' : 'reject',
      },
    })

  return (
    <div className='space-y-4'>
      <PaneSection
        icon={Waypoints}
        title='传输'
        desc='推理 WebSocket 与上游传输。总闸或 GPT 子闸任一关闭时强制 HTTP，并拒绝入站 WS。'
        aside={
          <Badge variant={wsLive ? 'default' : 'secondary'}>
            {wsLive ? '推理 WS 开' : '强制 HTTP'}
          </Badge>
        }
      >
        <div className='divide-y'>
          <SettingRow
            label='全局推理 WebSocket'
            desc='推理入站与上游 WS 总闸。关闭后全部推理走 HTTP，并拒绝入站 WS。不影响终端或集群 WebSocket。'
          >
            <Switch
              checked={globalWs}
              disabled={saving}
              onCheckedChange={(enabled) =>
                onWebsocketChange({ ...websocket, enabled })
              }
              aria-label='全局推理 WebSocket'
            />
          </SettingRow>
          <SettingRow
            label='GPT WebSocket'
            desc={
              globalWs
                ? 'GPT 推理 WS 子闸。关闭后 GPT 走 HTTP，并拒绝入站 WS。'
                : '当前值保留。总闸已关，GPT 即使打开也强制 HTTP。'
            }
          >
            <Switch
              checked={gptWs}
              disabled={saving}
              onCheckedChange={(enabled) =>
                update({
                  websocket: { ...asBlock(codex.websocket), enabled },
                })
              }
              aria-label='GPT WebSocket'
            />
          </SettingRow>
          <SettingRow
            label='上游传输'
            desc={
              wsLive
                ? '默认优先 WebSocket；选仅 HTTP 时固定走 HTTP/SSE。'
                : `已保存「${transport === 'http' ? '仅 HTTP' : '优先 WebSocket'}」，总闸或 GPT 子闸关闭期间实际强制 HTTP，不改草稿。`
            }
          >
            <ChipGroup
              label='上游传输'
              value={transport}
              options={TRANSPORT_OPTIONS}
              disabled={saving || !wsLive}
              onChange={(upstream_transport) => update({ upstream_transport })}
            />
          </SettingRow>
        </div>
      </PaneSection>

      <PaneSection
        icon={ShieldCheck}
        title='协议准入'
        desc={
          routeOn
            ? '谁能调用 GPT，以及 gpt-* 进 codex-kernel 的入口。'
            : '已关：gpt-* 请求 4xx，不回落 Claude。'
        }
        aside={
          <Switch
            checked={routeOn}
            disabled={saving}
            onCheckedChange={(enabled) => update({ enabled })}
            aria-label='启用 GPT 路由'
          />
        }
      >
        <div
          className={cn(
            'space-y-6 transition-opacity duration-200',
            !routeOn && 'opacity-55'
          )}
        >
          <section className='min-w-0 space-y-2'>
            <h4 className='text-xs font-medium text-muted-foreground'>
              客户端
            </h4>
            <div className='divide-y'>
              <SettingRow label='官方 Codex 客户端'>
                <Switch
                  checked={codexClient(codex, 'official_codex')}
                  disabled={saving}
                  onCheckedChange={(allow) =>
                    setClient('official_codex', allow)
                  }
                  aria-label='允许官方 Codex 客户端'
                />
              </SettingRow>
              <SettingRow
                label='官方 Codex 客户端透传'
                desc={
                  codex.official_passthrough === true
                    ? '开：保留 instructions/input/tools 等官方 body；session 与 prompt_cache_key 仍按槽位重建。'
                    : '关：官方 Codex 也走 body 归一化和 prompt_cache_key 重建。'
                }
              >
                <Switch
                  checked={codex.official_passthrough === true}
                  disabled={saving}
                  onCheckedChange={(on) => update({ official_passthrough: on })}
                  aria-label='官方 Codex 客户端透传'
                />
              </SettingRow>
              <SettingRow label='OpenAI 兼容客户端'>
                <Switch
                  checked={codexClient(codex, 'openai_compatible')}
                  disabled={saving}
                  onCheckedChange={(allow) =>
                    setClient('openai_compatible', allow)
                  }
                  aria-label='允许 OpenAI 兼容客户端'
                />
              </SettingRow>
              <SettingRow
                label='拒绝 Claude Code 客户端'
                desc='GPT 槽不走 Claude Code。'
              >
                <Switch
                  checked={!codexClient(codex, 'claude_code')}
                  disabled={saving}
                  onCheckedChange={(reject) =>
                    setClient('claude_code', !reject)
                  }
                  aria-label='GPT 模型拒绝 Claude Code 客户端'
                />
              </SettingRow>
            </div>
          </section>
          <section className='min-w-0 space-y-2'>
            <h4 className='text-xs font-medium text-muted-foreground'>入口</h4>
            <div className='divide-y'>
              <SettingRow label='/v1/responses' desc='ChatGPT native。'>
                <Switch
                  checked={responsesOn}
                  disabled={saving}
                  onCheckedChange={(on) =>
                    update({
                      protocols: {
                        ...asBlock(codex.protocols),
                        'openai.responses': { mode: 'native', enabled: on },
                      },
                    })
                  }
                  aria-label='/v1/responses'
                />
              </SettingRow>
              <SettingRow label='Chat 转 Codex Responses'>
                <Switch
                  checked={convert.chat_to_codex !== false}
                  disabled={saving}
                  onCheckedChange={(chat_to_codex) =>
                    update({ convert: { ...convert, chat_to_codex } })
                  }
                  aria-label='Chat 转 Codex Responses'
                />
              </SettingRow>
              <SettingRow label='Completions 转 Codex'>
                <Switch
                  checked={convert.completions_to_codex !== false}
                  disabled={saving}
                  onCheckedChange={(completions_to_codex) =>
                    update({
                      convert: { ...convert, completions_to_codex },
                    })
                  }
                  aria-label='Completions 转 Codex'
                />
              </SettingRow>
            </div>
          </section>
        </div>
      </PaneSection>

      <OpenaiQuotaSection
        quota={quota}
        saving={saving}
        pending={pending}
        onChange={(patch) =>
          update({
            quota: {
              ...asBlock(codex.quota),
              ...patch,
            },
          })
        }
      />

      <PaneSection
        icon={Fingerprint}
        title='客户端画像'
        desc='上游 User-Agent、安装标识与运行环境 Analytics 各自独立；后两项默认关闭。'
      >
        <div className='divide-y'>
          <SettingRow
            label='安装标识元数据'
            desc='默认关闭。显式打开后才在推理请求上送槽位持久安装 UUID 和会话 client_metadata，不发送 vm.device_id 原始指纹，也不是独立指纹上传。'
          >
            <Switch
              checked={features.enabled === true}
              disabled={saving}
              onCheckedChange={(enabled) =>
                update({
                  client_features: { ...features, enabled },
                })
              }
              aria-label='安装标识元数据'
            />
          </SettingRow>
          <SettingRow
            label='运行环境 Analytics 上报'
            desc='默认关闭。打开后对 kernel 观察到的每个会话独立 POST 一次官方 codex_thread_initialized（/backend-api/codex/analytics-events/events）：真实 kernel 版本、系统、系统版本、架构、会话标识、模型与秒级时间。上报的是 kernel 所在宿主，不是下游用户电脑；此事件没有 turn_id，也不含 prompt、文件、主机名或 MAC。与安装标识无关。'
          >
            <Switch
              checked={analytics.enabled === true}
              disabled={saving}
              onCheckedChange={(enabled) =>
                update({
                  analytics: { ...analytics, enabled },
                })
              }
              aria-label='运行环境 Analytics 上报'
            />
          </SettingRow>
          <SettingRow
            label='Codex 目录客户端版本'
            desc='auto 取官方 @openai/codex 版本并缓存，失败用 0.160.0。'
          >
            <Input
              className='w-28'
              maxLength={20}
              value={String(codex.catalog_client_version ?? 'auto')}
              placeholder='auto'
              disabled={saving}
              aria-label='Codex 目录客户端版本'
              onChange={(e) =>
                update({
                  catalog_client_version: e.target.value || 'auto',
                })
              }
            />
          </SettingRow>
          <div className='space-y-2 py-3'>
            <div className='space-y-0.5'>
              <Label htmlFor='codex-user-agent'>上游 User-Agent</Label>
              <p className='text-xs text-muted-foreground'>
                缺省为 {DEFAULT_USER_AGENT}。空输入会回到缺省，避免保存失败。
              </p>
            </div>
            <Input
              id='codex-user-agent'
              className='w-full min-w-0 font-mono text-xs'
              value={String(codex.user_agent ?? DEFAULT_USER_AGENT)}
              placeholder={DEFAULT_USER_AGENT}
              disabled={saving}
              spellCheck={false}
              autoComplete='off'
              aria-label='上游 User-Agent'
              onChange={(e) =>
                update({ user_agent: e.target.value || DEFAULT_USER_AGENT })
              }
            />
          </div>
        </div>
      </PaneSection>
    </div>
  )
}
