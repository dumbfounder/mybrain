import type { BridgeConfig } from '../types'

export type BridgeHealth = {
  ok: boolean
  basePath: string
  codexPath: string
  renderAvailable: boolean
  tokenRequired: boolean
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
) => {
  const response = await fetch(`${normalizeBridgeUrl(bridgeUrl)}${path}`, {
    headers: headersFor(token),
  })

  if (!response.ok) {
    throw new Error(`Bridge request failed (${response.status})`)
  }

  return (await response.json()) as T
}

export const streamCodexTurn = async (
  bridge: BridgeConfig,
  body: {
    cwd: string
    prompt: string
    projectId: string
    sessionId?: string
  },
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
