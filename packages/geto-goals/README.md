# geto-goals

Durable autonomous goal loop for [pi](https://pi.dev/packages) — Codex `/goal` style.

## Install

```bash
pi install npm:geto-goals
# or from this repo:
mkdir -p ~/.pi/agent/extensions/geto-goals
ln -s "$PWD/packages/geto-goals/index.ts" ~/.pi/agent/extensions/geto-goals/index.ts
```

Then `/reload` in pi.

## Commands

```
/goal <text> [--done <criteria>] [--max-iterations N] [--budget $]
/goal set|show|edit <text>|pause|resume|clear|status
```

Example:

```text
/goal Migrate the API client to v3; update all call sites; run unit and integration
      tests; keep going until they pass. --done "all tests green" --max-iterations 30
```

`/goal <free text>` (or `/goal set <text>`) starts the goal **and immediately kicks off the agent** — Codex `/goal` style. Subcommands: `show`/`status`, `edit`, `pause`, `resume`, `clear`.

## Tool

`goal_report(status: "progress"|"done"|"blocked", note)` — the agent's progress channel. Writing it updates the durable goal file; the loop continues while the goal is `active`. The injected prompt instructs the agent to call it with `done` only after a requirement-by-requirement completion audit passes, and `blocked` only after the same blocker repeats across three consecutive goal turns.

## The loop

- `before_agent_start` injects the goal (text, definition of done, last/next step, recent progress, iteration/budget counts) into every turn's system prompt, wrapped as untrusted user data.
- `agent_end` queues a continuation (a custom `goal-continuation` message — not a user message, so it never re-enters the run lifecycle) while the goal is active **and** guards allow:
  - iteration cap (`--max-iterations`, default 50)
  - cost budget (`--budget $`, summed from session usage)
  - stuck detection (two identical progress reports in a row)
- A `context` filter keeps only the latest continuation in the LLM context and strips goal UI cards, so long autonomous runs do not bloat the transcript.
- Aborted runs ask whether to pause (auto-pause headless) instead of blindly continuing — this is what prevents the runaway abort loop.
- Assistant `error` runs stop automatic continuation and mark the goal `usageLimited` or `blocked`; `/goal resume` restarts it.
- `session_compact` re-appends the goal state to the transcript; the goal itself lives in the file, so summaries cannot lose it.
  - explicit `done` / `blocked` via `goal_report`
- `session_compact` re-appends the goal state to the transcript and resumes the loop.

## Why it survives compaction

The goal is **state, not context**: it lives in `<project>/.pi/goals/goal.json`. Compaction can only delete context; it cannot touch the file. Every turn re-injects the goal verbatim from the file, so no matter how much history is summarized, the agent always sees the full goal and where it left off (`lastStep`/`nextStep`). The transcript mirrors (custom entries + `goal_report` results) are for humans only.

The loop also survives `/new` and restarts — the file is per-project, and `agent_settled` restarts it on any session in the project.

## Releases

Versions, changelogs, tags, and npm publication are managed by Release Please from Conventional Commits. Do not edit the package version manually.

## Notes

- Subagents spawned by geto-subagents run with `GETO_GOALS_DISABLED=1` and are excluded from the loop.
- Pairs well with geto-subagents: the goal loop can delegate bounded chunks to fork-based subagents, which report back.
