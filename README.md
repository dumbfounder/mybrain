# MyBrain

MyBrain is a private mobile-first tracker for Codex projects. Each project stores:

- status, stage, priority, current focus, and next action
- repo URL, production URL, local path, and notes
- deploy history
- feature history
- AI prompt history

## What it does

- local-first storage in the browser
- optional cross-device sync through a private GitHub gist
- ChatGPT export import from a `.zip` export or `conversations.json`
- local project snapshot import for Codex folders, git state, and Render services
- installable PWA with a phone share target
- GitHub Pages and Render deployment

## Local development

```bash
npm install --cache .npm-cache
npm run dev
```

## Project snapshot import

Generate a JSON snapshot of your local Codex project folders:

```bash
npm run snapshot:projects -- "/Users/dumbfounder/Dropbox/codex apps" > mybrain-projects.json
```

Then import that file in the app. The generator pulls local path, git remote, current branch, dirty state, last commit info, and matching Render services when the Render CLI is available and logged in.

## Deploy

Push to the `main` branch. The GitHub Actions workflow in `.github/workflows/deploy.yml` builds the app and publishes it to GitHub Pages.

## Render

This repo also includes a `render.yaml` Blueprint for deploying the app as a Render static site. The Render build should use the default root base path, so no extra environment variables are required.

## GitHub sync setup

1. Create a GitHub personal access token with the `gist` scope.
2. Open the deployed app.
3. Paste the token into the GitHub sync panel.
4. Click `Create sync gist`.
5. On your phone, open the same app, paste the same token and gist id once, then sync.

The token is stored only in that browser's local storage and used directly against the GitHub API.

## ChatGPT integration

MyBrain supports:

- importing a ChatGPT export
- saving ChatGPT links or copied text via the phone share sheet
- manually capturing prompts and outcomes against a project

It does not include automatic live ChatGPT history access.
