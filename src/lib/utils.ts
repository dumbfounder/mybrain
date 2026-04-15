import type { Priority, SessionEntry, ToolName, WorkItem, WorkStatus } from '../types'

export const STATUS_OPTIONS: Array<{ value: WorkStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'parked', label: 'Parked' },
  { value: 'done', label: 'Done' },
]

export const PRIORITY_OPTIONS: Array<{ value: Priority; label: string }> = [
  { value: 'now', label: 'Now' },
  { value: 'soon', label: 'Soon' },
  { value: 'later', label: 'Later' },
]

export const TOOL_OPTIONS: ToolName[] = [
  'ChatGPT',
  'Codex',
  'Claude',
  'Gemini',
  'Cursor',
  'Perplexity',
  'Other',
]

export const nowIso = () => new Date().toISOString()

export const generateId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

export const normalizeWhitespace = (value: string) =>
  value.replace(/\s+/g, ' ').trim()

export const truncateText = (value: string, limit = 240) => {
  const clean = value.trim()

  if (clean.length <= limit) {
    return clean
  }

  return `${clean.slice(0, limit).trimEnd()}...`
}

export const excerpt = (value: string, limit = 180) =>
  truncateText(normalizeWhitespace(value), limit)

export const normalizeTags = (value: string) =>
  Array.from(
    new Set(
      value
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  )

export const sortSessions = (sessions: SessionEntry[]) =>
  [...sessions].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  )

export const getLatestSession = (item: WorkItem) => sortSessions(item.sessions)[0] ?? null

export const sortItems = (items: WorkItem[]) =>
  [...items].sort((left, right) => {
    const priorityRank = { now: 0, soon: 1, later: 2 }
    const statusRank = { active: 0, waiting: 1, parked: 2, done: 3 }
    const priorityDelta = priorityRank[left.priority] - priorityRank[right.priority]

    if (priorityDelta !== 0) {
      return priorityDelta
    }

    const statusDelta = statusRank[left.status] - statusRank[right.status]

    if (statusDelta !== 0) {
      return statusDelta
    }

    return (
      new Date(right.lastTouchedAt).getTime() -
      new Date(left.lastTouchedAt).getTime()
    )
  })

export const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))

export const formatRelative = (value: string) => {
  const deltaMs = new Date(value).getTime() - Date.now()
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 1000 * 60 * 60 * 24 * 365],
    ['month', 1000 * 60 * 60 * 24 * 30],
    ['week', 1000 * 60 * 60 * 24 * 7],
    ['day', 1000 * 60 * 60 * 24],
    ['hour', 1000 * 60 * 60],
    ['minute', 1000 * 60],
  ]

  for (const [unit, size] of ranges) {
    if (Math.abs(deltaMs) >= size || unit === 'minute') {
      return formatter.format(Math.round(deltaMs / size), unit)
    }
  }

  return 'just now'
}

export const hasText = (value: string) => value.trim().length > 0

export const countStaleItems = (items: WorkItem[], ageDays = 7) => {
  const threshold = Date.now() - ageDays * 24 * 60 * 60 * 1000

  return items.filter(
    (item) =>
      item.status !== 'done' && new Date(item.lastTouchedAt).getTime() < threshold,
  ).length
}
