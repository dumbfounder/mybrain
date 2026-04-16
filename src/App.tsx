import { startTransition, useDeferredValue, useEffect, useState } from 'react'
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
  PROJECT_STAGE_OPTIONS,
  PROJECT_STATUS_OPTIONS,
  sortProjects,
  sortSessions,
} from './lib/utils'
import type {
  BridgeConfig,
  ConsoleMessage,
  LocalProjectSnapshot,
  Project,
  ProjectStage,
  ProjectStatus,
  PromptWrapper,
} from './types'

type ConsoleSettings = {
  bridge: BridgeConfig
  wrapper: PromptWrapper
  messagesByProject: Record<string, ConsoleMessage[]>
  sessionIdsByProject: Record<string, string>
}

const CONSOLE_STORAGE_KEY = 'mybrain-codex-console-v1'

const defaultBridgeUrl = () => {
  const hostname = window.location.hostname

  if (hostname.includes('onrender.com') || hostname.includes('github.io')) {
    return ''
  }

  return window.location.origin
}

const defaultConsoleSettings = (): ConsoleSettings => ({
  bridge: {
    mode: 'auto',
    url: defaultBridgeUrl(),
    token: '',
    sandbox: 'workspace-write',
    model: '',
  },
  wrapper: defaultPromptWrapper(),
  messagesByProject: {},
  sessionIdsByProject: {},
})

const loadConsoleSettings = () => {
  const fallback = defaultConsoleSettings()

  try {
    const raw = window.localStorage.getItem(CONSOLE_STORAGE_KEY)

    if (!raw) {
      return fallback
    }

    const parsed = JSON.parse(raw) as Partial<ConsoleSettings>

    return {
      bridge: { ...fallback.bridge, ...parsed.bridge },
      wrapper: { ...fallback.wrapper, ...parsed.wrapper },
      messagesByProject: parsed.messagesByProject ?? {},
      sessionIdsByProject: parsed.sessionIdsByProject ?? {},
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

const statusLineFor = (project: Project) => {
  const latestDeploy = getLatestDeploy(project)
  const bits = [
    project.status,
    project.stage,
    project.priority,
    latestDeploy ? `${latestDeploy.status} ${hostFromUrl(latestDeploy.url) || latestDeploy.provider}` : '',
  ].filter(Boolean)

  return bits.join(' · ')
}

function App() {
  const [storedState] = useState(loadState)
  const [initialConsole] = useState(loadConsoleSettings)
  const [projects, setProjects] = useState<Project[]>(sortProjects(storedState.projects))
  const [selectedProjectId, setSelectedProjectId] = useState(storedState.projects[0]?.id ?? '')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [bridge, setBridge] = useState(initialConsole.bridge)
  const [wrapper, setWrapper] = useState(initialConsole.wrapper)
  const [messagesByProject, setMessagesByProject] = useState(initialConsole.messagesByProject)
  const [sessionIdsByProject, setSessionIdsByProject] = useState(
    initialConsole.sessionIdsByProject,
  )
  const [input, setInput] = useState('')
  const [bridgeStatus, setBridgeStatus] = useState('Bridge not checked yet.')
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null)
  const [runBusy, setRunBusy] = useState(false)
  const [projectBusy, setProjectBusy] = useState(false)
  const [runLog, setRunLog] = useState<string[]>([])

  const filteredProjects = sortProjects(
    projects.filter((project) =>
      deferredSearch.trim() ? projectMatches(project, deferredSearch.trim()) : true,
    ),
  )
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? filteredProjects[0] ?? null
  const activeMessages = selectedProject ? messagesByProject[selectedProject.id] ?? [] : []
  const activeSessionId = selectedProject ? sessionIdsByProject[selectedProject.id] : ''
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
      messagesByProject,
      sessionIdsByProject,
    })
  }, [bridge, messagesByProject, sessionIdsByProject, wrapper])

  useEffect(() => {
    if (!selectedProject && filteredProjects[0]) {
      setSelectedProjectId(filteredProjects[0].id)
    }
  }, [filteredProjects, selectedProject])

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

  const appendMessages = (projectId: string, messages: ConsoleMessage[]) => {
    setMessagesByProject((current) => ({
      ...current,
      [projectId]: [...(current[projectId] ?? []), ...messages],
    }))
  }

  const updateMessage = (
    projectId: string,
    messageId: string,
    updater: (message: ConsoleMessage) => ConsoleMessage,
  ) => {
    setMessagesByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? []).map((message) =>
        message.id === messageId ? updater(message) : message,
      ),
    }))
  }

  const addRunLog = (line: string) => {
    setRunLog((current) => [...current.slice(-8), line])
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
      setBridgeStatus('Scanning projects on your Mac...')
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

      setBridgeStatus(`Loaded ${imported.count} Codex projects from ${snapshot.basePath}.`)
    } catch (error) {
      setBridgeStatus(error instanceof Error ? error.message : 'Project scan failed.')
    } finally {
      setProjectBusy(false)
    }
  }

  const handleStreamEvent = (
    project: Project,
    assistantId: string,
    event: BridgeStreamEvent,
  ) => {
    if (event.type === 'thread') {
      setSessionIdsByProject((current) => ({
        ...current,
        [project.id]: event.threadId,
      }))
      addRunLog(`Thread ${event.threadId}`)
      return
    }

    if (event.type === 'assistant') {
      updateMessage(project.id, assistantId, (message) => ({
        ...message,
        text: `${message.text}${event.text}`,
      }))
      return
    }

    if (event.type === 'turn-completed') {
      addRunLog('Turn completed.')
      return
    }

    if (event.type === 'exit') {
      addRunLog(`Codex exited with ${event.code ?? 0}.`)
      return
    }

    if (event.type === 'error') {
      addRunLog(event.message)
      updateMessage(project.id, assistantId, (message) => ({
        ...message,
        text: message.text || event.message,
      }))
      return
    }

    if (event.type === 'log') {
      addRunLog(event.text)
      return
    }

    if (event.type === 'bridge') {
      addRunLog(event.message)
    }
  }

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedProject || runBusy) {
      return
    }

    if (!hasText(input)) {
      return
    }

    if (!bridge.url.trim()) {
      appendMessages(selectedProject.id, [
        makeMessage(
          selectedProject.id,
          'system',
          'Add a bridge URL before sending to Codex.',
        ),
      ])
      return
    }

    if (!selectedProject.localPath && !activeSessionId) {
      appendMessages(selectedProject.id, [
        makeMessage(
          selectedProject.id,
          'system',
          'This project needs a local path before a new Codex thread can start.',
        ),
      ])
      return
    }

    const rawPrompt = input.trim()
    const sentPrompt = buildCodexPrompt(rawPrompt, selectedProject, wrapper)
    const assistantId = generateId()

    appendMessages(selectedProject.id, [
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
    setInput('')
    setRunLog([])

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
          sessionId: activeSessionId,
        },
        (streamEvent) => handleStreamEvent(selectedProject, assistantId, streamEvent),
      )
    } catch (error) {
      updateMessage(selectedProject.id, assistantId, (message) => ({
        ...message,
        text:
          message.text ||
          (error instanceof Error ? error.message : 'Could not reach the Codex bridge.'),
      }))
    } finally {
      setRunBusy(false)
    }
  }

  const handleClearThread = () => {
    if (!selectedProject) {
      return
    }

    setMessagesByProject((current) => ({
      ...current,
      [selectedProject.id]: [],
    }))
    setSessionIdsByProject((current) => {
      const next = { ...current }
      delete next[selectedProject.id]
      return next
    })
  }

  const latestSessions = selectedProject ? sortSessions(selectedProject.sessions).slice(0, 3) : []

  return (
    <div className="codex-console">
      <header className="console-top">
        <label className="project-picker">
          <span>Product</span>
          <select
            value={selectedProject?.id ?? ''}
            onChange={(event) => setSelectedProjectId(event.target.value)}
          >
            {filteredProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
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
          {projectBusy ? 'Scanning...' : 'Refresh'}
        </button>
      </header>

      <main className="console-main">
        <section className="status-strip">
          <div>
            <p className="eyebrow">Codex Mobile Console</p>
            <h1>{selectedProject?.name ?? 'No project loaded'}</h1>
            <p>{selectedProject ? statusLineFor(selectedProject) : 'Run the bridge and refresh projects.'}</p>
          </div>
          {selectedProject ? (
            <div className="quick-links">
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
          ) : null}
        </section>

        <section className="panel bridge-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Bridge</p>
              <h2>Web to your Mac</h2>
            </div>
            <button type="button" className="secondary-button" onClick={handleBridgeHealth}>
              Test
            </button>
          </div>
          <div className="bridge-grid">
            <label>
              <span>Bridge mode</span>
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
            <label>
              <span>Bridge URL</span>
              <input
                value={bridge.url}
                onChange={(event) =>
                  setBridge((current) => ({ ...current, url: event.target.value }))
                }
                placeholder="https://your-tunnel.example.com or http://192.168.1.5:8787"
              />
            </label>
            <label>
              <span>Token</span>
              <input
                type="password"
                value={bridge.token}
                onChange={(event) =>
                  setBridge((current) => ({ ...current, token: event.target.value }))
                }
                placeholder="MYBRAIN_BRIDGE_TOKEN"
              />
            </label>
            <label>
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
            <label>
              <span>Model override</span>
              <input
                value={bridge.model}
                onChange={(event) =>
                  setBridge((current) => ({ ...current, model: event.target.value }))
                }
                placeholder="leave blank for Codex default"
              />
            </label>
          </div>
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
          <>
            <section className="panel project-controls">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Project State</p>
                  <h2>Status and next move</h2>
                </div>
                <button type="button" className="secondary-button" onClick={handleClearThread}>
                  Clear chat
                </button>
              </div>
              <div className="bridge-grid">
                <label>
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
                <label>
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
              </div>
              <label>
                <span>Current focus</span>
                <input
                  value={selectedProject.currentFocus}
                  onChange={(event) => updateSelectedProject({ currentFocus: event.target.value })}
                  placeholder="what this project needs now"
                />
              </label>
              <label>
                <span>Next action</span>
                <input
                  value={selectedProject.nextAction}
                  onChange={(event) => updateSelectedProject({ nextAction: event.target.value })}
                  placeholder="exact next action"
                />
              </label>
            </section>

            <section className="panel chat-panel">
              <div className="message-list">
                {activeMessages.length === 0 ? (
                  <div className="empty-chat">
                    <p>No mobile Codex chat for this project yet.</p>
                    <span>Send a message below; the wrapper preview shows what Codex receives.</span>
                  </div>
                ) : (
                  activeMessages.map((message) => (
                    <article key={message.id} className={`message message--${message.role}`}>
                      <div className="message-meta">
                        <span>{message.role}</span>
                        <time dateTime={message.createdAt}>
                          {formatDateTime(message.createdAt)}
                        </time>
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

              <form className="composer" onSubmit={handleSend}>
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Tell Codex what to do in this product..."
                  rows={4}
                />
                <div className="composer-actions">
                  <span>{activeSessionId ? `Thread ${excerpt(activeSessionId, 18)}` : 'New thread'}</span>
                  <button type="submit" className="primary-button" disabled={runBusy || !input.trim()}>
                    {runBusy ? 'Running...' : 'Send to Codex'}
                  </button>
                </div>
              </form>
            </section>

            <details className="panel wrapper-panel" open>
              <summary>
                <span>Prompt Wrapper</span>
                <strong>Always alter what gets sent</strong>
              </summary>
              <label>
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
              <label>
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

            <section className="panel facts-panel">
              <div>
                <p className="eyebrow">Project Memory</p>
                <h2>Deploys, features, prior AI</h2>
              </div>
              <div className="fact-grid">
                <article>
                  <h3>Deploys</h3>
                  {selectedProject.deploys.length ? (
                    selectedProject.deploys.slice(0, 4).map((deploy) => (
                      <p key={deploy.id}>
                        {deploy.status} · {deploy.provider} ·{' '}
                        {deploy.url || deploy.commit || 'no URL'}
                      </p>
                    ))
                  ) : (
                    <p>No deploys tracked.</p>
                  )}
                </article>
                <article>
                  <h3>Features</h3>
                  {selectedProject.features.length ? (
                    selectedProject.features.slice(0, 4).map((feature) => (
                      <p key={feature.id}>
                        {feature.status} · {feature.title}
                      </p>
                    ))
                  ) : (
                    <p>No features tracked.</p>
                  )}
                </article>
                <article>
                  <h3>Prior AI</h3>
                  {latestSessions.length ? (
                    latestSessions.map((session) => (
                      <p key={session.id}>
                        {session.tool} · {formatRelative(session.updatedAt)} ·{' '}
                        {excerpt(session.prompt || session.result, 90)}
                      </p>
                    ))
                  ) : (
                    <p>No previous AI logs.</p>
                  )}
                </article>
              </div>
            </section>
          </>
        ) : (
          <section className="panel empty-chat">
            <p>No projects loaded.</p>
            <span>
              Run the bridge, then tap Refresh. You can also import the existing snapshot data by
              using the old tracker storage.
            </span>
          </section>
        )}
      </main>

      <aside className="project-drawer">
        <div className="drawer-header">
          <span>{projects.length} projects</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
          />
        </div>
        <div className="drawer-list">
          {filteredProjects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={project.id === selectedProject?.id ? 'project-row selected' : 'project-row'}
              onClick={() => setSelectedProjectId(project.id)}
            >
              <strong>{project.name}</strong>
              <span>{statusLineFor(project)}</span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  )
}

export default App
