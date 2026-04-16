#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const defaultRelayUrl = 'https://codexremote.onrender.com'
const defaultRenderServiceId = 'srv-d7ggs6t8nd3s73fveik0'
const defaultEnvFile = path.join(
  os.homedir(),
  'Library/Mobile Documents/com~apple~CloudDocs/code/CodexRemote/bridge/web/.env',
)

const normalizeUrl = (value) => value.trim().replace(/\/+$/, '')

const parseEnvFile = (filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return {}
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .reduce((env, line) => {
      const trimmed = line.trim()

      if (!trimmed || trimmed.startsWith('#')) {
        return env
      }

      const separator = trimmed.indexOf('=')

      if (separator === -1) {
        return env
      }

      const key = trimmed.slice(0, separator).trim()
      const rawValue = trimmed.slice(separator + 1).trim()
      const value = rawValue.replace(/^['"]|['"]$/g, '')

      if (key) {
        env[key] = value
      }

      return env
    }, {})
}

const envFile = process.env.CODEXREMOTE_ENV_FILE || defaultEnvFile
const fileEnv = parseEnvFile(envFile)
const relayUrl = normalizeUrl(
  process.env.MYBRAIN_PROD_BRIDGE_URL ||
    process.env.CODEXREMOTE_RELAY_URL ||
    fileEnv.CODEXREMOTE_RELAY_URL ||
    defaultRelayUrl,
)
const relayToken =
  process.env.CODEXREMOTE_RELAY_TOKEN ||
  process.env.CODEXREMOTE_WEB_TOKEN ||
  fileEnv.CODEXREMOTE_RELAY_TOKEN ||
  fileEnv.CODEXREMOTE_WEB_TOKEN ||
  ''
const renderServiceId = process.env.CODEXREMOTE_RENDER_SERVICE_ID || defaultRenderServiceId

const maskSecrets = (value) => (relayToken ? value.split(relayToken).join('[redacted]') : value)

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 20_000,
  })

  return {
    status: result.status,
    error: result.error,
    stdout: maskSecrets(result.stdout || ''),
    stderr: maskSecrets(result.stderr || ''),
  }
}

const fetchJson = async (endpoint) => {
  const response = await fetch(`${relayUrl}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${relayToken}`,
    },
  })
  const body = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(body.error || `${endpoint} failed with HTTP ${response.status}`)
  }

  return body
}

const summarizeLogs = () => {
  const probe = run('render', ['--version'], { timeout: 8000 })

  if (probe.error || probe.status !== 0) {
    return {
      warning: 'Render CLI is not available, so production logs were not included.',
      lines: [],
    }
  }

  const result = run(
    'render',
    ['logs', '-r', renderServiceId, '--limit', '80', '--output', 'text'],
    { timeout: 20_000 },
  )
  const output = `${result.stdout}\n${result.stderr}`.trim()

  if (result.error) {
    return {
      warning: `Render logs timed out or failed: ${result.error.message}`,
      lines: [],
    }
  }

  if (result.status !== 0) {
    return {
      warning: `Render logs failed with exit ${result.status}. ${output}`,
      lines: [],
    }
  }

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const relevant = lines.filter((line) =>
    /\/api\/(agent\/state|projects|health|command|events)|\b(status|error|deploy|started|listening)\b/i.test(
      line,
    ),
  )

  return {
    warning: '',
    lines: (relevant.length ? relevant : lines).slice(-25),
  }
}

const validateProjects = (projects) => {
  if (!Array.isArray(projects)) {
    return ['Project response did not include a projects array.']
  }

  if (projects.length === 0) {
    return ['Project response returned zero projects.']
  }

  const missingPath = projects.filter((project) => !project.path && !project.localPath)
  const missingName = projects.filter((project) => !project.name)
  const errors = []

  if (missingName.length) {
    errors.push(`${missingName.length} project entries are missing names.`)
  }

  if (missingPath.length) {
    errors.push(`${missingPath.length} project entries are missing path/localPath.`)
  }

  return errors
}

const main = async () => {
  const errors = []

  console.log('Production bridge check')
  console.log(`Relay URL: ${relayUrl}`)
  console.log(`Token source: ${relayToken ? 'configured' : 'missing'}`)

  if (!relayToken) {
    console.error('Missing CODEXREMOTE_RELAY_TOKEN. Set it or keep it in the CodexRemote env file.')
    process.exit(1)
  }

  let health = null
  let projectsResponse = null

  try {
    health = await fetchJson('/api/health')
    projectsResponse = await fetchJson('/api/projects')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Production relay request failed.')
  }

  if (health) {
    if (!health.ok) {
      errors.push('Health response did not report ok=true.')
    }

    if (health.mode !== 'relay') {
      errors.push(`Expected relay mode, got ${health.mode || 'unknown'}.`)
    }

    if (!health.agent?.online) {
      errors.push('Relay health says the Mac agent is offline.')
    }

    console.log(
      `Health: mode=${health.mode || 'unknown'} agent=${
        health.agent?.online ? 'online' : 'offline'
      } host=${health.agent?.hostname || 'unknown'}`,
    )
  }

  if (projectsResponse) {
    const projectErrors = validateProjects(projectsResponse.projects)
    errors.push(...projectErrors)

    const projects = Array.isArray(projectsResponse.projects) ? projectsResponse.projects : []
    const activeProject = projects.find((project) => project.active)
    const firstProject = projects[0]

    console.log(`Projects: count=${projects.length}`)
    console.log(
      `Active: ${activeProject?.name || 'none'} ${
        activeProject?.path || activeProject?.localPath || ''
      }`.trim(),
    )
    console.log(
      `First: ${firstProject?.name || 'none'} ${firstProject?.path || firstProject?.localPath || ''}`.trim(),
    )
  }

  const logs = summarizeLogs()

  if (logs.warning) {
    console.warn(`Logs: ${logs.warning}`)
  } else {
    console.log('Recent production log lines:')
    logs.lines.forEach((line) => console.log(line))
  }

  if (errors.length) {
    console.error('Validation failed:')
    errors.forEach((error) => console.error(`- ${error}`))
    process.exit(1)
  }

  console.log('Validation passed: production relay is returning projects with usable paths.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
