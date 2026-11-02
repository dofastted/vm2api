/** `/api/panel/cluster/*` payloads. Credentials never come back from the server. */

export type ClusterLinkState =
  'idle' | 'connecting' | 'ready' | 'backoff' | 'error'

/** linux：槽位是 Docker 容器；darwin：Apple Silicon Mac，槽位是 launchd 服务、不用 Docker。 */
export type ClusterNodePlatform = 'linux' | 'darwin'

export type ClusterApiNode = {
  id: string
  label: string
  host: string
  port: number
  username: string
  auth_type: 'key' | 'password'
  host_key_alg: string
  host_key_sha256: string
  jump_node_id: string | null
  created_at: string
  updated_at: string
  /** 连上后按 `uname -s` 识别；老服务端没有该字段时按 linux。 */
  platform?: ClusterNodePlatform
  link: {
    state: ClusterLinkState
    error?: { code: string; message: string } | null
    attempt?: number
    connected_at?: string | null
    next_retry_at?: string | null
    host_key?: { alg: string; sha256: string } | null
  }
  health: {
    latency_ms: number | null
    docker: { ok: boolean; error: string | null }
    /** Docker `/info` 计数；Docker 不可用时为 null。 */
    containers: { total: number | null; running: number | null } | null
    /** 节点宿主负载，口径同本机宿主列；远端读不到时为 null。 */
    host?: NodeHostStats | null
    checked_at: string
  } | null
  bridge: {
    socket_path: string
    listening: boolean
    error: string | null
    active: number
  } | null
  install: DockerInstallJob | null
  /** 直连通道（kin-slot-gate，TLS）；未配置为 null。令牌与证书指纹从不返回。 */
  direct_link?: ClusterDirectLink | null
}

export type ClusterDirectLink = {
  address: string
  port: number
  /** ok 直连；down 已退回 SSH；pending 尚未检查。 */
  state: 'ok' | 'down' | 'pending'
  latency_ms: number | null
  error: string | null
  gate_error: string | null
  checked_at: string | null
}

export type NodeHostStats = {
  cpu_count: number
  load1: number
  load5: number | null
  load15: number | null
  cpu_pct: number
  mem_total: number
  mem_used: number
  mem_pct: number
  /** 全部 Docker 容器内存合计（扣除 inactive_file）；读不到 cgroup 时为 null。 */
  containers_mem: number | null
  /** 根分区（macOS 为家目录所在卷），口径同 df；旧服务端没有这三项。 */
  disk_total?: number | null
  disk_used?: number | null
  disk_pct?: number | null
}

export type DockerInstallJob = {
  status: 'running' | 'done' | 'failed'
  log: string
  exit_code: number | null
  started_at: string
  finished_at: string | null
}

/** `POST|GET /api/panel/cluster/nodes/:id/slot-image`：远端节点上构建槽位镜像。 */
export type SlotImageJob = {
  status: 'running' | 'done' | 'failed'
  ref: string
  kernel: string
  log: string
  started_at: string
  finished_at: string | null
}

export type PreflightCheckId =
  | 'ssh'
  | 'docker'
  | 'arch'
  | 'memory'
  | 'disk'
  | 'sudo'
  | 'swap'
  | 'image'
  | 'hostd'
  | 'relay'
  | 'kvm'
  | 'runtime'
  | 'macos'
  | 'launchd'
  | 'sleep'
  | 'socket_path'
  | 'payload'

/** `ok:false` + `level:'error'` 阻断创建；`warn` 只提示。 */
export type PreflightCheck = {
  id: PreflightCheckId
  ok: boolean
  level: 'error' | 'warn'
  message: string
}

/** `POST /api/panel/cluster/nodes/:id/preflight`：`ok` = 没有失败的 error 级检查。 */
export type NodePreflight = {
  node_id: string
  ok: boolean
  image: { ref: string; present: boolean; job: SlotImageJob | null }
  checks: PreflightCheck[]
}

export type ClusterNodeInput = {
  label?: string
  host: string
  port: number
  username: string
  auth_type: 'key' | 'password'
  private_key?: string
  passphrase?: string
  password?: string
  jump_node_id?: string | null
  host_key_sha256?: string
  host_key_alg?: string
}

export type ClusterProbeResult = {
  host_key: { alg: string; sha256: string }
  docker: { ok: boolean; error: string | null }
  uname: string | null
  platform?: ClusterNodePlatform
  existing_id: string | null
}

/** Existing-node edits preserve the node id, jump node and pinned host key. */
export type ClusterNodePatch = {
  expected_updated_at: string
  label?: string
  host?: string
  port?: number
  username?: string
  auth_type?: 'key' | 'password'
  private_key?: string
  passphrase?: string
  password?: string
}

export type ClusterNodeUpdateProbe = {
  host_key: { alg: string; sha256: string }
  docker: { ok: boolean; error: string | null }
  platform?: ClusterNodePlatform
  vm_count: number
  dependent_count: number
}

export type DockerInfo = {
  version: string | null
  api_version: string | null
  os: string | null
  arch: string | null
  cpus: number | null
  mem_bytes: number | null
  containers: number | null
  running: number | null
  images: number | null
}

export type DockerContainer = {
  id: string
  name: string
  image: string
  state: string
  status: string
  created_at: string | null
  ports: string[]
  managed: boolean
  /** 槽位与其出口共用：`kin-02`（slot）/ `kin-02-egress`（egress）。 */
  vm_id: string | null
  role: 'slot' | 'egress' | null
}

export type DockerContainerInput = {
  image: string
  name?: string
  ports?: string[]
  env?: string[]
  restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure'
}

export type DockerLogs = {
  tty: boolean
  lines: { stream: 'stdout' | 'stderr'; text: string }[]
}

/** `GET /api/panel/cluster/local`：控制面自身的网络形态与 NAT 观测。 */
export type ClusterLocalStatus = {
  checked_at: string
  control: {
    mode: 'process' | 'container'
    container: string | null
    network_mode: string | null
    listen_host: string | null
    listen_port: number | null
    loopback_only: boolean
  }
  nat: {
    public_ip: string | null
    observed_via: { id: string; label: string } | null
    local_ips: string[]
    behind_nat: boolean | null
    inbound: 'open' | 'closed' | 'loopback' | null
    note?: string
  }
  docker: {
    ok: boolean
    version: string | null
    running: number | null
    containers: number | null
    slots: number | null
    /** 本机在跑的槽容器此刻实际占的内存（KVM 含虚拟机已用内存）；任一读不到为 null。 */
    slots_mem?: number | null
    error: string | null
  }
  /** 控制面数据目录所在磁盘，口径同 df；旧服务端没有。 */
  disk?: {
    disk_total: number | null
    disk_used: number | null
    disk_pct: number | null
  }
  /** 本机 KVM 能力。面板非 admin 可能 403，调用方按未知处理。 */
  kvm?: {
    ok: boolean
    accel: 'kvm' | 'tcg' | null
    error: string | null
  }
}
