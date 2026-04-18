export type RemoteControlHealth = {
  ok: boolean
  process?: {
    pid: number
    uptimeSeconds: number
  }
  queue?: {
    queued: number
    running: number
    ok: number
    blocked: number
    failed: number
  }
}

export type RemoteControlProject = {
  name: string
  path: string
  repoUrl?: string
  deployUrl?: string
  notes?: string
  defaultSandboxMode?: string
}

export type RemoteHistoryStatus = 'queued' | 'running' | 'ok' | 'blocked' | 'failed'

export type RemoteHistoryItem = {
  requestId: string
  projectName: string
  projectPath?: string
  workstreamAlias?: string | null
  codexSessionId?: string | null
  status: RemoteHistoryStatus
  createdAt: string
  claimedAt?: string | null
  finishedAt?: string | null
  promptPreview?: string
  promptText?: string
  latestStatusLine?: string | null
  finalCompletionText?: string | null
  summary?: string | null
  repoUrl?: string | null
  deployUrl?: string | null
  commitSha?: string | null
  artifactUrl?: string | null
  codexUiHandoff?: string | null
}

export type RemoteHistoryDetail = RemoteHistoryItem & {
  inputPrompt?: string
  workerPrompt?: string
  assistantOutput?: string
  relayCompletion?: string
  changedFiles?: string[]
  codexEventsUrl?: string
  codexEventsJsonl?: string
  metadata?: Record<string, unknown>
}

export type RemoteHistoryMode = 'local' | 'server'

const hostedHistoryMode = () => {
  if (typeof window === 'undefined') {
    return false
  }

  const hostname = window.location.hostname

  return hostname.includes('onrender.com') || hostname.includes('github.io')
}

export const DEFAULT_REMOTE_HISTORY_MODE: RemoteHistoryMode =
  import.meta.env.VITE_REMOTE_HISTORY_MODE === 'server' || hostedHistoryMode()
    ? 'server'
    : 'local'

export const DEFAULT_LOCAL_REMOTE_CONTROL_URL =
  import.meta.env.VITE_REMOTE_CONTROL_URL?.trim() || 'http://127.0.0.1:3187'

export const DEFAULT_MYBRAIN_API_BASE = import.meta.env.VITE_MYBRAIN_API_BASE?.trim() || ''

export const DEFAULT_REMOTE_CONTROL_URL =
  DEFAULT_REMOTE_HISTORY_MODE === 'server'
    ? DEFAULT_MYBRAIN_API_BASE
    : DEFAULT_LOCAL_REMOTE_CONTROL_URL

export class RemoteControlHttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'RemoteControlHttpError'
    this.status = status
  }
}

export const normalizeRemoteControlUrl = (value: string) =>
  value.trim().replace(/\/+$/, '') || DEFAULT_REMOTE_CONTROL_URL

const apiPathFor = (mode: RemoteHistoryMode, path: string) =>
  mode === 'server'
    ? `/api/remote-control${path.replace(/^\/api/, '')}`
    : path

const fetchJson = async <T>(
  baseUrl: string,
  path: string,
  mode: RemoteHistoryMode,
  signal?: AbortSignal,
) => {
  const response = await fetch(`${normalizeRemoteControlUrl(baseUrl)}${apiPathFor(mode, path)}`, {
    signal,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const message =
      typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : `RemoteControl request failed (${response.status})`

    throw new RemoteControlHttpError(response.status, message)
  }

  return (await response.json()) as T
}

const arrayFromResponse = <T>(value: unknown, keys: string[]) => {
  if (Array.isArray(value)) {
    return value as T[]
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>

    for (const key of keys) {
      if (Array.isArray(record[key])) {
        return record[key] as T[]
      }
    }
  }

  return []
}

const objectFromResponse = <T>(value: unknown, keys: string[]) => {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>

    for (const key of keys) {
      if (record[key] && typeof record[key] === 'object') {
        return record[key] as T
      }
    }

    return value as T
  }

  return null
}

export const getHealth = (
  baseUrl = DEFAULT_REMOTE_CONTROL_URL,
  signal?: AbortSignal,
  mode = DEFAULT_REMOTE_HISTORY_MODE,
) => fetchJson<RemoteControlHealth>(baseUrl, '/api/health', mode, signal)

export const getProjects = async (
  baseUrl = DEFAULT_REMOTE_CONTROL_URL,
  signal?: AbortSignal,
  mode = DEFAULT_REMOTE_HISTORY_MODE,
) => {
  const value = await fetchJson<unknown>(baseUrl, '/api/projects', mode, signal)

  return arrayFromResponse<RemoteControlProject>(value, ['projects', 'items'])
}

export const getHistory = async (
  baseUrl = DEFAULT_REMOTE_CONTROL_URL,
  signal?: AbortSignal,
  mode = DEFAULT_REMOTE_HISTORY_MODE,
) => {
  const value = await fetchJson<unknown>(baseUrl, '/api/history', mode, signal)

  return arrayFromResponse<RemoteHistoryItem>(value, ['history', 'items', 'requests'])
}

export const getHistoryDetail = async (
  requestId: string,
  baseUrl = DEFAULT_REMOTE_CONTROL_URL,
  signal?: AbortSignal,
  mode = DEFAULT_REMOTE_HISTORY_MODE,
) => {
  const value = await fetchJson<unknown>(
    baseUrl,
    `/api/history/${encodeURIComponent(requestId)}`,
    mode,
    signal,
  )

  return objectFromResponse<RemoteHistoryDetail>(value, ['detail', 'item', 'request'])
}
