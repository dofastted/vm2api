import { useNavigate, useRouter } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { routeErrorKind } from './error-kind'

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
  // 分包没取到时没有 HTTP 状态码可言，不要借 500 来表示它。
  const asset = routeErrorKind(error) === 'asset'
  return (
    <div className={cn('h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        {!minimal && !asset && (
          <h1 className='text-[7rem] leading-tight font-bold'>500</h1>
        )}
        <span className='font-medium'>
          {asset
            ? 'This page could not finish loading'
            : `Oops! Something went wrong :')`}
        </span>
        <p className='text-center text-muted-foreground'>
          {asset ? (
            <>
              A page asset did not load. <br /> Reload to try again.
            </>
          ) : (
            <>
              We apologize for the inconvenience. <br /> Please try again later.
            </>
          )}
        </p>
        {!minimal && (
          <div className='mt-6 flex gap-4'>
            {asset ? (
              <Button onClick={() => window.location.reload()}>Reload</Button>
            ) : (
              <>
                <Button variant='outline' onClick={() => history.go(-1)}>
                  Go Back
                </Button>
                <Button onClick={() => navigate({ to: '/overview' })}>
                  Back to Home
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
