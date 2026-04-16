import type { AiSessionEntry } from '../types'
import { formatDateTime } from '../lib/utils'

type AiSessionListProps = {
  sessions: AiSessionEntry[]
  onCopy: (value: string, label: string) => void
}

export const AiSessionList = ({ sessions, onCopy }: AiSessionListProps) => {
  if (sessions.length === 0) {
    return (
      <div className="empty-panel empty-panel--small">
        <p>No AI activity logged yet.</p>
      </div>
    )
  }

  return (
    <div className="activity-list">
      {sessions.map((session) => (
        <article key={session.id} className="entry-card">
          <header className="entry-card__header">
            <div>
              <span className="tool-chip">{session.tool}</span>
              <span className="entry-badge">{session.source}</span>
            </div>
            <time dateTime={session.updatedAt}>{formatDateTime(session.updatedAt)}</time>
          </header>

          <div className="entry-card__block">
            <div className="entry-card__label-row">
              <span className="label">Last prompt</span>
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

          <div className="entry-card__block">
            <span className="label">What it did</span>
            <p>{session.result || 'No output note stored.'}</p>
          </div>

          <div className="entry-card__block">
            <div className="entry-card__label-row">
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
            <p>{session.nextPrompt || 'No next prompt stored.'}</p>
          </div>

          {session.link ? (
            <a className="entry-card__link" href={session.link} target="_blank" rel="noreferrer">
              Open source link
            </a>
          ) : null}
        </article>
      ))}
    </div>
  )
}
