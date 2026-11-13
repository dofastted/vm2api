import http from 'node:http'

function request({ socketPath, capability, method, path, principal, session, policy, body, codec, maxBodyBytes }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: {
          'x-kin-redact-capability': capability,
          'x-kin-redact-principal': principal || '',
          'x-kin-redact-session': session || '',
          'x-kin-redact-policy': Buffer.from(JSON.stringify(policy || {}), 'utf8').toString('base64'),
          'x-kin-redact-codec': codec || 'text',
          ...(maxBodyBytes == null ? {} : { 'x-kin-redact-max-body-bytes': String(maxBodyBytes) }),
          'content-type': 'application/octet-stream',
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const payload = Buffer.concat(chunks)
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: payload.toString('utf8') })
            return
          }
          const text = payload.toString('utf8').trim()
          let fault
          try {
            fault = JSON.parse(text)?.error
          } catch {}
          const error = new Error(fault?.message || text || 'redaction_unavailable')
          error.status = res.statusCode
          error.code = fault?.code || text || 'redaction_unavailable'
          if (fault?.details) error.details = fault.details
          reject(error)
        })
      },
    )
    req.on('error', (error) => {
      const wrapped = new Error('redaction_unavailable')
      wrapped.status = 503
      wrapped.code = 'redaction_unavailable'
      wrapped.cause = error
      reject(wrapped)
    })
    if (body != null) req.write(body)
    req.end()
  })
}

export function createRedactionClient({ socketPath, capability }) {
  return {
    health() {
      return request({ socketPath, capability, method: 'GET', path: '/health', body: '' })
    },
    mask({ principal, session, policy, body, maxBodyBytes }) {
      return request({
        socketPath,
        capability,
        method: 'POST',
        path: '/v1/mask',
        principal,
        session,
        policy,
        body,
        maxBodyBytes,
        codec: 'json',
      })
    },
    restore({ principal, session, policy, body, codec = 'json', maxBodyBytes }) {
      return request({
        socketPath,
        capability,
        method: 'POST',
        path: '/v1/restore',
        principal,
        session,
        policy,
        body,
        maxBodyBytes,
        codec,
      })
    },
    validate({ policy }) {
      return request({
        socketPath,
        capability,
        method: 'POST',
        path: '/v1/validate',
        policy,
        body: '',
      })
    },
  }
}
