import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

const COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-gemini.sh | sudo bash'

export function GeminiInstallPane() {
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(COMMAND)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className='max-w-3xl space-y-3'>
      <div>
        <h2 className='text-base font-medium'>手动安装 CRAGGemini</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          自动安装未完成时，在 Linux amd64 宿主机单独运行。它只准备 Gemini
          宿主服务和签名载荷，不升级控制面，也不改现有 Claude 槽。
        </p>
      </div>
      <pre className='overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs'>
        {COMMAND}
      </pre>
      <Button
        type='button'
        size='sm'
        variant='outline'
        onClick={() => void copy()}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? '已复制' : '复制安装命令'}
      </Button>
    </section>
  )
}
