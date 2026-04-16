import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const basePath = path.resolve(process.argv[2] || path.join(process.cwd(), '..'))

const exists = (target) => fs.existsSync(target)

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    return ''
  }

  return result.stdout.trim()
}

const normalizeRepoUrl = (value) => {
  if (!value) {
    return ''
  }

  if (value.startsWith('git@github.com:')) {
    return `https://github.com/${value.replace('git@github.com:', '').replace(/\.git$/, '')}`
  }

  return value.replace(/\.git$/, '')
}

const listProjectDirectories = (rootPath) =>
  fs
    .readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootPath, entry.name))
    .filter((directory) => {
      const markers = [
        '.git',
        'package.json',
        'render.yaml',
        'src',
        'App',
        'Sources',
      ]

      return markers.some((marker) => exists(path.join(directory, marker)))
    })

const readPackageInfo = (directory) => {
  const packagePath = path.join(directory, 'package.json')

  if (!exists(packagePath)) {
    return {}
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    return {
      name: pkg.name || '',
      description: pkg.description || '',
    }
  } catch {
    return {}
  }
}

const loadRenderServices = () => {
  const raw = run('render', ['services', '--output', 'json'])

  if (!raw) {
    return []
  }

  try {
    return JSON.parse(raw)
      .map((entry) => entry.service)
      .filter(Boolean)
      .map((service) => ({
        id: service.id,
        name: service.name,
        repoUrl: normalizeRepoUrl(service.repo),
        type: service.type,
        url: service.serviceDetails?.url || '',
      }))
  } catch {
    return []
  }
}

const loadLatestDeployForService = (serviceId) => {
  const raw = run('render', ['deploys', 'list', serviceId, '--output', 'json'])

  if (!raw) {
    return {}
  }

  try {
    const deploys = JSON.parse(raw)
    const latest = Array.isArray(deploys) ? deploys[0] : null

    if (!latest) {
      return {}
    }

    return {
      lastDeployStatus: latest.status || '',
      lastDeployAt: latest.finishedAt || latest.updatedAt || latest.startedAt || '',
      lastDeployCommit: latest.commit?.id || '',
    }
  } catch {
    return {}
  }
}

const renderServices = loadRenderServices()
const renderByRepo = new Map()

for (const service of renderServices) {
  if (!service.repoUrl) {
    continue
  }

  const current = renderByRepo.get(service.repoUrl) || []
  current.push({
    id: service.id,
    name: service.name,
    type: service.type,
    url: service.url,
    ...loadLatestDeployForService(service.id),
  })
  renderByRepo.set(service.repoUrl, current)
}

const projects = listProjectDirectories(basePath).map((directory) => {
  const packageInfo = readPackageInfo(directory)
  const repoUrl = normalizeRepoUrl(run('git', ['-C', directory, 'remote', 'get-url', 'origin']))
  const branch = run('git', ['-C', directory, 'branch', '--show-current'])
  const dirty = run('git', ['-C', directory, 'status', '--porcelain']).length > 0
  const lastCommitHash = run('git', ['-C', directory, 'log', '-1', '--format=%H'])
  const lastCommitMessage = run('git', ['-C', directory, 'log', '-1', '--format=%s'])
  const lastCommitDate = run('git', ['-C', directory, 'log', '-1', '--format=%cI'])
  const services = repoUrl ? renderByRepo.get(repoUrl) || [] : []
  const name = path.basename(directory)

  return {
    name,
    description: packageInfo.description || packageInfo.name || '',
    repoUrl,
    localPath: directory,
    branch,
    dirty,
    lastCommitHash,
    lastCommitMessage,
    lastCommitDate,
    tags: [
      repoUrl ? 'git' : '',
      packageInfo.name ? 'package' : '',
      services.length > 0 ? 'render' : '',
    ].filter(Boolean),
    services,
  }
})

const snapshot = {
  version: 1,
  exportedAt: new Date().toISOString(),
  basePath,
  projects,
}

process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
