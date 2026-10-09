# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `docs/efforts/`.

## Conventions

- One effort per directory: `docs/efforts/<effort-slug>/`
- The spec is `docs/efforts/<effort-slug>/spec.md`
- Implementation tickets are one file per ticket at `docs/efforts/<effort-slug>/tickets/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- The effort directory is tracked in git and deleted when the effort ships; git history keeps the record
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading
- Throwaway artifacts (debug scripts, raw output, tool temp dirs) go in `.tmp/` (gitignored; safe for any session to clear without asking) — never into `docs/efforts/`
- `.scratch` is retired: junk goes to `.tmp/`, plans go to `docs/efforts/`. Do not recreate it.

## When a skill says "publish to the issue tracker"

Create a new file under `docs/efforts/<effort-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is the single entry point, with one **child** file per decision ticket in its own lane.

- **Map**: `docs/efforts/<effort>/map.md` (the Notes / Decisions-so-far / Fog body). Index, not store.
- **Decision ticket**: `docs/efforts/<effort>/wayfinder/WNN-<slug>.md`, numbered from `W01`, with the question in the body. A `Type:` line records the wayfinder type as `wayfinder:research` / `wayfinder:prototype` / `wayfinder:grilling` / `wayfinder:task`; a `Status:` line records `open` / `claimed` / `resolved`. (The `W` prefix and the separate `wayfinder/` directory keep these apart from `/to-tickets` implementation tickets at `tickets/NN-<slug>.md`.)
- **Blocking**: a `Blocked by: WNN, WNN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
