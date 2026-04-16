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

Render serves the static app from `dist`. GitHub Pages still builds with `VITE_BASE_PATH=/mybrain/`.

CodexRemote-managed changes should push to GitHub and wait for the Render deploy to finish before the task is called complete. The mobile prompt wrapper also asks Codex to include the GitHub push result, Render deploy result, live URL, verification, and exact next action in its final relay completion.

The static deployment is useful for the mobile shell, but real Codex control requires the local bridge, a private tunnel to it, or the CodexRemote relay.
