<!-- CODEXREMOTE_DEPLOY_TEMPLATE:START -->
## CodexRemote GitHub + Render Template

This block is managed by CodexRemote. Use these template sources by default:
- `/Users/dumbfounder/Dropbox/codex apps/templates/NEW_PROJECT_TEMPLATE.md`
- `/Users/dumbfounder/Dropbox/codex apps/templates/feature-templates/github-render-codexremote.md`
- `/Users/dumbfounder/Dropbox/codex apps/templates/TEMPLATE_SYSTEM_PROMPT.md`

Default operating rules for `mybrain`:
- Keep the project GitHub-backed. If `origin` is missing, create or connect the GitHub repo before leaving remote work.
- Keep the project Render-deployable. Reuse the current Render service when it exists; otherwise create the simplest sensible Render deployment for the app.
- If a Render deploy fails or the live app is broken, inspect deploy logs, runtime logs, health checks, env vars, and start/build commands before concluding the task.
- Prefer explicit deploy config and docs over tribal knowledge. Update deployment-facing files when stack, startup, or build commands change.
- Remote Codex work should commit and push after each successful task when the repo began clean.
- Reuse sibling-project patterns before inventing new deploy or env conventions.
- Verify the deploy path, or explain the exact blocker and next step, before ending deployment-related work.
<!-- CODEXREMOTE_DEPLOY_TEMPLATE:END -->

## Project-specific Git rule

- Any Codex-made repository change must be committed and pushed before the task is considered complete. If commit or push is blocked, report the blocker and the exact next step.
