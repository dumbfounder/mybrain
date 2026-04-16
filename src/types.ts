export type ProjectStatus = 'active' | 'blocked' | 'paused' | 'done'

export type ProjectStage = 'idea' | 'building' | 'testing' | 'live' | 'maintaining'

export type Priority = 'now' | 'soon' | 'later'

export type ToolName =
  | 'Codex'
  | 'ChatGPT'
  | 'Claude'
  | 'Gemini'
  | 'Cursor'
  | 'Perplexity'
  | 'Other'

export type ProjectSource = 'manual' | 'chatgpt-export' | 'share-target' | 'local-scan'

export type FeatureStatus = 'planned' | 'building' | 'shipped'

export type DeployProvider =
  | 'Render'
  | 'Vercel'
  | 'Netlify'
  | 'Railway'
  | 'Fly'
  | 'GitHub Pages'
  | 'Other'

export type DeployEnvironment =
  | 'production'
  | 'preview'
  | 'staging'
  | 'worker'
  | 'other'

export type DeployStatus = 'live' | 'building' | 'failed' | 'draft'

export type AiSessionEntry = {
  id: string
  tool: ToolName
  prompt: string
  result: string
  nextPrompt: string
  link: string
  createdAt: string
  updatedAt: string
  source: ProjectSource
}

export type FeatureEntry = {
  id: string
  title: string
  status: FeatureStatus
  summary: string
  notes: string
  createdAt: string
  updatedAt: string
  shippedAt?: string
}

export type DeployEntry = {
  id: string
  provider: DeployProvider
  environment: DeployEnvironment
  status: DeployStatus
  url: string
  commit: string
  notes: string
  createdAt: string
  updatedAt: string
}

export type Project = {
  id: string
  name: string
  summary: string
  status: ProjectStatus
  stage: ProjectStage
  priority: Priority
  tool: ToolName
  tags: string[]
  notes: string
  currentFocus: string
  nextAction: string
  repoUrl: string
  productionUrl: string
  localPath: string
  createdAt: string
  updatedAt: string
  lastTouchedAt: string
  features: FeatureEntry[]
  deploys: DeployEntry[]
  sessions: AiSessionEntry[]
  source: ProjectSource
}

export type SyncConfig = {
  provider: 'github-gist'
  gistId: string
  token: string
  lastSyncedAt?: string
  lastSyncStatus?: string
}

export type StoredState = {
  projects: Project[]
  sync?: SyncConfig
}

export type SnapshotService = {
  id: string
  name: string
  type: string
  url?: string
  lastDeployStatus?: string
  lastDeployAt?: string
  lastDeployCommit?: string
}

export type SnapshotProject = {
  id?: string
  name: string
  description?: string
  repoUrl?: string
  localPath?: string
  path?: string
  active?: boolean
  branch?: string
  dirty?: boolean
  lastCommitHash?: string
  lastCommitMessage?: string
  lastCommitDate?: string
  tags?: string[]
  services?: SnapshotService[]
}

export type LocalProjectSnapshot = {
  version: 1
  mode?: 'local' | 'relay'
  agent?: {
    online?: boolean
    hostname?: string
    lastSeenAt?: string
  }
  exportedAt: string
  basePath?: string
  projects: SnapshotProject[]
}

export type PromptWrapper = {
  before: string
  after: string
  includeProjectContext: boolean
  requireStatusSummary: boolean
  requireVerification: boolean
  protectUserChanges: boolean
}

export type ConsoleMessageRole = 'user' | 'assistant' | 'system' | 'event'

export type ConsoleMessage = {
  id: string
  projectId: string
  role: ConsoleMessageRole
  text: string
  createdAt: string
  rawPrompt?: string
  sentPrompt?: string
}

export type BridgeConfig = {
  mode: 'auto' | 'mybrain-local' | 'codexremote-relay'
  url: string
  token: string
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  model: string
}
