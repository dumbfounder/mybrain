import type { AiSessionEntry, Project, StoredState } from '../types'
import { normalizeRepoUrl, sortProjects } from './utils'

type LegacySession = AiSessionEntry

type LegacyWorkItem = {
  id: string
  title: string
  objective: string
  status: 'active' | 'waiting' | 'parked' | 'done'
  priority: 'now' | 'soon' | 'later'
  tool: Project['tool']
  tags: string[]
  notes: string
  createdAt: string
  updatedAt: string
  lastTouchedAt: string
  sessions: LegacySession[]
  source: Project['source']
}

type LegacyStoredState = {
  items?: LegacyWorkItem[]
  sync?: StoredState['sync']
}

const migrateLegacyItem = (item: LegacyWorkItem): Project => {
  const status =
    item.status === 'waiting'
      ? 'blocked'
      : item.status === 'parked'
        ? 'paused'
        : item.status
  const latestSession = item.sessions[0]

  return {
    id: item.id,
    name: item.title,
    summary: item.objective,
    status,
    stage: item.status === 'done' ? 'maintaining' : 'building',
    priority: item.priority,
    tool: item.tool,
    tags: item.tags,
    notes: item.notes,
    currentFocus: latestSession?.result ?? item.objective,
    nextAction: latestSession?.nextPrompt ?? '',
    repoUrl: '',
    productionUrl: '',
    localPath: '',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastTouchedAt: item.lastTouchedAt,
    features: [],
    deploys: [],
    sessions: item.sessions,
    source: item.source,
  }
}

export const normalizeStoredState = (value: unknown): StoredState => {
  if (!value || typeof value !== 'object') {
    return { projects: [] }
  }

  const candidate = value as StoredState & LegacyStoredState

  if (Array.isArray(candidate.projects)) {
    return {
      projects: sortProjects(
        candidate.projects.map((project) => ({
          ...project,
          repoUrl: normalizeRepoUrl(project.repoUrl),
        })),
      ),
      sync: candidate.sync,
    }
  }

  if (Array.isArray(candidate.items)) {
    return {
      projects: sortProjects(candidate.items.map(migrateLegacyItem)),
      sync: candidate.sync,
    }
  }

  return { projects: [] }
}
