import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import {
  RouterProvider,
  createHashHistory,
  createRouter,
} from '@tanstack/react-router'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { ApiError } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { onPanelSessionExpired } from '@/lib/session'
import { RoutePending } from '@/features/errors/route-pending'
import { DirectionProvider } from './context/direction-provider'
import { FontProvider } from './context/font-provider'
import { ThemeProvider } from './context/theme-provider'
import { routeTree } from './routeTree.gen'
import './styles/index.css'

onPanelSessionExpired(() => {
  useAuthStore.setState({ token: '', user: '', me: null })
  toast.error('登录已过期')
  if (!window.location.hash.startsWith('#/login')) {
    window.location.hash = '/login'
  }
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 401) return false
        return failureCount < 1
      },
      refetchOnWindowFocus: false,
      // panel data is dashboard-grade, not live — remounting a page within
      // this window should read cache instead of re-hitting the gateway
      staleTime: 30_000,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) return
      handleServerError(error)
    },
  }),
})

const router = createRouter({
  routeTree,
  history: createHashHistory(),
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingComponent: RoutePending,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider defaultTheme='dark'>
          <FontProvider>
            <DirectionProvider>
              <RouterProvider router={router} />
            </DirectionProvider>
          </FontProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}
