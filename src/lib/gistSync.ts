import type { SessionEntry, WorkItem } from '../types'
import { nowIso, sortItems, sortSessions } from './utils'

const GIST_FILENAME = 'mybrain-data.json'

type SyncDocument = {
  version: 1
  exportedAt: string
  items: WorkItem[]
}

const buildHeaders = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
})

const safeDate = (value?: string) => new Date(value ?? 0).getTime()

const pickLatest = <T extends { updatedAt: string }>(left: T, right: T) =>
  safeDate(left.updatedAt) >= safeDate(right.updatedAt) ? left : right

const mergeSessions = (
  primarySessions: SessionEntry[],
  secondarySessions: SessionEntry[],
) => {
  const merged = new Map<string, SessionEntry>()

  for (const session of secondarySessions) {
    merged.set(session.id, session)
  }

  for (const session of primarySessions) {
    const existing = merged.get(session.id)
    merged.set(session.id, existing ? pickLatest(session, existing) : session)
  }

  return sortSessions(Array.from(merged.values()))
}

const mergeOneItem = (primary: WorkItem, secondary: WorkItem): WorkItem => {
  const latest = pickLatest(primary, secondary)
  const fallback = latest.id === primary.id && latest.updatedAt === primary.updatedAt
    ? secondary
    : primary
  const sessions = mergeSessions(primary.sessions, secondary.sessions)

  return {
    ...fallback,
    ...latest,
    title: latest.title || fallback.title,
    objective: latest.objective || fallback.objective,
    tool: latest.tool || fallback.tool,
    notes: latest.notes || fallback.notes,
    tags: Array.from(new Set([...fallback.tags, ...latest.tags])),
    createdAt:
      safeDate(primary.createdAt) <= safeDate(secondary.createdAt)
        ? primary.createdAt
        : secondary.createdAt,
    updatedAt:
      safeDate(primary.updatedAt) >= safeDate(secondary.updatedAt)
        ? primary.updatedAt
        : secondary.updatedAt,
    lastTouchedAt:
      safeDate(primary.lastTouchedAt) >= safeDate(secondary.lastTouchedAt)
        ? primary.lastTouchedAt
        : secondary.lastTouchedAt,
    sessions,
  }
}

export const mergeItemCollections = (
  primaryItems: WorkItem[],
  secondaryItems: WorkItem[],
) => {
  const merged = new Map<string, WorkItem>()

  for (const item of secondaryItems) {
    merged.set(item.id, item)
  }

  for (const item of primaryItems) {
    const existing = merged.get(item.id)
    merged.set(item.id, existing ? mergeOneItem(item, existing) : item)
  }

  return sortItems(Array.from(merged.values()))
}

const encodeDocument = (items: WorkItem[]) =>
  JSON.stringify(
    {
      version: 1,
      exportedAt: nowIso(),
      items: sortItems(items),
    } satisfies SyncDocument,
    null,
    2,
  )

const decodeDocument = (raw?: string) => {
  if (!raw) {
    return { version: 1, exportedAt: nowIso(), items: [] } satisfies SyncDocument
  }

  const parsed = JSON.parse(raw) as SyncDocument

  return {
    version: 1,
    exportedAt: parsed.exportedAt ?? nowIso(),
    items: Array.isArray(parsed.items) ? parsed.items : [],
  } satisfies SyncDocument
}

export const createSecretSyncGist = async (token: string, items: WorkItem[]) => {
  const response = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      description: 'MyBrain sync store',
      public: false,
      files: {
        [GIST_FILENAME]: {
          content: encodeDocument(items),
        },
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`GitHub rejected gist creation (${response.status})`)
  }

  const payload = (await response.json()) as { id: string; updated_at: string }

  return {
    gistId: payload.id,
    syncedAt: payload.updated_at,
  }
}

export const fetchSyncDocument = async (token: string, gistId: string) => {
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: buildHeaders(token),
  })

  if (!response.ok) {
    throw new Error(`GitHub could not read gist ${gistId} (${response.status})`)
  }

  const payload = (await response.json()) as {
    files?: Record<string, { content?: string }>
    updated_at: string
  }

  return {
    document: decodeDocument(payload.files?.[GIST_FILENAME]?.content),
    syncedAt: payload.updated_at,
  }
}

export const saveSyncDocument = async (
  token: string,
  gistId: string,
  items: WorkItem[],
) => {
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: buildHeaders(token),
    body: JSON.stringify({
      files: {
        [GIST_FILENAME]: {
          content: encodeDocument(items),
        },
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`GitHub could not update gist ${gistId} (${response.status})`)
  }

  const payload = (await response.json()) as { updated_at: string }

  return {
    syncedAt: payload.updated_at,
  }
}

export const syncWithRemote = async (
  token: string,
  gistId: string,
  localItems: WorkItem[],
) => {
  const remote = await fetchSyncDocument(token, gistId)
  const mergedItems = mergeItemCollections(localItems, remote.document.items)
  const saved = await saveSyncDocument(token, gistId, mergedItems)

  return {
    items: mergedItems,
    syncedAt: saved.syncedAt,
  }
}
