import type { WorkItem } from '../types'
import { excerpt, formatRelative, getLatestSession } from '../lib/utils'

type WorkItemCardProps = {
  item: WorkItem
  selected: boolean
  onSelect: (itemId: string) => void
}

export const WorkItemCard = ({ item, selected, onSelect }: WorkItemCardProps) => {
  const latestSession = getLatestSession(item)

  return (
    <button
      type="button"
      className={`work-card ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(item.id)}
    >
      <div className="work-card__meta">
        <span className={`pill pill--${item.status}`}>{item.status}</span>
        <span className={`pill pill--priority-${item.priority}`}>{item.priority}</span>
        <span className="tool-chip">{item.tool}</span>
      </div>

      <div className="work-card__body">
        <h3>{item.title}</h3>
        <p>{item.objective || 'No objective yet. Capture the goal so future-you can restart fast.'}</p>
      </div>

      {latestSession ? (
        <div className="work-card__session">
          <div>
            <span className="label">Last prompt</span>
            <p>{excerpt(latestSession.prompt || 'No prompt captured yet.', 120)}</p>
          </div>
          <div>
            <span className="label">What it did</span>
            <p>{excerpt(latestSession.result || 'No outcome note yet.', 120)}</p>
          </div>
        </div>
      ) : null}

      <div className="work-card__footer">
        <span>{item.tags.slice(0, 3).join(' · ') || 'untagged'}</span>
        <span>{formatRelative(item.lastTouchedAt)}</span>
      </div>
    </button>
  )
}
