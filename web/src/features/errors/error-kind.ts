/**
 * 路由级错误的来源分类。
 *
 * `asset` 表示这一页的分包/动态模块没取到（网络抖动、刚发版旧 chunk 失效等），
 * 它没有 HTTP 状态码可言；把它和真正的应用异常一起显示成「500」会把排查方向
 * 引向服务端（#1043）。返回枚举而不是原始错误，确保失败资源的 URL 不进界面。
 */
export type RouteErrorKind = 'asset' | 'app'

const ASSET_ERROR =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk \S+ failed|chunkloaderror/i

function textOf(error: unknown, key: 'name' | 'message'): string {
  const value = (error as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' ? value : ''
}

export function routeErrorKind(error: unknown): RouteErrorKind {
  if (error == null) return 'app'
  const probe =
    `${textOf(error, 'name')} ${textOf(error, 'message')}`.trim() ||
    (typeof error === 'string' ? error : '')
  return ASSET_ERROR.test(probe) ? 'asset' : 'app'
}
