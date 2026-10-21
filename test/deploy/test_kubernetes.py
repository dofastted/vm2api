"""Check Kubernetes isolation and execute the entrypoint without running a server."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]


class KubernetesDeploymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rendered = subprocess.check_output(['kubectl', 'kustomize', str(ROOT / 'deploy/k8s')], text=True)
        cls.resources = list(yaml.safe_load_all(rendered))
        cls.deployment = next(item for item in cls.resources if item['kind'] == 'Deployment')
        cls.config = next(item for item in cls.resources if item['kind'] == 'ConfigMap')['data']

    def test_single_active_control_plane_has_no_host_or_kubernetes_api_access(self):
        self.assertEqual(self.deployment['spec']['replicas'], 1)
        self.assertEqual(self.deployment['spec']['strategy'], {'type': 'Recreate'})
        self.assertEqual(self.config['VM2API_CONTROL_PLANE_MODE'], 'kubernetes')
        pod = self.deployment['spec']['template']['spec']
        self.assertFalse(pod['automountServiceAccountToken'])
        self.assertFalse(pod.get('hostNetwork', False))
        self.assertTrue(pod['securityContext']['runAsNonRoot'])
        for volume in pod['volumes']:
            self.assertNotIn('hostPath', volume)
        for container in pod['containers'] + pod['initContainers']:
            self.assertFalse(container['securityContext'].get('privileged', False))
            self.assertFalse(container['securityContext']['allowPrivilegeEscalation'])
            self.assertEqual(container['securityContext']['capabilities'], {'drop': ['ALL']})
        self.assertFalse({'Secret', 'Role', 'ClusterRole', 'HorizontalPodAutoscaler'} &
                         {item['kind'] for item in self.resources})

    def test_runtime_sockets_and_image_helpers_are_pod_local(self):
        pod = self.deployment['spec']['template']['spec']
        volumes = {item['name']: item for item in pod['volumes']}
        mounts = {item['mountPath']: item for item in pod['containers'][0]['volumeMounts']}
        for directory in ('data/run', 'bin', 'share'):
            self.assertIn('emptyDir', volumes[mounts['/opt/vm2api/' + directory]['name']])
        self.assertTrue(self.config['VM2API_CLUSTER_SOCKET_DIR'].startswith('/opt/vm2api/data/run/'))
        pvc = next(item for item in self.resources if item['kind'] == 'PersistentVolumeClaim')
        self.assertEqual(pvc['spec']['accessModes'], ['ReadWriteOnce'])

    def test_readiness_and_shutdown_contract_and_required_secret_references(self):
        pod = self.deployment['spec']['template']['spec']
        container = pod['containers'][0]
        self.assertEqual(container['startupProbe']['httpGet']['path'], '/readyz')
        self.assertEqual(container['readinessProbe']['httpGet']['path'], '/readyz')
        self.assertEqual(container['livenessProbe']['httpGet']['path'], '/healthz')
        self.assertGreater(pod['terminationGracePeriodSeconds'] * 1000,
                           int(self.config['VM2API_SHUTDOWN_TIMEOUT_MS']))
        for item in container['env']:
            reference = item['valueFrom']['secretKeyRef']
            self.assertEqual(reference['name'], 'vm2api-secrets')
            self.assertEqual(reference['key'], item['name'])
            self.assertFalse(reference.get('optional', False))
        self.assertEqual({item['name'] for item in container['env']}, {
            'VM2API_DATABASE_URL', 'VM2API_ADMIN_PASSWORD', 'VM2API_API_KEY', 'VM2API_DB_SECRET',
        })

    def test_kubernetes_entrypoint_skips_host_docker_even_when_a_socket_exists(self):
        for mode in ('standalone', 'kubernetes'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='vm2api-entrypoint-') as directory:
                root = Path(directory)
                for name in ('image-bin', 'docker/kin-os', 'src', 'commands'):
                    (root / name).mkdir(parents=True, exist_ok=True)
                for name in ('kin-kernel', 'kin-api-kernel'):
                    (root / 'image-bin' / name).write_text('#!/bin/sh\nexit 0\n')
                (root / 'docker/kin-os/build.mjs').touch()
                node = root / 'commands/node'
                node.write_text('#!/usr/bin/env python3\nimport json,os,sys\n'
                                'with open(os.environ["TEST_NODE_LOG"],"a") as f:f.write(json.dumps(sys.argv[1:])+"\\n")\n')
                node.chmod(0o755)
                script = root / 'entrypoint.sh'
                script.write_text((ROOT / 'scripts/docker-entrypoint.sh').read_text()
                                  .replace('/opt/vm2api', str(root))
                                  .replace('/var/run/docker.sock', str(root / 'docker.sock')))
                env = {**os.environ, 'PATH': str(root / 'commands') + ':' + os.environ['PATH'],
                       'KIN_PROJECT_ROOT': str(root), 'VM2API_CONTROL_PLANE_MODE': mode,
                       'VM2API_DATABASE_URL': 'postgresql://synthetic.invalid/test',
                       'VM2API_ADMIN_USER': 'admin', 'VM2API_ADMIN_PASSWORD': 'synthetic-password',
                       'VM2API_API_KEY': 'synthetic-key', 'VM2API_DB_SECRET': 'synthetic-secret',
                       'KIN_AUTO_SYNC_WRAP': '0', 'TEST_NODE_LOG': str(root / 'node.log')}
                for key in ('KIN_KERNEL_BIN', 'KIN_API_KERNEL_BIN'):
                    env.pop(key, None)
                with socket.socket(socket.AF_UNIX) as daemon:
                    daemon.bind(str(root / 'docker.sock'))
                    result = subprocess.run(['sh', str(script)], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = [json.loads(line) for line in (root / 'node.log').read_text().splitlines()]
                self.assertEqual(any('--pull-only' in call for call in calls), mode == 'standalone')
                self.assertEqual(calls[-1], ['src/server.mjs'])
                self.assertNotIn('docker.sock not mounted', result.stderr)


if __name__ == '__main__':
    unittest.main()
