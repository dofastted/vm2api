import { memoryBytes } from '@/features/cluster/model'

const MEMORY = ['256m', '512m', '1g', '2g', '4g', '8g', '16g']

export function migrationMemoryOptions(current: unknown): string[] {
  const bytes = memoryBytes(current) || 2 * 1024 ** 3
  return MEMORY.filter((m) => (memoryBytes(m) || 0) >= bytes)
}

export function migrationPhase(phase: string): string {
  const labels: Record<string, string> = {
    queued: '等待槽位操作完成',
    preflight: '检查节点容量、镜像和磁盘',
    draining: '暂停调度，等待在途请求结束',
    stopping: '关闭原槽',
    copying: '限速复制并校验稀疏磁盘',
    switching: '切换节点记录',
    starting: '启动槽位',
    verifying: '验证内核和出口服务',
    cleanup: '清理旧运行资源，保留冷盘',
    done: '迁移 / 扩容完成',
    rolling_back: '恢复原节点',
    rolled_back: '迁移失败，已回滚原节点',
    rollback_failed: '回滚未完成，需管理员核对',
    failed: '预检或迁移失败',
  }
  return labels[phase] || phase
}
