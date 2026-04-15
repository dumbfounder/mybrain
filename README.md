# MyBrain

MyBrain is a mobile-first tracker for AI work. Each thread stores:

- what you are trying to get done
- the last prompt you sent
- what that prompt produced
- the next prompt you want ready
- notes, tags, status, and priority

## What it does

- local-first storage in the browser
- optional cross-device sync through a private GitHub gist
- ChatGPT export import from a `.zip` export or `conversations.json`
- installable PWA with a phone share target so you can share text or links into it
- GitHub Pages deployment

## Local development

```bash
npm install --cache .npm-cache
npm run dev
```

## Deploy

Push to the `main` branch. The GitHub Actions workflow in `.github/workflows/deploy.yml` builds the app and publishes it to GitHub Pages.

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
- manually capturing prompts and outcomes

It does not include automatic live ChatGPT history access.
