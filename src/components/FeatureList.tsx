import type { FeatureEntry } from '../types'
import { formatDateTime } from '../lib/utils'

type FeatureListProps = {
  features: FeatureEntry[]
}

export const FeatureList = ({ features }: FeatureListProps) => {
  if (features.length === 0) {
    return (
      <div className="empty-panel empty-panel--small">
        <p>No feature log yet.</p>
      </div>
    )
  }

  return (
    <div className="activity-list">
      {features.map((feature) => (
        <article key={feature.id} className="entry-card">
          <header className="entry-card__header">
            <div>
              <span className={`pill pill--feature-${feature.status}`}>{feature.status}</span>
            </div>
            <time dateTime={feature.updatedAt}>
              {formatDateTime(feature.shippedAt ?? feature.updatedAt)}
            </time>
          </header>

          <div className="entry-card__block">
            <span className="label">Feature</span>
            <p className="entry-card__title">{feature.title}</p>
          </div>

          {feature.summary ? (
            <div className="entry-card__block">
              <span className="label">Summary</span>
              <p>{feature.summary}</p>
            </div>
          ) : null}

          {feature.notes ? (
            <div className="entry-card__block">
              <span className="label">Notes</span>
              <p>{feature.notes}</p>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  )
}
