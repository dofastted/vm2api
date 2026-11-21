export function resetNotice(
  mode: 'keep' | 'traits',
  id: string | undefined,
  data: unknown
) {
  const failed =
    !!data &&
    typeof data === 'object' &&
    (data as { runtime?: { ok?: boolean } }).runtime?.ok === false
  const rebuilt = mode === 'keep' ? '已保留原数据重建' : '已按新特征重建'
  return {
    level: failed ? 'warning' : 'success',
    message: failed
      ? '槽位已重建，但启动失败，当前已停止'
      : id
        ? `${rebuilt} ${id}`
        : rebuilt,
  } as const
}
