import type { DeployEntry } from '../types'
import { formatDateTime, hostFromUrl } from '../lib/utils'

type DeployListProps = {
  deploys: DeployEntry[]
}

export const DeployList = ({ deploys }: DeployListProps) => {
  if (deploys.length === 0) {
    return (
      <div className="empty-panel empty-panel--small">
        <p>No deploys tracked yet.</p>
      </div>
    )
  }

  return (
    <div className="activity-list">
      {deploys.map((deploy) => (
        <article key={deploy.id} className="entry-card">
          <header className="entry-card__header">
            <div>
              <span className={`pill pill--deploy-${deploy.status}`}>{deploy.status}</span>
              <span className="entry-badge">
                {deploy.provider} · {deploy.environment}
              </span>
            </div>
            <time dateTime={deploy.updatedAt}>{formatDateTime(deploy.updatedAt)}</time>
          </header>

          <div className="entry-card__block">
            <span className="label">URL</span>
            <p>{deploy.url || 'No deploy URL stored.'}</p>
          </div>

          <div className="entry-card__block">
            <span className="label">Commit</span>
            <p>{deploy.commit || 'No commit stored.'}</p>
          </div>

          {deploy.notes ? (
            <div className="entry-card__block">
              <span className="label">Notes</span>
              <p>{deploy.notes}</p>
            </div>
          ) : null}

          {deploy.url ? (
            <a className="entry-card__link" href={deploy.url} target="_blank" rel="noreferrer">
              Open {hostFromUrl(deploy.url) || 'deploy'}
            </a>
          ) : null}
        </article>
      ))}
    </div>
  )
}
