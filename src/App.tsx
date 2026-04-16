import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'
import type { FormEvent } from 'react'
import './App.css'
import { AiSessionList } from './components/AiSessionList'
import { DeployList } from './components/DeployList'
import { FeatureList } from './components/FeatureList'
import { ProjectCard } from './components/ProjectCard'
import { importChatGptFile } from './lib/chatgptImport'
import { createSecretSyncGist, mergeProjectCollections, syncWithRemote } from './lib/gistSync'
import { importProjectSnapshotFile } from './lib/projectSnapshotImport'
import { loadState, saveState } from './lib/storage'
import {
  countLiveProjects,
  countShippedFeatures,
  countStaleProjects,
  DEPLOY_ENV_OPTIONS,
  DEPLOY_PROVIDER_OPTIONS,
  DEPLOY_STATUS_OPTIONS,
  excerpt,
  FEATURE_STATUS_OPTIONS,
  formatDateTime,
  formatRelative,
  generateId,
  getLatestDeploy,
  getLatestSession,
  hasText,
  hostFromUrl,
  normalizeRepoUrl,
  normalizeTags,
  nowIso,
  PRIORITY_OPTIONS,
  PROJECT_STAGE_OPTIONS,
  PROJECT_STATUS_OPTIONS,
  sortDeploys,
  sortFeatures,
  sortProjects,
  sortSessions,
  TOOL_OPTIONS,
} from './lib/utils'
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
  SyncConfig,
  ToolName,
} from './types'

type NewProjectDraft = {
  name: string
  summary: string
  status: ProjectStatus
  stage: ProjectStage
  priority: Priority
  tool: ToolName
  currentFocus: string
  nextAction: string
  repoUrl: string
  productionUrl: string
  localPath: string
  tags: string
  notes: string
  prompt: string
  result: string
  nextPrompt: string
  link: string
}

type ProjectEditDraft = {
  name: string
  summary: string
  status: ProjectStatus
  stage: ProjectStage
  priority: Priority
  tool: ToolName
  currentFocus: string
  nextAction: string
  repoUrl: string
  productionUrl: string
  localPath: string
  notes: string
}

type SessionDraft = {
  tool: ToolName
  prompt: string
  result: string
  nextPrompt: string
  link: string
}

type FeatureDraft = {
  title: string
  status: FeatureStatus
  summary: string
  notes: string
}

type DeployDraft = {
  provider: DeployProvider
  environment: DeployEnvironment
  status: DeployStatus
  url: string
  commit: string
  notes: string
}

const emptyNewProjectDraft = (): NewProjectDraft => ({
  name: '',
  summary: '',
  status: 'active',
  stage: 'building',
  priority: 'now',
  tool: 'Codex',
  currentFocus: '',
  nextAction: '',
  repoUrl: '',
  productionUrl: '',
  localPath: '',
  tags: '',
  notes: '',
  prompt: '',
  result: '',
  nextPrompt: '',
  link: '',
})

const emptySessionDraft = (tool: ToolName = 'Codex'): SessionDraft => ({
  tool,
  prompt: '',
  result: '',
  nextPrompt: '',
  link: '',
})

const emptyFeatureDraft = (): FeatureDraft => ({
  title: '',
  status: 'building',
  summary: '',
  notes: '',
})

const emptyDeployDraft = (): DeployDraft => ({
  provider: 'Render',
  environment: 'production',
  status: 'live',
  url: '',
  commit: '',
  notes: '',
})

const cloneProject = (project: Project) => ({
  ...project,
  tags: [...project.tags],
  sessions: [...project.sessions],
  features: [...project.features],
  deploys: [...project.deploys],
})

const projectToEditDraft = (project: Project): ProjectEditDraft => ({
  name: project.name,
  summary: project.summary,
  status: project.status,
  stage: project.stage,
  priority: project.priority,
  tool: project.tool,
  currentFocus: project.currentFocus,
  nextAction: project.nextAction,
  repoUrl: project.repoUrl,
  productionUrl: project.productionUrl,
  localPath: project.localPath,
  notes: project.notes,
})

const buildSession = (draft: SessionDraft, source: AiSessionEntry['source']) => {
  const timestamp = nowIso()

  return {
    id: generateId(),
    tool: draft.tool,
    prompt: draft.prompt.trim(),
    result: draft.result.trim(),
    nextPrompt: draft.nextPrompt.trim(),
    link: draft.link.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
    source,
  } satisfies AiSessionEntry
}

const buildFeature = (draft: FeatureDraft) => {
  const timestamp = nowIso()

  return {
    id: generateId(),
    title: draft.title.trim(),
    status: draft.status,
    summary: draft.summary.trim(),
    notes: draft.notes.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
    shippedAt: draft.status === 'shipped' ? timestamp : undefined,
  } satisfies FeatureEntry
}

const buildDeploy = (draft: DeployDraft) => {
  const timestamp = nowIso()

  return {
    id: generateId(),
    provider: draft.provider,
    environment: draft.environment,
    status: draft.status,
    url: draft.url.trim(),
    commit: draft.commit.trim(),
    notes: draft.notes.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies DeployEntry
}

const projectMatches = (project: Project, query: string) => {
  const haystack = [
    project.name,
    project.summary,
    project.currentFocus,
    project.nextAction,
    project.notes,
    project.repoUrl,
    project.productionUrl,
    project.localPath,
    project.tags.join(' '),
    project.features.map((feature) => `${feature.title} ${feature.summary}`).join(' '),
    project.deploys.map((deploy) => `${deploy.provider} ${deploy.url} ${deploy.notes}`).join(' '),
    project.sessions.map((session) => `${session.prompt} ${session.result}`).join(' '),
  ]
    .join(' ')
    .toLowerCase()

  return haystack.includes(query.toLowerCase())
}

function App() {
  const initialState = loadState()
  const [projects, setProjects] = useState<Project[]>(sortProjects(initialState.projects))
  const [sync, setSync] = useState<SyncConfig | undefined>(initialState.sync)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'all'>('all')
  const [stageFilter, setStageFilter] = useState<ProjectStage | 'all'>('all')
  const [newProjectDraft, setNewProjectDraft] = useState(emptyNewProjectDraft)
  const [selectedProjectId, setSelectedProjectId] = useState(initialState.projects[0]?.id ?? '')
  const [projectDraft, setProjectDraft] = useState<ProjectEditDraft | null>(
    initialState.projects[0] ? projectToEditDraft(sortProjects(initialState.projects)[0]) : null,
  )
  const [projectTags, setProjectTags] = useState(initialState.projects[0]?.tags.join(', ') ?? '')
  const [sessionDraft, setSessionDraft] = useState(emptySessionDraft())
  const [featureDraft, setFeatureDraft] = useState(emptyFeatureDraft)
  const [deployDraft, setDeployDraft] = useState(emptyDeployDraft)
  const [syncTokenInput, setSyncTokenInput] = useState(initialState.sync?.token ?? '')
  const [syncGistInput, setSyncGistInput] = useState(initialState.sync?.gistId ?? '')
  const [syncMessage, setSyncMessage] = useState(
    initialState.sync?.lastSyncStatus ?? 'Local-first mode. Add GitHub sync when you are ready.',
  )
  const [syncBusy, setSyncBusy] = useState(false)
  const [chatGptImportMessage, setChatGptImportMessage] = useState(
    'Import a ChatGPT export zip or conversations.json to turn research chats into tracked projects.',
  )
  const [snapshotImportMessage, setSnapshotImportMessage] = useState(
    'Import a local Codex project snapshot JSON to seed your board with repos, commit state, and deploy URLs.',
  )
  const [importBusy, setImportBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [shareBanner, setShareBanner] = useState('')
  const lastSyncedSignature = useRef(JSON.stringify(sortProjects(initialState.projects)))

  const filteredProjects = sortProjects(
    projects.filter((project) => {
      const matchesStatus = statusFilter === 'all' || project.status === statusFilter
      const matchesStage = stageFilter === 'all' || project.stage === stageFilter
      const matchesSearch =
        deferredSearch.trim().length === 0 || projectMatches(project, deferredSearch.trim())

      return matchesStatus && matchesStage && matchesSearch
    }),
  )

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? filteredProjects[0] ?? null
  const latestSelectedSession = selectedProject ? getLatestSession(selectedProject) : null
  const latestSelectedDeploy = selectedProject ? getLatestDeploy(selectedProject) : null
  const projectSignature = JSON.stringify(sortProjects(projects))

  useEffect(() => {
    saveState({ projects, sync })
  }, [projects, sync])

  useEffect(() => {
    const nextSelected =
      projects.find((project) => project.id === selectedProjectId) ?? filteredProjects[0] ?? null

    if (!nextSelected) {
      setProjectDraft(null)
      setProjectTags('')
      return
    }

    if (nextSelected.id !== selectedProjectId) {
      setSelectedProjectId(nextSelected.id)
    }

    setProjectDraft(projectToEditDraft(cloneProject(nextSelected)))
    setProjectTags(nextSelected.tags.join(', '))
    setSessionDraft(emptySessionDraft(nextSelected.tool))
    setFeatureDraft(emptyFeatureDraft())
    setDeployDraft((current) => ({
      ...emptyDeployDraft(),
      provider: current.provider,
      environment: current.environment,
      status: current.status,
      url: nextSelected.productionUrl || current.url,
    }))
  }, [filteredProjects, projects, selectedProjectId])

  useEffect(() => {
    if (!toast) {
      return undefined
    }

    const timeout = window.setTimeout(() => setToast(''), 2800)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)

    if (params.get('share') !== '1') {
      return
    }

    const title = params.get('title') ?? ''
    const text = params.get('text') ?? ''
    const url = params.get('url') ?? ''
    const host = url ? hostFromUrl(url) : ''

    setNewProjectDraft((current) => ({
      ...current,
      name: current.name || title || host,
      tool: current.tool === 'Other' ? 'ChatGPT' : current.tool,
      prompt: current.prompt || text,
      link: current.link || url,
      notes: current.notes || (url ? `Shared into MyBrain from ${host}.` : current.notes),
    }))
    setShareBanner('Shared content is ready in New Project. Save it before the context evaporates.')

    window.history.replaceState({}, document.title, window.location.pathname)
  }, [])

  const runBackgroundSync = useEffectEvent(() => {
    void handleSyncNow(true)
  })

  useEffect(() => {
    if (!sync?.token || !sync.gistId || syncBusy) {
      return undefined
    }

    if (projectSignature === lastSyncedSignature.current) {
      return undefined
    }

    const timeout = window.setTimeout(() => {
      runBackgroundSync()
    }, 1800)

    return () => window.clearTimeout(timeout)
  }, [projectSignature, sync?.gistId, sync?.token, syncBusy])

  const setToastMessage = (message: string) => {
    setToast(message)
  }

  const updateProjectById = (
    projectId: string,
    updater: (project: Project) => Project,
    toastMessage?: string,
  ) => {
    setProjects((currentProjects) =>
      sortProjects(
        currentProjects.map((project) =>
          project.id === projectId ? updater(cloneProject(project)) : project,
        ),
      ),
    )

    if (toastMessage) {
      setToastMessage(toastMessage)
    }
  }

  const resetNewProjectDraft = () => {
    setNewProjectDraft((current) => ({
      ...emptyNewProjectDraft(),
      tool: current.tool,
      status: current.status,
      stage: current.stage,
      priority: current.priority,
    }))
    setShareBanner('')
  }

  const handleCreateProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!hasText(newProjectDraft.name)) {
      setToastMessage('Project name is required.')
      return
    }

    const timestamp = nowIso()
    const sessionHasData =
      hasText(newProjectDraft.prompt) ||
      hasText(newProjectDraft.result) ||
      hasText(newProjectDraft.nextPrompt) ||
      hasText(newProjectDraft.link)
    const session = sessionHasData
      ? buildSession(
          {
            tool: newProjectDraft.tool,
            prompt: newProjectDraft.prompt,
            result: newProjectDraft.result,
            nextPrompt: newProjectDraft.nextPrompt,
            link: newProjectDraft.link,
          },
          shareBanner ? 'share-target' : 'manual',
        )
      : null

    const project: Project = {
      id: generateId(),
      name: newProjectDraft.name.trim(),
      summary: newProjectDraft.summary.trim(),
      status: newProjectDraft.status,
      stage: newProjectDraft.stage,
      priority: newProjectDraft.priority,
      tool: newProjectDraft.tool,
      tags: normalizeTags(newProjectDraft.tags),
      notes: newProjectDraft.notes.trim(),
      currentFocus:
        newProjectDraft.currentFocus.trim() ||
        excerpt(newProjectDraft.result, 160) ||
        excerpt(newProjectDraft.summary, 160),
      nextAction:
        newProjectDraft.nextAction.trim() || newProjectDraft.nextPrompt.trim(),
      repoUrl: normalizeRepoUrl(newProjectDraft.repoUrl),
      productionUrl: newProjectDraft.productionUrl.trim(),
      localPath: newProjectDraft.localPath.trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastTouchedAt: timestamp,
      features: [],
      deploys: [],
      sessions: session ? [session] : [],
      source: shareBanner ? 'share-target' : 'manual',
    }

    setProjects((currentProjects) => sortProjects([project, ...currentProjects]))
    setSelectedProjectId(project.id)
    resetNewProjectDraft()
    setToastMessage('Saved a new project.')
  }

  const handleSaveProjectDetails = () => {
    if (!selectedProject || !projectDraft) {
      return
    }

    const timestamp = nowIso()

    updateProjectById(
      selectedProject.id,
      (project) => ({
        ...project,
        ...projectDraft,
        repoUrl: normalizeRepoUrl(projectDraft.repoUrl),
        tags: normalizeTags(projectTags),
        updatedAt: timestamp,
        lastTouchedAt: timestamp,
      }),
      'Updated project details.',
    )
  }

  const handleAddSession = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedProject) {
      return
    }

    if (
      !hasText(sessionDraft.prompt) &&
      !hasText(sessionDraft.result) &&
      !hasText(sessionDraft.nextPrompt) &&
      !hasText(sessionDraft.link)
    ) {
      setToastMessage('Add some AI activity before saving the log.')
      return
    }

    const session = buildSession(sessionDraft, 'manual')
    const timestamp = session.updatedAt

    updateProjectById(
      selectedProject.id,
      (project) => ({
        ...project,
        tool: session.tool,
        currentFocus: project.currentFocus || excerpt(session.result, 160),
        nextAction: session.nextPrompt || project.nextAction,
        updatedAt: timestamp,
        lastTouchedAt: timestamp,
        sessions: sortSessions([session, ...project.sessions]),
      }),
      'Added AI activity.',
    )
    setSessionDraft(emptySessionDraft(selectedProject.tool))
  }

  const handleAddFeature = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedProject) {
      return
    }

    if (!hasText(featureDraft.title)) {
      setToastMessage('Feature title is required.')
      return
    }

    const feature = buildFeature(featureDraft)
    const timestamp = feature.updatedAt

    updateProjectById(
      selectedProject.id,
      (project) => ({
        ...project,
        updatedAt: timestamp,
        lastTouchedAt: timestamp,
        features: sortFeatures([feature, ...project.features]),
      }),
      'Added feature log.',
    )
    setFeatureDraft(emptyFeatureDraft())
  }

  const handleAddDeploy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedProject) {
      return
    }

    const deploy = buildDeploy(deployDraft)
    const timestamp = deploy.updatedAt

    updateProjectById(
      selectedProject.id,
      (project) => ({
        ...project,
        stage:
          deploy.status === 'live' && deploy.environment === 'production'
            ? 'live'
            : project.stage,
        productionUrl:
          deploy.environment === 'production' && deploy.url
            ? deploy.url
            : project.productionUrl,
        updatedAt: timestamp,
        lastTouchedAt: timestamp,
        deploys: sortDeploys([deploy, ...project.deploys]),
      }),
      'Added deploy log.',
    )
    setDeployDraft((current) => ({
      ...emptyDeployDraft(),
      provider: current.provider,
      environment: current.environment,
      status: current.status,
    }))
  }

  const handleCreateSyncGist = async () => {
    if (!syncTokenInput.trim()) {
      setSyncMessage('Paste a GitHub token with gist scope first.')
      return
    }

    try {
      setSyncBusy(true)
      setSyncMessage('Creating a private sync gist on GitHub...')
      const created = await createSecretSyncGist(syncTokenInput.trim(), projects)
      const nextSync: SyncConfig = {
        provider: 'github-gist',
        gistId: created.gistId,
        token: syncTokenInput.trim(),
        lastSyncedAt: created.syncedAt,
        lastSyncStatus: `Connected. Last synced ${formatRelative(created.syncedAt)}.`,
      }

      setSync(nextSync)
      setSyncGistInput(created.gistId)
      setSyncMessage(nextSync.lastSyncStatus ?? 'Connected.')
      lastSyncedSignature.current = projectSignature
      setToastMessage('GitHub sync is live.')
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Could not create the sync gist.')
    } finally {
      setSyncBusy(false)
    }
  }

  async function handleSyncNow(quiet = false) {
    const token = (sync?.token ?? syncTokenInput).trim()
    const gistId = (sync?.gistId ?? syncGistInput).trim()

    if (!token || !gistId) {
      setSyncMessage('Add both a GitHub gist token and gist id before syncing.')
      return
    }

    try {
      setSyncBusy(true)
      setSyncMessage('Merging local changes with GitHub...')
      const merged = await syncWithRemote(token, gistId, projects)
      startTransition(() => {
        setProjects(merged.projects)
      })

      const nextSync: SyncConfig = {
        provider: 'github-gist',
        gistId,
        token,
        lastSyncedAt: merged.syncedAt,
        lastSyncStatus: `Synced ${formatRelative(merged.syncedAt)}.`,
      }

      setSync(nextSync)
      setSyncTokenInput(token)
      setSyncGistInput(gistId)
      setSyncMessage(nextSync.lastSyncStatus ?? 'Synced.')
      lastSyncedSignature.current = JSON.stringify(sortProjects(merged.projects))

      if (!quiet) {
        setToastMessage('Synced with GitHub.')
      }
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Sync failed.')
    } finally {
      setSyncBusy(false)
    }
  }

  const handleImportChatGpt = async (file: File | undefined) => {
    if (!file) {
      return
    }

    try {
      setImportBusy(true)
      setChatGptImportMessage('Parsing your ChatGPT export...')
      const imported = await importChatGptFile(file)

      startTransition(() => {
        setProjects((currentProjects) =>
          mergeProjectCollections(imported.projects, currentProjects),
        )
      })

      if (imported.projects[0]) {
        setSelectedProjectId(imported.projects[0].id)
      }

      setChatGptImportMessage(`Imported ${imported.count} ChatGPT projects.`)
      setToastMessage(`Imported ${imported.count} ChatGPT projects.`)
    } catch (error) {
      setChatGptImportMessage(
        error instanceof Error ? error.message : 'The ChatGPT file could not be imported.',
      )
    } finally {
      setImportBusy(false)
    }
  }

  const handleImportSnapshot = async (file: File | undefined) => {
    if (!file) {
      return
    }

    try {
      setImportBusy(true)
      setSnapshotImportMessage('Parsing your local project snapshot...')
      const imported = await importProjectSnapshotFile(file)

      startTransition(() => {
        setProjects((currentProjects) =>
          mergeProjectCollections(imported.projects, currentProjects),
        )
      })

      if (imported.projects[0]) {
        setSelectedProjectId(imported.projects[0].id)
      }

      setSnapshotImportMessage(`Imported ${imported.count} Codex projects.`)
      setToastMessage(`Imported ${imported.count} Codex projects.`)
    } catch (error) {
      setSnapshotImportMessage(
        error instanceof Error ? error.message : 'The snapshot file could not be imported.',
      )
    } finally {
      setImportBusy(false)
    }
  }

  const handleCopy = async (value: string, label: string) => {
    if (!value) {
      return
    }

    try {
      await navigator.clipboard.writeText(value)
      setToastMessage(`Copied ${label}.`)
    } catch {
      setToastMessage(`Could not copy ${label}.`)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__title">
          <h1>Projects</h1>
          <p>Private Codex tracker</p>
        </div>
        <div className="topbar__stats">
          <span className="stat-pill">
            <strong>{projects.filter((project) => project.status === 'active').length}</strong>
            active
          </span>
          <span className="stat-pill">
            <strong>{countLiveProjects(projects)}</strong>
            live
          </span>
          <span className="stat-pill">
            <strong>{countShippedFeatures(projects)}</strong>
            shipped
          </span>
          <span className="stat-pill">
            <strong>{countStaleProjects(projects)}</strong>
            stale
          </span>
        </div>
      </header>

      {toast ? <div className="toast">{toast}</div> : null}

      {shareBanner ? (
        <section className="banner">
          <p>{shareBanner}</p>
        </section>
      ) : null}

      <main className="workspace-grid">
        <section className="panel">
          <div className="panel__header">
            <div>
              <p className="eyebrow">Project List</p>
              <h2>Everything you are building.</h2>
            </div>
            <div className="board-controls">
              <input
                className="search-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search projects, features, deploys, prompts..."
              />
              <select
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as ProjectStatus | 'all')
                }
              >
                <option value="all">All statuses</option>
                {PROJECT_STATUS_OPTIONS.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </select>
              <select
                value={stageFilter}
                onChange={(event) =>
                  setStageFilter(event.target.value as ProjectStage | 'all')
                }
              >
                <option value="all">All stages</option>
                {PROJECT_STAGE_OPTIONS.map((stage) => (
                  <option key={stage.value} value={stage.value}>
                    {stage.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {filteredProjects.length === 0 ? (
            <div className="empty-panel">
              <p>No projects match this view yet.</p>
              <span>Import a snapshot or add a project below.</span>
            </div>
          ) : (
            <div className="project-grid">
              {filteredProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  selected={project.id === selectedProjectId}
                  onSelect={setSelectedProjectId}
                />
              ))}
            </div>
          )}
        </section>

        <section className="panel panel--focus">
          <div className="panel__header">
            <div>
              <p className="eyebrow">Selected Project</p>
              <h2>{selectedProject?.name ?? 'Pick a project'}</h2>
            </div>
            {selectedProject ? (
              <div className="focus-meta">
                <span>{selectedProject.tool}</span>
                <span>{selectedProject.stage}</span>
                <span>{formatRelative(selectedProject.lastTouchedAt)}</span>
              </div>
            ) : null}
          </div>

          {selectedProject && projectDraft ? (
            <div className="focus-layout">
              <div className="focus-column">
                <section className="subpanel">
                  <div className="subpanel__header">
                    <div>
                      <p className="eyebrow">Details</p>
                      <h3>Status, links, and next move.</h3>
                    </div>
                  </div>

                  <div className="focus-form">
                    <label>
                      <span>Name</span>
                      <input
                        value={projectDraft.name}
                        onChange={(event) =>
                          setProjectDraft((current) =>
                            current ? { ...current, name: event.target.value } : current,
                          )
                        }
                      />
                    </label>
                    <label>
                      <span>Summary</span>
                      <textarea
                        rows={3}
                        value={projectDraft.summary}
                        onChange={(event) =>
                          setProjectDraft((current) =>
                            current ? { ...current, summary: event.target.value } : current,
                          )
                        }
                      />
                    </label>
                    <div className="form-row form-row--4">
                      <label>
                        <span>Status</span>
                        <select
                          value={projectDraft.status}
                          onChange={(event) =>
                            setProjectDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    status: event.target.value as ProjectStatus,
                                  }
                                : current,
                            )
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
                          value={projectDraft.stage}
                          onChange={(event) =>
                            setProjectDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    stage: event.target.value as ProjectStage,
                                  }
                                : current,
                            )
                          }
                        >
                          {PROJECT_STAGE_OPTIONS.map((stage) => (
                            <option key={stage.value} value={stage.value}>
                              {stage.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Priority</span>
                        <select
                          value={projectDraft.priority}
                          onChange={(event) =>
                            setProjectDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    priority: event.target.value as Priority,
                                  }
                                : current,
                            )
                          }
                        >
                          {PRIORITY_OPTIONS.map((priority) => (
                            <option key={priority.value} value={priority.value}>
                              {priority.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Main tool</span>
                        <select
                          value={projectDraft.tool}
                          onChange={(event) =>
                            setProjectDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    tool: event.target.value as ToolName,
                                  }
                                : current,
                            )
                          }
                        >
                          {TOOL_OPTIONS.map((tool) => (
                            <option key={tool} value={tool}>
                              {tool}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="form-row">
                      <label>
                        <span>Current focus</span>
                        <input
                          value={projectDraft.currentFocus}
                          onChange={(event) =>
                            setProjectDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    currentFocus: event.target.value,
                                  }
                                : current,
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Next action</span>
                        <input
                          value={projectDraft.nextAction}
                          onChange={(event) =>
                            setProjectDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    nextAction: event.target.value,
                                  }
                                : current,
                            )
                          }
                        />
                      </label>
                    </div>
                    <div className="form-row">
                      <label>
                        <span>Repo URL</span>
                        <input
                          value={projectDraft.repoUrl}
                          onChange={(event) =>
                            setProjectDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    repoUrl: event.target.value,
                                  }
                                : current,
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Production URL</span>
                        <input
                          value={projectDraft.productionUrl}
                          onChange={(event) =>
                            setProjectDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    productionUrl: event.target.value,
                                  }
                                : current,
                            )
                          }
                        />
                      </label>
                    </div>
                    <div className="form-row">
                      <label>
                        <span>Local path</span>
                        <input
                          value={projectDraft.localPath}
                          onChange={(event) =>
                            setProjectDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    localPath: event.target.value,
                                  }
                                : current,
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Tags</span>
                        <input
                          value={projectTags}
                          onChange={(event) => setProjectTags(event.target.value)}
                        />
                      </label>
                    </div>
                    <label>
                      <span>Notes</span>
                      <textarea
                        rows={4}
                        value={projectDraft.notes}
                        onChange={(event) =>
                          setProjectDraft((current) =>
                            current ? { ...current, notes: event.target.value } : current,
                          )
                        }
                      />
                    </label>

                    <div className="form-actions">
                      <button
                        type="button"
                        className="primary-button"
                        onClick={handleSaveProjectDetails}
                      >
                        Save details
                      </button>
                      {projectDraft.repoUrl ? (
                        <a
                          className="ghost-button"
                          href={projectDraft.repoUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open repo
                        </a>
                      ) : null}
                      {projectDraft.productionUrl ? (
                        <a
                          className="ghost-button"
                          href={projectDraft.productionUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open production
                        </a>
                      ) : null}
                      {projectDraft.nextAction ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => handleCopy(projectDraft.nextAction, 'next action')}
                        >
                          Copy next action
                        </button>
                      ) : null}
                    </div>

                    <div className="focus-timestamps">
                      <span>Created {formatDateTime(selectedProject.createdAt)}</span>
                      <span>Updated {formatDateTime(selectedProject.updatedAt)}</span>
                    </div>
                  </div>
                </section>

                <section className="subpanel">
                  <div className="subpanel__header">
                    <div>
                      <p className="eyebrow">AI Log</p>
                      <h3>Latest prompt, result, and next prompt.</h3>
                    </div>
                  </div>

                  <form className="mini-form" onSubmit={handleAddSession}>
                    <label>
                      <span>Tool</span>
                      <select
                        value={sessionDraft.tool}
                        onChange={(event) =>
                          setSessionDraft((current) => ({
                            ...current,
                            tool: event.target.value as ToolName,
                          }))
                        }
                      >
                        {TOOL_OPTIONS.map((tool) => (
                          <option key={tool} value={tool}>
                            {tool}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Last prompt</span>
                      <textarea
                        rows={3}
                        value={sessionDraft.prompt}
                        onChange={(event) =>
                          setSessionDraft((current) => ({
                            ...current,
                            prompt: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>What it did</span>
                      <textarea
                        rows={3}
                        value={sessionDraft.result}
                        onChange={(event) =>
                          setSessionDraft((current) => ({
                            ...current,
                            result: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="form-row">
                      <label>
                        <span>Next prompt</span>
                        <textarea
                          rows={2}
                          value={sessionDraft.nextPrompt}
                          onChange={(event) =>
                            setSessionDraft((current) => ({
                              ...current,
                              nextPrompt: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        <span>Link</span>
                        <input
                          value={sessionDraft.link}
                          onChange={(event) =>
                            setSessionDraft((current) => ({
                              ...current,
                              link: event.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                    <div className="form-actions">
                      <button type="submit" className="primary-button">
                        Add AI log
                      </button>
                    </div>
                  </form>
                </section>
              </div>

              <div className="focus-column">
                <section className="subpanel">
                  <div className="subpanel__header">
                    <div>
                      <p className="eyebrow">Deploys</p>
                      <h3>
                        {latestSelectedDeploy
                          ? `${latestSelectedDeploy.status} on ${latestSelectedDeploy.provider}`
                          : 'Track deploy state, URLs, and commits.'}
                      </h3>
                    </div>
                  </div>

                  <form className="mini-form" onSubmit={handleAddDeploy}>
                    <div className="form-row form-row--3">
                      <label>
                        <span>Provider</span>
                        <select
                          value={deployDraft.provider}
                          onChange={(event) =>
                            setDeployDraft((current) => ({
                              ...current,
                              provider: event.target.value as DeployProvider,
                            }))
                          }
                        >
                          {DEPLOY_PROVIDER_OPTIONS.map((provider) => (
                            <option key={provider} value={provider}>
                              {provider}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Environment</span>
                        <select
                          value={deployDraft.environment}
                          onChange={(event) =>
                            setDeployDraft((current) => ({
                              ...current,
                              environment: event.target.value as DeployEnvironment,
                            }))
                          }
                        >
                          {DEPLOY_ENV_OPTIONS.map((environment) => (
                            <option key={environment.value} value={environment.value}>
                              {environment.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Status</span>
                        <select
                          value={deployDraft.status}
                          onChange={(event) =>
                            setDeployDraft((current) => ({
                              ...current,
                              status: event.target.value as DeployStatus,
                            }))
                          }
                        >
                          {DEPLOY_STATUS_OPTIONS.map((status) => (
                            <option key={status.value} value={status.value}>
                              {status.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="form-row">
                      <label>
                        <span>Deploy URL</span>
                        <input
                          value={deployDraft.url}
                          onChange={(event) =>
                            setDeployDraft((current) => ({
                              ...current,
                              url: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        <span>Commit</span>
                        <input
                          value={deployDraft.commit}
                          onChange={(event) =>
                            setDeployDraft((current) => ({
                              ...current,
                              commit: event.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                    <label>
                      <span>Notes</span>
                      <textarea
                        rows={2}
                        value={deployDraft.notes}
                        onChange={(event) =>
                          setDeployDraft((current) => ({
                            ...current,
                            notes: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="form-actions">
                      <button type="submit" className="primary-button">
                        Add deploy
                      </button>
                    </div>
                  </form>

                  <DeployList deploys={selectedProject.deploys} />
                </section>

                <section className="subpanel">
                  <div className="subpanel__header">
                    <div>
                      <p className="eyebrow">Features</p>
                      <h3>What shipped, what is in progress, what is next.</h3>
                    </div>
                  </div>

                  <form className="mini-form" onSubmit={handleAddFeature}>
                    <div className="form-row">
                      <label>
                        <span>Feature</span>
                        <input
                          value={featureDraft.title}
                          onChange={(event) =>
                            setFeatureDraft((current) => ({
                              ...current,
                              title: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        <span>Status</span>
                        <select
                          value={featureDraft.status}
                          onChange={(event) =>
                            setFeatureDraft((current) => ({
                              ...current,
                              status: event.target.value as FeatureStatus,
                            }))
                          }
                        >
                          {FEATURE_STATUS_OPTIONS.map((status) => (
                            <option key={status.value} value={status.value}>
                              {status.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label>
                      <span>Summary</span>
                      <textarea
                        rows={2}
                        value={featureDraft.summary}
                        onChange={(event) =>
                          setFeatureDraft((current) => ({
                            ...current,
                            summary: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>Notes</span>
                      <textarea
                        rows={2}
                        value={featureDraft.notes}
                        onChange={(event) =>
                          setFeatureDraft((current) => ({
                            ...current,
                            notes: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="form-actions">
                      <button type="submit" className="primary-button">
                        Add feature
                      </button>
                    </div>
                  </form>

                  <FeatureList features={selectedProject.features} />
                </section>

                <section className="subpanel">
                  <div className="subpanel__header">
                    <div>
                      <p className="eyebrow">AI Activity</p>
                      <h3>
                        {latestSelectedSession
                          ? excerpt(latestSelectedSession.prompt, 72)
                          : 'Chronological AI work for this project.'}
                      </h3>
                    </div>
                  </div>

                  <AiSessionList sessions={selectedProject.sessions} onCopy={handleCopy} />
                </section>
              </div>
            </div>
          ) : (
            <div className="empty-panel">
              <p>Pick a project from the board to manage its deploys, features, and AI work.</p>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel__header">
            <div>
              <p className="eyebrow">Quick Add</p>
              <h2>New project</h2>
            </div>
          </div>

          <form className="capture-form" onSubmit={handleCreateProject}>
            <label>
              <span>Name</span>
              <input
                value={newProjectDraft.name}
                onChange={(event) =>
                  setNewProjectDraft((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="new project"
              />
            </label>

            <label>
              <span>Summary</span>
              <textarea
                rows={2}
                value={newProjectDraft.summary}
                onChange={(event) =>
                  setNewProjectDraft((current) => ({
                    ...current,
                    summary: event.target.value,
                  }))
                }
                placeholder="what this is"
              />
            </label>

            <div className="form-row form-row--4">
              <label>
                <span>Status</span>
                <select
                  value={newProjectDraft.status}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({
                      ...current,
                      status: event.target.value as ProjectStatus,
                    }))
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
                  value={newProjectDraft.stage}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({
                      ...current,
                      stage: event.target.value as ProjectStage,
                    }))
                  }
                >
                  {PROJECT_STAGE_OPTIONS.map((stage) => (
                    <option key={stage.value} value={stage.value}>
                      {stage.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Priority</span>
                <select
                  value={newProjectDraft.priority}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({
                      ...current,
                      priority: event.target.value as Priority,
                    }))
                  }
                >
                  {PRIORITY_OPTIONS.map((priority) => (
                    <option key={priority.value} value={priority.value}>
                      {priority.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Tool</span>
                <select
                  value={newProjectDraft.tool}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({
                      ...current,
                      tool: event.target.value as ToolName,
                    }))
                  }
                >
                  {TOOL_OPTIONS.map((tool) => (
                    <option key={tool} value={tool}>
                      {tool}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="form-row">
              <label>
                <span>Current focus</span>
                <input
                  value={newProjectDraft.currentFocus}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({
                      ...current,
                      currentFocus: event.target.value,
                    }))
                  }
                  placeholder="what matters right now"
                />
              </label>
              <label>
                <span>Next action</span>
                <input
                  value={newProjectDraft.nextAction}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({
                      ...current,
                      nextAction: event.target.value,
                    }))
                  }
                  placeholder="exact next step"
                />
              </label>
            </div>

            <div className="form-row">
              <label>
                <span>Repo</span>
                <input
                  value={newProjectDraft.repoUrl}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({
                      ...current,
                      repoUrl: event.target.value,
                    }))
                  }
                  placeholder="repo url"
                />
              </label>
              <label>
                <span>Production</span>
                <input
                  value={newProjectDraft.productionUrl}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({
                      ...current,
                      productionUrl: event.target.value,
                    }))
                  }
                  placeholder="prod url"
                />
              </label>
            </div>

            <div className="form-row">
              <label>
                <span>Path</span>
                <input
                  value={newProjectDraft.localPath}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({
                      ...current,
                      localPath: event.target.value,
                    }))
                  }
                  placeholder="local path"
                />
              </label>
              <label>
                <span>Tags</span>
                <input
                  value={newProjectDraft.tags}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({ ...current, tags: event.target.value }))
                  }
                  placeholder="tags"
                />
              </label>
            </div>

            <label>
              <span>Notes</span>
              <textarea
                rows={2}
                value={newProjectDraft.notes}
                onChange={(event) =>
                  setNewProjectDraft((current) => ({ ...current, notes: event.target.value }))
                }
                placeholder="setup rules, blockers, context"
              />
            </label>

            <div className="subpanel">
              <div className="subpanel__header">
                <div>
                  <p className="eyebrow">Initial AI Log</p>
                  <h3>Optional</h3>
                </div>
              </div>

              <label>
                <span>Prompt</span>
                <textarea
                  rows={2}
                  value={newProjectDraft.prompt}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({ ...current, prompt: event.target.value }))
                  }
                  placeholder="last prompt"
                />
              </label>

              <label>
                <span>What it did</span>
                <textarea
                  rows={2}
                  value={newProjectDraft.result}
                  onChange={(event) =>
                    setNewProjectDraft((current) => ({ ...current, result: event.target.value }))
                  }
                  placeholder="result"
                />
              </label>

              <div className="form-row">
                <label>
                  <span>Next prompt</span>
                  <textarea
                    rows={2}
                    value={newProjectDraft.nextPrompt}
                    onChange={(event) =>
                      setNewProjectDraft((current) => ({
                        ...current,
                        nextPrompt: event.target.value,
                      }))
                    }
                    placeholder="next prompt"
                  />
                </label>
                <label>
                  <span>Link</span>
                  <input
                    value={newProjectDraft.link}
                    onChange={(event) =>
                      setNewProjectDraft((current) => ({ ...current, link: event.target.value }))
                    }
                    placeholder="chat link"
                  />
                </label>
              </div>
            </div>

            <div className="form-actions">
              <button type="submit" className="primary-button">
                Save project
              </button>
              <button type="button" className="ghost-button" onClick={resetNewProjectDraft}>
                Clear
              </button>
            </div>
          </form>
        </section>

        <section className="panel panel--system">
          <div className="panel__header">
            <div>
              <p className="eyebrow">Imports & Sync</p>
              <h2>Phone and desktop continuity.</h2>
            </div>
          </div>

          <div className="system-grid">
            <article className="system-card">
              <h3>GitHub sync</h3>
              <p>
                Store project state locally first, then sync it across phone and desktop
                through a private gist using a GitHub token with <code>gist</code> scope.
              </p>
              <label>
                <span>GitHub token</span>
                <input
                  type="password"
                  value={syncTokenInput}
                  onChange={(event) => setSyncTokenInput(event.target.value)}
                  placeholder="ghp_..."
                />
              </label>
              <label>
                <span>Gist id</span>
                <input
                  value={syncGistInput}
                  onChange={(event) => setSyncGistInput(event.target.value)}
                  placeholder="Leave blank and create one"
                />
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleCreateSyncGist}
                  disabled={syncBusy}
                >
                  Create sync gist
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void handleSyncNow(false)}
                  disabled={syncBusy}
                >
                  Sync now
                </button>
              </div>
              <p className="system-status">{syncMessage}</p>
            </article>

            <article className="system-card">
              <h3>ChatGPT import</h3>
              <p>
                Import a ChatGPT export zip or raw <code>conversations.json</code>. Each
                imported chat becomes a project-like research item with the latest prompt
                and latest result attached.
              </p>
              <label className="file-input">
                <span>{importBusy ? 'Importing...' : 'Choose ChatGPT export'}</span>
                <input
                  type="file"
                  accept=".zip,.json,application/json"
                  onChange={(event) => {
                    void handleImportChatGpt(event.target.files?.[0])
                    event.currentTarget.value = ''
                  }}
                />
              </label>
              <p className="system-status">{chatGptImportMessage}</p>
            </article>

            <article className="system-card">
              <h3>Codex project snapshot</h3>
              <p>
                Generate a local snapshot JSON from your Codex app folders, then import it
                here to seed project names, repo URLs, paths, latest commits, and Render
                deploys.
              </p>
              <div className="system-note">
                <strong>Generator:</strong> <code>npm run snapshot:projects -- "/Users/dumbfounder/Dropbox/codex apps"</code>
              </div>
              <label className="file-input">
                <span>{importBusy ? 'Importing...' : 'Choose project snapshot'}</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => {
                    void handleImportSnapshot(event.target.files?.[0])
                    event.currentTarget.value = ''
                  }}
                />
              </label>
              <p className="system-status">{snapshotImportMessage}</p>
            </article>

            <article className="system-card">
              <h3>Phone capture</h3>
              <p>
                Share ChatGPT links, notes, or URLs into the app from your phone. They land
                in Quick Add so you can turn loose AI work into a tracked project.
              </p>
              <div className="system-note">
                <strong>Latest deploy:</strong>{' '}
                {selectedProject?.productionUrl || latestSelectedDeploy?.url || 'Not set yet.'}
              </div>
            </article>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
