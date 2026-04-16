import type { Project, PromptWrapper } from '../types'

export const defaultPromptWrapper = (): PromptWrapper => ({
  before:
    'You are operating through my private mobile Codex console. Be direct, preserve momentum, and act inside the selected project.',
  after:
    'When you finish, summarize what changed, what you verified, and the exact next action.',
  includeProjectContext: true,
  requireStatusSummary: true,
  requireVerification: true,
  protectUserChanges: true,
})

const compact = (value: string) => value.trim()

const projectContext = (project: Project) =>
  [
    `Project: ${project.name}`,
    project.summary ? `Summary: ${project.summary}` : '',
    `Status: ${project.status}`,
    `Stage: ${project.stage}`,
    `Priority: ${project.priority}`,
    project.currentFocus ? `Current focus: ${project.currentFocus}` : '',
    project.nextAction ? `Next action: ${project.nextAction}` : '',
    project.repoUrl ? `Repo: ${project.repoUrl}` : '',
    project.productionUrl ? `Production: ${project.productionUrl}` : '',
    project.localPath ? `Local path: ${project.localPath}` : '',
    project.notes ? `Notes: ${project.notes}` : '',
    project.tags.length ? `Tags: ${project.tags.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

export const buildCodexPrompt = (
  userPrompt: string,
  project: Project,
  wrapper: PromptWrapper,
) => {
  const rules = [
    wrapper.protectUserChanges
      ? 'Do not overwrite or revert user changes unless explicitly asked.'
      : '',
    wrapper.requireVerification
      ? 'Run or recommend the most relevant verification for code changes.'
      : '',
    wrapper.requireStatusSummary
      ? 'Call out deploy/status impact and whether the project tracker should be updated.'
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return [
    compact(wrapper.before),
    wrapper.includeProjectContext ? projectContext(project) : '',
    rules ? `Standing rules:\n${rules}` : '',
    `User request:\n${compact(userPrompt)}`,
    compact(wrapper.after),
  ]
    .filter(Boolean)
    .join('\n\n')
}
