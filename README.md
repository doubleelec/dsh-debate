# dsh-session-enhance

> DSH native plugin with two functions: deliberate open-ended questions (builder/challenger/synthesizer → argument map) and run cross-repo tasks (scan → build → launch → report/collect).
> Human-operated plugin: registers no model tools (`contributes.tools` is empty); orders are placed from panel buttons, driven directly by the host in the background.

## Features

- **Deliberation**: composer `✦ Enhance` menu → deliberation item → starts from the draft as the seed question, runs builder/challenger rounds on a single-thread fork, synthesizer outputs the five-piece map (see `docs/architecture.md` §4.4a).
- **Cross-repo tasks**: `✦ Enhance` menu → multi-repo task item → auto-scans the current session directory and prefills → `TaskDialog` creates the task with a session preview → confirm to launch (confirmation issues the directive), report/collect gathers replies (see §4.4b and `docs/adr/0026-task-autofill-preview.md`).

## Status

v0.14.0: full rename (`dsh-debate` → `dsh-session-enhance`, old routes/KV/report paths incompatible) + model-tool removal (human-operated plugin, old `debate_*`/`task_*` tool names no longer registered). Single-thread fork by default (ADR-0024) + task merge (ADR-0025). The full cycle follows `docs/architecture.md`.
Post-v0.1 changes are tracked in the S0~S27 progress table in `docs/action-plan.md` (entry/rounds/judge/direct-drive/mutual-blindness/routing/map shape each point at an ADR; the former `docs/efforts/debate-v01/` was deleted on ship per convention, history kept in git).

## Domain docs

- `CONTEXT.md`: glossary (authoritative, includes cross-repo task vocabulary; kept in Chinese as the domain language)
- `docs/adr/`: 26 settled decisions (deliberation 0001~0024 + task merge 0025 + task panel autofill with preview-as-confirm 0026)
- `docs/architecture.md`: the single architecture description for the whole project (both functions)
- `docs/agents/`: engineering skill conventions (issue tracker / domain)

## Development

```powershell
# 1) Install dependencies (first time)
npm install

# 2) Build (lib/ is what DSH actually loads)
npm run build

# 3) Unit tests
npm test

# 4) Dev loop: symlink this repo into the dev profile (3090), once
$p = "$env:USERPROFILE\.dsh\profiles\dev\node_modules\@doubleelec\dsh-session-enhance"
cmd /c mklink /D "$p" "<repo>"   # needs one admin approval
# afterwards: npm run build + refresh 3090

# 5) Ship to prod (3080): one elevation
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

## Usage (current)

1. Click the composer `✦ Enhance` menu → deliberation item (a draft becomes the seed question; without a draft the panel still opens and prompts for a question).
2. Configure three models + max rounds in the dialog (1~20, default 5; above 20 clamps to 20 with a trace in progress); question/type/lenses/background are inferred from the current session at run time.
3. Click start to place the order; the host drives open → rounds → synthesize in the background (watch progress by panel polling, no trigger phrases).
4. The panel polls and shows the transcript; on completion it outputs the full result-map markdown + conclusion document (`<workspace>/docs/session-enhance/`). The structured five-piece set is not parsed yet (text only).
