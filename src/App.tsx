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

type AppTab = 'chat' | 'projects' | 'settings' | 'memory'

type ConsoleThread = {
  id: string
  projectId: string
  title: string
  codexSessionId: string
  createdAt: string
  updatedAt: string
}

type ConsoleSettings = {
  bridge: BridgeConfig
  wrapper: PromptWrapper
  threadsByProject: Record<string, ConsoleThread[]>
  activeThreadIdsByProject: Record<string, string>
  messagesByThread: Record<string, ConsoleMessage[]>
  inputDraftsByProject: Record<string, string>
  threadTitleDraftsByProject: Record<string, string>
}

type StoredConsoleSettings = Partial<ConsoleSettings> & {
  messagesByProject?: Record<string, ConsoleMessage[]>
  sessionIdsByProject?: Record<string, string>
}

const CONSOLE_STORAGE_KEY = 'mybrain-codex-console-v1'
const CODEXREMOTE_RELAY_URL = 'https://codexremote.onrender.com'
const NEW_THREAD_VALUE = '__new_thread__'

const tabs: { id: AppTab; label: string }[] = [
  { id: 'chat', label: 'Current' },
  { id: 'projects', label: 'All Projects' },
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
  threadsByProject: {},
  activeThreadIdsByProject: {},
  messagesByThread: {},
  inputDraftsByProject: {},
  threadTitleDraftsByProject: {},
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
      threadsByProject: parsed.threadsByProject ?? legacy.threadsByProject,
      activeThreadIdsByProject:
        parsed.activeThreadIdsByProject ?? legacy.activeThreadIdsByProject,
      messagesByThread: parsed.messagesByThread ?? legacy.messagesByThread,
      inputDraftsByProject: parsed.inputDraftsByProject ?? fallback.inputDraftsByProject,
      threadTitleDraftsByProject:
        parsed.threadTitleDraftsByProject ?? fallback.threadTitleDraftsByProject,
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

const projectStateLineFor = (project: Project) =>
  [
    `Status: ${optionLabel(PROJECT_STATUS_OPTIONS, project.status)}`,
    `Stage: ${optionLabel(PROJECT_STAGE_OPTIONS, project.stage)}`,
    `Priority: ${optionLabel(PRIORITY_OPTIONS, project.priority)}`,
  ].join(' · ')

const projectOverviewLineFor = (project: Project) =>
  [`Last engaged ${formatRelative(engagementDateFor(project))}`, deployLineFor(project)]
    .filter(Boolean)
    .join(' · ')

function App() {
  const [storedState] = useState(loadState)
  const [initialConsole] = useState(loadConsoleSettings)
  const [projects, setProjects] = useState<Project[]>(sortProjects(storedState.projects))
  const [selectedProjectId, setSelectedProjectId] = useState(
    sortProjects(storedState.projects)[0]?.id ?? '',
  )
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
  const [threadTitleDraftsByProject, setThreadTitleDraftsByProject] = useState(
    initialConsole.threadTitleDraftsByProject,
  )
  const [newProjectDraft, setNewProjectDraft] = useState({ name: '', prompt: '' })
  const [bridgeStatus, setBridgeStatus] = useState('Bridge not checked yet.')
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null)
  const [runBusy, setRunBusy] = useState(false)
  const [projectBusy, setProjectBusy] = useState(false)
  const [runLogsByProject, setRunLogsByProject] = useState<Record<string, string[]>>({})

  const filteredProjects = sortProjects(
    projects.filter((project) =>
      deferredSearch.trim() ? projectMatches(project, deferredSearch.trim()) : true,
    ),
  )
  const projectMenuProjects = sortProjects(projects)
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
  const activeSessionId = activeThread?.codexSessionId ?? ''
  const latestSessions = selectedProject ? sortSessions(selectedProject.sessions).slice(0, 5) : []
  const latestSession = latestSessions[0] ?? null
  const input = selectedProject ? inputDraftsByProject[selectedProject.id] ?? '' : ''
  const threadTitleDraft = selectedProject
    ? threadTitleDraftsByProject[selectedProject.id] ?? ''
    : ''
  const runLog = selectedProject ? runLogsByProject[selectedProject.id] ?? [] : []
  const selectedStatus = selectedProject ? projectOverviewLineFor(selectedProject) : ''
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
      threadsByProject,
      activeThreadIdsByProject,
      messagesByThread,
      inputDraftsByProject,
      threadTitleDraftsByProject,
    })
  }, [
    activeThreadIdsByProject,
    bridge,
    inputDraftsByProject,
    messagesByThread,
    threadTitleDraftsByProject,
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

  const setProjectInput = (projectId: string, value: string) => {
    setInputDraftsByProject((current) => ({
      ...current,
      [projectId]: value,
    }))
  }

  const setProjectThreadTitleDraft = (projectId: string, value: string) => {
    setThreadTitleDraftsByProject((current) => ({
      ...current,
      [projectId]: value,
    }))
  }

  const addThread = (project: Project, titleSeed: string) => {
    const thread = makeThread(project, titleSeed)

    setThreadsByProject((current) => ({
      ...current,
      [project.id]: [...(current[project.id] ?? []), thread],
    }))
    setActiveThreadIdsByProject((current) => ({ ...current, [project.id]: thread.id }))
    setProjectThreadTitleDraft(project.id, '')

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
    const thread = makeThread(project, newProjectDraft.prompt)

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

  const handleNewThread = () => {
    if (!selectedProject) {
      return
    }

    addThread(selectedProject, threadTitleDraft || 'New Codex chat')
    setActiveTab('chat')
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

      startTransition(() => {
        setProjects((currentProjects) =>
          mergeProjectCollections(imported.projects, currentProjects),
        )
      })

      if (imported.projects[0]) {
        setSelectedProjectId(imported.projects[0].id)
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

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedProject || runBusy || !hasText(input)) {
      return
    }

    const rawPrompt = input.trim()
    const startedAt = nowIso()
    const thread = activeThread ?? addThread(selectedProject, threadTitleDraft || rawPrompt)

    if (!bridge.url.trim()) {
      const message = 'Add a bridge URL before sending to Codex.'
      appendMessages(thread.id, [
        makeMessage(selectedProject.id, 'user', rawPrompt),
        makeMessage(selectedProject.id, 'system', message),
      ])
      recordCodexSession(selectedProject.id, rawPrompt, message, startedAt)
      setProjectInput(selectedProject.id, '')
      return
    }

    if (!selectedProject.localPath && !activeSessionId) {
      const message = 'This project needs a local path before a new Codex thread can start.'
      appendMessages(thread.id, [
        makeMessage(selectedProject.id, 'user', rawPrompt),
        makeMessage(selectedProject.id, 'system', message),
      ])
      recordCodexSession(selectedProject.id, rawPrompt, message, startedAt)
      setProjectInput(selectedProject.id, '')
      return
    }

    const sentPrompt = buildCodexPrompt(rawPrompt, selectedProject, wrapper)
    const assistantId = generateId()
    let assistantText = ''

    if (activeThread) {
      updateThread(selectedProject.id, thread.id, {})
    }

    appendMessages(thread.id, [
      makeMessage(selectedProject.id, 'user', rawPrompt, { sentPrompt }),
      {
        id: assistantId,
        projectId: selectedProject.id,
        role: 'assistant',
        text: '',
        createdAt: nowIso(),
        rawPrompt,
        sentPrompt,
      },
    ])
    setProjectInput(selectedProject.id, '')
    setRunLogsByProject((current) => ({ ...current, [selectedProject.id]: [] }))

    try {
      setRunBusy(true)
      await streamCodexTurn(
        {
          ...bridge,
          url: normalizeBridgeUrl(bridge.url),
        },
        {
          cwd: selectedProject.localPath,
          prompt: sentPrompt,
          projectId: selectedProject.id,
          projectName: selectedProject.name,
          sessionId: thread.codexSessionId,
        },
        (streamEvent) => {
          if (streamEvent.type === 'assistant') {
            assistantText += streamEvent.text
          }

          if (streamEvent.type === 'error' && !assistantText) {
            assistantText = streamEvent.message
          }

          handleStreamEvent(selectedProject, thread.id, assistantId, streamEvent)
        },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not reach the Codex bridge.'
      assistantText = assistantText || message
      updateMessage(thread.id, assistantId, (message) => ({
        ...message,
        text: message.text || assistantText,
      }))
    } finally {
      recordCodexSession(selectedProject.id, rawPrompt, assistantText, startedAt)
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
      <div className="main-heading">
        <div>
          <p className="eyebrow">Current Work</p>
          <h2>
            {selectedProject?.currentFocus ||
              selectedProject?.nextAction ||
              selectedProject?.summary ||
              'Choose or create a project'}
          </h2>
        </div>
        <span className={bridgeHealth ? 'status-pill online' : 'status-pill'}>{bridgeState}</span>
      </div>

      {selectedProject ? (
        <>
          <div className="quick-links">
            <span>{projectStateLineFor(selectedProject) || 'No project status set'}</span>
            {selectedProject.repoUrl ? (
              <a href={selectedProject.repoUrl} target="_blank" rel="noreferrer">
                Repo
              </a>
            ) : null}
            {selectedProject.productionUrl ? (
              <a href={selectedProject.productionUrl} target="_blank" rel="noreferrer">
                Live
              </a>
            ) : null}
            {selectedProject.localPath ? <span>{selectedProject.localPath}</span> : null}
          </div>

          <div className="thread-bar">
            <label className="field thread-select">
              <span>Codex thread</span>
              <select
                value={activeThread?.id ?? NEW_THREAD_VALUE}
                onChange={(event) => {
                  if (event.target.value === NEW_THREAD_VALUE) {
                    handleNewThread()
                    return
                  }

                  setActiveThreadIdsByProject((current) => ({
                    ...current,
                    [selectedProject.id]: event.target.value,
                  }))
                }}
              >
                <option value={NEW_THREAD_VALUE}>New Codex chat</option>
                {projectThreads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field topic-title">
              <span>New thread label</span>
              <input
                value={threadTitleDraft}
                onChange={(event) =>
                  setProjectThreadTitleDraft(selectedProject.id, event.target.value)
                }
                placeholder="Optional"
              />
            </label>
            <button type="button" className="secondary-button" onClick={handleNewThread}>
              <span aria-hidden="true">＋</span>
              New Chat
            </button>
          </div>

          <div className="message-list">
            {activeMessages.length === 0 ? (
              <div className="empty-state">
                <p>No messages in this Codex thread.</p>
              </div>
            ) : (
              activeMessages.map((message) => (
                <article key={message.id} className={`message message--${message.role}`}>
                  <div className="message-meta">
                    <span>{message.role}</span>
                    <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
                  </div>
                  <p>{message.text || (message.role === 'assistant' ? 'Codex is working...' : '')}</p>
                </article>
              ))
            )}
          </div>

          {runLog.length ? (
            <div className="run-log">
              {runLog.map((line, index) => (
                <span key={`${line}-${index}`}>{line}</span>
              ))}
            </div>
          ) : null}

          {latestSession ? (
            <section className="last-run-panel">
              <div>
                <span>Last prompt</span>
                <p>{latestSession.prompt}</p>
              </div>
              <div>
                <span>Last result</span>
                <p>{latestSession.result || 'No result stored yet.'}</p>
              </div>
            </section>
          ) : null}

          <form className="composer" onSubmit={handleSend}>
            <textarea
              value={input}
              onChange={(event) => setProjectInput(selectedProject.id, event.target.value)}
              placeholder="Tell Codex what to do in this project"
              rows={4}
            />
            <div className="composer-actions">
              <span>{activeThread ? activeThread.title : 'New Codex chat'}</span>
              <button type="submit" className="primary-button" disabled={runBusy || !input.trim()}>
                <span aria-hidden="true">↵</span>
                {runBusy ? 'Running' : 'Send'}
              </button>
            </div>
          </form>
        </>
      ) : (
        <section className="empty-state">
          <p>Create a project or refresh from the bridge to start.</p>
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
        <button
          type="button"
          className="secondary-button"
          onClick={handleRefreshProjects}
          disabled={projectBusy}
        >
          <span aria-hidden="true">↻</span>
          {projectBusy ? 'Scanning' : 'Refresh'}
        </button>
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
            onClick={() => {
              setSelectedProjectId(project.id)
              setActiveTab('chat')
            }}
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
        <p className="eyebrow">Codex Threads</p>
        <h2>{projectThreads.length} threads</h2>
        <div className="thread-list">
          <button type="button" className="thread-card" onClick={handleNewThread}>
            <strong>New Codex chat</strong>
            <span>Start clean in Codex</span>
          </button>
          {projectThreads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className={thread.id === activeThread?.id ? 'thread-card selected' : 'thread-card'}
              onClick={() => {
                if (!selectedProject) {
                  return
                }

                setActiveThreadIdsByProject((current) => ({
                  ...current,
                  [selectedProject.id]: thread.id,
                }))
                setActiveTab('chat')
              }}
            >
              <strong>{thread.title}</strong>
              <span>{thread.codexSessionId ? excerpt(thread.codexSessionId, 22) : 'No Codex thread yet'}</span>
            </button>
          ))}
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
          <h1>{selectedProject?.name ?? 'Project console'}</h1>
          <p>{selectedProject ? selectedStatus || 'No status set' : `${projects.length} projects`}</p>
        </div>
        <div className="topbar-actions">
          <label className="field compact-field">
            <span>Project</span>
            <select
              value={selectedProject?.id ?? ''}
              onChange={(event) => {
                setSelectedProjectId(event.target.value)
                setActiveTab('chat')
              }}
            >
              {projects.length === 0 ? (
                <option value="">No projects yet</option>
              ) : null}
              {projectMenuProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} - {formatRelative(engagementDateFor(project))}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={handleRefreshProjects}
            disabled={projectBusy}
          >
            <span aria-hidden="true">↻</span>
            {projectBusy ? 'Scanning' : 'Refresh'}
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="MyBrain sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? 'tab selected' : 'tab'}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main className="tab-panel">
        {activeTab === 'chat' ? chatTab : null}
        {activeTab === 'projects' ? projectsTab : null}
        {activeTab === 'settings' ? settingsTab : null}
        {activeTab === 'memory' ? memoryTab : null}
      </main>
    </div>
  )
}

export default App
