import process from 'node:process'

const baseUrl = (
  process.env.REMOTE_CONTROL_URL ||
  process.env.VITE_REMOTE_CONTROL_URL ||
  'http://127.0.0.1:3187'
).replace(/\/+$/, '')

const readJson = async (path, { allowNotFound = false } = {}) => {
  const response = await fetch(`${baseUrl}${path}`)

  if (allowNotFound && response.status === 404) {
    return { missing: true, value: null }
  }

  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`)
  }

  return { missing: false, value: await response.json() }
}

const arrayFrom = (value, keys) => {
  if (Array.isArray(value)) {
    return value
  }

  if (value && typeof value === 'object') {
    for (const key of keys) {
      if (Array.isArray(value[key])) {
        return value[key]
      }
    }
  }

  return []
}

const main = async () => {
  console.log(`RemoteControl check: ${baseUrl}`)

  const health = (await readJson('/api/health')).value

  if (!health?.ok) {
    throw new Error('RemoteControl health did not return ok=true.')
  }

  console.log(
    `Health: ok pid=${health.process?.pid ?? 'unknown'} queued=${health.queue?.queued ?? 0} running=${
      health.queue?.running ?? 0
    }`,
  )

  const projectsPayload = (await readJson('/api/projects')).value
  const projects = arrayFrom(projectsPayload, ['projects', 'items'])

  if (!projects.length) {
    throw new Error('RemoteControl returned no projects.')
  }

  console.log(`Projects: ${projects.length}`)
  console.log(`First project: ${projects[0].name ?? 'unnamed'} ${projects[0].path ?? ''}`.trim())

  const historyResult = await readJson('/api/history', { allowNotFound: true })

  if (historyResult.missing) {
    console.log('History: not enabled yet (404 accepted).')
    return
  }

  const history = arrayFrom(historyResult.value, ['history', 'items', 'requests'])
  console.log(`History: ${history.length} requests`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
