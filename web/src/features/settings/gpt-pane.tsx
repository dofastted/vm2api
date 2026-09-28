import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'

type CodexBlock = Record<string, unknown>

function protocolEntry(codex: CodexBlock, key: string) {
  const protocols =
    (codex.protocols as Record<string, Record<string, unknown>>) || {}
  return protocols[key] || {}
}

function clientEntry(codex: CodexBlock, key: string) {
  const clients = (codex.clients as Record<string, unknown>) || {}
  return clients[key] === 'allow' ? 'allow' : 'reject'
}

export function GptPane({
  value,
  onChange,
}: {
  value: CodexBlock
  onChange: (next: CodexBlock) => void
}) {
  const convert = (value.convert as Record<string, unknown>) || {}
  const catalogClientVersion = String(value.catalog_client_version ?? 'auto')
  const update = (patch: CodexBlock) => onChange({ ...value, ...patch })
  const setProtocol = (key: string, enabled: boolean, mode: string) => {
    const protocols = {
      ...((value.protocols as object) || {}),
      [key]: { mode, enabled },
    }
    update({ protocols })
  }
  const setClient = (key: string, allow: boolean) => {
    update({
      clients: {
        ...((value.clients as object) || {}),
        [key]: allow ? 'allow' : 'reject',
      },
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>GPT</CardTitle>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow
          label='启用 GPT 路由'
          desc='关闭后 gpt-* 请求 4xx，不回落 Claude。'
        >
          <Switch
            checked={value.enabled !== false}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </SettingRow>
        <SettingRow label='/v1/responses' desc='ChatGPT native。'>
          <Switch
            checked={protocolEntry(value, 'openai.responses').enabled !== false}
            onCheckedChange={(enabled) =>
              setProtocol('openai.responses', enabled, 'native')
            }
          />
        </SettingRow>
        <SettingRow label='Chat 转 Codex Responses'>
          <Switch
            checked={convert.chat_to_codex !== false}
            onCheckedChange={(chat_to_codex) =>
              update({ convert: { ...convert, chat_to_codex } })
            }
          />
        </SettingRow>
        <SettingRow label='Completions 转 Codex'>
          <Switch
            checked={convert.completions_to_codex !== false}
            onCheckedChange={(completions_to_codex) =>
              update({ convert: { ...convert, completions_to_codex } })
            }
          />
        </SettingRow>
        <SettingRow label='官方 Codex 客户端'>
          <Switch
            checked={clientEntry(value, 'official_codex') === 'allow'}
            onCheckedChange={(allow) => setClient('official_codex', allow)}
          />
        </SettingRow>
        <SettingRow
          label='Codex 目录客户端版本'
          desc='auto 会从官方 @openai/codex 获取并缓存版本；失败时默认使用 0.158.0。需要固定版本时可直接填写。'
        >
          <Input
            className='w-32'
            maxLength={20}
            value={catalogClientVersion}
            placeholder='auto'
            aria-label='Codex 目录客户端版本'
            onChange={(e) =>
              update({ catalog_client_version: e.target.value || 'auto' })
            }
          />
        </SettingRow>
        <SettingRow label='OpenAI 兼容客户端'>
          <Switch
            checked={clientEntry(value, 'openai_compatible') === 'allow'}
            onCheckedChange={(allow) => setClient('openai_compatible', allow)}
          />
        </SettingRow>
        <SettingRow
          label='拒绝 Claude Code 客户端'
          desc='GPT 槽不走 Claude Code。'
        >
          <Switch
            checked={clientEntry(value, 'claude_code') !== 'allow'}
            onCheckedChange={(reject) => setClient('claude_code', !reject)}
          />
        </SettingRow>
        <p className='py-3 text-xs text-muted-foreground'>
          仅 GPT 槽。模型名 /^gpt/ 进 codex-kernel。Claude
          内核路由在「协议」页，不会改 GPT 槽。
        </p>
      </CardContent>
    </Card>
  )
}
