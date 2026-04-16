import type { AiSessionEntry, DeployEntry, FeatureEntry, Project } from '../types'
import { normalizeStoredState } from './migrations'
import {
  normalizeRepoUrl,
  nowIso,
  sortDeploys,
  sortFeatures,
  sortProjects,
  sortSessions,
} from './utils'

const GIST_FILENAME = 'mybrain-data.json'

type SyncDocument = {
  version: 2
  exportedAt: string
  projects: Project[]
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

const preferText = (primary: string, fallback: string) =>
  primary.trim().length > 0 ? primary : fallback

const mergeCollectionById = <T extends { id: string; updatedAt: string }>(
  primary: T[],
  secondary: T[],
  sort: (values: T[]) => T[],
) => {
  const merged = new Map<string, T>()

  for (const entry of secondary) {
    merged.set(entry.id, entry)
  }

  for (const entry of primary) {
    const existing = merged.get(entry.id)
    merged.set(entry.id, existing ? pickLatest(entry, existing) : entry)
  }

  return sort(Array.from(merged.values()))
}

const mergeSessions = (primary: AiSessionEntry[], secondary: AiSessionEntry[]) =>
  mergeCollectionById(primary, secondary, sortSessions)

const mergeFeatures = (primary: FeatureEntry[], secondary: FeatureEntry[]) =>
  mergeCollectionById(primary, secondary, sortFeatures)

const mergeDeploys = (primary: DeployEntry[], secondary: DeployEntry[]) =>
  mergeCollectionById(primary, secondary, sortDeploys)

const mergeOneProject = (primary: Project, secondary: Project): Project => {
  const latest = pickLatest(primary, secondary)
  const fallback =
    latest.id === primary.id && latest.updatedAt === primary.updatedAt
      ? secondary
      : primary

  return {
    ...fallback,
    ...latest,
    name: preferText(latest.name, fallback.name),
    summary: preferText(latest.summary, fallback.summary),
    notes: preferText(latest.notes, fallback.notes),
    currentFocus: preferText(latest.currentFocus, fallback.currentFocus),
    nextAction: preferText(latest.nextAction, fallback.nextAction),
    repoUrl: normalizeRepoUrl(preferText(latest.repoUrl, fallback.repoUrl)),
    productionUrl: preferText(latest.productionUrl, fallback.productionUrl),
    localPath: preferText(latest.localPath, fallback.localPath),
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
    sessions: mergeSessions(primary.sessions, secondary.sessions),
    features: mergeFeatures(primary.features, secondary.features),
    deploys: mergeDeploys(primary.deploys, secondary.deploys),
  }
}

export const mergeProjectCollections = (
  primaryProjects: Project[],
  secondaryProjects: Project[],
) => {
  const merged = new Map<string, Project>()

  for (const project of secondaryProjects) {
    merged.set(project.id, {
      ...project,
      repoUrl: normalizeRepoUrl(project.repoUrl),
    })
  }

  for (const project of primaryProjects) {
    const normalized = {
      ...project,
      repoUrl: normalizeRepoUrl(project.repoUrl),
    }
    const existing = merged.get(normalized.id)
    merged.set(normalized.id, existing ? mergeOneProject(normalized, existing) : normalized)
  }

  return sortProjects(Array.from(merged.values()))
}

const encodeDocument = (projects: Project[]) =>
  JSON.stringify(
    {
      version: 2,
      exportedAt: nowIso(),
      projects: sortProjects(projects),
    } satisfies SyncDocument,
    null,
    2,
  )

const decodeDocument = (raw?: string) => {
  if (!raw) {
    return { version: 2, exportedAt: nowIso(), projects: [] } satisfies SyncDocument
  }

  const parsed = JSON.parse(raw)
  const state = normalizeStoredState(parsed)

  return {
    version: 2,
    exportedAt: parsed.exportedAt ?? nowIso(),
    projects: state.projects,
  } satisfies SyncDocument
}

export const createSecretSyncGist = async (token: string, projects: Project[]) => {
  const response = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      description: 'MyBrain sync store',
      public: false,
      files: {
        [GIST_FILENAME]: {
          content: encodeDocument(projects),
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
  projects: Project[],
) => {
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: buildHeaders(token),
    body: JSON.stringify({
      files: {
        [GIST_FILENAME]: {
          content: encodeDocument(projects),
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
  localProjects: Project[],
) => {
  const remote = await fetchSyncDocument(token, gistId)
  const mergedProjects = mergeProjectCollections(localProjects, remote.document.projects)
  const saved = await saveSyncDocument(token, gistId, mergedProjects)

  return {
    projects: mergedProjects,
    syncedAt: saved.syncedAt,
  }
}
