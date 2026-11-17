import type { VmKernelSnapshot } from '@/types/panel-vm'

type NativeTelemetry = VmKernelSnapshot['telemetry']

/** A saved switch is not the VM's acknowledgement or proof of a cleared queue. */
export function telemetryPolicyConfirmed(
  telemetry: NativeTelemetry,
  enabled: boolean
): boolean {
  if (!telemetry || telemetry.state === 'unsupported') return false
  if (telemetry.state === 'launch_policy') return telemetry.enabled === enabled
  if (enabled) return telemetry.enabled && telemetry.state !== 'disabled'
  return (
    !telemetry.enabled &&
    telemetry.state === 'disabled' &&
    telemetry.pending_events === 0
  )
}

export function telemetryStatusLabel(
  telemetry: NativeTelemetry,
  desired: boolean | null = null
): string {
  if (telemetry?.state === 'unsupported') return '此运行环境不支持'
  if (telemetry?.state === 'launch_policy') {
    if (
      telemetry.enabled === null ||
      (desired !== null && telemetry.enabled !== desired)
    ) {
      return telemetry.error || 'CRAG 启动策略待确认'
    }
    return telemetry.enabled
      ? 'CRAG 已确认开启 · 未验证上传'
      : 'CRAG 已确认关闭启动策略'
  }
  if (desired !== null && !telemetryPolicyConfirmed(telemetry, desired)) {
    return desired
      ? '已配置开启 · 等待 VM 确认'
      : '已配置关闭 · 等待 VM 停采集并清队列'
  }
  if (!telemetry) return '状态未知'
  switch (telemetry.state) {
    case 'disabled':
      return '原生已确认关闭 · 队列已清空'
    case 'waiting_credentials':
      return '等待有效凭证'
    case 'waiting_egress':
      return '等待当前出口信息'
    case 'uploading':
      return '上传中'
    case 'error':
      return '上传失败'
    case 'idle':
      return telemetry.pending_events
        ? `待发送 · ${telemetry.pending_events} 条`
        : '空闲 · 无待发事件'
  }
}
