import { Ban, ShieldCheck, TextQuote } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { PaneSection } from './scheduler-controls'

type Block = Record<string, unknown>
type Rule = { kind?: string; prefix?: string; regex?: string }

const KINDS: { id: string; label: string; desc: string; on: boolean }[] = [
  {
    id: 'ssn',
    label: '社会安全号',
    desc: '美国 SSN，只认已发放的号段。',
    on: true,
  },
  {
    id: 'passport',
    label: '护照号',
    desc: '出现在 passport、护照或 パスポート 后面的号码。',
    on: true,
  },
  { id: 'iban', label: '银行账号', desc: '校验和成立的 IBAN。', on: true },
  {
    id: 'birthday',
    label: '生日',
    desc: '跟在 birthday、DOB、born 或生日后面的日期。单独一个日期不遮。',
    on: true,
  },
  { id: 'mac', label: 'MAC 地址', desc: '网卡硬件地址。', on: true },
  {
    id: 'serial',
    label: '序列号',
    desc: '出现在 S/N、Serial 或序列号后面的值。',
    on: true,
  },
  {
    id: 'home',
    label: '家目录用户名',
    desc: '/Users、/home 和 C:\\Users 里的名字。默认关：代理每次都会带上自己的目录。',
    on: false,
  },
  {
    id: 'userhost',
    label: '用户和计算机名',
    desc: 'shell 提示符或 ssh 命令里的 user@host，以及 hostname、user 行。',
    on: false,
  },
  {
    id: 'ip',
    label: '公网 IP',
    desc: '内网、本机和文档地址保留。默认关：日志和配置里到处都是。',
    on: false,
  },
  {
    id: 'bucket',
    label: '云存储桶',
    desc: 's3://、gs://、oss://、cos:// 里的桶名。桶里的路径保留。',
    on: false,
  },
]

export function RedactionPane({
  redaction,
  runtime,
  onChange,
}: {
  redaction: Block
  runtime: Block
  onChange: (next: Block) => void
}) {
  const enabled = redaction.enabled === true
  const personal = redaction.personal !== false
  const kinds =
    redaction.kinds &&
    typeof redaction.kinds === 'object' &&
    !Array.isArray(redaction.kinds)
      ? (redaction.kinds as Record<string, boolean>)
      : {}
  const rules = Array.isArray(redaction.rules)
    ? (redaction.rules as Rule[])
    : []
  const status = runtime.error
    ? '不可用，新请求会被阻断'
    : runtime.enabled && runtime.ready
      ? '正在保护新请求'
      : enabled
        ? '已保存，等待生效'
        : '未开启'

  function patch(next: Block) {
    onChange({ ...redaction, ...next })
  }

  function setRule(index: number, next: Rule) {
    patch({ rules: rules.map((rule, at) => (at === index ? next : rule)) })
  }

  return (
    <div className='space-y-4'>
      <PaneSection
        icon={ShieldCheck}
        title='内容脱敏'
        desc='出站正文在发给上游前替换，回答回到客户端前还原。保存后只影响新请求。'
        aside={
          <Badge
            variant={runtime.ready && runtime.enabled ? 'default' : 'secondary'}
          >
            {status}
          </Badge>
        }
      >
        <div className='divide-y'>
          <SettingRow
            label='启用'
            desc='关闭时请求按原文发送。已填写的词、规则和放行名单保留。'
          >
            <Switch
              checked={enabled}
              onCheckedChange={(on) => patch({ enabled: on })}
              aria-label='启用内容脱敏'
            />
          </SettingRow>
          <SettingRow
            label='凭据与秘密'
            desc='API key、token、私钥和连接串密码。'
          >
            <Switch
              checked={redaction.secrets !== false}
              onCheckedChange={(on) => patch({ secrets: on })}
              aria-label='脱敏凭据与秘密'
            />
          </SettingRow>
          <SettingRow
            label='个人信息'
            desc='邮箱、电话、证件号和卡号。协议 ID 不一律遮住。'
          >
            <Switch
              checked={personal}
              onCheckedChange={(on) => patch({ personal: on })}
              aria-label='脱敏个人信息'
            />
          </SettingRow>
        </div>
      </PaneSection>

      <PaneSection
        icon={ShieldCheck}
        title='个人信息类别'
        desc='只在「个人信息」打开时生效。没改过的类别用引擎默认值。'
      >
        <div className='divide-y'>
          {KINDS.map((kind) => (
            <SettingRow key={kind.id} label={kind.label} desc={kind.desc}>
              <Switch
                checked={kinds[kind.id] ?? kind.on}
                disabled={!personal}
                onCheckedChange={(on) =>
                  patch({ kinds: { ...kinds, [kind.id]: on } })
                }
                aria-label={kind.label}
              />
            </SettingRow>
          ))}
        </div>
      </PaneSection>

      <PaneSection
        icon={TextQuote}
        title='自定义词和规则'
        desc='引擎不认识的名字、代号和密钥前缀。一行一个词。规则最多 32 条，前缀和正则只能填一个。'
      >
        <div className='space-y-4'>
          <SettingRow
            label='忽略大小写'
            desc='Nightjar 也会遮住 NIGHTJAR 和 nightjar。关闭时按写下的大小写匹配。'
          >
            <Switch
              checked={redaction.wordsAnyCase === true}
              onCheckedChange={(on) => patch({ wordsAnyCase: on })}
              aria-label='自定义词忽略大小写'
            />
          </SettingRow>
          <label className='block space-y-1.5'>
            <span className='text-sm font-medium'>自定义词</span>
            <textarea
              aria-label='自定义敏感词'
              rows={4}
              value={
                Array.isArray(redaction.words)
                  ? redaction.words.map((item) => String(item)).join('\n')
                  : ''
              }
              onChange={(event) =>
                patch({ words: event.target.value.split('\n') })
              }
              className='w-full rounded-md border bg-transparent p-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
            />
          </label>
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-3'>
              <span className='text-sm font-medium'>自定义规则</span>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={rules.length >= 32}
                onClick={() =>
                  patch({
                    rules: [...rules, { kind: '', prefix: '', regex: '' }],
                  })
                }
              >
                添加规则
              </Button>
            </div>
            {rules.length === 0 ? (
              <p className='text-xs leading-5 text-muted-foreground'>
                还没有自定义规则。内置的密钥和邮箱规则仍然有效。
              </p>
            ) : (
              <ul className='space-y-2'>
                {rules.map((rule, index) => {
                  const mode = rule.regex ? 'regex' : 'prefix'
                  return (
                    <li
                      key={index}
                      className='grid gap-2 rounded-md border p-2 sm:grid-cols-[8rem_6rem_1fr_auto]'
                    >
                      <input
                        aria-label={`规则 ${index + 1} 名称`}
                        value={rule.kind || ''}
                        onChange={(event) =>
                          setRule(index, { ...rule, kind: event.target.value })
                        }
                        placeholder='名称'
                        className='rounded-md border bg-transparent px-2 py-1.5 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                      />
                      <select
                        aria-label={`规则 ${index + 1} 类型`}
                        value={mode}
                        onChange={(event) =>
                          setRule(
                            index,
                            event.target.value === 'regex'
                              ? {
                                  kind: rule.kind,
                                  prefix: '',
                                  regex: rule.prefix || rule.regex || '',
                                }
                              : {
                                  kind: rule.kind,
                                  prefix: rule.regex || rule.prefix || '',
                                  regex: '',
                                }
                          )
                        }
                        className='rounded-md border bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                      >
                        <option value='prefix'>前缀</option>
                        <option value='regex'>正则</option>
                      </select>
                      <input
                        aria-label={`规则 ${index + 1} 内容`}
                        value={
                          mode === 'regex'
                            ? rule.regex || ''
                            : rule.prefix || ''
                        }
                        onChange={(event) =>
                          setRule(
                            index,
                            mode === 'regex'
                              ? {
                                  kind: rule.kind,
                                  prefix: '',
                                  regex: event.target.value,
                                }
                              : {
                                  kind: rule.kind,
                                  prefix: event.target.value,
                                  regex: '',
                                }
                          )
                        }
                        placeholder={
                          mode === 'regex' ? 'RE2 正则' : '例如 oc_sk_'
                        }
                        className='rounded-md border bg-transparent px-2 py-1.5 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                      />
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        onClick={() =>
                          patch({
                            rules: rules.filter((_, at) => at !== index),
                          })
                        }
                      >
                        删除
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </PaneSection>

      <PaneSection
        icon={Ban}
        title='放行'
        desc='整段值原样发送，不管是哪条规则找到的。比较时不区分大小写。一行一个。'
      >
        <textarea
          aria-label='放行名单'
          rows={4}
          value={
            Array.isArray(redaction.allow)
              ? redaction.allow.map((item) => String(item)).join('\n')
              : ''
          }
          onChange={(event) => patch({ allow: event.target.value.split('\n') })}
          className='w-full rounded-md border bg-transparent p-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
        />
      </PaneSection>

      <PaneSection
        icon={Ban}
        title='这里不做'
        desc='AgentDock 隐私页还有三项。这个网关的 helper 固定关掉它们，所以页面上没有开关。'
      >
        <ul className='space-y-1 text-sm leading-6 text-muted-foreground'>
          <li>保留密钥格式：不会把密钥换成同形的虚构值，仍然用占位符。</li>
          <li>本地模型：不下载、不调用人名地址模型。</li>
          <li>
            按类型提醒或拦截：命中后一律替换。没有「原样提醒」或「挡住整次请求」。
          </li>
        </ul>
      </PaneSection>
    </div>
  )
}
