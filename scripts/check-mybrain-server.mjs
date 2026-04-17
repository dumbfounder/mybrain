import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const port = Number(process.env.MYBRAIN_TEST_PORT || 3099)
const baseUrl = `http://127.0.0.1:${port}`
const token = 'check-token'
const historyDir = path.join(repoRoot, '.tmp', 'mybrain-server-check-history')

const readJson = async (url, options = {}) => {
  const response = await fetch(url, options)
  const text = await response.text()
  const json = text ? JSON.parse(text) : {}

  return { response, json }
}

const waitForServer = async () => {
  const deadline = Date.now() + 8000

  while (Date.now() < deadline) {
    try {
      const { response } = await readJson(`${baseUrl}/api/remote-control/health`)

      if (response.ok) {
        return
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  throw new Error('MyBrain server did not start.')
}

const main = async () => {
  fs.rmSync(historyDir, { force: true, recursive: true })
  const child = spawn(process.execPath, ['server/mybrain-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MYBRAIN_PORT: String(port),
      MYBRAIN_HOST: '127.0.0.1',
      MYBRAIN_REMOTE_CONTROL_TOKEN: token,
      MYBRAIN_HISTORY_DIR: historyDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })

  try {
    await waitForServer()

    const health = await readJson(`${baseUrl}/api/remote-control/health`)

    if (!health.json.ok || health.json.service !== 'mybrain-remote-control-ingest') {
      throw new Error('Health endpoint returned unexpected payload.')
    }

    const unauthenticated = await fetch(`${baseUrl}/api/remote-control/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'test',
        projectName: 'mybrain',
        status: 'ok',
        createdAt: '2026-04-17T00:00:00.000Z',
      }),
    })

    if (unauthenticated.status !== 401) {
      throw new Error(`Unauthenticated ingest returned ${unauthenticated.status}, expected 401.`)
    }

    const snapshot = await readJson(`${baseUrl}/api/remote-control/snapshots`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requestId: 'test',
        projectName: 'mybrain',
        workstreamAlias: 'remote-history',
        status: 'ok',
        createdAt: '2026-04-17T00:00:00.000Z',
        finishedAt: '2026-04-17T00:01:00.000Z',
        promptText: 'Test remote sync',
        summary: 'Stored a test RemoteControl snapshot.',
        codexUiHandoff: '# Handoff\nContinue this test request.',
      }),
    })

    if (!snapshot.response.ok || snapshot.json.requestId !== 'test' || !snapshot.json.stored) {
      throw new Error('Authenticated snapshot ingest failed.')
    }

    const history = await readJson(`${baseUrl}/api/remote-control/history`)

    if (!history.json.history?.some((item) => item.requestId === 'test')) {
      throw new Error('Stored snapshot was not returned from history list.')
    }

    const detail = await readJson(`${baseUrl}/api/remote-control/history/test`)

    if (detail.json.detail?.codexUiHandoff !== '# Handoff\nContinue this test request.') {
      throw new Error('Stored detail did not include Codex UI handoff.')
    }

    const handoff = await fetch(`${baseUrl}/api/remote-control/history/test/codex-context`)
    const handoffText = await handoff.text()

    if (!handoff.ok || !handoffText.includes('Continue this test request.')) {
      throw new Error('Codex context endpoint did not return handoff markdown.')
    }

    const app = await fetch(baseUrl)
    const appHtml = await app.text()

    if (!app.ok || !appHtml.includes('<div id="root"></div>')) {
      throw new Error('SPA HTML was not served.')
    }

    console.log('MyBrain server check passed.')
  } finally {
    child.kill('SIGTERM')

    if (output.trim()) {
      console.log(output.trim())
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
