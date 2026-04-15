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
import { SessionList } from './components/SessionList'
import { WorkItemCard } from './components/WorkItemCard'
import { importChatGptFile } from './lib/chatgptImport'
import {
  createSecretSyncGist,
  mergeItemCollections,
  syncWithRemote,
} from './lib/gistSync'
import { loadState, saveState } from './lib/storage'
import {
  countStaleItems,
  excerpt,
  formatDateTime,
  formatRelative,
  generateId,
  getLatestSession,
  hasText,
  normalizeTags,
  nowIso,
  PRIORITY_OPTIONS,
  sortItems,
  sortSessions,
  STATUS_OPTIONS,
  TOOL_OPTIONS,
} from './lib/utils'
import type { Priority, SessionEntry, SyncConfig, ToolName, WorkItem, WorkStatus } from './types'

type CaptureDraft = {
  title: string
  objective: string
  status: WorkStatus
  priority: Priority
  tool: ToolName
  prompt: string
  result: string
  nextPrompt: string
  notes: string
  tags: string
  link: string
}

const emptyCaptureDraft = (): CaptureDraft => ({
  title: '',
  objective: '',
  status: 'active',
  priority: 'now',
  tool: 'ChatGPT',
  prompt: '',
  result: '',
  nextPrompt: '',
  notes: '',
  tags: '',
  link: '',
})

const cloneItem = (item: WorkItem) => ({
  ...item,
  tags: [...item.tags],
  sessions: [...item.sessions],
})

const buildSession = (draft: CaptureDraft, source: SessionEntry['source']): SessionEntry => {
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
  }
}

const deriveTitle = (draft: CaptureDraft) =>
  draft.title.trim() ||
  excerpt(draft.prompt, 56) ||
  excerpt(draft.objective, 56) ||
  `AI thread ${new Date().toLocaleDateString()}`

const copyText = async (value: string) => {
  await navigator.clipboard.writeText(value)
}

function App() {
  const initialState = loadState()
  const [items, setItems] = useState<WorkItem[]>(sortItems(initialState.items))
  const [sync, setSync] = useState<SyncConfig | undefined>(initialState.sync)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [statusFilter, setStatusFilter] = useState<WorkStatus | 'all'>('all')
  const [captureMode, setCaptureMode] = useState<'new' | 'existing'>('new')
  const [captureTargetId, setCaptureTargetId] = useState(initialState.items[0]?.id ?? '')
  const [captureDraft, setCaptureDraft] = useState(emptyCaptureDraft)
  const [selectedId, setSelectedId] = useState(initialState.items[0]?.id ?? '')
  const [focusDraft, setFocusDraft] = useState<WorkItem | null>(
    initialState.items[0] ? cloneItem(sortItems(initialState.items)[0]) : null,
  )
  const [focusTags, setFocusTags] = useState(
    initialState.items[0]?.tags.join(', ') ?? '',
  )
  const [syncTokenInput, setSyncTokenInput] = useState(initialState.sync?.token ?? '')
  const [syncGistInput, setSyncGistInput] = useState(initialState.sync?.gistId ?? '')
  const [syncMessage, setSyncMessage] = useState(
    initialState.sync?.lastSyncStatus ?? 'Local-first mode. Add GitHub sync when you are ready.',
  )
  const [syncBusy, setSyncBusy] = useState(false)
  const [importMessage, setImportMessage] = useState(
    'Import a ChatGPT export zip or conversations.json when you want to seed the tracker.',
  )
  const [importBusy, setImportBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [shareBanner, setShareBanner] = useState('')
  const lastSyncedSignature = useRef(JSON.stringify(sortItems(initialState.items)))

  const filteredItems = sortItems(
    items.filter((item) => {
      const haystack = [
        item.title,
        item.objective,
        item.notes,
        item.tags.join(' '),
        getLatestSession(item)?.prompt ?? '',
        getLatestSession(item)?.result ?? '',
      ]
        .join(' ')
        .toLowerCase()

      const matchesStatus = statusFilter === 'all' || item.status === statusFilter
      const matchesSearch =
        deferredSearch.trim().length === 0 ||
        haystack.includes(deferredSearch.trim().toLowerCase())

      return matchesStatus && matchesSearch
    }),
  )

  const selectedItem =
    items.find((item) => item.id === selectedId) ?? filteredItems[0] ?? null
  const latestSelectedSession = selectedItem ? getLatestSession(selectedItem) : null
  const itemSignature = JSON.stringify(sortItems(items))

  useEffect(() => {
    saveState({ items, sync })
  }, [items, sync])

  useEffect(() => {
    const nextSelected =
      items.find((item) => item.id === selectedId) ?? filteredItems[0] ?? null

    if (!nextSelected) {
      setFocusDraft(null)
      setFocusTags('')
      return
    }

    if (nextSelected.id !== selectedId) {
      setSelectedId(nextSelected.id)
    }

    setFocusDraft(cloneItem(nextSelected))
    setFocusTags(nextSelected.tags.join(', '))
  }, [filteredItems, items, selectedId])

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
    const host = url ? new URL(url).hostname.replace(/^www\./, '') : ''

    setCaptureMode('new')
    setCaptureDraft((current) => ({
      ...current,
      title: current.title || title || host,
      tool: current.tool === 'Other' ? 'ChatGPT' : current.tool,
      prompt: current.prompt || text,
      link: current.link || url,
      notes: current.notes || (url ? `Shared into MyBrain from ${host}.` : current.notes),
    }))
    setShareBanner('Shared content is ready in Quick Capture. Save it before you forget why it mattered.')

    window.history.replaceState({}, document.title, window.location.pathname)
  }, [])

  const runBackgroundSync = useEffectEvent(() => {
    void handleSyncNow(true)
  })

  useEffect(() => {
    if (!sync?.token || !sync.gistId || syncBusy) {
      return undefined
    }

    if (itemSignature === lastSyncedSignature.current) {
      return undefined
    }

    const timeout = window.setTimeout(() => {
      runBackgroundSync()
    }, 1800)

    return () => window.clearTimeout(timeout)
  }, [itemSignature, sync?.gistId, sync?.token, syncBusy])

  const setToastMessage = (message: string) => {
    setToast(message)
  }

  const resetCaptureDraft = () => {
    setCaptureDraft((current) => ({
      ...emptyCaptureDraft(),
      tool: current.tool,
      status: current.status,
      priority: current.priority,
    }))
    setShareBanner('')
  }

  const handleCaptureSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const source = shareBanner ? 'share-target' : 'manual'
    const sessionHasData =
      hasText(captureDraft.prompt) ||
      hasText(captureDraft.result) ||
      hasText(captureDraft.nextPrompt) ||
      hasText(captureDraft.link)
    const session = sessionHasData ? buildSession(captureDraft, source) : null

    if (captureMode === 'existing' && captureTargetId) {
      setItems((currentItems) =>
        sortItems(
          currentItems.map((item) => {
            if (item.id !== captureTargetId) {
              return item
            }

            const updatedAt = nowIso()
            const mergedNotes = [item.notes, captureDraft.notes.trim()].filter(Boolean).join('\n\n')

            return {
              ...item,
              status: captureDraft.status,
              priority: captureDraft.priority,
              tool: captureDraft.tool,
              objective: captureDraft.objective.trim() || item.objective,
              notes: mergedNotes,
              tags: Array.from(new Set([...item.tags, ...normalizeTags(captureDraft.tags)])),
              updatedAt,
              lastTouchedAt: updatedAt,
              sessions: session ? sortSessions([session, ...item.sessions]) : item.sessions,
            }
          }),
        ),
      )
      setSelectedId(captureTargetId)
      resetCaptureDraft()
      setToastMessage('Saved a new update to that thread.')
      return
    }

    const timestamp = nowIso()
    const nextItem: WorkItem = {
      id: generateId(),
      title: deriveTitle(captureDraft),
      objective: captureDraft.objective.trim(),
      status: captureDraft.status,
      priority: captureDraft.priority,
      tool: captureDraft.tool,
      tags: normalizeTags(captureDraft.tags),
      notes: captureDraft.notes.trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastTouchedAt: timestamp,
      sessions: session ? [session] : [],
      source,
    }

    setItems((currentItems) => sortItems([nextItem, ...currentItems]))
    setSelectedId(nextItem.id)
    setCaptureMode('existing')
    setCaptureTargetId(nextItem.id)
    resetCaptureDraft()
    setToastMessage('Saved a new AI thread.')
  }

  const handleFocusSave = () => {
    if (!focusDraft) {
      return
    }

    const updatedItem: WorkItem = {
      ...focusDraft,
      tags: normalizeTags(focusTags),
      updatedAt: nowIso(),
      lastTouchedAt: focusDraft.lastTouchedAt || nowIso(),
    }

    setItems((currentItems) =>
      sortItems(
        currentItems.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
      ),
    )
    setToastMessage('Updated thread details.')
  }

  const handleCreateSyncGist = async () => {
    if (!syncTokenInput.trim()) {
      setSyncMessage('Paste a GitHub token with gist scope first.')
      return
    }

    try {
      setSyncBusy(true)
      setSyncMessage('Creating a private sync gist on GitHub...')
      const created = await createSecretSyncGist(syncTokenInput.trim(), items)
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
      lastSyncedSignature.current = itemSignature
      setToastMessage('GitHub sync is live.')
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Could not create the sync gist.')
    } finally {
      setSyncBusy(false)
    }
  }

  const handleSyncNow = async (quiet = false) => {
    const token = (sync?.token ?? syncTokenInput).trim()
    const gistId = (sync?.gistId ?? syncGistInput).trim()

    if (!token || !gistId) {
      setSyncMessage('Add both a GitHub gist token and gist id before syncing.')
      return
    }

    try {
      setSyncBusy(true)
      setSyncMessage('Merging local changes with GitHub...')
      const merged = await syncWithRemote(token, gistId, items)
      startTransition(() => {
        setItems(merged.items)
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
      lastSyncedSignature.current = JSON.stringify(sortItems(merged.items))

      if (!quiet) {
        setToastMessage('Synced with GitHub.')
      }
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Sync failed.')
    } finally {
      setSyncBusy(false)
    }
  }

  const handleImportFile = async (file: File | undefined) => {
    if (!file) {
      return
    }

    try {
      setImportBusy(true)
      setImportMessage('Parsing your ChatGPT export...')
      const imported = await importChatGptFile(file)

      startTransition(() => {
        setItems((currentItems) => mergeItemCollections(imported.items, currentItems))
      })

      if (imported.items[0]) {
        setSelectedId(imported.items[0].id)
      }

      setImportMessage(`Imported ${imported.count} ChatGPT threads.`)
      setToastMessage(`Imported ${imported.count} chats.`)
    } catch (error) {
      setImportMessage(
        error instanceof Error ? error.message : 'The ChatGPT file could not be imported.',
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
      await copyText(value)
      setToastMessage(`Copied ${label}.`)
    } catch {
      setToastMessage(`Could not copy ${label}.`)
    }
  }

  return (
    <div className="app-shell">
      <header className="hero-panel">
        <div className="hero-panel__intro">
          <p className="eyebrow">MyBrain</p>
          <h1>Your AI life, with enough context to pick it back up on your phone.</h1>
          <p className="hero-copy">
            Track each thread, the last prompt you sent, what it produced, and the
            exact next move. Install it on your phone, share chats into it, and keep
            your active AI work from dissolving into tabs.
          </p>
        </div>

        <div className="hero-panel__stats">
          <article className="stat-card">
            <span className="label">Active</span>
            <strong>{items.filter((item) => item.status === 'active').length}</strong>
            <p>Threads you should move today.</p>
          </article>
          <article className="stat-card">
            <span className="label">Waiting</span>
            <strong>{items.filter((item) => item.status === 'waiting').length}</strong>
            <p>Blocked on other people, tools, or time.</p>
          </article>
          <article className="stat-card">
            <span className="label">Stale</span>
            <strong>{countStaleItems(items)}</strong>
            <p>Untouched for a week and likely fading.</p>
          </article>
          <article className="stat-card stat-card--accent">
            <span className="label">Phone-ready</span>
            <strong>{sync?.gistId ? 'Synced' : 'Local'}</strong>
            <p>{sync?.gistId ? 'GitHub sync is attached.' : 'Turn on sync below.'}</p>
          </article>
        </div>
      </header>

      {toast ? <div className="toast">{toast}</div> : null}

      {shareBanner ? (
        <section className="banner">
          <p>{shareBanner}</p>
        </section>
      ) : null}

      <main className="workspace-grid">
        <section className="panel panel--capture">
          <div className="panel__header">
            <div>
              <p className="eyebrow">Quick Capture</p>
              <h2>Freeze the thread before it disappears.</h2>
            </div>
            <div className="capture-toggle">
              <button
                type="button"
                className={captureMode === 'new' ? 'active' : ''}
                onClick={() => setCaptureMode('new')}
              >
                New thread
              </button>
              <button
                type="button"
                className={captureMode === 'existing' ? 'active' : ''}
                onClick={() => setCaptureMode('existing')}
              >
                Update existing
              </button>
            </div>
          </div>

          <form className="capture-form" onSubmit={handleCaptureSubmit}>
            {captureMode === 'existing' ? (
              <label>
                <span>Thread</span>
                <select
                  value={captureTargetId}
                  onChange={(event) => setCaptureTargetId(event.target.value)}
                >
                  <option value="">Choose a thread</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                <span>Thread title</span>
                <input
                  value={captureDraft.title}
                  onChange={(event) =>
                    setCaptureDraft((current) => ({ ...current, title: event.target.value }))
                  }
                  placeholder="Ship a Codex workflow for invoicing"
                />
              </label>
            )}

            <div className="form-row">
              <label>
                <span>Tool</span>
                <select
                  value={captureDraft.tool}
                  onChange={(event) =>
                    setCaptureDraft((current) => ({
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
                <span>Status</span>
                <select
                  value={captureDraft.status}
                  onChange={(event) =>
                    setCaptureDraft((current) => ({
                      ...current,
                      status: event.target.value as WorkStatus,
                    }))
                  }
                >
                  {STATUS_OPTIONS.map((status) => (
                    <option key={status.value} value={status.value}>
                      {status.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Priority</span>
                <select
                  value={captureDraft.priority}
                  onChange={(event) =>
                    setCaptureDraft((current) => ({
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
            </div>

            <label>
              <span>Objective</span>
              <textarea
                rows={3}
                value={captureDraft.objective}
                onChange={(event) =>
                  setCaptureDraft((current) => ({
                    ...current,
                    objective: event.target.value,
                  }))
                }
                placeholder="What are you actually trying to get done?"
              />
            </label>

            <label>
              <span>Last prompt</span>
              <textarea
                rows={4}
                value={captureDraft.prompt}
                onChange={(event) =>
                  setCaptureDraft((current) => ({ ...current, prompt: event.target.value }))
                }
                placeholder="Paste the last thing you asked the model."
              />
            </label>

            <label>
              <span>What that prompt did</span>
              <textarea
                rows={4}
                value={captureDraft.result}
                onChange={(event) =>
                  setCaptureDraft((current) => ({ ...current, result: event.target.value }))
                }
                placeholder="Summarize what happened, what it produced, or why it failed."
              />
            </label>

            <label>
              <span>Next prompt</span>
              <textarea
                rows={3}
                value={captureDraft.nextPrompt}
                onChange={(event) =>
                  setCaptureDraft((current) => ({
                    ...current,
                    nextPrompt: event.target.value,
                  }))
                }
                placeholder="Store the next exact prompt so restart friction stays low."
              />
            </label>

            <div className="form-row">
              <label>
                <span>Tags</span>
                <input
                  value={captureDraft.tags}
                  onChange={(event) =>
                    setCaptureDraft((current) => ({ ...current, tags: event.target.value }))
                  }
                  placeholder="client, launch, video"
                />
              </label>

              <label>
                <span>Link</span>
                <input
                  type="url"
                  value={captureDraft.link}
                  onChange={(event) =>
                    setCaptureDraft((current) => ({ ...current, link: event.target.value }))
                  }
                  placeholder="https://chatgpt.com/..."
                />
              </label>
            </div>

            <label>
              <span>Notes</span>
              <textarea
                rows={3}
                value={captureDraft.notes}
                onChange={(event) =>
                  setCaptureDraft((current) => ({ ...current, notes: event.target.value }))
                }
                placeholder="Human reminders, blockers, or the weird thing to remember later."
              />
            </label>

            <div className="form-actions">
              <button type="submit" className="primary-button">
                {captureMode === 'new' ? 'Save thread' : 'Save update'}
              </button>
              <button type="button" className="ghost-button" onClick={resetCaptureDraft}>
                Clear
              </button>
            </div>
          </form>
        </section>

        <section className="panel">
          <div className="panel__header">
            <div>
              <p className="eyebrow">Thread Board</p>
              <h2>Everything you have in motion.</h2>
            </div>
            <div className="board-controls">
              <input
                className="search-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search prompts, results, tags, notes..."
              />
              <select
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as WorkStatus | 'all')
                }
              >
                <option value="all">All statuses</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {filteredItems.length === 0 ? (
            <div className="empty-panel">
              <p>No threads match this view yet.</p>
              <span>Start by saving a thread or importing your ChatGPT export below.</span>
            </div>
          ) : (
            <div className="work-grid">
              {filteredItems.map((item) => (
                <WorkItemCard
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          )}
        </section>

        <section className="panel panel--focus">
          <div className="panel__header">
            <div>
              <p className="eyebrow">Focus Sheet</p>
              <h2>{selectedItem?.title ?? 'Pick a thread'}</h2>
            </div>
            {selectedItem ? (
              <div className="focus-meta">
                <span>{selectedItem.tool}</span>
                <span>{formatRelative(selectedItem.lastTouchedAt)}</span>
              </div>
            ) : null}
          </div>

          {focusDraft ? (
            <div className="focus-layout">
              <div className="focus-form">
                <label>
                  <span>Title</span>
                  <input
                    value={focusDraft.title}
                    onChange={(event) =>
                      setFocusDraft((current) =>
                        current ? { ...current, title: event.target.value } : current,
                      )
                    }
                  />
                </label>
                <label>
                  <span>Objective</span>
                  <textarea
                    rows={4}
                    value={focusDraft.objective}
                    onChange={(event) =>
                      setFocusDraft((current) =>
                        current ? { ...current, objective: event.target.value } : current,
                      )
                    }
                  />
                </label>
                <div className="form-row">
                  <label>
                    <span>Status</span>
                    <select
                      value={focusDraft.status}
                      onChange={(event) =>
                        setFocusDraft((current) =>
                          current
                            ? {
                                ...current,
                                status: event.target.value as WorkStatus,
                              }
                            : current,
                        )
                      }
                    >
                      {STATUS_OPTIONS.map((status) => (
                        <option key={status.value} value={status.value}>
                          {status.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Priority</span>
                    <select
                      value={focusDraft.priority}
                      onChange={(event) =>
                        setFocusDraft((current) =>
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
                </div>
                <label>
                  <span>Tags</span>
                  <input
                    value={focusTags}
                    onChange={(event) => setFocusTags(event.target.value)}
                    placeholder="comma, separated, tags"
                  />
                </label>
                <label>
                  <span>Notes</span>
                  <textarea
                    rows={5}
                    value={focusDraft.notes}
                    onChange={(event) =>
                      setFocusDraft((current) =>
                        current ? { ...current, notes: event.target.value } : current,
                      )
                    }
                  />
                </label>

                <div className="focus-actions">
                  <button type="button" className="primary-button" onClick={handleFocusSave}>
                    Save details
                  </button>
                  {latestSelectedSession?.nextPrompt ? (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        handleCopy(latestSelectedSession.nextPrompt, 'next prompt')
                      }
                    >
                      Copy next prompt
                    </button>
                  ) : null}
                </div>

                <div className="focus-timestamps">
                  <span>Created {formatDateTime(focusDraft.createdAt)}</span>
                  <span>Updated {formatDateTime(focusDraft.updatedAt)}</span>
                </div>
              </div>

              <div className="focus-timeline">
                <SessionList sessions={focusDraft.sessions} onCopy={handleCopy} />
              </div>
            </div>
          ) : (
            <div className="empty-panel">
              <p>Pick a thread from the board to see its full context.</p>
            </div>
          )}
        </section>

        <section className="panel panel--system">
          <div className="panel__header">
            <div>
              <p className="eyebrow">Sync & Import</p>
              <h2>Make it survive across devices.</h2>
            </div>
          </div>

          <div className="system-grid">
            <article className="system-card">
              <h3>GitHub sync</h3>
              <p>
                This app stores data locally first. Add a GitHub token with
                <code>gist</code> scope and it will sync through a private gist so your
                phone and desktop stay aligned.
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
                Import a ChatGPT export zip or a raw <code>conversations.json</code>{' '}
                file. MyBrain keeps the latest prompt and latest result for each chat so
                the tracker stays lightweight enough to sync cleanly.
              </p>
              <label className="file-input">
                <span>{importBusy ? 'Importing...' : 'Choose ChatGPT export'}</span>
                <input
                  type="file"
                  accept=".zip,.json,application/json"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    void handleImportFile(file)
                    event.currentTarget.value = ''
                  }}
                />
              </label>
              <p className="system-status">{importMessage}</p>
              <div className="system-note">
                <strong>Phone move:</strong> install the app, then use your phone share
                sheet from ChatGPT or Safari to drop links or text straight into Quick
                Capture.
              </div>
            </article>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
