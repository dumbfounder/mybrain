import type { Project } from '../types'
import { excerpt, formatRelative, getLatestDeploy, getLatestSession, hostFromUrl } from '../lib/utils'

type ProjectCardProps = {
  project: Project
  selected: boolean
  onSelect: (projectId: string) => void
}

export const ProjectCard = ({ project, selected, onSelect }: ProjectCardProps) => {
  const latestSession = getLatestSession(project)
  const latestDeploy = getLatestDeploy(project)

  return (
    <button
      type="button"
      className={`project-card ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(project.id)}
    >
      <div className="project-card__meta">
        <span className={`pill pill--${project.status}`}>{project.status}</span>
        <span className={`pill pill--stage-${project.stage}`}>{project.stage}</span>
        <span className={`pill pill--priority-${project.priority}`}>{project.priority}</span>
        <span className="tool-chip">{project.tool}</span>
      </div>

      <div className="project-card__body">
        <h3>{project.name}</h3>
        <p>{project.summary || 'No project summary yet.'}</p>
      </div>

      <div className="project-card__signals">
        <div>
          <span className="label">Current focus</span>
          <p>{excerpt(project.currentFocus || latestSession?.result || 'No focus logged yet.', 120)}</p>
        </div>
        <div>
          <span className="label">Latest deploy</span>
          <p>
            {latestDeploy
              ? `${latestDeploy.status} ${hostFromUrl(latestDeploy.url) || latestDeploy.provider}`
              : 'No deploy tracked yet.'}
          </p>
        </div>
      </div>

      <div className="project-card__footer">
        <span>{project.tags.slice(0, 4).join(' · ') || 'untagged'}</span>
        <span>
          {project.features.length} features · {project.deploys.length} deploys ·{' '}
          {formatRelative(project.lastTouchedAt)}
        </span>
      </div>
    </button>
  )
}
