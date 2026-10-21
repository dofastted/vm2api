"""Exercise smoke-test ownership guards without accessing Kubernetes."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('vm2api_kubernetes_smoke', Path(__file__).with_name('smoke_kubernetes.py'))
smoke_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke_module)
OWNER_LABEL, Smoke = smoke_module.OWNER_LABEL, smoke_module.Smoke


class KubernetesSmokeOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.smoke = Smoke('synthetic-context', 'synthetic-image', None)

    def result(self, value):
        return subprocess.CompletedProcess([], 0, stdout=json.dumps(value), stderr='')

    def test_remote_context_is_rejected_before_creating_a_namespace(self):
        result = subprocess.CompletedProcess([], 0, stdout='https://remote.invalid:6443', stderr='')
        with patch.object(self.smoke, 'kubectl', return_value=result) as kubectl:
            with self.assertRaisesRegex(RuntimeError, 'local Kubernetes context'):
                self.smoke.create_namespace()
            self.assertEqual(kubectl.call_count, 1)
            self.assertIsNone(self.smoke.namespace_uid)

    def test_existing_namespace_is_never_reused(self):
        local = subprocess.CompletedProcess([], 0, stdout='https://127.0.0.1:6443', stderr='')
        with patch.object(self.smoke, 'kubectl', side_effect=[local, self.result({})]) as kubectl:
            with self.assertRaisesRegex(RuntimeError, 'refusing to reuse'):
                self.smoke.create_namespace()
            self.assertEqual(kubectl.call_count, 2)
            self.assertIsNone(self.smoke.namespace_uid)

    def test_changed_namespace_ownership_prevents_deletion(self):
        self.smoke.namespace_uid = 'created-uid'
        for uid, label in [('replacement-uid', self.smoke.run_id), ('created-uid', 'another-run')]:
            with self.subTest(uid=uid, label=label):
                resource = {'metadata': {'uid': uid, 'labels': {OWNER_LABEL: label}}}
                with patch.object(self.smoke, 'kubectl', return_value=self.result(resource)) as kubectl:
                    with self.assertRaisesRegex(RuntimeError, 'refusing cleanup'):
                        self.smoke.cleanup()
                    self.assertEqual(kubectl.call_count, 1)

    def test_cleanup_deletes_only_the_namespace_created_by_this_run(self):
        self.smoke.namespace_uid = 'created-uid'
        resource = {'metadata': {'uid': 'created-uid', 'labels': {OWNER_LABEL: self.smoke.run_id}}}
        with patch.object(self.smoke, 'kubectl', return_value=self.result(resource)) as kubectl:
            self.smoke.cleanup()
            self.assertEqual(kubectl.call_count, 3)
            deletion = kubectl.call_args_list[1]
            self.assertEqual(deletion.args,
                             ('delete', '--raw=/api/v1/namespaces/' + self.smoke.namespace, '-f', '-'))
            self.assertEqual(json.loads(deletion.kwargs['content'])['preconditions'], {'uid': 'created-uid'})
            self.assertFalse(deletion.kwargs['namespaced'])
            kubectl.assert_called_with('wait', '--for=delete', 'namespace/' + self.smoke.namespace,
                                       '--timeout=180s', namespaced=False, timeout=195)


if __name__ == '__main__':
    unittest.main()
