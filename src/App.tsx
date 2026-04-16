import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import {
  bridgeJson,
  normalizeBridgeUrl,
  streamCodexTurn,
  type BridgeHealth,
  type BridgeStreamEvent,
} from './lib/codexBridge'
import { mergeProjectCollections } from './lib/gistSync'
import { importProjectSnapshotValue } from './lib/projectSnapshotImport'
import { buildCodexPrompt, defaultPromptWrapper } from './lib/promptWrapper'
import { loadState, saveState } from './lib/storage'
import {
  excerpt,
  formatDateTime,
  formatRelative,
  generateId,
  getLatestDeploy,
  hasText,
  hostFromUrl,
  nowIso,
  DEPLOY_STATUS_OPTIONS,
  PRIORITY_OPTIONS,
  PROJECT_STAGE_OPTIONS,
  PROJECT_STATUS_OPTIONS,
  projectEngagementTime,
  sortProjects,
  sortSessions,
} from './lib/utils'
import type {
  BridgeConfig,
  ConsoleMessage,
  LocalProjectSnapshot,
  Priority,
  Project,
  ProjectStage,
  ProjectStatus,
  PromptWrapper,
} from './types'

type AppTab = 'chat' | 'queue' | 'projects' | 'settings' | 'memory'

type ConsoleThread = {
  id: string
  projectId: string
  title: string
  codexSessionId: string
  createdAt: string
  updatedAt: string
}

type QueuedPromptStatus = 'queued' | 'running' | 'failed'

type QueuedPrompt = {
  id: string
  projectId: string
  text: string
  status: QueuedPromptStatus
  createdAt: string
  updatedAt: string
  error?: string
}

type ConsoleSettings = {
  bridge: BridgeConfig
  wrapper: PromptWrapper
  selectedProjectId: string
  threadsByProject: Record<string, ConsoleThread[]>
  activeThreadIdsByProject: Record<string, string>
  messagesByThread: Record<string, ConsoleMessage[]>
  inputDraftsByProject: Record<string, string>
  queuedPromptsByProject: Record<string, QueuedPrompt[]>
}

type StoredConsoleSettings = Partial<ConsoleSettings> & {
  messagesByProject?: Record<string, ConsoleMessage[]>
  sessionIdsByProject?: Record<string, string>
}

const CONSOLE_STORAGE_KEY = 'mybrain-codex-console-v1'
const CODEXREMOTE_RELAY_URL = 'https://codexremote.onrender.com'

const tabs: { id: AppTab; label: string }[] = [
  { id: 'chat', label: 'Current' },
  { id: 'queue', label: 'Queue' },
  { id: 'projects', label: 'Projects' },
  { id: 'settings', label: 'Settings' },
  { id: 'memory', label: 'Memory' },
]

const isHostedMyBrain = () => {
  const hostname = window.location.hostname

  return hostname === 'mybrain-ai-tracker.onrender.com' || hostname.includes('github.io')
}

const defaultBridgeMode = (): BridgeConfig['mode'] =>
  isHostedMyBrain() ? 'codexremote-relay' : 'auto'

const defaultBridgeUrl = () => {
  const hostname = window.location.hostname

  if (isHostedMyBrain()) {
    return CODEXREMOTE_RELAY_URL
  }

  if (hostname.includes('onrender.com')) {
    return ''
  }

  return window.location.origin
}

const migrateLegacyThreads = (parsed: StoredConsoleSettings) => {
  const threadsByProject: Record<string, ConsoleThread[]> = {}
  const activeThreadIdsByProject: Record<string, string> = {}
  const messagesByThread: Record<string, ConsoleMessage[]> = {}
  const projectIds = new Set([
    ...Object.keys(parsed.messagesByProject ?? {}),
    ...Object.keys(parsed.sessionIdsByProject ?? {}),
  ])
  const timestamp = nowIso()

  for (const projectId of projectIds) {
    const codexSessionId = parsed.sessionIdsByProject?.[projectId] ?? ''
    const threadId = codexSessionId || `legacy-${projectId}`

    threadsByProject[projectId] = [
      {
        id: threadId,
        projectId,
        title: 'Current thread',
        codexSessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]
    activeThreadIdsByProject[projectId] = threadId
    messagesByThread[threadId] = parsed.messagesByProject?.[projectId] ?? []
  }

  return { threadsByProject, activeThreadIdsByProject, messagesByThread }
}

const defaultConsoleSettings = (): ConsoleSettings => ({
  bridge: {
    mode: defaultBridgeMode(),
    url: defaultBridgeUrl(),
    token: '',
    sandbox: 'workspace-write',
    model: '',
  },
  wrapper: defaultPromptWrapper(),
  selectedProjectId: '',
  threadsByProject: {},
  activeThreadIdsByProject: {},
  messagesByThread: {},
  inputDraftsByProject: {},
  queuedPromptsByProject: {},
})

const loadConsoleSettings = () => {
  const fallback = defaultConsoleSettings()

  try {
    const raw = window.localStorage.getItem(CONSOLE_STORAGE_KEY)

    if (!raw) {
      return fallback
    }

    const parsed = JSON.parse(raw) as StoredConsoleSettings
    const parsedBridge = (parsed.bridge ?? {}) as Partial<BridgeConfig>
    const bridge = { ...fallback.bridge, ...parsedBridge }
    const legacy = migrateLegacyThreads(parsed)

    if (!bridge.url.trim() && fallback.bridge.url) {
      bridge.url = fallback.bridge.url
    }

    if (
      fallback.bridge.mode === 'codexremote-relay' &&
      (!parsedBridge.mode || parsedBridge.mode === 'auto')
    ) {
      bridge.mode = fallback.bridge.mode
    }

    return {
      bridge,
      wrapper: { ...fallback.wrapper, ...parsed.wrapper },
      selectedProjectId:
        typeof parsed.selectedProjectId === 'string'
          ? parsed.selectedProjectId
          : fallback.selectedProjectId,
      threadsByProject: parsed.threadsByProject ?? legacy.threadsByProject,
      activeThreadIdsByProject:
        parsed.activeThreadIdsByProject ?? legacy.activeThreadIdsByProject,
      messagesByThread: parsed.messagesByThread ?? legacy.messagesByThread,
      inputDraftsByProject: parsed.inputDraftsByProject ?? fallback.inputDraftsByProject,
      queuedPromptsByProject: parsed.queuedPromptsByProject ?? fallback.queuedPromptsByProject,
    }
  } catch {
    return fallback
  }
}

const saveConsoleSettings = (settings: ConsoleSettings) => {
  window.localStorage.setItem(CONSOLE_STORAGE_KEY, JSON.stringify(settings))
}

const projectMatches = (project: Project, query: string) => {
  const text = [
    project.name,
    project.summary,
    project.currentFocus,
    project.nextAction,
    project.localPath,
    project.repoUrl,
    project.productionUrl,
    project.notes,
    project.tags.join(' '),
  ]
    .join(' ')
    .toLowerCase()

  return text.includes(query.toLowerCase())
}

const makeMessage = (
  projectId: string,
  role: ConsoleMessage['role'],
  text: string,
  extra: Partial<ConsoleMessage> = {},
): ConsoleMessage => ({
  id: generateId(),
  projectId,
  role,
  text,
  createdAt: nowIso(),
  ...extra,
})

const makeThread = (project: Project, titleSeed: string): ConsoleThread => {
  const timestamp = nowIso()
  const cleanTitle = titleSeed.trim() || 'New topic'

  return {
    id: generateId(),
    projectId: project.id,
    title: excerpt(cleanTitle, 48),
    codexSessionId: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

const makeManualProject = (name: string, prompt: string): Project => {
  const timestamp = nowIso()
  const cleanPrompt = prompt.trim()

  return {
    id: generateId(),
    name: name.trim(),
    summary: excerpt(cleanPrompt, 180),
    status: 'active',
    stage: 'idea',
    priority: 'soon',
    tool: 'Codex',
    tags: ['codex-project'],
    notes: '',
    currentFocus: cleanPrompt,
    nextAction: cleanPrompt,
    repoUrl: '',
    productionUrl: '',
    localPath: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    lastTouchedAt: timestamp,
    features: [],
    deploys: [],
    sessions: [],
    source: 'manual',
  }
}

const optionLabel = <T extends string>(
  options: Array<{ value: T; label: string }>,
  value: T,
) => options.find((option) => option.value === value)?.label ?? value

const engagementDateFor = (project: Project) =>
  new Date(projectEngagementTime(project) || new Date(project.createdAt).getTime()).toISOString()

const deployLineFor = (project: Project) => {
  const latestDeploy = getLatestDeploy(project)

  if (!latestDeploy) {
    return ''
  }

  const deployLabel = optionLabel(DEPLOY_STATUS_OPTIONS, latestDeploy.status)
  const target = hostFromUrl(latestDeploy.url) || latestDeploy.provider

  return `Deploy: ${deployLabel}${target ? ` at ${target}` : ''}`
}

const statusLineFor = (project: Project) =>
  [
    `Last engaged ${formatRelative(engagementDateFor(project))}`,
    deployLineFor(project),
    `Status: ${optionLabel(PROJECT_STATUS_OPTIONS, project.status)}`,
  ]
    .filter(Boolean)
    .join(' · ')

function App() {
  const [storedState] = useState(loadState)
  const [initialConsole] = useState(loadConsoleSettings)
  const [projects, setProjects] = useState<Project[]>(() => sortProjects(storedState.projects))
  const [selectedProjectId, setSelectedProjectId] = useState(() => {
    const sorted = sortProjects(storedState.projects)
    const savedId = initialConsole.selectedProjectId

    return savedId && sorted.some((project) => project.id === savedId)
      ? savedId
      : sorted[0]?.id ?? ''
  })
  const [activeTab, setActiveTab] = useState<AppTab>('chat')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [bridge, setBridge] = useState(initialConsole.bridge)
  const [wrapper, setWrapper] = useState(initialConsole.wrapper)
  const [threadsByProject, setThreadsByProject] = useState(initialConsole.threadsByProject)
  const [activeThreadIdsByProject, setActiveThreadIdsByProject] = useState(
    initialConsole.activeThreadIdsByProject,
  )
  const [messagesByThread, setMessagesByThread] = useState(initialConsole.messagesByThread)
  const [inputDraftsByProject, setInputDraftsByProject] = useState(
    initialConsole.inputDraftsByProject,
  )
  const [queuedPromptsByProject, setQueuedPromptsByProject] = useState(
    initialConsole.queuedPromptsByProject,
  )
  const [newProjectDraft, setNewProjectDraft] = useState({ name: '', prompt: '' })
  const [bridgeStatus, setBridgeStatus] = useState('Bridge not checked yet.')
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null)
  const [runBusy, setRunBusy] = useState(false)
  const [projectBusy, setProjectBusy] = useState(false)
  const [runLogsByProject, setRunLogsByProject] = useState<Record<string, string[]>>({})

  const sortedProjects = useMemo(() => sortProjects(projects), [projects])
  const filteredProjects = useMemo(
    () =>
      sortProjects(
        sortedProjects.filter((project) =>
          deferredSearch.trim() ? projectMatches(project, deferredSearch.trim()) : true,
        ),
      ),
    [deferredSearch, sortedProjects],
  )
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? filteredProjects[0] ?? null
  const projectThreads = useMemo(
    () => (selectedProject ? threadsByProject[selectedProject.id] ?? [] : []),
    [selectedProject, threadsByProject],
  )
  const selectedThreadId = selectedProject ? activeThreadIdsByProject[selectedProject.id] ?? '' : ''
  const activeThread =
    selectedThreadId ? projectThreads.find((thread) => thread.id === selectedThreadId) ?? null : null
  const resolvedThreadId = activeThread?.id ?? ''
  const activeMessages = resolvedThreadId ? messagesByThread[resolvedThreadId] ?? [] : []
  const queuedPrompts = selectedProject ? queuedPromptsByProject[selectedProject.id] ?? [] : []
  const totalQueuedPrompts = Object.values(queuedPromptsByProject).reduce(
    (count, projectQueue) => count + projectQueue.length,
    0,
  )
  const runnableQueuedPrompts = queuedPrompts.filter((item) => item.status !== 'running')
  const latestSessions = selectedProject ? sortSessions(selectedProject.sessions).slice(0, 5) : []
  const input = selectedProject ? inputDraftsByProject[selectedProject.id] ?? '' : ''
  const runLog = selectedProject ? runLogsByProject[selectedProject.id] ?? [] : []
  const recentMessages = [...activeMessages].reverse()
  const recentRunLog = [...runLog].reverse()
  const projectStatusCounts = PROJECT_STATUS_OPTIONS.map((status) => ({
    ...status,
    count: projects.filter((project) => project.status === status.value).length,
  }))
  const bridgeState =
    bridgeHealth?.mode === 'relay'
      ? bridgeHealth.agent?.online
        ? 'Agent online'
        : 'Agent offline'
      : bridgeHealth
        ? 'Bridge online'
        : 'Not checked'
  const previewPrompt =
    selectedProject && input.trim()
      ? buildCodexPrompt(input, selectedProject, wrapper)
      : selectedProject
        ? buildCodexPrompt('Describe the current state and next action.', selectedProject, wrapper)
        : ''

  useEffect(() => {
    saveState({ projects, sync: storedState.sync })
  }, [projects, storedState.sync])

  useEffect(() => {
    saveConsoleSettings({
      bridge,
      wrapper,
      selectedProjectId,
      threadsByProject,
      activeThreadIdsByProject,
      messagesByThread,
      inputDraftsByProject,
      queuedPromptsByProject,
    })
  }, [
    activeThreadIdsByProject,
    bridge,
    inputDraftsByProject,
    messagesByThread,
    queuedPromptsByProject,
    selectedProjectId,
    threadsByProject,
    wrapper,
  ])

  useEffect(() => {
    if (!selectedProject && filteredProjects[0]) {
      setSelectedProjectId(filteredProjects[0].id)
    }
  }, [filteredProjects, selectedProject])

  useEffect(() => {
    if (
      !selectedProject ||
      !projectThreads[0] ||
      (selectedThreadId && projectThreads.some((thread) => thread.id === selectedThreadId))
    ) {
      return
    }

    setActiveThreadIdsByProject((current) => ({
      ...current,
      [selectedProject.id]: projectThreads[0].id,
    }))
  }, [projectThreads, selectedProject, selectedThreadId])

  const updateSelectedProject = (patch: Partial<Project>) => {
    if (!selectedProject) {
      return
    }

    const timestamp = nowIso()
    setProjects((currentProjects) =>
      sortProjects(
        currentProjects.map((project) =>
          project.id === selectedProject.id
            ? {
                ...project,
                ...patch,
                updatedAt: timestamp,
                lastTouchedAt: timestamp,
              }
            : project,
        ),
      ),
    )
  }

  const touchProject = (projectId: string, timestamp = nowIso()) => {
    setProjects((currentProjects) =>
      sortProjects(
        currentProjects.map((project) =>
          project.id === projectId
            ? {
                ...project,
                updatedAt: timestamp,
                lastTouchedAt: timestamp,
              }
            : project,
        ),
      ),
    )
  }

  const handleProjectSelect = (projectId: string) => {
    if (!projectId) {
      return
    }

    setSelectedProjectId(projectId)
    setActiveTab('chat')
  }

  const setProjectInput = (projectId: string, value: string) => {
    setInputDraftsByProject((current) => ({
      ...current,
      [projectId]: value,
    }))
  }

  const ensureProjectThread = (project: Project, titleSeed = 'Codex UI selected thread') => {
    const currentThreads = threadsByProject[project.id] ?? []
    const selectedThread = currentThreads.find(
      (thread) => thread.id === activeThreadIdsByProject[project.id],
    )
    const existingThread = selectedThread ?? currentThreads[0]

    if (existingThread) {
      setActiveThreadIdsByProject((current) => ({
        ...current,
        [project.id]: existingThread.id,
      }))
      return existingThread
    }

    const thread = makeThread(project, titleSeed)

    setThreadsByProject((current) => ({
      ...current,
      [project.id]: [thread],
    }))
    setActiveThreadIdsByProject((current) => ({ ...current, [project.id]: thread.id }))

    return thread
  }

  const recordCodexSession = (
    projectId: string,
    prompt: string,
    result: string,
    startedAt: string,
  ) => {
    const timestamp = nowIso()

    setProjects((currentProjects) =>
      sortProjects(
        currentProjects.map((project) =>
          project.id === projectId
            ? {
                ...project,
                sessions: [
                  {
                    id: generateId(),
                    tool: 'Codex',
                    prompt,
                    result: result.trim() || 'No result was returned.',
                    nextPrompt: '',
                    link: '',
                    createdAt: startedAt,
                    updatedAt: timestamp,
                    source: 'manual',
                  },
                  ...project.sessions,
                ],
                updatedAt: timestamp,
                lastTouchedAt: timestamp,
              }
            : project,
        ),
      ),
    )
  }

  const handleCreateProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!hasText(newProjectDraft.name) || !hasText(newProjectDraft.prompt)) {
      return
    }

    const project = makeManualProject(newProjectDraft.name, newProjectDraft.prompt)
    const thread = makeThread(project, 'Codex UI selected thread')

    setProjects((currentProjects) => sortProjects([project, ...currentProjects]))
    setThreadsByProject((current) => ({ ...current, [project.id]: [thread] }))
    setActiveThreadIdsByProject((current) => ({ ...current, [project.id]: thread.id }))
    setInputDraftsByProject((current) => ({
      ...current,
      [project.id]: newProjectDraft.prompt.trim(),
    }))
    setSelectedProjectId(project.id)
    setActiveTab('chat')
    setNewProjectDraft({ name: '', prompt: '' })
  }

  const appendMessages = (threadId: string, messages: ConsoleMessage[]) => {
    setMessagesByThread((current) => ({
      ...current,
      [threadId]: [...(current[threadId] ?? []), ...messages],
    }))
  }

  const updateMessage = (
    threadId: string,
    messageId: string,
    updater: (message: ConsoleMessage) => ConsoleMessage,
  ) => {
    setMessagesByThread((current) => ({
      ...current,
      [threadId]: (current[threadId] ?? []).map((message) =>
        message.id === messageId ? updater(message) : message,
      ),
    }))
  }

  const updateThread = (projectId: string, threadId: string, patch: Partial<ConsoleThread>) => {
    setThreadsByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? []).map((thread) =>
        thread.id === threadId ? { ...thread, ...patch, updatedAt: nowIso() } : thread,
      ),
    }))
  }

  const addRunLog = (projectId: string, line: string) => {
    setRunLogsByProject((current) => ({
      ...current,
      [projectId]: [...(current[projectId] ?? []).slice(-8), line],
    }))
  }

  const handleBridgeHealth = async () => {
    if (!bridge.url.trim()) {
      setBridgeStatus('Add the bridge URL first.')
      return
    }

    try {
      setBridgeStatus('Checking bridge...')
      const health = await bridgeJson<BridgeHealth>(
        bridge.url,
        bridge.token,
        '/api/health',
      )
      setBridgeHealth(health)
      const modeLabel = health.mode === 'relay' ? 'CodexRemote relay' : 'MyBrain local bridge'
      const detail = health.mode === 'relay'
        ? health.agent?.online
          ? ` Agent online${health.agent.hostname ? ` on ${health.agent.hostname}` : ''}.`
          : ' Waiting for the Mac relay agent.'
        : health.codexPath
          ? ` Codex at ${health.codexPath}.`
          : ''
      setBridgeStatus(`Connected to ${modeLabel}.${detail}`)
    } catch (error) {
      setBridgeHealth(null)
      setBridgeStatus(error instanceof Error ? error.message : 'Bridge check failed.')
    }
  }

  const handleRefreshProjects = async () => {
    if (!bridge.url.trim()) {
      setBridgeStatus('Add the bridge URL first.')
      return
    }

    try {
      setProjectBusy(true)
      setBridgeStatus('Loading projects from the bridge...')
      const snapshot = await bridgeJson<LocalProjectSnapshot>(
        bridge.url,
        bridge.token,
        '/api/projects',
      )
      const imported = importProjectSnapshotValue(snapshot)
      const mergedProjects = mergeProjectCollections(imported.projects, projects)

      startTransition(() => {
        setProjects(mergedProjects)
      })

      if (
        mergedProjects[0] &&
        (!selectedProjectId ||
          !mergedProjects.some((project) => project.id === selectedProjectId))
      ) {
        setSelectedProjectId(mergedProjects[0].id)
      }

      const sourceLabel =
        snapshot.basePath ?? (snapshot.mode === 'relay' ? 'CodexRemote relay' : 'bridge')
      setBridgeStatus(`Loaded ${imported.count} Codex projects from ${sourceLabel}.`)
    } catch (error) {
      setBridgeStatus(error instanceof Error ? error.message : 'Project scan failed.')
    } finally {
      setProjectBusy(false)
    }
  }

  const handleStreamEvent = (
    project: Project,
    threadId: string,
    assistantId: string,
    event: BridgeStreamEvent,
  ) => {
    if (event.type === 'thread') {
      updateThread(project.id, threadId, {
        codexSessionId: event.threadId,
        ...(event.title ? { title: excerpt(event.title, 48) } : {}),
      })
      setActiveThreadIdsByProject((current) => ({
        ...current,
        [project.id]: threadId,
      }))
      addRunLog(project.id, `Codex thread: ${event.title || event.threadId}`)
      return
    }

    if (event.type === 'assistant') {
      updateMessage(threadId, assistantId, (message) => ({
        ...message,
        text: `${message.text}${event.text}`,
      }))
      return
    }

    if (event.type === 'turn-completed') {
      addRunLog(project.id, 'Turn completed.')
      return
    }

    if (event.type === 'exit') {
      addRunLog(project.id, `Codex exited with ${event.code ?? 0}.`)
      return
    }

    if (event.type === 'error') {
      addRunLog(project.id, event.message)
      updateMessage(threadId, assistantId, (message) => ({
        ...message,
        text: message.text || event.message,
      }))
      return
    }

    if (event.type === 'log') {
      addRunLog(project.id, event.text)
      return
    }

    if (event.type === 'bridge') {
      addRunLog(project.id, event.message)
    }
  }

  const runCodexPrompt = async (
    project: Project,
    rawPrompt: string,
    thread: ConsoleThread,
  ): Promise<{ success: boolean; thread: ConsoleThread; error: string }> => {
    const startedAt = nowIso()
    const isRelayMode = bridge.mode === 'codexremote-relay'
    let nextThread = thread
    let assistantText = ''
    let streamHadError = false
    let errorText = ''

    touchProject(project.id, startedAt)

    if (!bridge.url.trim()) {
      const message = 'Add a bridge URL before sending to Codex.'
      appendMessages(thread.id, [
        makeMessage(project.id, 'user', rawPrompt),
        makeMessage(project.id, 'system', message),
      ])
      recordCodexSession(project.id, rawPrompt, message, startedAt)
      return { success: false, thread: nextThread, error: message }
    }

    if (!isRelayMode && !project.localPath && !nextThread.codexSessionId) {
      const message = 'This project needs a local path before Codex can run locally.'
      appendMessages(thread.id, [
        makeMessage(project.id, 'user', rawPrompt),
        makeMessage(project.id, 'system', message),
      ])
      recordCodexSession(project.id, rawPrompt, message, startedAt)
      return { success: false, thread: nextThread, error: message }
    }

    const sentPrompt = buildCodexPrompt(rawPrompt, project, wrapper)
    const assistantId = generateId()

    updateThread(project.id, thread.id, {})

    appendMessages(thread.id, [
      makeMessage(project.id, 'user', rawPrompt, { sentPrompt }),
      {
        id: assistantId,
        projectId: project.id,
        role: 'assistant',
        text: '',
        createdAt: nowIso(),
        rawPrompt,
        sentPrompt,
      },
    ])
    setRunLogsByProject((current) => ({ ...current, [project.id]: [] }))

    try {
      await streamCodexTurn(
        {
          ...bridge,
          url: normalizeBridgeUrl(bridge.url),
        },
        {
          cwd: project.localPath,
          prompt: sentPrompt,
          projectId: project.id,
          projectName: project.name,
          sessionId: nextThread.codexSessionId,
        },
        (streamEvent) => {
          if (streamEvent.type === 'assistant') {
            assistantText += streamEvent.text
          }

          if (streamEvent.type === 'error' && !assistantText) {
            assistantText = streamEvent.message
          }

          if (streamEvent.type === 'error') {
            streamHadError = true
            errorText = streamEvent.message
          }

          if (streamEvent.type === 'exit' && streamEvent.code && streamEvent.code !== 0) {
            streamHadError = true
            errorText = errorText || `Codex exited with ${streamEvent.code}.`
          }

          if (streamEvent.type === 'thread') {
            nextThread = {
              ...nextThread,
              codexSessionId: streamEvent.threadId,
              ...(streamEvent.title ? { title: excerpt(streamEvent.title, 48) } : {}),
              updatedAt: nowIso(),
            }
          }

          handleStreamEvent(project, thread.id, assistantId, streamEvent)
        },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not reach the Codex bridge.'
      assistantText = assistantText || message
      streamHadError = true
      errorText = message
      updateMessage(thread.id, assistantId, (message) => ({
        ...message,
        text: message.text || assistantText,
      }))
    } finally {
      recordCodexSession(project.id, rawPrompt, assistantText, startedAt)
    }

    return {
      success: !streamHadError,
      thread: nextThread,
      error: errorText,
    }
  }

  const patchQueuedPrompt = (
    projectId: string,
    promptId: string,
    patch: Partial<QueuedPrompt>,
  ) => {
    setQueuedPromptsByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? []).map((item) =>
        item.id === promptId ? { ...item, ...patch, updatedAt: nowIso() } : item,
      ),
    }))
  }

  const removeQueuedPrompt = (projectId: string, promptId: string) => {
    setQueuedPromptsByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? []).filter((item) => item.id !== promptId),
    }))
  }

  const handleQueuePrompt = () => {
    if (!selectedProject || !hasText(input)) {
      return
    }

    const timestamp = nowIso()
    const queuedPrompt: QueuedPrompt = {
      id: generateId(),
      projectId: selectedProject.id,
      text: input.trim(),
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    setQueuedPromptsByProject((current) => ({
      ...current,
      [selectedProject.id]: [...(current[selectedProject.id] ?? []), queuedPrompt],
    }))
    setProjectInput(selectedProject.id, '')
    touchProject(selectedProject.id, timestamp)
    addRunLog(selectedProject.id, 'Prompt queued.')
    setActiveTab('queue')
  }

  const handleClearQueue = () => {
    if (!selectedProject || runBusy) {
      return
    }

    setQueuedPromptsByProject((current) => ({
      ...current,
      [selectedProject.id]: [],
    }))
  }

  const handleRunQueuedPrompt = async (promptId?: string) => {
    if (!selectedProject || runBusy) {
      return
    }

    const queuedPrompt =
      queuedPrompts.find((item) => item.id === promptId) ??
      queuedPrompts.find((item) => item.status !== 'running')

    if (!queuedPrompt) {
      return
    }

    const thread = activeThread ?? ensureProjectThread(selectedProject)

    setRunBusy(true)
    patchQueuedPrompt(selectedProject.id, queuedPrompt.id, { status: 'running', error: '' })

    try {
      const result = await runCodexPrompt(selectedProject, queuedPrompt.text, thread)

      if (result.success) {
        removeQueuedPrompt(selectedProject.id, queuedPrompt.id)
      } else {
        patchQueuedPrompt(selectedProject.id, queuedPrompt.id, {
          status: 'failed',
          error: result.error || 'Codex run failed.',
        })
      }
    } finally {
      setRunBusy(false)
    }
  }

  const handleRunQueue = async () => {
    if (!selectedProject || runBusy || !runnableQueuedPrompts.length) {
      return
    }

    let thread = activeThread ?? ensureProjectThread(selectedProject)

    setRunBusy(true)

    try {
      for (const queuedPrompt of runnableQueuedPrompts) {
        patchQueuedPrompt(selectedProject.id, queuedPrompt.id, { status: 'running', error: '' })
        const result = await runCodexPrompt(selectedProject, queuedPrompt.text, thread)
        thread = result.thread

        if (result.success) {
          removeQueuedPrompt(selectedProject.id, queuedPrompt.id)
        } else {
          patchQueuedPrompt(selectedProject.id, queuedPrompt.id, {
            status: 'failed',
            error: result.error || 'Codex run failed.',
          })
          break
        }
      }
    } finally {
      setRunBusy(false)
    }
  }

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedProject || runBusy || !hasText(input)) {
      return
    }

    const rawPrompt = input.trim()
    const thread = activeThread ?? ensureProjectThread(selectedProject)

    setProjectInput(selectedProject.id, '')
    setRunBusy(true)

    try {
      await runCodexPrompt(selectedProject, rawPrompt, thread)
    } finally {
      setRunBusy(false)
    }
  }

  const handleClearThread = () => {
    if (!resolvedThreadId) {
      return
    }

    setMessagesByThread((current) => ({
      ...current,
      [resolvedThreadId]: [],
    }))
  }

	  const chatTab = (
	    <section className="main-surface">
	      {selectedProject ? (
        <>
          <form className="composer" onSubmit={handleSend}>
            <textarea
              value={input}
              onChange={(event) => setProjectInput(selectedProject.id, event.target.value)}
              placeholder="Tell Codex what to do in this project"
              rows={4}
            />
            <div className="composer-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={!input.trim()}
                onClick={handleQueuePrompt}
              >
                <span aria-hidden="true">＋</span>
                Queue
              </button>
              <button type="submit" className="primary-button" disabled={runBusy || !input.trim()}>
                <span aria-hidden="true">↵</span>
                {runBusy ? 'Running' : 'Send'}
              </button>
            </div>
          </form>

          <section className="activity-panel" aria-label="Activity">
            <div className="activity-heading">
              <h2>Activity</h2>
              <span className={bridgeHealth ? 'status-pill online' : 'status-pill'}>
                {bridgeState}
              </span>
            </div>

            {recentRunLog.length ? (
              <div className="run-log">
                {recentRunLog.map((line, index) => (
                  <span key={`${line}-${index}`}>{line}</span>
                ))}
              </div>
            ) : null}

            <div className="message-list">
              {recentMessages.length === 0 ? (
                <div className="empty-state">
                  <p>No activity yet.</p>
                </div>
              ) : (
                recentMessages.map((message) => (
                  <article key={message.id} className={`message message--${message.role}`}>
                    <div className="message-meta">
                      <span>{message.role}</span>
                      <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
                    </div>
                    <p>
                      {message.text ||
                        (message.role === 'assistant' ? 'Codex is working...' : '')}
                    </p>
                  </article>
                ))
              )}
            </div>
          </section>
        </>
      ) : (
        <section className="empty-state">
          <p>No project selected.</p>
        </section>
      )}
    </section>
  )

  const queueTab = (
    <section className="tab-section">
      {selectedProject ? (
        <>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Queued Prompts</p>
              <h2>{queuedPrompts.length} in queue</h2>
            </div>
            <div className="queue-actions">
              <span className="muted">{totalQueuedPrompts} total</span>
              <button
                type="button"
                className="secondary-button"
                disabled={runBusy || !runnableQueuedPrompts.length}
                onClick={() => void handleRunQueuedPrompt()}
              >
                <span aria-hidden="true">▶</span>
                Next
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={runBusy || !runnableQueuedPrompts.length}
                onClick={() => void handleRunQueue()}
              >
                <span aria-hidden="true">↵</span>
                All
              </button>
            </div>
          </div>

          {queuedPrompts.length ? (
            <>
              <div className="queue-list">
                {queuedPrompts.map((queuedPrompt, index) => (
                  <article key={queuedPrompt.id} className="queue-item">
                    <div className="queue-item-main">
                      <span className={`queue-status queue-status--${queuedPrompt.status}`}>
                        {queuedPrompt.status}
                      </span>
                      <h3>
                        {index + 1}. {excerpt(queuedPrompt.text, 72)}
                      </h3>
                      <time dateTime={queuedPrompt.createdAt}>
                        {formatDateTime(queuedPrompt.createdAt)}
                      </time>
                      <p>{queuedPrompt.text}</p>
                      {queuedPrompt.error ? <small>{queuedPrompt.error}</small> : null}
                    </div>
                    <div className="queue-item-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={runBusy || queuedPrompt.status === 'running'}
                        onClick={() => void handleRunQueuedPrompt(queuedPrompt.id)}
                      >
                        <span aria-hidden="true">▶</span>
                        Run
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={runBusy || queuedPrompt.status === 'running'}
                        onClick={() => removeQueuedPrompt(selectedProject.id, queuedPrompt.id)}
                        aria-label="Remove queued prompt"
                        title="Remove queued prompt"
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <button
                type="button"
                className="secondary-button"
                disabled={runBusy}
                onClick={handleClearQueue}
              >
                <span aria-hidden="true">×</span>
                Clear queue
              </button>
            </>
          ) : (
            <section className="empty-state">
              <p>No queued prompts.</p>
            </section>
          )}
        </>
      ) : (
        <section className="empty-state">
          <p>No project selected.</p>
        </section>
	      )}
	    </section>
	  )

		  const projectsTab = (
	    <section className="tab-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">All Projects</p>
          <h2>{filteredProjects.length} visible</h2>
        </div>
      </div>
      <div className="status-overview" aria-label="Project status overview">
        {projectStatusCounts.map((status) => (
          <span key={status.value}>
            <strong>{status.count}</strong>
            {status.label}
          </span>
        ))}
      </div>
      <form className="create-project-form" onSubmit={handleCreateProject}>
        <label className="field">
          <span>New project name</span>
          <input
            value={newProjectDraft.name}
            onChange={(event) =>
              setNewProjectDraft((current) => ({ ...current, name: event.target.value }))
            }
            placeholder="Project name"
          />
        </label>
        <label className="field">
          <span>Prompt</span>
          <textarea
            value={newProjectDraft.prompt}
            onChange={(event) =>
              setNewProjectDraft((current) => ({ ...current, prompt: event.target.value }))
            }
            placeholder="Initial Codex prompt"
            rows={3}
          />
        </label>
        <button
          type="submit"
          className="primary-button"
          disabled={!hasText(newProjectDraft.name) || !hasText(newProjectDraft.prompt)}
        >
          <span aria-hidden="true">＋</span>
          Create
        </button>
      </form>
      <label className="field">
        <span>Search</span>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Project name, path, repo, tag"
        />
      </label>
      <div className="project-grid">
        {filteredProjects.map((project) => (
          <button
            key={project.id}
            type="button"
            className={project.id === selectedProject?.id ? 'project-card selected' : 'project-card'}
            onClick={() => handleProjectSelect(project.id)}
          >
            <span className="project-card-title">{project.name}</span>
            <span>{statusLineFor(project) || 'No status set'}</span>
            {project.localPath ? <small>{project.localPath}</small> : null}
          </button>
        ))}
      </div>
    </section>
  )

  const settingsTab = (
    <section className="settings-grid">
      <section className="tab-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Bridge</p>
            <h2>Connection</h2>
          </div>
          <button type="button" className="secondary-button" onClick={handleBridgeHealth}>
            <span aria-hidden="true">✓</span>
            Test
          </button>
        </div>
        <div className="field-grid">
          <label className="field">
            <span>Mode</span>
            <select
              value={bridge.mode}
              onChange={(event) =>
                setBridge((current) => ({
                  ...current,
                  mode: event.target.value as BridgeConfig['mode'],
                }))
              }
            >
              <option value="auto">Auto detect</option>
              <option value="mybrain-local">MyBrain local</option>
              <option value="codexremote-relay">CodexRemote relay</option>
            </select>
          </label>
          <label className="field">
            <span>Sandbox</span>
            <select
              value={bridge.sandbox}
              onChange={(event) =>
                setBridge((current) => ({
                  ...current,
                  sandbox: event.target.value as BridgeConfig['sandbox'],
                }))
              }
            >
              <option value="workspace-write">Workspace write</option>
              <option value="read-only">Read only</option>
              <option value="danger-full-access">Danger full access</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>URL</span>
          <input
            value={bridge.url}
            onChange={(event) => setBridge((current) => ({ ...current, url: event.target.value }))}
            placeholder="https://codexremote.onrender.com"
          />
        </label>
        <label className="field">
          <span>Token</span>
          <input
            type="password"
            value={bridge.token}
            onChange={(event) => setBridge((current) => ({ ...current, token: event.target.value }))}
            placeholder={
              bridge.mode === 'codexremote-relay'
                ? 'CODEXREMOTE_RELAY_TOKEN'
                : 'MYBRAIN_BRIDGE_TOKEN'
            }
          />
        </label>
        <label className="field">
          <span>Model override</span>
          <input
            value={bridge.model}
            onChange={(event) => setBridge((current) => ({ ...current, model: event.target.value }))}
            placeholder="Codex default"
          />
        </label>
        <p className="muted">{bridgeStatus}</p>
        {bridgeHealth ? (
          <p className="muted">
            {bridgeHealth.mode === 'relay'
              ? `Relay agent: ${bridgeHealth.agent?.online ? 'online' : 'offline'}.`
              : `Base path: ${bridgeHealth.basePath ?? 'unknown'}. Render CLI: ${
                  bridgeHealth.renderAvailable ? 'available' : 'not found'
                }.`}
          </p>
        ) : null}
      </section>

      {selectedProject ? (
        <section className="tab-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Project State</p>
              <h2>Status and next move</h2>
            </div>
            <button type="button" className="secondary-button" onClick={handleClearThread}>
              <span aria-hidden="true">×</span>
              Clear
            </button>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>Status</span>
              <select
                value={selectedProject.status}
                onChange={(event) =>
                  updateSelectedProject({
                    status: event.target.value as ProjectStatus,
                  })
                }
              >
                {PROJECT_STATUS_OPTIONS.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Stage</span>
              <select
                value={selectedProject.stage}
                onChange={(event) =>
                  updateSelectedProject({
                    stage: event.target.value as ProjectStage,
                  })
                }
              >
                {PROJECT_STAGE_OPTIONS.map((stage) => (
                  <option key={stage.value} value={stage.value}>
                    {stage.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Priority</span>
              <select
                value={selectedProject.priority}
                onChange={(event) =>
                  updateSelectedProject({
                    priority: event.target.value as Priority,
                  })
                }
              >
                {PRIORITY_OPTIONS.map((priority) => (
                  <option key={priority.value} value={priority.value}>
                    {priority.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Current focus</span>
            <input
              value={selectedProject.currentFocus}
              onChange={(event) => updateSelectedProject({ currentFocus: event.target.value })}
              placeholder="What this project needs now"
            />
          </label>
          <label className="field">
            <span>Next action</span>
            <input
              value={selectedProject.nextAction}
              onChange={(event) => updateSelectedProject({ nextAction: event.target.value })}
              placeholder="Exact next action"
            />
          </label>
        </section>
      ) : null}

      <details className="tab-section wrapper-panel">
        <summary>
          <span>Prompt Wrapper</span>
          <strong>Message envelope</strong>
        </summary>
        <label className="field">
          <span>Before user prompt</span>
          <textarea
            value={wrapper.before}
            onChange={(event) =>
              setWrapper((current) => ({ ...current, before: event.target.value }))
            }
            rows={4}
          />
        </label>
        <div className="toggle-grid">
          <label>
            <input
              type="checkbox"
              checked={wrapper.includeProjectContext}
              onChange={(event) =>
                setWrapper((current) => ({
                  ...current,
                  includeProjectContext: event.target.checked,
                }))
              }
            />
            Include project context
          </label>
          <label>
            <input
              type="checkbox"
              checked={wrapper.protectUserChanges}
              onChange={(event) =>
                setWrapper((current) => ({
                  ...current,
                  protectUserChanges: event.target.checked,
                }))
              }
            />
            Protect user changes
          </label>
          <label>
            <input
              type="checkbox"
              checked={wrapper.requireVerification}
              onChange={(event) =>
                setWrapper((current) => ({
                  ...current,
                  requireVerification: event.target.checked,
                }))
              }
            />
            Require verification
          </label>
          <label>
            <input
              type="checkbox"
              checked={wrapper.requireDeployment}
              onChange={(event) =>
                setWrapper((current) => ({
                  ...current,
                  requireDeployment: event.target.checked,
                }))
              }
            />
            Require deploy confirmation
          </label>
          <label>
            <input
              type="checkbox"
              checked={wrapper.requireStatusSummary}
              onChange={(event) =>
                setWrapper((current) => ({
                  ...current,
                  requireStatusSummary: event.target.checked,
                }))
              }
            />
            Require status summary
          </label>
        </div>
        <label className="field">
          <span>After user prompt</span>
          <textarea
            value={wrapper.after}
            onChange={(event) =>
              setWrapper((current) => ({ ...current, after: event.target.value }))
            }
            rows={3}
          />
        </label>
        <div className="prompt-preview">
          <span>Preview sent to Codex</span>
          <pre>{previewPrompt}</pre>
        </div>
      </details>
    </section>
  )

  const memoryTab = (
    <section className="memory-grid">
      <section className="tab-section">
        <p className="eyebrow">Codex UI Thread</p>
        <h2>{activeThread?.title ?? 'Selected in Codex'}</h2>
        <div className="thread-list">
          <article className="thread-card selected">
            <strong>{activeThread?.title ?? 'Codex UI selected thread'}</strong>
            <span>
              {activeThread?.codexSessionId
                ? excerpt(activeThread.codexSessionId, 42)
                : 'No Codex thread reported yet.'}
            </span>
          </article>
        </div>
      </section>

      {selectedProject ? (
        <>
          <section className="tab-section">
            <p className="eyebrow">Deploys</p>
            <h2>Production signals</h2>
            <div className="fact-list">
              {selectedProject.deploys.length ? (
                selectedProject.deploys.slice(0, 6).map((deploy) => (
                  <article key={deploy.id}>
                    <h3>{deploy.status}</h3>
                    <p>
                      {deploy.provider} · {deploy.url || deploy.commit || 'no URL'}
                    </p>
                  </article>
                ))
              ) : (
                <p className="muted">No deploys tracked.</p>
              )}
            </div>
          </section>

          <section className="tab-section">
            <p className="eyebrow">Features</p>
            <h2>Project scope</h2>
            <div className="fact-list">
              {selectedProject.features.length ? (
                selectedProject.features.slice(0, 6).map((feature) => (
                  <article key={feature.id}>
                    <h3>{feature.title}</h3>
                    <p>{feature.status}</p>
                  </article>
                ))
              ) : (
                <p className="muted">No features tracked.</p>
              )}
            </div>
          </section>

          <section className="tab-section">
            <p className="eyebrow">Prior AI</p>
            <h2>Saved prompts and results</h2>
            <div className="fact-list">
              {latestSessions.length ? (
                latestSessions.map((session) => (
                  <article key={session.id}>
                    <h3>
                      {session.tool} · {formatRelative(session.updatedAt)}
                    </h3>
                    <p>Prompt: {excerpt(session.prompt, 180)}</p>
                    <p>Result: {excerpt(session.result, 220)}</p>
                  </article>
                ))
              ) : (
                <p className="muted">No previous AI logs.</p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </section>
  )

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-title">
          <p className="eyebrow">MyBrain</p>
          <div className="project-title-row">
            <h1>{selectedProject?.name ?? 'MyBrain'}</h1>
            {sortedProjects.length ? (
              <label className="project-title-picker">
                <span className="sr-only">Switch project</span>
                <span className="project-title-caret" aria-hidden="true" />
                <select
                  className="project-title-select"
                  value={selectedProject?.id ?? ''}
                  onChange={(event) => handleProjectSelect(event.target.value)}
                  aria-label="Switch project"
                >
                  {!selectedProject ? <option value="">Select project</option> : null}
                  {sortedProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={handleRefreshProjects}
          disabled={projectBusy}
          aria-label={projectBusy ? 'Refreshing projects' : 'Refresh projects'}
          title={projectBusy ? 'Refreshing projects' : 'Refresh projects'}
        >
          <span aria-hidden="true">↻</span>
        </button>
      </header>

      <nav className="tabs" aria-label="MyBrain sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? 'tab selected' : 'tab'}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.id === 'queue' && totalQueuedPrompts
              ? `${tab.label} ${totalQueuedPrompts}`
              : tab.label}
          </button>
        ))}
      </nav>

      <main className="tab-panel">
        {activeTab === 'chat' ? chatTab : null}
        {activeTab === 'queue' ? queueTab : null}
        {activeTab === 'projects' ? projectsTab : null}
        {activeTab === 'settings' ? settingsTab : null}
        {activeTab === 'memory' ? memoryTab : null}
      </main>
    </div>
  )
}

export default App
