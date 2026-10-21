import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function realAllocationGate(t, management) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ag2-'))
  const worker = path.join(root,'worker')
  fs.cpSync(fileURLToPath(new URL('../../worker',import.meta.url)),worker,{recursive:true})
  const cmd = path.join(worker,'cmd','allocation-fixture')
  fs.mkdirSync(cmd,{recursive:true})
  fs.copyFileSync(fileURLToPath(new URL('./slotgate-allocation-node.go',import.meta.url)),path.join(cmd,'main.go'))
  const binary = path.join(root,'gate')
  let child
  let exited
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      if (child && child.exitCode == null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'),3000)
        try { await exited } finally { clearTimeout(timer) }
      }
    } finally { fs.rmSync(root,{recursive:true,force:true}) }
  }
  t.after(close)
  try {
    execFileSync('go',['build','-buildvcs=false','-o',binary,'./cmd/allocation-fixture'],{
      cwd:worker,env:{...process.env,GOCACHE:'/tmp/vm2api-648-go-cache',GOPROXY:'off'},stdio:'pipe',timeout:60000,
    })
    const runtime = path.join(root,'runtime')
    fs.mkdirSync(runtime,{mode:0o700})
    const configFile = path.join(root,'config.json')
    fs.writeFileSync(configFile,JSON.stringify({listen:'127.0.0.1:0',root:runtime,token:'synthetic-node-allocation-token-000000',tls_dir:path.join(root,'tls'),
      fenced:true,authority_dir:path.join(root,'authority'),docker_socket:path.join(root,'never-opened.sock'),management}),{mode:0o600})
    child = spawn(binary,[configFile],{stdio:['ignore','pipe','pipe']})
    exited = once(child,'exit')
    const link = await new Promise((resolve,reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('synthetic allocation fixture startup timeout')),5000)
      child.once('error',(error) => {clearTimeout(timer);reject(error)})
      child.once('exit',(code) => {clearTimeout(timer);if(code)reject(new Error(`synthetic allocation fixture exit ${code}`))})
      child.stderr.resume()
      child.stdout.on('data',(chunk) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        clearTimeout(timer)
        try {resolve(JSON.parse(buffer.slice(0,newline)))} catch(error){reject(error)}
      })
    })
    return {link,root,close}
  } catch(error) {await close();throw error}
}
