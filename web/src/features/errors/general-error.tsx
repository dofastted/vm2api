import { useNavigate, useRouter } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { describeRouteError } from './route-error'

type GeneralErrorProps = React.HTMLAttributes<HTMLDivElement> & {
  minimal?: boolean
  error?: unknown
}

export function GeneralError({
  className,
  minimal = false,
  error,
}: GeneralErrorProps) {
  const navigate = useNavigate()
  const { history } = useRouter()
  const detail = describeRouteError(error)
  return (
    <div className={cn('h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='text-xl font-semibold'>{detail.title}</h1>
        <p className='text-center text-muted-foreground'>
          {detail.description}
        </p>
        {!minimal && (
          <div className='mt-6 flex flex-wrap justify-center gap-4'>
            <Button onClick={() => window.location.reload()}>重新加载</Button>
            <Button variant='outline' onClick={() => history.go(-1)}>
              返回上一页
            </Button>
            <Button onClick={() => navigate({ to: '/overview' })}>
              返回首页
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
