import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const distPath = path.join(repoRoot, 'dist')
const basePath = path.resolve(process.argv[2] || path.join(repoRoot, '..'))
const port = Number(process.env.MYBRAIN_BRIDGE_PORT || process.env.PORT || 8787)
const host = process.env.MYBRAIN_BRIDGE_HOST || '0.0.0.0'
const token = process.env.MYBRAIN_BRIDGE_TOKEN || ''

const exists = (target) => fs.existsSync(target)

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 12000,
  })

  if (result.status !== 0) {
    return ''
  }

  return result.stdout.trim()
}

const normalizeRepoUrl = (value) => {
  if (!value) {
    return ''
  }

  if (value.startsWith('git@github.com:')) {
    return `https://github.com/${value.replace('git@github.com:', '').replace(/\.git$/, '')}`
  }

  return value.replace(/\.git$/, '')
}

const listProjectDirectories = (rootPath) =>
  fs
    .readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootPath, entry.name))
    .filter((directory) => {
      const markers = ['.git', 'package.json', 'render.yaml', 'src', 'App', 'Sources']

      return markers.some((marker) => exists(path.join(directory, marker)))
    })

const readPackageInfo = (directory) => {
  const packagePath = path.join(directory, 'package.json')

  if (!exists(packagePath)) {
    return {}
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    return {
      name: pkg.name || '',
      description: pkg.description || '',
    }
  } catch {
    return {}
  }
}

const safeTime = (value) => {
  const time = value ? new Date(value).getTime() : 0

  return Number.isFinite(time) ? time : 0
}

const newestIso = (...values) => {
  const newest = Math.max(...values.map(safeTime))

  return newest > 0 ? new Date(newest).toISOString() : ''
}

const latestWorkingTreeActivityAt = (directory) => {
  const raw = run('git', ['-C', directory, 'ls-files', '-m', '-o', '--exclude-standard', '-z'])
  const files = raw.split('\0').filter(Boolean)
  const newest = files.reduce((latest, file) => {
    try {
      return Math.max(latest, fs.statSync(path.join(directory, file)).mtimeMs)
    } catch {
      return latest
    }
  }, 0)

  return newest > 0 ? new Date(newest).toISOString() : ''
}

const loadRenderServices = () => {
  const raw = run('render', ['services', '--output', 'json'], { timeout: 16000 })

  if (!raw) {
    return []
  }

  try {
    return JSON.parse(raw)
      .map((entry) => entry.service)
      .filter(Boolean)
      .map((service) => ({
        id: service.id,
        name: service.name,
        repoUrl: normalizeRepoUrl(service.repo),
        type: service.type,
        url: service.serviceDetails?.url || '',
      }))
  } catch {
    return []
  }
}

const loadLatestDeployForService = (serviceId) => {
  const raw = run('render', ['deploys', 'list', serviceId, '--output', 'json'], {
    timeout: 16000,
  })

  if (!raw) {
    return {}
  }

  try {
    const deploys = JSON.parse(raw)
    const latest = Array.isArray(deploys) ? deploys[0] : null

    if (!latest) {
      return {}
    }

    return {
      lastDeployStatus: latest.status || '',
      lastDeployAt: latest.finishedAt || latest.updatedAt || latest.startedAt || '',
      lastDeployCommit: latest.commit?.id || '',
    }
  } catch {
    return {}
  }
}

const buildSnapshot = () => {
  const renderServices = loadRenderServices()
  const renderByRepo = new Map()

  for (const service of renderServices) {
    if (!service.repoUrl) {
      continue
    }

    const current = renderByRepo.get(service.repoUrl) || []
    current.push({
      id: service.id,
      name: service.name,
      type: service.type,
      url: service.url,
      ...loadLatestDeployForService(service.id),
    })
    renderByRepo.set(service.repoUrl, current)
  }

  const projects = listProjectDirectories(basePath).map((directory) => {
    const packageInfo = readPackageInfo(directory)
    const repoUrl = normalizeRepoUrl(run('git', ['-C', directory, 'remote', 'get-url', 'origin']))
    const branch = run('git', ['-C', directory, 'branch', '--show-current'])
    const dirty = run('git', ['-C', directory, 'status', '--porcelain']).length > 0
    const lastCommitHash = run('git', ['-C', directory, 'log', '-1', '--format=%H'])
    const lastCommitMessage = run('git', ['-C', directory, 'log', '-1', '--format=%s'])
    const lastCommitDate = run('git', ['-C', directory, 'log', '-1', '--format=%cI'])
    const services = repoUrl ? renderByRepo.get(repoUrl) || [] : []
    const lastActivityAt = newestIso(
      latestWorkingTreeActivityAt(directory),
      lastCommitDate,
      ...services.map((service) => service.lastDeployAt),
    )
    const name = path.basename(directory)

    return {
      name,
      description: packageInfo.description || packageInfo.name || '',
      repoUrl,
      localPath: directory,
      branch,
      dirty,
      lastCommitHash,
      lastCommitMessage,
      lastCommitDate,
      lastActivityAt,
      tags: [
        repoUrl ? 'git' : '',
        packageInfo.name ? 'package' : '',
        services.length > 0 ? 'render' : '',
      ].filter(Boolean),
      services,
    }
  })

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    basePath,
    projects,
  }
}

const json = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsHeaders(response.req),
  })
  response.end(JSON.stringify(payload, null, 2))
}

const corsHeaders = (request) => ({
  'Access-Control-Allow-Origin': request.headers.origin || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
})

const readBody = (request) =>
  new Promise((resolve, reject) => {
    let body = ''

    request.on('data', (chunk) => {
      body += chunk

      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large.'))
        request.destroy()
      }
    })
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })

const isLoopback = (request) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')

const authorize = (request) => {
  if (!token && isLoopback(request)) {
    return true
  }

  if (!token) {
    return false
  }

  return request.headers.authorization === `Bearer ${token}`
}

const contentTypeFor = (target) => {
  if (target.endsWith('.html')) {
    return 'text/html; charset=utf-8'
  }

  if (target.endsWith('.js')) {
    return 'text/javascript; charset=utf-8'
  }

  if (target.endsWith('.css')) {
    return 'text/css; charset=utf-8'
  }

  if (target.endsWith('.svg')) {
    return 'image/svg+xml'
  }

  if (target.endsWith('.webmanifest')) {
    return 'application/manifest+json'
  }

  return 'application/octet-stream'
}

const serveStatic = (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const requestedPath = safePath ? path.join(distPath, safePath) : path.join(distPath, 'index.html')
  const target = exists(requestedPath) && fs.statSync(requestedPath).isFile()
    ? requestedPath
    : path.join(distPath, 'index.html')

  if (!exists(target)) {
    json(response, 404, {
      error: 'Build the app first with npm run build before serving it through the bridge.',
    })
    return
  }

  response.writeHead(200, { 'Content-Type': contentTypeFor(target) })
  fs.createReadStream(target).pipe(response)
}

const writeEvent = (response, payload) => {
  response.write(`${JSON.stringify(payload)}\n`)
}

const createCodexRun = (body, onEvent) => {
  const cwd = typeof body.cwd === 'string' ? body.cwd : ''
  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const sandbox =
    body.sandbox === 'read-only' ||
    body.sandbox === 'workspace-write' ||
    body.sandbox === 'danger-full-access'
      ? body.sandbox
      : 'workspace-write'

  if (!prompt.trim()) {
    throw new Error('Prompt is required.')
  }

  if (!sessionId && !cwd) {
    throw new Error('Project cwd is required for a new Codex session.')
  }

  const args = sessionId
    ? ['exec', 'resume', '--json']
    : ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '--sandbox', sandbox]

  if (model) {
    args.push('-m', model)
  }

  if (sessionId) {
    args.push(sessionId, '-')
  } else {
    args.push('-')
  }

  const child = spawn('codex', args, {
    cwd: cwd || process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdoutBuffer = ''
  let stderrBuffer = ''
  const done = new Promise((resolve) => {
    onEvent({ type: 'bridge', message: sessionId ? 'Resuming Codex thread.' : 'Starting Codex thread.' })

    const handleLine = (line, stream) => {
      const trimmed = line.trim()

      if (!trimmed) {
        return
      }

      if (
        stream === 'stderr' &&
        (trimmed.includes('codex_core::plugins::manifest') ||
          trimmed.includes('codex_core::shell_snapshot'))
      ) {
        return
      }

      if (!trimmed.startsWith('{')) {
        onEvent({ type: 'log', stream, text: trimmed })
        return
      }

      try {
        const event = JSON.parse(trimmed)
        onEvent({ type: 'codex-event', event })

        if (event.type === 'thread.started' && event.thread_id) {
          onEvent({ type: 'thread', threadId: event.thread_id })
        }

        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          onEvent({ type: 'assistant', text: event.item.text || '' })
        }

        if (event.type === 'turn.completed') {
          onEvent({ type: 'turn-completed', usage: event.usage })
        }
      } catch {
        onEvent({ type: 'log', stream, text: trimmed })
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() || ''
      lines.forEach((line) => handleLine(line, 'stdout'))
    })

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString()
      const lines = stderrBuffer.split('\n')
      stderrBuffer = lines.pop() || ''
      lines.forEach((line) => handleLine(line, 'stderr'))
    })

    child.on('error', (error) => {
      onEvent({ type: 'error', message: error.message })
    })

    child.on('close', (code) => {
      handleLine(stdoutBuffer, 'stdout')
      handleLine(stderrBuffer, 'stderr')
      onEvent({ type: 'exit', code })
      resolve()
    })
  })

  child.stdin.end(prompt)

  return { child, done }
}

const handleCodexRun = async (request, response) => {
  const body = await readBody(request)

  try {
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      ...corsHeaders(request),
    })

    const runState = createCodexRun(body, (event) => writeEvent(response, event))

    response.on('close', () => {
      if (!runState.child.killed) {
        runState.child.kill('SIGTERM')
      }
    })

    await runState.done
    response.end()
  } catch (error) {
    if (!response.headersSent) {
      json(response, 400, {
        error: error instanceof Error ? error.message : 'Codex run failed.',
      })
      return
    }

    writeEvent(response, {
      type: 'error',
      message: error instanceof Error ? error.message : 'Codex run failed.',
    })
    response.end()
  }
}

const server = http.createServer(async (request, response) => {
  response.req = request

  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders(request))
    response.end()
    return
  }

  const url = new URL(request.url || '/', `http://${request.headers.host}`)

  try {
    if (url.pathname.startsWith('/api/')) {
      if (!authorize(request)) {
        json(response, 401, {
          error: token
            ? 'Bridge token is missing or incorrect.'
            : 'Set MYBRAIN_BRIDGE_TOKEN for non-local browser access.',
        })
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, {
          ok: true,
          basePath,
          codexPath: run('which', ['codex']) || 'codex',
          renderAvailable: Boolean(run('which', ['render'])),
          tokenRequired: Boolean(token),
        })
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/projects') {
        json(response, 200, buildSnapshot())
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/codex/run') {
        await handleCodexRun(request, response)
        return
      }

      json(response, 404, { error: 'Unknown bridge endpoint.' })
      return
    }

    serveStatic(request, response)
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : 'Bridge request failed.',
    })
  }
})

server.listen(port, host, () => {
  console.log(`MyBrain Codex bridge listening on http://${host}:${port}`)
  console.log(`Scanning projects under ${basePath}`)
  console.log(token ? 'Bridge token is enabled.' : 'Set MYBRAIN_BRIDGE_TOKEN before exposing this beyond localhost.')
})
