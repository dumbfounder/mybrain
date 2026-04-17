# MyBrain

MyBrain is a private mobile console for Codex projects. The phone UI is built around:

- a product dropdown at the top
- a chat composer for the selected local project
- a customizable prompt wrapper that changes what gets sent to Codex every time
- project state, deploy context, feature memory, and prior AI notes
- a local bridge that lets the browser talk to your computer in real time

## Local Bridge

The deployed static site cannot directly control your Mac. For real Codex runs, start the bridge on the computer that has your projects and Codex login:

```bash
npm run build
MYBRAIN_BRIDGE_TOKEN="pick-a-private-token" npm run bridge -- "/Users/dumbfounder/Dropbox/codex apps"
```

Then open the app from your phone using one of these paths:

- same Wi-Fi: `http://YOUR_MAC_IP:8787`
- remote/mobile data: expose port `8787` with a private tunnel such as Tailscale Serve, Cloudflare Tunnel, or ngrok
- Render-hosted UI: paste your tunnel URL and token into the Bridge panel

The bridge exposes:

- `GET /api/health`
- `GET /api/projects`
- `POST /api/codex/run`

`POST /api/codex/run` streams newline-delimited JSON while `codex exec --json` runs, so the mobile chat sees Codex status and final responses without waiting for a full request to finish.

## CodexRemote Relay

For a phone that cannot reach the Mac directly, MyBrain can also use a CodexRemote relay service. In the Bridge panel, choose Auto Detect or CodexRemote Relay, set the relay URL, and use the relay token. MyBrain will queue work through:

- `POST /api/command`
- `GET /api/events/<request-id>`

CodexRemote stays API-only in this setup. It does not render a separate web app; it only relays commands between MyBrain and the Mac-side CodexRemote agent.

## Remote Work History

The Remote tab can read orchestration state in two modes:

- Local mode reads directly from a Mac-side RemoteControl service. The default URL is `http://127.0.0.1:3187`, and it can be overridden with `VITE_REMOTE_CONTROL_URL` or from the Remote tab.
- Server mode reads synced history from the MyBrain backend at same-origin `/api/remote-control/*`. This is the default for the Render-hosted app because a remote browser cannot access the Mac's localhost.

Read endpoints used by the UI:

- Local mode: `GET /api/health`, `GET /api/projects`, `GET /api/history`, `GET /api/history/:requestId`
- Server mode: `GET /api/remote-control/health`, `GET /api/remote-control/projects`, `GET /api/remote-control/history`, `GET /api/remote-control/history/:requestId`

RemoteControl can push server-mode history into MyBrain with authenticated write endpoints:

- `POST /api/remote-control/snapshots`
- `POST /api/remote-control/history/:requestId`
- `GET /api/remote-control/history/:requestId/codex-context`

Write requests must include:

```http
Authorization: Bearer MYBRAIN_REMOTE_CONTROL_TOKEN
```

Server-side environment variables:

```env
MYBRAIN_REMOTE_CONTROL_TOKEN=
MYBRAIN_HISTORY_REPO=
MYBRAIN_HISTORY_BRANCH=main
GITHUB_TOKEN=
```

`MYBRAIN_HISTORY_REPO` should be an `owner/name` repo slug such as `dumbfounder/remote-codex-history`. When `MYBRAIN_HISTORY_REPO` and `GITHUB_TOKEN` are configured, MyBrain writes history artifacts to GitHub with this layout:

```text
projects/
  <projectName>/
    workstreams/
      <workstreamAlias-or-default>/
        <requestId>/
          metadata.json
          input.md
          worker-prompt.md
          assistant-output.md
          relay-completion.md
          summary.md
          codex-context.md
          codex-events.jsonl
    index.jsonl
  index.jsonl
  projects.json
```

If GitHub storage is not configured, the Node server uses a local JSON-file adapter at `.mybrain-history`. That fallback is useful for local verification, but Render should use GitHub storage for durable history.

Because MyBrain runs browser code for the UI, private GitHub history, artifact reads, and token-backed metadata must flow through RemoteControl, the MyBrain backend, or another backend proxy. Do not put GitHub tokens, Render secrets, or ingestion tokens in Vite/client code.

Local verification:

```bash
npm run check:remote-control
npm run check:server
npm run build
MYBRAIN_REMOTE_CONTROL_TOKEN="test-token" npm run start

curl -sS http://localhost:3000/api/remote-control/health
curl -i -X POST http://localhost:3000/api/remote-control/snapshots \
  -H 'content-type: application/json' \
  -d '{"requestId":"test","projectName":"mybrain","status":"ok","createdAt":"2026-04-17T00:00:00.000Z"}'
curl -i -X POST http://localhost:3000/api/remote-control/snapshots \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MYBRAIN_REMOTE_CONTROL_TOKEN" \
  -d '{"requestId":"test","projectName":"mybrain","workstreamAlias":"remote-history","status":"ok","createdAt":"2026-04-17T00:00:00.000Z","finishedAt":"2026-04-17T00:01:00.000Z","promptText":"Test remote sync","summary":"Stored a test RemoteControl snapshot.","codexUiHandoff":"# Handoff\nContinue this test request."}'
curl -sS http://localhost:3000/api/remote-control/history
curl -sS http://localhost:3000/api/remote-control/history/test
```

## Project Snapshot

You can still generate a snapshot without running the bridge:

```bash
npm run snapshot:projects -- "/Users/dumbfounder/Dropbox/codex apps" > mybrain-projects.json
```

The bridge uses the same scan concept: local path, git remote, current branch, dirty state, last commit info, and matching Render services when the Render CLI is available and logged in.

## Development

```bash
npm install --cache .npm-cache
npm run dev
```

## Deploy

Render runs the Node server as `mybrain-ai-tracker-web` with `npm run start`. The server exposes `/api/remote-control/*` first, then serves the built Vite app from `dist` and falls back to `dist/index.html` for SPA routes. The older `mybrain-ai-tracker` static service can still serve the SPA, but it cannot receive RemoteControl POSTs. GitHub Pages still builds with `VITE_BASE_PATH=/mybrain/` but does not provide backend ingestion APIs.

Render requires these environment variables for production RemoteControl ingest:

- `MYBRAIN_REMOTE_CONTROL_TOKEN`
- `MYBRAIN_HISTORY_REPO`
- `MYBRAIN_HISTORY_BRANCH`
- `GITHUB_TOKEN`
- `VITE_REMOTE_HISTORY_MODE=server`

CodexRemote-managed changes should push to GitHub and wait for the Render deploy to finish before the task is called complete. The mobile prompt wrapper also asks Codex to include the GitHub push result, Render deploy result, live URL, verification, and exact next action in its final relay completion.

The hosted deployment is useful for the mobile shell and RemoteControl history review. Real Codex execution still requires the local bridge, a private tunnel to it, the CodexRemote relay, or a RemoteControl worker that pushes status back through the authenticated ingest API.
