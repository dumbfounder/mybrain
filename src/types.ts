export type WorkStatus = 'active' | 'waiting' | 'parked' | 'done'

export type Priority = 'now' | 'soon' | 'later'

export type ToolName =
  | 'ChatGPT'
  | 'Codex'
  | 'Claude'
  | 'Gemini'
  | 'Cursor'
  | 'Perplexity'
  | 'Other'

export type SessionSource = 'manual' | 'chatgpt-export' | 'share-target'

export type SessionEntry = {
  id: string
  tool: ToolName
  prompt: string
  result: string
  nextPrompt: string
  link: string
  createdAt: string
  updatedAt: string
  source: SessionSource
}

export type WorkItem = {
  id: string
  title: string
  objective: string
  status: WorkStatus
  priority: Priority
  tool: ToolName
  tags: string[]
  notes: string
  createdAt: string
  updatedAt: string
  lastTouchedAt: string
  sessions: SessionEntry[]
  source: SessionSource
}

export type SyncConfig = {
  provider: 'github-gist'
  gistId: string
  token: string
  lastSyncedAt?: string
  lastSyncStatus?: string
}

export type StoredState = {
  items: WorkItem[]
  sync?: SyncConfig
}
