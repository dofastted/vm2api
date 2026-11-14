export function RoutePending() {
  return (
    <div
      className='flex min-h-48 flex-col items-center justify-center gap-2 p-6'
      role='status'
      aria-live='polite'
    >
      <p className='font-medium'>正在加载页面…</p>
      <p className='text-sm text-muted-foreground'>
        正在获取页面资源和访问权限。
      </p>
    </div>
  )
}
