import type { BridgeConfig } from '../types'

export type BridgeHealth = {
  ok: boolean
  mode?: 'local' | 'relay'
  basePath?: string
  codexPath?: string
  renderAvailable?: boolean
  tokenRequired: boolean
  passwordRequired?: boolean
  agent?: {
    online?: boolean
    hostname?: string
    lastSeenAt?: string
  }
}

export type BridgeStreamEvent =
  | { type: 'bridge'; message: string }
  | { type: 'thread'; threadId: string }
  | { type: 'assistant'; text: string }
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'codex-event'; event: unknown }
  | { type: 'turn-completed'; usage?: unknown }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string }

export const normalizeBridgeUrl = (value: string) => value.trim().replace(/\/+$/, '')

const headersFor = (token: string) => ({
  'Content-Type': 'application/json',
  ...(token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
})

export const bridgeJson = async <T>(
  bridgeUrl: string,
  token: string,
  path: string,
  options: RequestInit = {},
) => {
  const response = await fetch(`${normalizeBridgeUrl(bridgeUrl)}${path}`, {
    ...options,
    headers: headersFor(token),
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `Bridge request failed (${response.status})`)
  }

  return (await response.json()) as T
}

type CodexTurnBody = {
  cwd: string
  prompt: string
  projectId: string
  projectName?: string
  sessionId?: string
}

type RelaySnapshot = {
  done?: boolean
  phase?: string | null
  statusText?: string | null
  relayStatus?: string | null
  relayCompletion?: string | null
  codexActivity?: string | null
  result?: { message?: string } | null
  resultText?: string | null
  error?: string | null
}

const detectBridgeMode = async (bridge: BridgeConfig) => {
  if (bridge.mode !== 'auto') {
    return bridge.mode
  }

  const health = await bridgeJson<BridgeHealth>(bridge.url, bridge.token, '/api/health')
  return health.mode === 'relay' ? 'codexremote-relay' : 'mybrain-local'
}

const streamLocalCodexTurn = async (
  bridge: BridgeConfig,
  body: CodexTurnBody,
  onEvent: (event: BridgeStreamEvent) => void,
) => {
  const response = await fetch(`${normalizeBridgeUrl(bridge.url)}/api/codex/run`, {
    method: 'POST',
    headers: headersFor(bridge.token),
    body: JSON.stringify({
      ...body,
      sandbox: bridge.sandbox,
      model: bridge.model.trim() || undefined,
    }),
  })

  if (!response.ok || !response.body) {
    throw new Error(`Codex bridge rejected the run (${response.status})`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()

      if (!trimmed) {
        continue
      }

      onEvent(JSON.parse(trimmed) as BridgeStreamEvent)
    }
  }

  const tail = buffer.trim()

  if (tail) {
    onEvent(JSON.parse(tail) as BridgeStreamEvent)
  }
}

const snapshotText = (snapshot: RelaySnapshot) =>
  snapshot.result?.message ||
  snapshot.resultText ||
  snapshot.relayCompletion ||
  snapshot.error ||
  ''

const streamRelayEvents = async (
  bridge: BridgeConfig,
  requestId: string,
  onEvent: (event: BridgeStreamEvent) => void,
) => {
  const response = await fetch(
    `${normalizeBridgeUrl(bridge.url)}/api/events/${encodeURIComponent(requestId)}`,
    {
      headers: headersFor(bridge.token),
    },
  )

  if (!response.ok || !response.body) {
    throw new Error(`Relay event stream failed (${response.status})`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastStatus = ''

  const handleBlock = (block: string) => {
    let eventName = 'message'
    const dataLines: string[] = []

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim()
      }

      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart())
      }
    }

    if (!dataLines.length) {
      return
    }

    const snapshot = JSON.parse(dataLines.join('\n')) as RelaySnapshot
    const status =
      snapshot.relayStatus ||
      snapshot.codexActivity ||
      snapshot.statusText ||
      snapshot.phase ||
      ''

    if (status && status !== lastStatus) {
      lastStatus = status
      onEvent({ type: 'log', stream: 'stdout', text: status })
    }

    if (eventName === 'done' || snapshot.done) {
      const text = snapshotText(snapshot)

      if (snapshot.error) {
        onEvent({ type: 'error', message: snapshot.error })
      } else if (text) {
        onEvent({ type: 'assistant', text })
      }

      onEvent({ type: 'turn-completed' })
      onEvent({ type: 'exit', code: snapshot.error ? 1 : 0 })
    }
  }

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ''
    blocks.forEach(handleBlock)
  }

  if (buffer.trim()) {
    handleBlock(buffer)
  }
}

const streamCodexRemoteRelayTurn = async (
  bridge: BridgeConfig,
  body: CodexTurnBody,
  onEvent: (event: BridgeStreamEvent) => void,
) => {
  const queued = await bridgeJson<{ requestId: string; message: string }>(
    bridge.url,
    bridge.token,
    '/api/command',
    {
      method: 'POST',
      body: JSON.stringify({
        text: body.prompt,
        projectPath: body.cwd,
        projectName: body.projectName || body.projectId,
      }),
    },
  )

  onEvent({ type: 'bridge', message: queued.message })
  await streamRelayEvents(bridge, queued.requestId, onEvent)
}

export const streamCodexTurn = async (
  bridge: BridgeConfig,
  body: CodexTurnBody,
  onEvent: (event: BridgeStreamEvent) => void,
) => {
  const normalizedBridge = {
    ...bridge,
    url: normalizeBridgeUrl(bridge.url),
  }
  const mode = await detectBridgeMode(normalizedBridge)

  if (mode === 'codexremote-relay') {
    await streamCodexRemoteRelayTurn(normalizedBridge, body, onEvent)
    return
  }

  await streamLocalCodexTurn(normalizedBridge, body, onEvent)
}
