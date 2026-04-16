import JSZip from 'jszip'
import type { AiSessionEntry, Project } from '../types'
import { buildStableId, excerpt, generateId, nowIso, truncateText } from './utils'

type ExportConversation = {
  id?: string
  title?: string
  create_time?: number | null
  update_time?: number | null
  mapping?: Record<
    string,
    {
      message?: {
        author?: { role?: string }
        content?: {
          parts?: Array<string | { text?: string }>
        }
        create_time?: number | null
        update_time?: number | null
      }
    }
  >
}

type FlatMessage = {
  role: string
  text: string
  time: number
}

const toIso = (value?: number | string | null) => {
  if (typeof value === 'string') {
    return new Date(value).toISOString()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString()
  }

  return nowIso()
}

const extractText = (parts?: Array<string | { text?: string }>) =>
  (parts ?? [])
    .map((part) => {
      if (typeof part === 'string') {
        return part
      }

      return part.text ?? ''
    })
    .join('\n')
    .trim()

const flattenConversation = (conversation: ExportConversation): FlatMessage[] => {
  const values = Object.values(conversation.mapping ?? {})

  return values
    .map((node) => {
      const role = node.message?.author?.role ?? ''
      const text = extractText(node.message?.content?.parts)
      const time =
        node.message?.create_time ??
        node.message?.update_time ??
        conversation.update_time ??
        conversation.create_time ??
        0

      return { role, text, time }
    })
    .filter((message) => message.role && message.text)
    .sort((left, right) => left.time - right.time)
}

const buildLatestSession = (conversation: ExportConversation, messages: FlatMessage[]) => {
  const lastUserIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user')
    .pop()

  if (!lastUserIndex) {
    return null
  }

  const reply = messages
    .slice(lastUserIndex.index + 1)
    .find((message) => message.role === 'assistant')

  const createdAt = toIso(lastUserIndex.message.time)
  const updatedAt = toIso(reply?.time ?? conversation.update_time ?? conversation.create_time)

  return {
    id: conversation.id
      ? buildStableId('session', `chatgpt-${conversation.id}-latest`)
      : generateId(),
    tool: 'ChatGPT',
    prompt: truncateText(lastUserIndex.message.text, 1400),
    result: truncateText(reply?.text ?? '', 1800),
    nextPrompt: '',
    link: '',
    createdAt,
    updatedAt,
    source: 'chatgpt-export',
  } satisfies AiSessionEntry
}

const buildImportedProject = (conversation: ExportConversation): Project | null => {
  const messages = flattenConversation(conversation)
  const userMessages = messages.filter((message) => message.role === 'user')

  if (userMessages.length === 0) {
    return null
  }

  const latestSession = buildLatestSession(conversation, messages)

  if (!latestSession) {
    return null
  }

  const firstUserText = userMessages[0]?.text ?? ''
  const name =
    conversation.title?.trim() ||
    excerpt(firstUserText, 52) ||
    `Imported chat ${conversation.id ?? generateId()}`
  const createdAt = toIso(conversation.create_time)
  const updatedAt = toIso(conversation.update_time ?? latestSession.updatedAt)
  const stableSeed = conversation.id ?? `${name}-${createdAt}`

  return {
    id: buildStableId('project', `chatgpt-${stableSeed}`),
    name,
    summary: excerpt(firstUserText, 180),
    status: 'paused',
    stage: 'idea',
    priority: 'soon',
    tool: 'ChatGPT',
    tags: ['chatgpt', 'imported'],
    notes: [
      `Imported from a ChatGPT export on ${new Date().toLocaleDateString()}.`,
      `Tracked messages: ${messages.length}.`,
      'Latest AI exchange only is stored so the tracker stays lightweight for phone sync.',
    ].join(' '),
    currentFocus: excerpt(latestSession.result, 180),
    nextAction: latestSession.nextPrompt,
    repoUrl: '',
    productionUrl: '',
    localPath: '',
    createdAt,
    updatedAt,
    lastTouchedAt: updatedAt,
    features: [],
    deploys: [],
    sessions: [latestSession],
    source: 'chatgpt-export',
  }
}

const loadConversationArray = async (file: File) => {
  const lowerName = file.name.toLowerCase()

  if (lowerName.endsWith('.zip')) {
    const archive = await JSZip.loadAsync(await file.arrayBuffer())
    const entry =
      archive.file(/(^|\/)conversations\.json$/i)[0] ??
      archive.file(/(^|\/)chat\.json$/i)[0]

    if (!entry) {
      throw new Error('The export zip does not contain conversations.json')
    }

    return JSON.parse(await entry.async('text')) as ExportConversation[]
  }

  return JSON.parse(await file.text()) as ExportConversation[]
}

export const importChatGptFile = async (file: File) => {
  const conversations = await loadConversationArray(file)
  const projects = conversations
    .map(buildImportedProject)
    .filter((project): project is Project => project !== null)
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )

  return {
    projects,
    count: projects.length,
  }
}
