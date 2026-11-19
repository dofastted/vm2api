import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AntigravitySettings } from '@/features/vm/antigravity-panel'
import { antigravityModelsFromIds } from './antigravity-models'
import { SETTINGS_NAV_ITEMS, settingsTabId } from './navigation'

describe('global Antigravity settings', () => {
  it('has a dedicated settings route and retains enable, CLI and model controls', () => {
    expect(settingsTabId('antigravity')).toBe('antigravity')
    expect(
      SETTINGS_NAV_ITEMS.filter((item) => item.id === 'antigravity')
    ).toHaveLength(1)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(['panel', 'routing'], {
      antigravity: { enabled: false, cli_bin: 'agy', models: [] },
    })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AntigravitySettings />
      </QueryClientProvider>
    )
    expect(html).toContain('启用 Antigravity API 接入')
    expect(html).toContain('槽内客户端路径')
    expect(html).toContain('模型 ID，每行一个')
    expect(html).toContain('保存平台配置')
    expect(html).toContain('同步账号模型')
    expect(html).not.toContain('提交授权码')
    client.clear()
  })

  it('preserves disabled models and their metadata while adding or removing IDs', () => {
    const disabled = {
      id: 'gemini-pro',
      enabled: false,
      vendor: 'google',
      display_name: 'Gemini Pro',
    }
    const removed = { id: 'remove', enabled: true }
    expect(
      antigravityModelsFromIds(
        [disabled, removed],
        'gemini-pro\nnew-model\ngemini-pro\n'
      )
    ).toEqual([disabled, 'new-model'])
    expect(
      antigravityModelsFromIds([disabled], 'gemini-pro\nnew-model', {
        'gemini-pro': ['low', 'high'],
        'new-model': ['medium'],
      })
    ).toEqual([
      { ...disabled, levels: ['low', 'high'] },
      { id: 'new-model', levels: ['medium'] },
    ])
  })
})
