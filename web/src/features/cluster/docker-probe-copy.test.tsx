import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DockerTab } from './docker-tab'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
    useQueryClient: () => ({ invalidateQueries: () => {} }),
    useMutation: () => ({ mutate: () => {}, isPending: false }),
  }
})

describe('Docker probe wording', () => {
  it('keeps a pending health check distinct from unavailable Docker', () => {
    const pending = renderToStaticMarkup(
      <DockerTab
        node={
          {
            id: 'n1',
            platform: 'linux',
            link: { state: 'ready' },
            username: 'root',
          } as never
        }
      />
    )
    expect(pending).toContain('正在检测远端 Docker')
    expect(pending).not.toContain('远端 Docker 不可用')

    const failed = renderToStaticMarkup(
      <DockerTab
        node={
          {
            id: 'n1',
            platform: 'linux',
            link: { state: 'ready' },
            username: 'root',
            health: { docker: { ok: false, error: 'daemon down' } },
          } as never
        }
      />
    )
    expect(failed).toContain('远端 Docker 不可用：daemon down')
    expect(failed).not.toContain('正在检测远端 Docker')
  })
})
