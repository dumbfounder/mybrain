import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const distPath = path.join(repoRoot, 'dist')
const localHistoryRoot = process.env.MYBRAIN_HISTORY_DIR || path.join(repoRoot, '.mybrain-history')
const port = Number(process.env.PORT || process.env.MYBRAIN_PORT || 3000)
const host = process.env.HOST || process.env.MYBRAIN_HOST || '0.0.0.0'
const ingestToken = process.env.MYBRAIN_REMOTE_CONTROL_TOKEN || ''
const historyRepo = process.env.MYBRAIN_HISTORY_REPO || ''
const historyBranch = process.env.MYBRAIN_HISTORY_BRANCH || 'main'
const githubToken = process.env.GITHUB_TOKEN || ''
const githubApiBase = 'https://api.github.com'

const globalIndexPath = 'projects/index.jsonl'
const projectsPath = 'projects/projects.json'
const markdownFields = [
  ['inputPrompt', 'input.md'],
  ['workerPrompt', 'worker-prompt.md'],
  ['assistantOutput', 'assistant-output.md'],
  ['relayCompletion', 'relay-completion.md'],
  ['summary', 'summary.md'],
  ['codexUiHandoff', 'codex-context.md'],
]

const repoConfigured = () => Boolean(historyRepo && githubToken)

const corsHeaders = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
})

const json = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(),
  })
  response.end(JSON.stringify(payload, null, 2))
}

const text = (response, status, body, contentType = 'text/plain; charset=utf-8') => {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...corsHeaders(),
  })
  response.end(body)
}

const safePathPart = (value) =>
  String(value || 'default')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 180)

const normalizeRepoUrl = (value = '') => {
  const trimmed = String(value).trim()

  if (!trimmed) {
    return ''
  }

  if (trimmed.startsWith('git@github.com:')) {
    return `https://github.com/${trimmed.replace('git@github.com:', '').replace(/\.git$/, '')}`
  }

  return trimmed.replace(/\.git$/, '')
}

const excerpt = (value = '', limit = 180) => {
  const clean = String(value).replace(/\s+/g, ' ').trim()

  return clean.length > limit ? `${clean.slice(0, limit).trimEnd()}...` : clean
}

const parseRepo = () => {
  const [owner, repo] = historyRepo.split('/')

  if (!owner || !repo) {
    throw new Error('MYBRAIN_HISTORY_REPO must be in owner/name format.')
  }

  return { owner, repo }
}

const githubRequest = async (apiPath, options = {}) => {
  const response = await fetch(`${githubApiBase}${apiPath}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers ?? {}),
    },
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub request failed (${response.status}): ${body}`)
  }

  return response.json()
}

const readGithubText = async (filePath) => {
  const { owner, repo } = parseRepo()
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  const file = await githubRequest(
    `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(historyBranch)}`,
  )

  if (!file?.content) {
    return null
  }

  return {
    sha: file.sha,
    content: Buffer.from(file.content, 'base64').toString('utf8'),
  }
}

const writeGithubText = async (filePath, content, message) => {
  const { owner, repo } = parseRepo()
  const current = await readGithubText(filePath)
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  const payload = {
    message,
    branch: historyBranch,
    content: Buffer.from(content, 'utf8').toString('base64'),
    ...(current?.sha ? { sha: current.sha } : {}),
  }

  return githubRequest(`/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

const localFilePath = (filePath) => path.join(localHistoryRoot, ...filePath.split('/'))

const readStorageText = async (filePath) => {
  if (repoConfigured()) {
    const file = await readGithubText(filePath)

    return file?.content ?? null
  }

  const target = localFilePath(filePath)

  if (!fs.existsSync(target)) {
    return null
  }

  return fs.readFileSync(target, 'utf8')
}

const writeStorageText = async (filePath, content, message) => {
  if (repoConfigured()) {
    await writeGithubText(filePath, content, message)
    return
  }

  const target = localFilePath(filePath)

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

const readStorageJson = async (filePath, fallback) => {
  const content = await readStorageText(filePath)

  return content ? JSON.parse(content) : fallback
}

const writeStorageJson = async (filePath, value, message) => {
  await writeStorageText(filePath, `${JSON.stringify(value, null, 2)}\n`, message)
}

const readStorageJsonl = async (filePath) => {
  const content = await readStorageText(filePath)

  if (!content) {
    return []
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const writeStorageJsonl = async (filePath, values, message) => {
  await writeStorageText(
    filePath,
    `${values.map((value) => JSON.stringify(value)).join('\n')}\n`,
    message,
  )
}

const readBody = (request) =>
  new Promise((resolve, reject) => {
    let body = ''

    request.on('data', (chunk) => {
      body += chunk

      if (body.length > 4_000_000) {
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

const authorizeIngest = (request) =>
  Boolean(ingestToken && request.headers.authorization === `Bearer ${ingestToken}`)

const artifactPaths = (detail) => {
  const projectName = safePathPart(detail.projectName || 'remote-work')
  const workstream = safePathPart(detail.workstreamAlias || 'default')
  const requestId = safePathPart(detail.requestId)
  const base = `projects/${projectName}/workstreams/${workstream}/${requestId}`

  return {
    base,
    metadata: `${base}/metadata.json`,
    projectIndex: `projects/${projectName}/index.jsonl`,
    input: `${base}/input.md`,
    workerPrompt: `${base}/worker-prompt.md`,
    assistantOutput: `${base}/assistant-output.md`,
    relayCompletion: `${base}/relay-completion.md`,
    summary: `${base}/summary.md`,
    codexContext: `${base}/codex-context.md`,
    codexEvents: `${base}/codex-events.jsonl`,
  }
}

const normalizePayload = (raw, requestIdOverride = '') => {
  const source = raw?.detail || raw?.request || raw?.snapshot || raw?.item || raw || {}
  const requestId = requestIdOverride || source.requestId || raw?.requestId

  if (!requestId || typeof requestId !== 'string') {
    throw new Error('requestId is required.')
  }

  if (!source.projectName || typeof source.projectName !== 'string') {
    throw new Error('projectName is required.')
  }

  if (!['queued', 'running', 'ok', 'blocked', 'failed'].includes(source.status)) {
    throw new Error('status must be queued, running, ok, blocked, or failed.')
  }

  const promptText = source.promptText || source.inputPrompt || source.prompt || ''
  const relayCompletion = source.relayCompletion || source.finalCompletionText || ''
  const summary =
    source.summary ||
    source.summaryText ||
    source.assistantOutput ||
    excerpt(relayCompletion || source.latestStatusLine || promptText || `${source.status} request`)

  return {
    requestId,
    projectName: source.projectName,
    projectPath: source.projectPath || source.path || '',
    workstreamAlias: source.workstreamAlias ?? null,
    codexSessionId: source.codexSessionId || source.thread || source.codexThreadId || null,
    status: source.status,
    createdAt: source.createdAt || new Date().toISOString(),
    claimedAt: source.claimedAt ?? null,
    finishedAt: source.finishedAt ?? null,
    promptText,
    promptPreview: source.promptPreview || excerpt(promptText),
    latestStatusLine: source.latestStatusLine || source.statusText || null,
    finalCompletionText: source.finalCompletionText || relayCompletion || null,
    summary,
    repoUrl: source.repoUrl ? normalizeRepoUrl(source.repoUrl) : null,
    deployUrl: source.deployUrl || source.productionUrl || null,
    commitSha: source.commitSha || source.commit?.sha || source.commit?.id || null,
    artifactUrl: source.artifactUrl || source.historyArtifactUrl || null,
    codexUiHandoff: source.codexUiHandoff || source.codexContext || null,
    inputPrompt: source.inputPrompt || promptText,
    workerPrompt: source.workerPrompt || '',
    assistantOutput: source.assistantOutput || '',
    relayCompletion,
    changedFiles: Array.isArray(source.changedFiles) ? source.changedFiles : [],
    codexEventsJsonl: source.codexEventsJsonl || '',
    metadata: {
      ...(source.metadata && typeof source.metadata === 'object' ? source.metadata : {}),
      receivedAt: new Date().toISOString(),
    },
  }
}

const indexItemFromDetail = (detail) => {
  const paths = artifactPaths(detail)

  return {
    requestId: detail.requestId,
    projectName: detail.projectName,
    projectPath: detail.projectPath,
    workstreamAlias: detail.workstreamAlias,
    codexSessionId: detail.codexSessionId,
    status: detail.status,
    createdAt: detail.createdAt,
    claimedAt: detail.claimedAt,
    finishedAt: detail.finishedAt,
    promptPreview: detail.promptPreview,
    promptText: detail.promptText,
    latestStatusLine: detail.latestStatusLine,
    finalCompletionText: detail.finalCompletionText,
    summary: detail.summary,
    repoUrl: detail.repoUrl,
    deployUrl: detail.deployUrl,
    commitSha: detail.commitSha,
    artifactUrl: detail.artifactUrl,
    detailPath: paths.metadata,
    codexContextPath: detail.codexUiHandoff ? paths.codexContext : '',
  }
}

const projectFromDetail = (detail) => ({
  name: detail.projectName,
  path: detail.projectPath || '',
  repoUrl: detail.repoUrl || '',
  deployUrl: detail.deployUrl || '',
  notes: detail.workstreamAlias ? `Workstream: ${detail.workstreamAlias}` : '',
  defaultSandboxMode: '',
})

const upsertByKey = (items, nextItem, key) => {
  const filtered = items.filter((item) => item[key] !== nextItem[key])

  return [nextItem, ...filtered]
}

const sortByCreatedAtDesc = (items) =>
  [...items].sort((left, right) => {
    const leftTime = new Date(left.createdAt || 0).getTime()
    const rightTime = new Date(right.createdAt || 0).getTime()

    return rightTime - leftTime
  })

const remoteHistoryStore = {
  async list() {
    return sortByCreatedAtDesc(await readStorageJsonl(globalIndexPath))
  },

  async get(requestId) {
    const index = await this.list()
    const item = index.find((entry) => entry.requestId === requestId)

    if (!item?.detailPath) {
      return null
    }

    return readStorageJson(item.detailPath, null)
  },

  async codexContext(requestId) {
    const index = await this.list()
    const item = index.find((entry) => entry.requestId === requestId)

    if (!item?.codexContextPath) {
      return null
    }

    return readStorageText(item.codexContextPath)
  },

  async projects() {
    const value = await readStorageJson(projectsPath, { projects: [] })

    return Array.isArray(value.projects) ? value.projects : []
  },

  async upsertProjects(projects) {
    const cleanProjects = projects
      .filter((project) => project?.name)
      .map((project) => ({
        name: project.name,
        path: project.path || project.projectPath || '',
        repoUrl: project.repoUrl ? normalizeRepoUrl(project.repoUrl) : '',
        deployUrl: project.deployUrl || '',
        notes: project.notes || '',
        defaultSandboxMode: project.defaultSandboxMode || '',
      }))

    await writeStorageJson(
      projectsPath,
      { projects: cleanProjects, updatedAt: new Date().toISOString() },
      'Update MyBrain remote projects',
    )

    return cleanProjects
  },

  async upsertSnapshot(payload) {
    return this.upsertDetail(payload)
  },

  async upsertDetail(payload) {
    const detail = normalizePayload(payload)
    const paths = artifactPaths(detail)

    await writeStorageJson(paths.metadata, detail, `Update MyBrain remote history ${detail.requestId}`)

    for (const [field, filename] of markdownFields) {
      if (detail[field]) {
        await writeStorageText(
          `${paths.base}/${filename}`,
          `${detail[field]}\n`,
          `Update MyBrain remote artifact ${detail.requestId}`,
        )
      }
    }

    if (detail.codexEventsJsonl) {
      await writeStorageText(
        paths.codexEvents,
        detail.codexEventsJsonl.endsWith('\n')
          ? detail.codexEventsJsonl
          : `${detail.codexEventsJsonl}\n`,
        `Update MyBrain Codex events ${detail.requestId}`,
      )
    }

    const indexItem = indexItemFromDetail(detail)
    const globalIndex = sortByCreatedAtDesc(
      upsertByKey(await readStorageJsonl(globalIndexPath), indexItem, 'requestId'),
    )
    const projectIndex = sortByCreatedAtDesc(
      upsertByKey(await readStorageJsonl(paths.projectIndex), indexItem, 'requestId'),
    )
    const projects = upsertByKey(await this.projects(), projectFromDetail(detail), 'name')

    await writeStorageJsonl(globalIndexPath, globalIndex, 'Update MyBrain remote history index')
    await writeStorageJsonl(paths.projectIndex, projectIndex, 'Update MyBrain project history index')
    await writeStorageJson(
      projectsPath,
      { projects, updatedAt: new Date().toISOString() },
      'Update MyBrain remote project index',
    )

    return detail
  },
}

const handleRemoteControlApi = async (request, response, url) => {
  const pathname = url.pathname

  if (request.method === 'GET' && pathname === '/api/remote-control/health') {
    json(response, 200, {
      ok: true,
      service: 'mybrain-remote-control-ingest',
      historyRepoConfigured: Boolean(historyRepo),
      historyStorage: repoConfigured() ? 'github' : 'local-json',
    })
    return
  }

  if (request.method === 'GET' && pathname === '/api/remote-control/projects') {
    json(response, 200, { projects: await remoteHistoryStore.projects() })
    return
  }

  if (request.method === 'GET' && pathname === '/api/remote-control/history') {
    json(response, 200, { history: await remoteHistoryStore.list() })
    return
  }

  const contextMatch = pathname.match(
    /^\/api\/remote-control\/history\/([^/]+)\/codex-context$/,
  )

  if (request.method === 'GET' && contextMatch) {
    const content = await remoteHistoryStore.codexContext(decodeURIComponent(contextMatch[1]))

    if (!content) {
      json(response, 404, { error: 'Codex UI handoff not found.' })
      return
    }

    text(response, 200, content, 'text/markdown; charset=utf-8')
    return
  }

  const detailMatch = pathname.match(/^\/api\/remote-control\/history\/([^/]+)$/)

  if (request.method === 'GET' && detailMatch) {
    const detail = await remoteHistoryStore.get(decodeURIComponent(detailMatch[1]))

    if (!detail) {
      json(response, 404, { error: 'Remote history detail not found.' })
      return
    }

    json(response, 200, { detail })
    return
  }

  if (request.method !== 'POST') {
    json(response, 404, { error: 'Unknown RemoteControl endpoint.' })
    return
  }

  if (!authorizeIngest(request)) {
    json(response, 401, { error: 'RemoteControl ingest token is missing or incorrect.' })
    return
  }

  const body = await readBody(request)

  if (pathname === '/api/remote-control/projects') {
    const projects = Array.isArray(body) ? body : body.projects || body.items || []
    json(response, 200, {
      ok: true,
      projects: await remoteHistoryStore.upsertProjects(projects),
    })
    return
  }

  if (pathname === '/api/remote-control/snapshots') {
    const detail = await remoteHistoryStore.upsertSnapshot(body)
    json(response, 200, { ok: true, requestId: detail.requestId, stored: true })
    return
  }

  const detailWriteMatch = pathname.match(/^\/api\/remote-control\/history\/([^/]+)$/)

  if (detailWriteMatch) {
    const detail = await remoteHistoryStore.upsertDetail({
      ...body,
      requestId: decodeURIComponent(detailWriteMatch[1]),
    })
    json(response, 200, { ok: true, requestId: detail.requestId })
    return
  }

  json(response, 404, { error: 'Unknown RemoteControl ingest endpoint.' })
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
  const requestedPath = safePath
    ? path.resolve(distPath, safePath)
    : path.join(distPath, 'index.html')
  const distRoot = `${path.resolve(distPath)}${path.sep}`
  const requestedInsideDist = requestedPath === distPath || requestedPath.startsWith(distRoot)
  const target =
    requestedInsideDist && fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()
      ? requestedPath
      : path.join(distPath, 'index.html')

  if (!fs.existsSync(target)) {
    json(response, 404, {
      error: 'Build the app first with npm run build before starting the MyBrain server.',
    })
    return
  }

  response.writeHead(200, {
    'Content-Type': contentTypeFor(target),
    'Cache-Control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000',
  })
  fs.createReadStream(target).pipe(response)
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders())
    response.end()
    return
  }

  const url = new URL(request.url || '/', `http://${request.headers.host}`)

  try {
    if (url.pathname.startsWith('/api/remote-control/')) {
      await handleRemoteControlApi(request, response, url)
      return
    }

    serveStatic(request, response)
  } catch (error) {
    json(response, error instanceof SyntaxError ? 400 : 500, {
      error: error instanceof Error ? error.message : 'MyBrain server request failed.',
    })
  }
})

server.listen(port, host, () => {
  console.log(`MyBrain server listening on http://${host}:${port}`)
  console.log(
    repoConfigured()
      ? `RemoteControl history repo: ${historyRepo}@${historyBranch}`
      : `RemoteControl history using local JSON at ${localHistoryRoot}`,
  )
})
