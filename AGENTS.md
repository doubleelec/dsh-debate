# dsh-debate

双视角辩论 Map：面向开放性论证题，用建构 / 挑战 / 制图三角色产出一套成果地图，而非单一结论。

## Commit messages

Write every commit subject and body in English so the public Git history is accessible to international contributors. Use Conventional Commits: `type(scope): imperative summary` (scope is optional). Keep the subject concise, use an imperative verb, and omit the trailing period. Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, and `chore`.

Examples: `fix(session): preserve earlier context` or `docs: clarify install steps`.

## Agent skills

### Issue tracker

Issues live as local markdown under `docs/efforts/`. See `docs/agents/issue-tracker.md`.

### Temp files

Throwaway artifacts go in `.tmp/` (gitignored; any session may clear it without asking). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.
