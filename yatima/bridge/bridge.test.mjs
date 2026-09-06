import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  FIXED_CONFIG,
  __test,
  createBridgeServer,
  loadTokenFromFile,
} from './bridge.mjs'

const TOKEN = 'yatima-test-token-0123456789abcdef0123456789'

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host)
  await once(server, 'listening')
  return server.address().port
}

async function closeServer(server) {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}

async function requestBridge(port, {
  method = 'POST',
  path = '/mcp',
  host = '127.0.0.1:43180',
  token = TOKEN,
  origin,
  body = '{}',
  headers = {},
  destroyOnResponse = false,
} = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const requestHeaders = {
      host,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...headers,
    }
    if (origin !== undefined) requestHeaders.origin = origin

    const clientRequest = request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: requestHeaders,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          resolveRequest({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
        if (destroyOnResponse) response.destroy()
      },
    )
    clientRequest.on('error', rejectRequest)
    clientRequest.end(body)
  })
}

async function makeHarness({
  upstreamHandler,
  startService = async () => {},
  healthCheck = async () => 200,
  ...options
} = {}) {
  const upstream = createServer(upstreamHandler ?? ((_, response) => response.end('ok')))
  const upstreamPort = await listen(upstream)
  const bridge = createBridgeServer({
    token: TOKEN,
    upstreamPort,
    listenPort: 0,
    startService,
    healthCheck,
    startupPollIntervalMs: 1,
    ...options,
  })
  const address = await bridge.listen()

  return {
    bridge,
    upstream,
    bridgePort: address.port,
    async close() {
      await bridge.close()
      await closeServer(upstream)
    },
  }
}

test('accepts only authenticated GET/POST/DELETE /mcp requests', async () => {
  let upstreamRequests = 0
  const harness = await makeHarness({
    upstreamHandler: (_, response) => {
      upstreamRequests += 1
      response.end('ok')
    },
  })

  try {
    const cases = [
      { path: '/other', expected: 404 },
      { path: '/mcp?unexpected=1', expected: 404 },
      { method: 'PUT', expected: 405 },
      { token: 'wrong-token', expected: 401 },
      { origin: 'https://example.test', expected: 403 },
      { host: '127.0.0.1:43181', expected: 400 },
      { host: 'localhost:43180', expected: 200 },
    ]

    for (const candidate of cases) {
      const result = await requestBridge(harness.bridgePort, candidate)
      assert.equal(result.statusCode, candidate.expected)
    }
    assert.equal(upstreamRequests, 1)
  } finally {
    await harness.close()
  }
})

test('forwards MCP headers and body while stripping Authorization and hop-by-hop headers', async () => {
  let seenRequest
  const harness = await makeHarness({
    upstreamHandler: async (requestMessage, response) => {
      const chunks = []
      for await (const chunk of requestMessage) chunks.push(chunk)
      seenRequest = {
        method: requestMessage.method,
        headers: requestMessage.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      response.writeHead(202, {
        'content-type': 'text/event-stream',
        'mcp-session-id': 'session-123',
        connection: 'close, x-response-hop',
        'x-response-hop': 'drop',
      })
      response.write('data: one\n\n')
      setTimeout(() => response.end('data: two\n\n'), 5)
    },
  })

  try {
    const result = await requestBridge(harness.bridgePort, {
      body: '{"jsonrpc":"2.0"}',
      headers: {
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-03-26',
        'mcp-session-id': 'session-123',
        connection: 'keep-alive, x-request-hop',
        'x-request-hop': 'drop',
      },
    })
    assert.equal(result.statusCode, 202)
    assert.equal(result.headers['content-type'], 'text/event-stream')
    assert.equal(result.headers['mcp-session-id'], 'session-123')
    assert.equal(result.headers['x-response-hop'], undefined)
    assert.equal(result.body, 'data: one\n\ndata: two\n\n')
    assert.equal(seenRequest.method, 'POST')
    assert.equal(seenRequest.body, '{"jsonrpc":"2.0"}')
    assert.equal(seenRequest.headers.authorization, undefined)
    assert.notEqual(seenRequest.headers.connection, 'upgrade')
    assert.equal(seenRequest.headers['x-request-hop'], undefined)
    assert.equal(seenRequest.headers.accept, 'application/json, text/event-stream')
    assert.equal(seenRequest.headers['mcp-protocol-version'], '2025-03-26')
    assert.equal(seenRequest.headers['mcp-session-id'], 'session-123')
  } finally {
    await harness.close()
  }
})

test('rejects request bodies over 1 MiB before forwarding', async () => {
  let upstreamRequests = 0
  const harness = await makeHarness({
    upstreamHandler: (_, response) => {
      upstreamRequests += 1
      response.end('unexpected')
    },
  })

  try {
    const result = await requestBridge(harness.bridgePort, {
      body: 'x'.repeat(FIXED_CONFIG.maxBodyBytes + 1),
    })
    assert.equal(result.statusCode, 413)
    assert.equal(upstreamRequests, 0)
  } finally {
    await harness.close()
  }
})

test('coalesces concurrent startup and waits for readiness', async () => {
  let startCount = 0
  let releaseStart
  const startGate = new Promise((resolveStart) => {
    releaseStart = resolveStart
  })
  const harness = await makeHarness({
    startService: async () => {
      startCount += 1
      await startGate
    },
  })

  try {
    const pending = Array.from({ length: 8 }, () => requestBridge(harness.bridgePort))
    await new Promise((resolveReady) => setTimeout(resolveReady, 10))
    assert.equal(startCount, 1)
    releaseStart()
    const results = await Promise.all(pending)
    assert.deepEqual(results.map(({ statusCode }) => statusCode), Array(8).fill(200))
    assert.equal(startCount, 1)
  } finally {
    releaseStart()
    await harness.close()
  }
})

test('rejects authenticated work above the concurrent request cap', async () => {
  let releaseStart
  const startGate = new Promise((resolveStart) => {
    releaseStart = resolveStart
  })
  const harness = await makeHarness({
    maxConcurrent: 1,
    startService: async () => {
      await startGate
    },
  })

  try {
    const first = requestBridge(harness.bridgePort)
    await new Promise((resolveReady) => setTimeout(resolveReady, 10))
    const second = await requestBridge(harness.bridgePort)
    assert.equal(second.statusCode, 503)
    releaseStart()
    assert.equal((await first).statusCode, 200)
  } finally {
    releaseStart()
    await harness.close()
  }
})

test('retries service startup after a failure', async () => {
  let startCount = 0
  const harness = await makeHarness({
    startService: async () => {
      startCount += 1
      if (startCount === 1) throw new Error('injected start failure')
    },
  })

  try {
    const first = await requestBridge(harness.bridgePort)
    const second = await requestBridge(harness.bridgePort)
    assert.equal(first.statusCode, 503)
    assert.equal(second.statusCode, 200)
    assert.equal(startCount, 2)
  } finally {
    await harness.close()
  }
})

test('aborts an upstream SSE request when the client disconnects', async () => {
  let upstreamClosed = false
  const upstream = createServer((requestMessage, response) => {
    requestMessage.once('close', () => {
      upstreamClosed = true
    })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: waiting\n\n')
  })
  const upstreamPort = await listen(upstream)
  const bridge = createBridgeServer({
    token: TOKEN,
    upstreamPort,
    listenPort: 0,
    startService: async () => {},
    healthCheck: async () => 200,
  })
  const bridgeAddress = await bridge.listen()

  try {
    await new Promise((resolveRequest, rejectRequest) => {
      const client = request({
        hostname: '127.0.0.1',
        port: bridgeAddress.port,
        method: 'POST',
        path: '/mcp',
        headers: {
          host: '127.0.0.1:43180',
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
      })
      client.once('response', (response) => {
        response.once('data', () => {
          client.destroy()
        })
        response.once('close', resolveRequest)
      })
      client.once('error', (error) => {
        if (error.code !== 'ECONNRESET') rejectRequest(error)
      })
      client.end('{}')
    })

    const deadline = Date.now() + 1_000
    while (!upstreamClosed && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }
    assert.equal(upstreamClosed, true)
  } finally {
    await bridge.close()
    await closeServer(upstream)
  }
})

test('enforces private owner-only token files and rejects symlinks', async (t) => {
  const directory = await mkdtemp(
    join(dirname(fileURLToPath(import.meta.url)), '.token-test-'),
  )
  const tokenPath = join(directory, 'token')
  const linkPath = join(directory, 'token-link')
  t.after(async () => rm(directory, { recursive: true, force: true }))

  await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 })
  await chmod(tokenPath, 0o600)
  assert.equal(await loadTokenFromFile(tokenPath), TOKEN)

  await chmod(tokenPath, 0o640)
  await assert.rejects(loadTokenFromFile(tokenPath))
  await chmod(tokenPath, 0o600)

  await symlink(tokenPath, linkPath)
  await assert.rejects(loadTokenFromFile(linkPath))
  assert.equal((await lstat(tokenPath)).isFile(), true)
  assert.equal((await readFile(tokenPath, 'utf8')).trim(), TOKEN)
})

test('exports fixed production endpoints and service command', () => {
  assert.deepEqual(
    {
      listenHost: FIXED_CONFIG.listenHost,
      listenPort: FIXED_CONFIG.listenPort,
      upstreamHost: FIXED_CONFIG.upstreamHost,
      upstreamPort: FIXED_CONFIG.upstreamPort,
      upstreamPath: FIXED_CONFIG.upstreamPath,
      healthPath: FIXED_CONFIG.healthPath,
      maxBodyBytes: FIXED_CONFIG.maxBodyBytes,
      maxConcurrent: FIXED_CONFIG.maxConcurrent,
      headersTimeoutMs: FIXED_CONFIG.headersTimeoutMs,
      startupTimeoutMs: FIXED_CONFIG.startupTimeoutMs,
      serviceCommand: FIXED_CONFIG.serviceCommand,
      serviceArguments: FIXED_CONFIG.serviceArguments,
    },
    {
      listenHost: '127.0.0.1',
      listenPort: 43180,
      upstreamHost: '127.0.0.1',
      upstreamPort: 43080,
      upstreamPath: '/mcp',
      healthPath: '/health',
      maxBodyBytes: 1024 * 1024,
      maxConcurrent: 64,
      headersTimeoutMs: 10_000,
      startupTimeoutMs: 45_000,
      serviceCommand: 'systemctl',
      serviceArguments: ['--user', 'start', 'yatima-browser.service'],
    },
  )
})
