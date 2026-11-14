import { ApiError } from '@/lib/api'

// Only return fixed public copy. Error messages may contain request URLs or tokens.
export function describeRouteError(error: unknown) {
  if (error instanceof ApiError) {
    return {
      title: '页面请求失败',
      description:
        error.status >= 400 && error.status <= 599
          ? `服务器返回 HTTP ${error.status}，页面所需数据未能加载。`
          : '页面所需数据未能加载，请检查连接后重新加载。',
    }
  }
  if (
    error instanceof Error &&
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk [\w-]+ failed/i.test(
      error.message
    )
  ) {
    return {
      title: '页面资源加载失败',
      description: '页面所需文件未能加载，请检查连接后重新加载。',
    }
  }
  return {
    title: '页面出现异常',
    description: '页面未能正常显示。请重新加载；如果仍然出现，请联系管理员。',
  }
}
