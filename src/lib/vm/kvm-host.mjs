/**
 * Local KVM capability probe. Cached 60s per allow_tcg so the cluster page
 * and create form can poll without spawning a device-probe container each time.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import {
  containerAction,
  createContainerRaw,
  dockerJson,
  inspectContainerOrNull,
  localDocker,
  removeContainer,
} from '../cluster/docker-remote.mjs'
import { DOCKER_SOCK } from './host-path.mjs'
import { normalizeVmConfig } from './machine-spec.mjs'

const CACHE_MS = 60_000
const cache = new Map()

export function resetKvmProbeCache() {
  cache.clear()
}

function kvmUnavailable(error) {
  return { ok: false, accel: null, error }
}

function kvmReady(accel) {
  return { ok: true, accel, error: null }
}

function allowTcgOf(routing) {
  return normalizeVmConfig(routing?.vm).allow_tcg === true
}

function runningInContainer({ existsSync = fs.existsSync } = {}) {
  // Same signal as local-status controlPlane: a control-plane process on the
  // host has no /.dockerenv even when docker.sock is mounted for sibling slots.
  return existsSync('/.dockerenv')
}

function accessHostKvm({ accessSync = fs.accessSync } = {}) {
  accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK)
}

async function selfImage(docker, { names } = {}) {
  const candidates = [
    ...(names || []),
    String(process.env.VM2API_CONTAINER_NAME || '').trim(),
    os.hostname(),
    'vm2api',
  ].filter(Boolean)
  const seen = new Set()
  for (const name of candidates) {
    if (seen.has(name)) continue
    seen.add(name)
    const inspect = await inspectContainerOrNull(docker, name)
    const image = inspect?.Config?.Image || inspect?.Image
    if (image) return String(image)
  }
  return null
}

async function probeKvmViaDeviceContainer(docker, image) {
  const name = `kin-kvm-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  let id = null
  try {
    id = await createContainerRaw(docker, name, {
      Image: image,
      Entrypoint: ['/bin/true'],
      Cmd: [],
      NetworkDisabled: true,
      HostConfig: {
        AutoRemove: false,
        Privileged: false,
        Devices: [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' }],
      },
    })
    await containerAction(docker, id, 'start')
    const wait = await dockerJson(docker, { method: 'POST', path: `/containers/${id}/wait`, timeoutMs: 20_000 }, [200])
    return Number(wait?.StatusCode) === 0
  } finally {
    if (id) await removeContainer(docker, id).catch(() => {})
  }
}

async function runProbe({ routing, docker, inContainer, accessKvm, probeContainer, resolveImage, sockPath }) {
  const allowTcg = allowTcgOf(routing)
  const tcgFallback = () => (allowTcg ? kvmReady('tcg') : kvmUnavailable('本机没有可用的 /dev/kvm'))
  const nested = inContainer ?? runningInContainer()
  if (!nested) {
    try {
      ;(accessKvm || accessHostKvm)()
      return kvmReady('kvm')
    } catch {
      return tcgFallback()
    }
  }
  const sock = sockPath || DOCKER_SOCK
  if (!fs.existsSync(sock)) {
    return allowTcg ? kvmReady('tcg') : kvmUnavailable('控制面容器无法访问 Docker，无法探测 /dev/kvm')
  }
  const connect = docker || localDocker(sock)
  let image = null
  try {
    image = resolveImage ? await resolveImage(connect) : await selfImage(connect)
  } catch (err) {
    return allowTcg ? kvmReady('tcg') : kvmUnavailable(`无法读取控制面镜像：${err.message}`)
  }
  if (!image) {
    return allowTcg ? kvmReady('tcg') : kvmUnavailable('无法确定控制面镜像，无法探测 /dev/kvm')
  }
  try {
    const ok = probeContainer ? await probeContainer(connect, image) : await probeKvmViaDeviceContainer(connect, image)
    if (ok) return kvmReady('kvm')
  } catch (err) {
    return allowTcg ? kvmReady('tcg') : kvmUnavailable(err?.message || '控制面容器无法访问 /dev/kvm')
  }
  return tcgFallback()
}

/**
 * @param {{ routing?: object, force?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, accel: 'kvm'|'tcg'|null, error: string|null }>}
 */
export async function probeLocalKvm(opts = {}) {
  const { routing, force = false, now = Date.now } = opts
  const key = allowTcgOf(routing) ? '1' : '0'
  const at = typeof now === 'function' ? now() : now
  if (!force) {
    const hit = cache.get(key)
    if (hit && at - hit.at < CACHE_MS) return hit.value
  }
  const value = await runProbe(opts)
  cache.set(key, { at, value })
  return value
}
