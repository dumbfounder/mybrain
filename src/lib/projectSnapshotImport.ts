import type {
  DeployStatus,
  LocalProjectSnapshot,
  Project,
  ProjectStage,
  ProjectStatus,
  SnapshotProject,
} from '../types'
import {
  buildStableId,
  excerpt,
  normalizeRepoUrl,
  nowIso,
  sortProjects,
} from './utils'

const inferStage = (project: SnapshotProject): ProjectStage => {
  if (project.services?.some((service) => service.url)) {
    return 'live'
  }

  if (project.lastCommitDate) {
    return 'building'
  }

  return 'idea'
}

const inferStatus = (project: SnapshotProject): ProjectStatus => {
  if (project.dirty) {
    return 'active'
  }

  if (project.services?.some((service) => service.lastDeployStatus === 'build_failed')) {
    return 'blocked'
  }

  return 'paused'
}

const mapDeployStatus = (status?: string): DeployStatus => {
  if (status === 'live') {
    return 'live'
  }

  if (status?.includes('failed')) {
    return 'failed'
  }

  if (status?.includes('build')) {
    return 'building'
  }

  return 'draft'
}

const toProject = (project: SnapshotProject): Project => {
  const repoUrl = normalizeRepoUrl(project.repoUrl ?? '')
  const stableSeed = repoUrl || project.localPath || project.name
  const timestamp = project.lastCommitDate ?? nowIso()
  const notes = [
    project.localPath ? `Local path: ${project.localPath}.` : '',
    project.branch ? `Branch: ${project.branch}.` : '',
    project.lastCommitMessage ? `Last commit: ${project.lastCommitMessage}.` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return {
    id: project.id ?? buildStableId('project', stableSeed),
    name: project.name,
    summary: excerpt(project.description ?? '', 180),
    status: inferStatus(project),
    stage: inferStage(project),
    priority: project.dirty ? 'now' : 'soon',
    tool: 'Codex',
    tags: Array.from(
      new Set([
        'codex-project',
        ...(project.tags ?? []),
        ...(project.dirty ? ['dirty'] : []),
      ]),
    ),
    notes,
    currentFocus: project.lastCommitMessage ?? '',
    nextAction: '',
    repoUrl,
    productionUrl: project.services?.find((service) => service.url)?.url ?? '',
    localPath: project.localPath ?? '',
    createdAt: timestamp,
    updatedAt: timestamp,
    lastTouchedAt: timestamp,
    features: [],
    deploys: (project.services ?? []).map((service) => {
      const updatedAt = service.lastDeployAt ?? timestamp

      return {
        id: buildStableId('deploy', `${stableSeed}-${service.id}`),
        provider: 'Render',
        environment: 'production',
        status: mapDeployStatus(service.lastDeployStatus),
        url: service.url ?? '',
        commit: service.lastDeployCommit ?? project.lastCommitHash ?? '',
        notes: `${service.name} (${service.type})`,
        createdAt: updatedAt,
        updatedAt,
      }
    }),
    sessions: [],
    source: 'local-scan',
  }
}

export const importProjectSnapshotFile = async (file: File) => {
  const parsed = JSON.parse(await file.text()) as LocalProjectSnapshot | SnapshotProject[]
  const projects = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.projects)
      ? parsed.projects
      : []

  if (projects.length === 0) {
    throw new Error('The snapshot file does not contain any projects.')
  }

  return {
    projects: sortProjects(projects.map(toProject)),
    count: projects.length,
  }
}
