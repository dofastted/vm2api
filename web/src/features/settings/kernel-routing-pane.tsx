import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SettingRow } from '@/components/setting-row'

export function KernelRoutingPane(_props: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Claude 内核</CardTitle>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label='推理路径'>
          <span className='text-sm'>Rust · Claude Code cli-hop</span>
        </SettingRow>
        <SettingRow label='凭证归属'>
          <span className='text-sm'>
            宿主机写 credentials.json，槽内 kernel / CLI 只读
          </span>
        </SettingRow>
      </CardContent>
    </Card>
  )
}
