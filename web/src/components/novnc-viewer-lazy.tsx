import { type ComponentPropsWithoutRef, lazy, Suspense } from 'react'
import type { NoVncViewer as NoVncViewerImpl } from '@/components/novnc-viewer'

export type { NoVncHandle } from '@/components/novnc-viewer'

// noVNC 只在打开槽位桌面时需要，按需加载，避免进入首屏包。
const LazyNoVncViewer = lazy(() =>
  import('@/components/novnc-viewer').then((m) => ({ default: m.NoVncViewer }))
)

export function NoVncViewer(
  props: ComponentPropsWithoutRef<typeof NoVncViewerImpl>
) {
  return (
    <Suspense
      fallback={
        <div className='flex h-full min-h-0 items-center justify-center text-xs text-muted-foreground'>
          加载桌面组件…
        </div>
      }
    >
      <LazyNoVncViewer {...props} />
    </Suspense>
  )
}
