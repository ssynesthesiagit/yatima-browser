#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'

export const FIXED_CONFIG = Object.freeze({
  listenHost: '127.0.0.1',
  listenPort: 43180,
  upstreamHost: '127.0.0.1',
  upstreamPort: 43080,
  upstreamPath: '/mcp',
  healthPath: '/health',
  serviceCommand: 'systemctl',
  serviceArguments: Object.freeze(['--user', 'start', 'yatima-browser.service']),
  tokenEnvironment: 'YATIMA_BROWSER_BRIDGE_TOKEN_FILE',
  maxBodyBytes: 1024 * 1024,
  maxConcurrent: 64,
  headersTimeoutMs: 10_000,
  startupTimeoutMs: 45_000,
  startupPollIntervalMs: 250,
})

const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE'])
const ALLOWED_HOSTS = new Set(['127.0.0.1:43180', 'localhost:43180'])
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const FORWARD_BLOCKED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'authorization',
  'expect',
  'host',
  'origin',
])

class BodyTooLargeError extends Error {}

class InvalidContentLengthError extends Error {}

class ClientAbortedError extends Error {}

function fixedError(message) {
  return new Error(message)
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isConstantTimeEqual(expected, actual) {
  const expectedBytes = Buffer.from(expected, 'utf8')
  const actualBytes = Buffer.from(actual, 'utf8')
  const length = Math.max(expectedBytes.length, actualBytes.length)
  const expectedPadded = Buffer.alloc(length)
  const actualPadded = Buffer.alloc(length)

  expectedBytes.copy(expectedPadded)
  actualBytes.copy(actualPadded)

  const equal = timingSafeEqual(expectedPadded, actualPadded)
  return equal && expectedBytes.length === actualBytes.length
}

function tokenFromAuthorization(value) {
  if (typeof value !== 'string') return null
  const match = /^Bearer ([^\s]+)$/.exec(value)
  return match?.[1] ?? null
}

function validateToken(token) {
  if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) {
    throw fixedError('invalid bridge token')
  }
  return token
}

function connectionHeaderTokens(headers) {
  const value = headers.connection
  const values = Array.isArray(value) ? value : [value]
  return new Set(
    values
      .filter((item) => typeof item === 'string')
      .flatMap((item) => item.split(','))
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )
}

function currentUid() {
  if (typeof process.getuid !== 'function') {
    throw fixedError('bridge requires a Unix owner uid')
  }
  return process.getuid()
}

/**
 * Load a private bearer token without following a symlink.
 *
 * `filePath`, `fsApi`, and `uid` are injectable only so provider-free tests can
 * exercise the file policy without changing the production entry point.
 */
export async function loadTokenFromFile(
  filePath = process.env[FIXED_CONFIG.tokenEnvironment],
  fsApi = fs,
  uid = currentUid(),
) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    throw fixedError('bridge token path must be absolute')
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  const handle = await fsApi.open(filePath, fsConstants.O_RDONLY | noFollow)
  try {
    const stats = await handle.stat()
    const mode = stats.mode & 0o777
    if (!stats.isFile() || stats.uid !== uid || (mode & 0o077) !== 0) {
      throw fixedError('bridge token file is not private')
    }

    return validateToken((await handle.readFile('utf8')).trim())
  } finally {
    await handle.close()
  }
}

function requestHeadersForUpstream(inboundHeaders, upstreamHost, upstreamPort) {
  const headers = {}
  const connectionTokens = connectionHeaderTokens(inboundHeaders)

  for (const [name, value] of Object.entries(inboundHeaders)) {
    const lowerName = name.toLowerCase()
    if (
      FORWARD_BLOCKED_HEADERS.has(lowerName) ||
      connectionTokens.has(lowerName)
    ) {
      continue
    }
    if (typeof value === 'string' || Array.isArray(value)) {
      headers[lowerName] = value
    }
  }

  headers.host = `${upstreamHost}:${upstreamPort}`
  return headers
}

function responseHeadersForClient(upstreamHeaders) {
  const headers = {}
  const connectionTokens = connectionHeaderTokens(upstreamHeaders)

  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName) || connectionTokens.has(lowerName)) {
      continue
    }
    if (value !== undefined) headers[name] = value
  }

  return headers
}

function writeFixedResponse(response, statusCode, message, headers = {}) {
  if (response.destroyed || response.headersSent) return

  const body = Buffer.from(message, 'utf8')
  response.writeHead(statusCode, {
    ...headers,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.byteLength,
  })
  response.end(body)
}

function parseRequestUrl(requestUrl) {
  return requestUrl === '/mcp'
}

function contentLengthForRequest(headers) {
  const value = headers['content-length']
  if (value === undefined) return null
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    throw new InvalidContentLengthError()
  }

  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw new InvalidContentLengthError()
  return length
}

function readRequestBody(request, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    let settled = false
    let total = 0
    const chunks = []

    const rejectOnce = (error) => {
      if (settled) return
      settled = true
      request.resume()
      rejectBody(error)
    }

    const resolveOnce = (body) => {
      if (settled) return
      settled = true
      resolveBody(body)
    }

    try {
      const contentLength = contentLengthForRequest(request.headers)
      if (contentLength !== null && contentLength > maxBytes) {
        rejectOnce(new BodyTooLargeError())
        return
      }
    } catch (error) {
      rejectOnce(error)
      return
    }

    request.on('data', (chunk) => {
      if (settled) return
      total += chunk.byteLength
      if (total > maxBytes) {
        rejectOnce(new BodyTooLargeError())
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    request.once('end', () => resolveOnce(Buffer.concat(chunks, total)))
    request.once('aborted', () => rejectOnce(new ClientAbortedError()))
    request.once('error', rejectOnce)
  })
}

function runSystemctl(signal, spawnImpl = spawn) {
  return new Promise((resolveCommand, rejectCommand) => {
    let settled = false
    const child = spawnImpl(
      FIXED_CONFIG.serviceCommand,
      [...FIXED_CONFIG.serviceArguments],
      { shell: false, stdio: 'ignore', signal },
    )

    const finish = (error) => {
      if (settled) return
      settled = true
      if (error) rejectCommand(error)
      else resolveCommand()
    }

    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (code === 0) finish()
      else finish(fixedError('browser service start failed'))
    })
  })
}

function requestHealth({
  signal,
  timeoutMs,
  httpRequestImpl,
  upstreamHost,
  upstreamPort,
  healthPath,
}) {
  return new Promise((resolveHealth, rejectHealth) => {
    let settled = false
    const finishError = (error) => {
      if (settled) return
      settled = true
      rejectHealth(error)
    }

    let request
    try {
      request = httpRequestImpl(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          path: healthPath,
          method: 'GET',
          headers: { host: `${upstreamHost}:${upstreamPort}` },
          signal,
        },
        (response) => {
          const statusCode = response.statusCode ?? 0
          response.once('error', finishError)
          response.once('aborted', () =>
            finishError(fixedError('browser readiness check aborted')),
          )
          response.resume()
          response.once('end', () => {
            if (settled) return
            settled = true
            resolveHealth(statusCode)
          })
        },
      )
    } catch (error) {
      finishError(error)
      return
    }

    request.once('error', finishError)
    request.setTimeout(timeoutMs, () => {
      request.destroy(fixedError('browser readiness check timed out'))
    })
    request.end()
  })
}

function delay(milliseconds, signal) {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal.aborted) {
      rejectDelay(fixedError('browser readiness aborted'))
      return
    }

    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      rejectDelay(fixedError('browser readiness aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolveDelay()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function waitForHealth({
  signal,
  healthCheck,
  startupTimeoutMs,
  startupPollIntervalMs,
}) {
  const deadline = Date.now() + startupTimeoutMs
  let lastError

  while (Date.now() < deadline) {
    const timeoutMs = Math.max(1, deadline - Date.now())
    try {
      if ((await healthCheck({ signal, timeoutMs })) === 200) return
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(startupPollIntervalMs, remaining), signal)
  }

  throw lastError ?? fixedError('browser readiness timed out')
}

function createDefaultHealthCheck(config, requestImpl) {
  return ({ signal, timeoutMs }) =>
    requestHealth({
      signal,
      timeoutMs,
      httpRequestImpl: requestImpl,
      upstreamHost: config.upstreamHost,
      upstreamPort: config.upstreamPort,
      healthPath: config.healthPath,
    })
}

async function forwardRequest({
  request,
  response,
  body,
  config,
  requestImpl,
  activeControllers,
}) {
  const controller = new AbortController()
  activeControllers.add(controller)

  return new Promise((resolveForward) => {
    let settled = false
    let upstreamResponseStarted = false

    const settle = () => {
      if (settled) return
      settled = true
      activeControllers.delete(controller)
      resolveForward()
    }

    const abort = () => {
      if (!controller.signal.aborted) controller.abort()
    }

    request.once('aborted', abort)
    response.once('finish', settle)
    response.once('close', () => {
      if (!response.writableEnded) abort()
      settle()
    })

    let upstreamRequest
    try {
      upstreamRequest = requestImpl(
        {
          hostname: config.upstreamHost,
          port: config.upstreamPort,
          path: config.upstreamPath,
          method: request.method,
          headers: requestHeadersForUpstream(
            request.headers,
            config.upstreamHost,
            config.upstreamPort,
          ),
          signal: controller.signal,
        },
        (upstreamResponse) => {
          upstreamResponseStarted = true
          if (response.destroyed) {
            upstreamResponse.resume()
            abort()
            settle()
            return
          }

          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            responseHeadersForClient(upstreamResponse.headers),
          )
          upstreamResponse.once('error', () => {
            if (!response.destroyed) response.destroy()
          })
          upstreamResponse.pipe(response)
        },
      )
    } catch {
      writeFixedResponse(response, 502, 'upstream unavailable')
      settle()
      return
    }

    upstreamRequest.once('error', () => {
      if (response.destroyed || controller.signal.aborted) {
        settle()
        return
      }
      if (!upstreamResponseStarted) {
        writeFixedResponse(response, 502, 'upstream unavailable')
      } else if (!response.destroyed) {
        response.destroy()
      }
      settle()
    })

    upstreamRequest.end(body)
  })
}

function isAllowedHost(request) {
  return typeof request.headers.host === 'string' && ALLOWED_HOSTS.has(request.headers.host)
}

function authenticate(request, token) {
  const supplied = tokenFromAuthorization(request.headers.authorization)
  return supplied !== null && isConstantTimeEqual(token, supplied)
}

/**
 * Construct the broker. Injectable functions are intentionally kept at this
 * boundary for provider-free tests; the executable entry point supplies none.
 */
export function createBridgeServer({
  token,
  listenHost = FIXED_CONFIG.listenHost,
  listenPort = FIXED_CONFIG.listenPort,
  upstreamHost = FIXED_CONFIG.upstreamHost,
  upstreamPort = FIXED_CONFIG.upstreamPort,
  upstreamPath = FIXED_CONFIG.upstreamPath,
  healthPath = FIXED_CONFIG.healthPath,
  maxBodyBytes = FIXED_CONFIG.maxBodyBytes,
  maxConcurrent = FIXED_CONFIG.maxConcurrent,
  headersTimeoutMs = FIXED_CONFIG.headersTimeoutMs,
  startupTimeoutMs = FIXED_CONFIG.startupTimeoutMs,
  startupPollIntervalMs = FIXED_CONFIG.startupPollIntervalMs,
  startService = ({ signal }) => runSystemctl(signal),
  healthCheck,
  requestImpl = httpRequest,
  serverFactory = createServer,
} = {}) {
  validateToken(token)

  const config = {
    listenHost,
    listenPort,
    upstreamHost,
    upstreamPort,
    upstreamPath,
    healthPath,
    maxBodyBytes,
    maxConcurrent,
    headersTimeoutMs,
    startupTimeoutMs,
    startupPollIntervalMs,
  }
  const checkHealth =
    healthCheck ?? createDefaultHealthCheck(config, requestImpl)
  const server = serverFactory((request, response) => {
    void handleRequest(request, response).catch(() =>
      writeFixedResponse(response, 503, 'bridge request failed'),
    )
  })
  const activeControllers = new Set()
  const activeResponses = new Set()
  let activeRequests = 0
  let startupPromise = null
  let startupAbortController = null
  let ready = false
  let closing = false

  server.headersTimeout = headersTimeoutMs
  server.requestTimeout = 0
  server.maxHeadersCount = 100

  async function ensureBrowserReady() {
    if (ready) return
    if (startupPromise) return startupPromise

    startupAbortController = new AbortController()
    const signal = startupAbortController.signal
    let startupTimer
    const startupOperation = (async () => {
      await startService({ signal })
      await waitForHealth({
        signal,
        healthCheck: checkHealth,
        startupTimeoutMs,
        startupPollIntervalMs,
      })
    })()
    const startupDeadline = new Promise((_, rejectDeadline) => {
      startupTimer = setTimeout(() => {
        startupAbortController?.abort()
        rejectDeadline(fixedError('browser startup timed out'))
      }, startupTimeoutMs)
    })

    startupPromise = Promise.race([startupOperation, startupDeadline])
      .then(() => {
        ready = true
      })
      .catch((error) => {
        ready = false
        throw error
      })
      .finally(() => {
        clearTimeout(startupTimer)
        startupPromise = null
        startupAbortController = null
      })

    return startupPromise
  }

  async function handleRequest(request, response) {
    if (closing) {
      writeFixedResponse(response, 503, 'bridge shutting down')
      return
    }

    if (!parseRequestUrl(request.url)) {
      writeFixedResponse(response, 404, 'not found')
      return
    }
    if (!ALLOWED_METHODS.has(request.method ?? '')) {
      writeFixedResponse(response, 405, 'method not allowed', {
        allow: 'GET, POST, DELETE',
      })
      return
    }
    if (!isAllowedHost(request)) {
      writeFixedResponse(response, 400, 'invalid host')
      return
    }
    if (hasOwn(request.headers, 'origin')) {
      writeFixedResponse(response, 403, 'origin not allowed')
      return
    }
    if (!authenticate(request, token)) {
      writeFixedResponse(response, 401, 'unauthorized', {
        'www-authenticate': 'Bearer',
      })
      return
    }
    if (activeRequests >= maxConcurrent) {
      writeFixedResponse(response, 503, 'bridge busy')
      return
    }

    activeRequests += 1
    activeResponses.add(response)
    try {
      const body = await readRequestBody(request, maxBodyBytes)
      if (request.aborted || response.destroyed) return
      await ensureBrowserReady()
      if (request.aborted || response.destroyed) return
      await forwardRequest({
        request,
        response,
        body,
        config,
        requestImpl,
        activeControllers,
      })
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        writeFixedResponse(response, 413, 'request body too large')
      } else if (error instanceof InvalidContentLengthError) {
        writeFixedResponse(response, 400, 'invalid content length')
      } else if (!(error instanceof ClientAbortedError)) {
        writeFixedResponse(response, 503, 'browser unavailable')
      }
    } finally {
      activeRequests -= 1
      activeResponses.delete(response)
    }
  }

  function listen() {
    return new Promise((resolveListen, rejectListen) => {
      const onError = (error) => {
        server.off('listening', onListening)
        rejectListen(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolveListen(server.address())
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(listenPort, listenHost)
    })
  }

  function close() {
    closing = true
    if (startupAbortController) startupAbortController.abort()
    for (const controller of activeControllers) controller.abort()
    for (const response of activeResponses) response.destroy()

    return new Promise((resolveClose) => {
      if (!server.listening) {
        resolveClose()
        return
      }
      server.close(() => resolveClose())
    })
  }

  return {
    server,
    listen,
    close,
    ensureBrowserReady,
    get activeRequests() {
      return activeRequests
    },
  }
}

export async function startProduction() {
  const token = await loadTokenFromFile()
  const bridge = createBridgeServer({ token })
  await bridge.listen()
  return bridge
}

async function main() {
  await startProduction()
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  let bridge
  const shutdown = async () => {
    if (!bridge) return
    await bridge.close()
    process.exit(0)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  main()
    .then((startedBridge) => {
      bridge = startedBridge
    })
    .catch(() => {
      process.exitCode = 1
    })
}

export const __test = Object.freeze({
  isConstantTimeEqual,
  requestHeadersForUpstream,
  responseHeadersForClient,
  tokenFromAuthorization,
})
