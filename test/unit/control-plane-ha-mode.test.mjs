import test from 'node:test'
import assert from 'node:assert/strict'
import * as mode from '../../src/lib/core/control-plane-mode.mjs'

test('HA is an explicit Kubernetes mode; existing standalone and singleton modes remain distinct', () => {
  const ha = { VM2API_CONTROL_PLANE_MODE: 'kubernetes-ha' }
  assert.equal(mode.controlPlaneMode(ha), 'kubernetes-ha')
  assert.equal(mode.isKubernetesMode(ha), true)
  assert.equal(mode.isKubernetesHaMode(ha), true)
  assert.equal(mode.isKubernetesHaMode({ VM2API_CONTROL_PLANE_MODE: 'kubernetes' }), false)
  assert.equal(mode.isKubernetesHaMode({}), false)
  assert.equal(mode.isKubernetesMode({}), false)
  assert.throws(() => mode.controlPlaneMode({ VM2API_CONTROL_PLANE_MODE: 'ha' }), /CONTROL_PLANE_MODE/)
})
