import { describe, expect, it } from 'vitest'
import {
  createMachinePayload,
  kvmAvailabilityFromCheck,
  kvmAvailabilityFromLocal,
  kvmAvailabilityFromPreflight,
  normalizeVmConfig,
  runtimeTypeLabel,
  runtimeTypeOf,
  validateVmConfigPatch,
  VM_CONFIG_DEFAULTS,
  vmConfigFieldErrors,
} from './machine-spec'

describe('normalizeVmConfig', () => {
  it('fills defaults for empty input', () => {
    expect(normalizeVmConfig(undefined)).toEqual(VM_CONFIG_DEFAULTS)
    expect(normalizeVmConfig(null)).toEqual(VM_CONFIG_DEFAULTS)
    expect(normalizeVmConfig({})).toMatchObject({
      default_runtime: 'docker',
      memory: '512m',
      vcpus: 2,
      disk_gb: 20,
      cpu_model: 'host',
      mac_oui: '52:54:00',
      allow_tcg: false,
    })
  })

  it('keeps legal values and resets illegal ones', () => {
    expect(
      normalizeVmConfig({
        default_runtime: 'kvm',
        memory: '4g',
        vcpus: 8,
        disk_gb: 40,
        cpu_model: 'qemu64',
        mac_oui: '52:54:00',
        allow_tcg: true,
        smbios: {
          manufacturer: 'QEMU',
          product: 'KVM',
          version: '2',
          family: 'PC',
        },
      })
    ).toMatchObject({
      default_runtime: 'kvm',
      memory: '4g',
      vcpus: 8,
      disk_gb: 40,
      cpu_model: 'qemu64',
      allow_tcg: true,
      smbios: {
        manufacturer: 'QEMU',
        product: 'KVM',
        version: '2',
        family: 'PC',
      },
    })
    expect(
      normalizeVmConfig({
        default_runtime: 'xen',
        memory: '3g',
        vcpus: 0,
        disk_gb: 9,
        cpu_model: 'pentium',
      })
    ).toMatchObject({
      default_runtime: 'docker',
      memory: '512m',
      vcpus: 2,
      disk_gb: 20,
      cpu_model: 'host',
    })
  })
})

describe('vmConfigFieldErrors / validateVmConfigPatch', () => {
  it('accepts a complete legal patch', () => {
    expect(validateVmConfigPatch(VM_CONFIG_DEFAULTS)).toEqual({ ok: true })
    expect(vmConfigFieldErrors(VM_CONFIG_DEFAULTS)).toEqual({})
  })

  it('rejects MAC, ranges and enums', () => {
    expect(vmConfigFieldErrors({ mac_oui: '525400' }).mac_oui).toMatch(
      /xx:xx:xx/
    )
    expect(vmConfigFieldErrors({ mac_oui: '52:54:00' })).toEqual({})
    expect(vmConfigFieldErrors({ vcpus: 0 }).vcpus).toMatch(/1–16/)
    expect(vmConfigFieldErrors({ vcpus: 16 })).toEqual({})
    expect(vmConfigFieldErrors({ disk_gb: 9 }).disk_gb).toMatch(/10–200/)
    expect(vmConfigFieldErrors({ disk_gb: 200 })).toEqual({})
    expect(vmConfigFieldErrors({ memory: '3g' }).memory).toMatch(/256m/)
    expect(
      vmConfigFieldErrors({ default_runtime: 'xen' }).default_runtime
    ).toBeTruthy()
    expect(validateVmConfigPatch({ mac_oui: 'zz:zz:zz' })).toMatchObject({
      ok: false,
      field: 'mac_oui',
    })
  })
})

describe('createMachinePayload', () => {
  it('always sends memory and only adds kvm fields for kvm', () => {
    expect(
      createMachinePayload({
        runtimeType: 'docker',
        memory: '2g',
        vcpus: 8,
        diskGb: 40,
      })
    ).toEqual({
      runtime_type: 'docker',
      machine: { memory: '2g' },
    })
    expect(
      createMachinePayload({
        runtimeType: 'kvm',
        memory: '4g',
        vcpus: 4,
        diskGb: 30,
      })
    ).toEqual({
      runtime_type: 'kvm',
      machine: { memory: '4g', vcpus: 4, disk_gb: 30 },
    })
  })

  it('falls back to default memory when the select value is unknown', () => {
    expect(
      createMachinePayload({
        runtimeType: 'docker',
        memory: '3g',
        vcpus: 2,
        diskGb: 20,
      }).machine.memory
    ).toBe('512m')
  })
})

describe('runtimeType helpers', () => {
  it('treats missing runtime_type as docker', () => {
    expect(runtimeTypeOf({})).toBe('docker')
    expect(runtimeTypeOf({ runtime_type: 'kvm' })).toBe('kvm')
    expect(runtimeTypeLabel('docker')).toBe('容器')
    expect(runtimeTypeLabel('kvm')).toBe('KVM')
  })
})

describe('kvm availability', () => {
  it('maps create-options probe accel and errors', () => {
    expect(
      kvmAvailabilityFromLocal({
        fetching: false,
        error: null,
        kvm: { ok: true, accel: 'tcg', error: null },
      })
    ).toEqual({ status: 'ok', accel: 'tcg' })
    expect(
      kvmAvailabilityFromLocal({
        fetching: false,
        error: null,
        kvm: { ok: false, accel: null, error: '宿主无 /dev/kvm' },
      })
    ).toEqual({ status: 'disabled', reason: '宿主无 /dev/kvm' })
    expect(
      kvmAvailabilityFromLocal({
        fetching: true,
        error: null,
      }).status
    ).toBe('loading')
    expect(
      kvmAvailabilityFromLocal({
        fetching: false,
        error: new Error('网络错误'),
      })
    ).toEqual({ status: 'unknown', reason: '网络错误' })
  })

  it('maps node preflight kvm check warn vs error', () => {
    expect(kvmAvailabilityFromCheck(undefined)).toEqual({
      status: 'ok',
      accel: null,
    })
    expect(
      kvmAvailabilityFromCheck({
        id: 'kvm',
        ok: false,
        level: 'warn',
        message: '无 /dev/kvm，将使用 TCG',
      })
    ).toEqual({ status: 'ok', accel: 'tcg' })
    expect(
      kvmAvailabilityFromCheck({
        id: 'kvm',
        ok: false,
        level: 'error',
        message: '宿主无 /dev/kvm',
      })
    ).toEqual({ status: 'disabled', reason: '宿主无 /dev/kvm' })
    expect(
      kvmAvailabilityFromPreflight({
        fetching: true,
        error: null,
      }).status
    ).toBe('loading')
  })
})
