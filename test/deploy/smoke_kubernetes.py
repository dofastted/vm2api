#!/usr/bin/env python3
"""Run a candidate image only in a newly created, owned local Kubernetes namespace."""
import argparse
import copy
from http.cookiejar import CookieJar
import json
from pathlib import Path
import re
import secrets
import selectors
import subprocess
import time
from urllib.parse import urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen
import uuid

import yaml


ROOT = Path(__file__).resolve().parents[2]
PREFIX = 'vm2api-k8s-649-'
OWNER_LABEL = 'vm2api.test/run'
MODEL = 'claude-haiku-4-5-20251001'
UPSTREAM_KEY = 'synthetic-kubernetes-upstream-key'
UPSTREAM = r'''
const http=require('node:http');
const proof=process.env.SMOKE_PROOF;
http.createServer(async(req,res)=>{
  if(req.url==='/readyz'){res.end('ok');return}
  if(!req.url.startsWith('/v1/messages')||req.headers['x-api-key']!=='synthetic-kubernetes-upstream-key'){
    res.writeHead(403);res.end();return;
  }
  let body='';for await(const chunk of req)body+=chunk;
  const input=JSON.parse(body);
  const message={id:'msg_kubernetes_smoke',type:'message',role:'assistant',model:input.model,
    content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:11,output_tokens:0}};
  if(!input.stream){
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({...message,content:[{type:'text',text:proof}],stop_reason:'end_turn',
      usage:{input_tokens:11,output_tokens:3}}));return;
  }
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  event('message_start',{message});
  event('content_block_start',{index:0,content_block:{type:'text',text:''}});
  setTimeout(()=>{
    event('content_block_delta',{index:0,delta:{type:'text_delta',text:proof}});
    event('content_block_stop',{index:0});
    event('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}});
    event('message_stop',{});res.end();
  },1000);
}).listen(8080,'0.0.0.0');
'''


class Smoke:
    def __init__(self, context, image, storage_class):
        self.context = context
        self.image = image
        self.storage_class = storage_class
        self.run_id = uuid.uuid4().hex
        self.namespace = PREFIX + self.run_id[:10]
        self.namespace_uid = None
        self.forward = None
        self.checks = []
        self.client = build_opener(HTTPCookieProcessor(CookieJar()))
        self.proof = 'kubernetes-proof-' + self.run_id[:12]

    def kubectl(self, *args, namespaced=True, content=None, check=True, timeout=240):
        command = ['kubectl', '--context', self.context]
        if namespaced:
            command += ['--namespace', self.namespace]
        result = subprocess.run(command + list(args), input=content, text=True,
                                capture_output=True, timeout=timeout)
        if check and result.returncode:
            # kubectl validation errors can include submitted Secret objects.
            raise RuntimeError(f'kubectl {args[0]} failed (exit {result.returncode})')
        return result

    def apply(self, *resources):
        self.kubectl('apply', '-f', '-', content=json.dumps({'apiVersion': 'v1', 'kind': 'List',
                                                          'items': resources}))

    def create_namespace(self):
        endpoint = self.kubectl('config', 'view', '--minify', '-o',
                                'jsonpath={.clusters[0].cluster.server}', namespaced=False).stdout
        if urlparse(endpoint).hostname not in ('127.0.0.1', 'localhost', '::1'):
            raise RuntimeError('smoke test requires an explicit local Kubernetes context')
        existing = self.kubectl('get', 'namespace', self.namespace, '-o', 'json',
                                namespaced=False, check=False)
        if existing.returncode == 0:
            raise RuntimeError('test namespace already exists; refusing to reuse it')
        resource = {'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {
            'name': self.namespace, 'labels': {OWNER_LABEL: self.run_id}}}
        created = self.kubectl('create', '-f', '-', '-o', 'json', namespaced=False,
                               content=json.dumps(resource))
        self.namespace_uid = json.loads(created.stdout)['metadata']['uid']
        self.apply({'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy',
                    'metadata': {'name': 'test-egress'}, 'spec': {'podSelector': {}, 'policyTypes': ['Egress'],
                        'egress': [{'to': [{'podSelector': {}}]},
                                   {'to': [{'namespaceSelector': {'matchLabels': {
                                       'kubernetes.io/metadata.name': 'kube-system'}}}],
                                    'ports': [{'protocol': 'UDP', 'port': 53}, {'protocol': 'TCP', 'port': 53}]}]}})

    def postgres(self, password, application_secret):
        self.apply(application_secret,
                   {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'postgres-init'},
                    'data': {'entrypoint.sh': (ROOT / 'deploy/postgres-entrypoint.sh').read_text(),
                             'init.sh': (ROOT / 'deploy/postgres-init.sh').read_text()}},
                   {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'postgres-password'},
                    'stringData': {'password': password}},
                   {'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'postgres'},
                    'spec': {'selector': {'app': 'postgres'}, 'ports': [{'port': 5432}]}},
                   {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'postgres'},
                    'spec': {'replicas': 1, 'selector': {'matchLabels': {'app': 'postgres'}},
                             'template': {'metadata': {'labels': {'app': 'postgres'}}, 'spec': {
                                 'automountServiceAccountToken': False,
                                 'securityContext': {'runAsUser': 999, 'runAsGroup': 999,
                                                     'runAsNonRoot': True, 'fsGroup': 999,
                                                     'seccompProfile': {'type': 'RuntimeDefault'}},
                                 'containers': [{'name': 'postgres', 'image': 'postgres:17-bookworm',
                                     'command': ['/bin/bash', '/scripts/entrypoint.sh', 'postgres'],
                                     'env': [{'name': 'POSTGRES_USER', 'value': 'postgres'},
                                             {'name': 'POSTGRES_DB', 'value': 'postgres'},
                                             {'name': 'POSTGRES_INITDB_ARGS', 'value': '--auth-host=scram-sha-256'},
                                             {'name': 'PGDATA', 'value': '/var/lib/postgresql/data/pgdata'},
                                             {'name': 'VM2API_POSTGRES_PASSWORD', 'valueFrom': {
                                                 'secretKeyRef': {'name': 'postgres-password', 'key': 'password'}}}],
                                     'securityContext': {'allowPrivilegeEscalation': False,
                                                         'capabilities': {'drop': ['ALL']}},
                                     'readinessProbe': {'exec': {'command': ['bash', '-ec',
                                         'PGPASSWORD="$VM2API_POSTGRES_PASSWORD" psql -h 127.0.0.1 '
                                         '-U vm2api -d vm2api -Atqc "SELECT 1" >/dev/null']}, 'periodSeconds': 2},
                                     'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/postgresql/data'},
                                                      {'name': 'scripts', 'mountPath': '/scripts'},
                                                      {'name': 'scripts', 'mountPath': '/docker-entrypoint-initdb.d/10-vm2api.sh',
                                                       'subPath': 'init.sh'}]}],
                                 'volumes': [{'name': 'data', 'emptyDir': {}},
                                             {'name': 'scripts', 'configMap': {'name': 'postgres-init'}}]}}}})
        self.kubectl('rollout', 'status', 'deployment/postgres', '--timeout=120s')

    def deploy(self):
        rendered = subprocess.check_output(['kubectl', 'kustomize', str(ROOT / 'deploy/k8s')], text=True)
        resources = list(yaml.safe_load_all(rendered))
        deployment = next(item for item in resources if item['kind'] == 'Deployment')
        pod = deployment['spec']['template']['spec']
        # Automatic public price-catalog refresh stays on loopback in this fixture.
        pod['hostAliases'] = [{'ip': '127.0.0.1', 'hostnames': ['models.dev']}]
        for container in pod['containers'] + pod['initContainers']:
            container['image'] = self.image
            container['imagePullPolicy'] = 'IfNotPresent'
        pvc = next(item for item in resources if item['kind'] == 'PersistentVolumeClaim')
        pvc['spec']['resources']['requests']['storage'] = '1Gi'
        if self.storage_class:
            pvc['spec']['storageClassName'] = self.storage_class
        config = next(item for item in resources if item['kind'] == 'ConfigMap')
        config['data']['KIN_BACKUP_DISABLED'] = '1'
        self.apply(*resources)
        self.kubectl('rollout', 'status', 'deployment/vm2api', '--timeout=240s', timeout=255)
        self.checks.append('pod-ready')
        self.kubectl('exec', 'deployment/vm2api', '-c', 'control-plane', '--', 'node', '--input-type=module', '-e',
                     "const r=await fetch('http://vm2api:8787/readyz');if(r.status!==200)process.exit(1)")
        self.checks.append('service-dns-and-clusterip')
        return pod

    def upstream(self):
        self.apply({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'synthetic-upstream'},
                    'data': {'server.cjs': UPSTREAM}},
                   {'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'synthetic-upstream'},
                    'spec': {'selector': {'app': 'synthetic-upstream'}, 'ports': [{'port': 8080}]}},
                   {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'synthetic-upstream'},
                    'spec': {'replicas': 1, 'selector': {'matchLabels': {'app': 'synthetic-upstream'}},
                             'template': {'metadata': {'labels': {'app': 'synthetic-upstream'}}, 'spec': {
                                 'automountServiceAccountToken': False,
                                 'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000,
                                                     'seccompProfile': {'type': 'RuntimeDefault'}},
                                 'containers': [{'name': 'upstream', 'image': self.image,
                                     'imagePullPolicy': 'IfNotPresent',
                                     'command': ['node', '/fixture/server.cjs'],
                                     'env': [{'name': 'SMOKE_PROOF', 'value': self.proof}],
                                     'securityContext': {'allowPrivilegeEscalation': False,
                                                         'capabilities': {'drop': ['ALL']}},
                                     'readinessProbe': {'httpGet': {'path': '/readyz', 'port': 8080}},
                                     'volumeMounts': [{'name': 'fixture', 'mountPath': '/fixture'}]}],
                                 'volumes': [{'name': 'fixture', 'configMap': {'name': 'synthetic-upstream'}}]}}}})
        self.kubectl('rollout', 'status', 'deployment/synthetic-upstream', '--timeout=120s')

    def start_forward(self):
        self.stop_forward()
        self.forward = subprocess.Popen(['kubectl', '--context', self.context, '-n', self.namespace,
                                         'port-forward', 'service/vm2api', ':8787', '--address=127.0.0.1'],
                                        text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        with selectors.DefaultSelector() as selector:
            selector.register(self.forward.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if selector.select(timeout=0.5):
                    line = self.forward.stdout.readline()
                    match = re.search(r'Forwarding from 127\.0\.0\.1:(\d+)', line)
                    if match:
                        self.base_url = 'http://127.0.0.1:' + match[1]
                        return
                if self.forward.poll() is not None:
                    break
        raise RuntimeError('service port-forward did not become ready')

    def request(self, path, body=None, token=None, use_cookie=True):
        headers = {'content-type': 'application/json'}
        if token:
            headers['authorization'] = 'Bearer ' + token
        request = Request(self.base_url + path, headers=headers,
                          data=None if body is None else json.dumps(body).encode())
        with (self.client.open if use_cookie else urlopen)(request, timeout=15) as response:
            assert response.status == 200 or response.status == 201, 'unexpected HTTP status'
            content = response.read()
            return json.loads(content) if 'application/json' in response.headers.get('content-type', '') else content

    def inference(self, managed_key):
        self.request('/api/panel/api-endpoints', {
            'name': 'kubernetes-synthetic-upstream', 'kind': 'custom', 'protocol': 'anthropic',
            'base_url': 'http://synthetic-upstream:8080', 'api_key_entries': [{'api_key': UPSTREAM_KEY}],
            'models': [{'name': MODEL}],
        })
        body = {'model': MODEL, 'max_tokens': 32, 'messages': [{'role': 'user', 'content': self.proof}]}
        for stream in (False, True):
            headers = {'authorization': 'Bearer ' + managed_key, 'content-type': 'application/json',
                       'x-request-id': self.proof + ('-stream' if stream else '-plain')}
            request = Request(self.base_url + '/v1/messages', headers=headers,
                              data=json.dumps({**body, 'stream': stream}).encode())
            with urlopen(request, timeout=15) as response:
                assert response.status == 200, 'inference did not succeed'
                if stream:
                    assert 'text/event-stream' in response.headers.get('content-type', ''), 'SSE response required'
                    first = response.readline()
                    first_at = time.monotonic()
                    content = first + response.read()
                    assert time.monotonic() - first_at >= 0.5, 'SSE frames were buffered until completion'
                    assert b'message_stop' in content, 'SSE stream did not finish'
                    assert self.proof.encode() in content, 'SSE response did not come from the synthetic upstream'
                else:
                    content = json.loads(response.read())
                    assert any(item.get('text') == self.proof for item in content['content']), 'upstream proof missing'
        logs = self.request('/api/panel/request-logs?q=' + self.proof + '&limit=10')['items']
        assert len(logs) == 2 and all(item['status'] == 200 for item in logs), 'two successful request logs required'
        self.checks += ['managed-api-key-inference', 'go-api-kernel-json-and-sse', 'two-request-logs']

    def duplicate(self, pod):
        other = copy.deepcopy(pod)
        other['restartPolicy'] = 'Never'
        for index, volume in enumerate(other['volumes']):
            if volume['name'] == 'state':
                other['volumes'][index] = {'name': 'state', 'emptyDir': {}}
        self.apply({'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'contender'}, 'spec': other})
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            status = json.loads(self.kubectl('get', 'pod', 'contender', '-o', 'json').stdout)['status']
            containers = status.get('containerStatuses', [])
            terminated = containers and containers[0]['state'].get('terminated')
            if terminated:
                assert terminated['exitCode'] != 0, 'second control plane was allowed to start'
                logs = self.kubectl('logs', 'contender', '-c', 'control-plane').stdout
                assert 'control_plane_already_active' in logs, 'contender did not fail for the exclusive lock'
                self.request('/readyz')
                self.kubectl('delete', 'pod', 'contender', '--wait=true', '--timeout=30s')
                self.checks.append('second-control-plane-rejected')
                return
            time.sleep(0.5)
        raise RuntimeError('second control plane did not terminate within the startup deadline')

    def restart(self, managed_key, marker):
        self.stop_forward()
        self.kubectl('rollout', 'restart', 'deployment/vm2api')
        self.kubectl('rollout', 'status', 'deployment/vm2api', '--timeout=240s', timeout=255)
        self.start_forward()
        self.request('/readyz')
        keys = self.request('/api/panel/api-keys')
        assert any(item['name'] == marker for item in keys['keys']), 'database or panel session did not persist'
        models = self.request('/v1/models', token=managed_key, use_cookie=False)
        assert any(item['id'] == MODEL for item in models['data']), 'managed API key or endpoint did not persist'
        self.kubectl('exec', 'deployment/vm2api', '-c', 'control-plane', '--', 'node', '-e',
                     "if(require('node:fs').readFileSync('/opt/vm2api/data/kubernetes-smoke.txt','utf8')!==process.argv[1])process.exit(1)", marker)
        self.checks += ['recreate-restart', 'postgres-session-and-api-key-persist', 'pvc-persists']

    def stop_forward(self):
        if self.forward is not None:
            self.forward.terminate()
            try:
                self.forward.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.forward.kill()
                self.forward.wait(timeout=5)
            self.forward.stdout.close()
            self.forward = None

    def cleanup(self):
        self.stop_forward()
        if self.namespace_uid is None:
            return
        metadata = json.loads(self.kubectl('get', 'namespace', self.namespace, '-o', 'json',
                                          namespaced=False).stdout)['metadata']
        if (not self.namespace.startswith(PREFIX) or metadata['uid'] != self.namespace_uid or
                metadata.get('labels', {}).get(OWNER_LABEL) != self.run_id):
            raise RuntimeError('namespace ownership changed; refusing cleanup')
        options = {'apiVersion': 'v1', 'kind': 'DeleteOptions',
                   'preconditions': {'uid': self.namespace_uid}}
        self.kubectl('delete', '--raw=/api/v1/namespaces/' + self.namespace, '-f', '-',
                     namespaced=False, content=json.dumps(options))
        self.kubectl('wait', '--for=delete', 'namespace/' + self.namespace, '--timeout=180s',
                     namespaced=False, timeout=195)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', required=True)
    parser.add_argument('--image', required=True, help='candidate image available to the local cluster')
    parser.add_argument('--storage-class', help='otherwise use the cluster default RWO storage class')
    args = parser.parse_args()
    smoke = Smoke(args.context, args.image, args.storage_class)
    password = secrets.token_hex(32)
    admin_password = secrets.token_hex(24)
    application_secret = {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'vm2api-secrets'},
                          'stringData': {'VM2API_DATABASE_URL': f'postgresql://vm2api:{password}@postgres:5432/vm2api',
                                         'VM2API_ADMIN_PASSWORD': admin_password,
                                         'VM2API_API_KEY': secrets.token_hex(32),
                                         'VM2API_DB_SECRET': secrets.token_hex(32)}}
    try:
        smoke.create_namespace()
        smoke.postgres(password, application_secret)
        pod = smoke.deploy()
        smoke.upstream()
        smoke.start_forward()
        smoke.request('/healthz')
        smoke.request('/readyz')
        smoke.request('/console')
        smoke.request('/api/panel/login', {'username': 'admin', 'password': admin_password})
        metrics = smoke.request('/api/panel/database/metrics')['data']['database']
        assert metrics['ok'] and metrics['engine'] == 'postgresql', 'PostgreSQL metrics required'
        marker = 'kubernetes-smoke-' + smoke.run_id[:10]
        managed_key = smoke.request('/api/panel/api-keys', {'name': marker, 'category': 'api'})['item']['key']
        smoke.kubectl('exec', 'deployment/vm2api', '-c', 'control-plane', '--', 'node', '-e',
                      "require('node:fs').writeFileSync('/opt/vm2api/data/kubernetes-smoke.txt',process.argv[1])", marker)
        smoke.checks += ['health-ready-console', 'panel-cookie-login-and-postgres-metrics', 'api-key-create']
        smoke.inference(managed_key)
        smoke.duplicate(pod)
        smoke.restart(managed_key, marker)
        pods = json.loads(smoke.kubectl('get', 'pods', '-l', 'app.kubernetes.io/name=vm2api', '-o', 'json').stdout)
        image_id = pods['items'][0]['status']['containerStatuses'][0]['imageID']
        result = {'ok': True, 'namespace': smoke.namespace, 'image_id': image_id,
                  'proof': smoke.proof, 'checks': smoke.checks}
    finally:
        smoke.cleanup()
    print(json.dumps(result))


if __name__ == '__main__':
    main()
