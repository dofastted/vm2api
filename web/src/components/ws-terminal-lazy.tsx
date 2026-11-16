import {
  type ComponentPropsWithoutRef,
  forwardRef,
  lazy,
  Suspense,
} from 'react'
import type {
  LoginTerminalHandle,
  WsTerminal as WsTerminalImpl,
} from '@/components/ws-terminal'

export type {
  LoginTerminalHandle,
  SlashCommand,
} from '@/components/ws-terminal'

// xterm 约 330 KB（gzip 80 KB）。终端只在少数面板里打开，静态导入会让
// 虚拟机列表/详情、集群页在首屏就下载它，所以按需加载。
const LazyWsTerminal = lazy(() =>
  import('@/components/ws-terminal').then((m) => ({ default: m.WsTerminal }))
)

export const WsTerminal = forwardRef<
  LoginTerminalHandle,
  ComponentPropsWithoutRef<typeof WsTerminalImpl>
>(function WsTerminal(props, ref) {
  return (
    <Suspense
      fallback={
        <div className='flex h-full min-h-0 items-center justify-center text-xs text-muted-foreground'>
          正在加载终端…
        </div>
      }
    >
      <LazyWsTerminal ref={ref} {...props} />
    </Suspense>
  )
})
