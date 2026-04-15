import type { SessionEntry } from '../types'
import { formatDateTime } from '../lib/utils'

type SessionListProps = {
  sessions: SessionEntry[]
  onCopy: (value: string, label: string) => void
}

export const SessionList = ({ sessions, onCopy }: SessionListProps) => {
  if (sessions.length === 0) {
    return (
      <div className="empty-panel">
        <p>No sessions captured yet.</p>
      </div>
    )
  }

  return (
    <div className="session-list">
      {sessions.map((session) => (
        <article key={session.id} className="session-card">
          <header className="session-card__header">
            <div>
              <span className="tool-chip">{session.tool}</span>
              <span className="session-source">{session.source}</span>
            </div>
            <time dateTime={session.updatedAt}>{formatDateTime(session.updatedAt)}</time>
          </header>

          <div className="session-card__block">
            <div className="session-card__label-row">
              <span className="label">Prompt</span>
              {session.prompt ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => onCopy(session.prompt, 'prompt')}
                >
                  Copy
                </button>
              ) : null}
            </div>
            <p>{session.prompt || 'No prompt stored.'}</p>
          </div>

          <div className="session-card__block">
            <span className="label">What it did</span>
            <p>{session.result || 'No outcome stored.'}</p>
          </div>

          <div className="session-card__block">
            <div className="session-card__label-row">
              <span className="label">Next prompt</span>
              {session.nextPrompt ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => onCopy(session.nextPrompt, 'next prompt')}
                >
                  Copy
                </button>
              ) : null}
            </div>
            <p>{session.nextPrompt || 'No next prompt captured.'}</p>
          </div>

          {session.link ? (
            <a
              className="session-card__link"
              href={session.link}
              target="_blank"
              rel="noreferrer"
            >
              Open source link
            </a>
          ) : null}
        </article>
      ))}
    </div>
  )
}
