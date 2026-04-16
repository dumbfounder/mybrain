import type {
  AiSessionEntry,
  DeployEntry,
  DeployEnvironment,
  DeployProvider,
  DeployStatus,
  FeatureEntry,
  FeatureStatus,
  Priority,
  Project,
  ProjectStage,
  ProjectStatus,
  ToolName,
} from '../types'

export const PROJECT_STATUS_OPTIONS: Array<{ value: ProjectStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
]

export const PROJECT_STAGE_OPTIONS: Array<{ value: ProjectStage; label: string }> = [
  { value: 'idea', label: 'Idea' },
  { value: 'building', label: 'Building' },
  { value: 'testing', label: 'Testing' },
  { value: 'live', label: 'Live' },
  { value: 'maintaining', label: 'Maintaining' },
]

export const PRIORITY_OPTIONS: Array<{ value: Priority; label: string }> = [
  { value: 'now', label: 'Now' },
  { value: 'soon', label: 'Soon' },
  { value: 'later', label: 'Later' },
]

export const TOOL_OPTIONS: ToolName[] = [
  'Codex',
  'ChatGPT',
  'Claude',
  'Gemini',
  'Cursor',
  'Perplexity',
  'Other',
]

export const FEATURE_STATUS_OPTIONS: Array<{ value: FeatureStatus; label: string }> = [
  { value: 'planned', label: 'Planned' },
  { value: 'building', label: 'Building' },
  { value: 'shipped', label: 'Shipped' },
]

export const DEPLOY_PROVIDER_OPTIONS: DeployProvider[] = [
  'Render',
  'Vercel',
  'Netlify',
  'Railway',
  'Fly',
  'GitHub Pages',
  'Other',
]

export const DEPLOY_ENV_OPTIONS: Array<{ value: DeployEnvironment; label: string }> = [
  { value: 'production', label: 'Production' },
  { value: 'preview', label: 'Preview' },
  { value: 'staging', label: 'Staging' },
  { value: 'worker', label: 'Worker' },
  { value: 'other', label: 'Other' },
]

export const DEPLOY_STATUS_OPTIONS: Array<{ value: DeployStatus; label: string }> = [
  { value: 'live', label: 'Live' },
  { value: 'building', label: 'Building' },
  { value: 'failed', label: 'Failed' },
  { value: 'draft', label: 'Draft' },
]

export const nowIso = () => new Date().toISOString()

export const generateId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

export const buildStableId = (prefix: string, value: string) => {
  let hash = 0

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  }

  return `${prefix}-${hash.toString(16)}`
}

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

export const normalizeRepoUrl = (value: string) => {
  const trimmed = value.trim()

  if (!trimmed) {
    return ''
  }

  if (trimmed.startsWith('git@github.com:')) {
    const path = trimmed.replace('git@github.com:', '').replace(/\.git$/, '')
    return `https://github.com/${path}`
  }

  return trimmed.replace(/\.git$/, '')
}

export const hostFromUrl = (value: string) => {
  if (!value.trim()) {
    return ''
  }

  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export const sortSessions = (sessions: AiSessionEntry[]) =>
  [...sessions].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  )

export const sortFeatures = (features: FeatureEntry[]) =>
  [...features].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  )

export const sortDeploys = (deploys: DeployEntry[]) =>
  [...deploys].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  )

export const getLatestSession = (project: Project) => sortSessions(project.sessions)[0] ?? null

export const getLatestDeploy = (project: Project) => sortDeploys(project.deploys)[0] ?? null

const safeTime = (value?: string) => {
  const time = value ? new Date(value).getTime() : 0

  return Number.isFinite(time) ? time : 0
}

export const projectEngagementTime = (project: Project) =>
  Math.max(
    safeTime(project.lastTouchedAt),
    safeTime(project.updatedAt),
    ...project.sessions.map((session) => safeTime(session.updatedAt)),
    ...project.features.map((feature) => safeTime(feature.updatedAt)),
    ...project.deploys.map((deploy) => safeTime(deploy.updatedAt)),
  )

export const sortProjects = (projects: Project[]) =>
  [...projects].sort((left, right) => {
    const priorityRank = { now: 0, soon: 1, later: 2 }
    const statusRank = { active: 0, blocked: 1, paused: 2, done: 3 }
    const stageRank = { live: 0, building: 1, testing: 2, maintaining: 3, idea: 4 }
    const engagementDelta = projectEngagementTime(right) - projectEngagementTime(left)

    if (engagementDelta !== 0) {
      return engagementDelta
    }

    const priorityDelta = priorityRank[left.priority] - priorityRank[right.priority]

    if (priorityDelta !== 0) {
      return priorityDelta
    }

    const statusDelta = statusRank[left.status] - statusRank[right.status]

    if (statusDelta !== 0) {
      return statusDelta
    }

    const stageDelta = stageRank[left.stage] - stageRank[right.stage]

    if (stageDelta !== 0) {
      return stageDelta
    }

    return left.name.localeCompare(right.name)
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

export const countStaleProjects = (projects: Project[], ageDays = 7) => {
  const threshold = Date.now() - ageDays * 24 * 60 * 60 * 1000

  return projects.filter(
    (project) =>
      project.status !== 'done' &&
      new Date(project.lastTouchedAt).getTime() < threshold,
  ).length
}

export const countLiveProjects = (projects: Project[]) =>
  projects.filter((project) => {
    const latestDeploy = getLatestDeploy(project)
    return project.stage === 'live' || latestDeploy?.status === 'live'
  }).length

export const countShippedFeatures = (projects: Project[]) =>
  projects.reduce(
    (count, project) =>
      count +
      project.features.filter((feature) => feature.status === 'shipped').length,
    0,
  )
