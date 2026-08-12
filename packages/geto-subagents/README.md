# geto-subagents

tmux-hosted subagents for [pi](https://pi.dev/packages): `/review`, `/find`, `/plan`.

Each subagent is a **fresh interactive `pi` instance** running in its own **detached tmux session**:

- **Own session file (separate leaf)** — the subagent gets a new session via `--session-id <uuid>`, so it never pollutes or forks your main conversation tree, and it keeps its own persistent history.
- **Never loses context** — the spawn message is seeded with the parent session's recent conversation, git branch, recent commits, and working-tree changes.
- **Attachable from any terminal** — `tmux attach -t geto-review-a1b2c3` from any terminal instance; keep chatting with the subagent after it finishes.
- **AI picks the model by default** — no `--model` flag means the subagent uses pi's default model. Override with `/review <prompt> <model>` or `--model <id>`.

## Install

```bash
pi install ./packages/geto-subagents   # from this repo
# or symlink for development:
mkdir -p ~/.pi/agent/extensions/geto-subagents
ln -s "$PWD/packages/geto-subagents/index.ts" ~/.pi/agent/extensions/geto-subagents/index.ts
ln -s "$PWD/packages/geto-subagents/agents.ts" ~/.pi/agent/extensions/geto-subagents/agents.ts
```

Requires `tmux` (3.x) on PATH. Then `/reload` in pi.

## Commands

| Command | Agent | Purpose |
|---|---|---|
| `/review <prompt> [model]` | reviewer | Code review: correctness, security, concurrency, perf; structured findings table + verdict (APPROVE / APPROVE WITH NITS / REQUEST CHANGES) |
| `/find <prompt> [model]` | finder | Codebase navigation. **geto-graph first**: searches the symbol index, then reads targeted ranges; returns exact file:line pointers |
| `/plan <prompt> [model]` | planner | Implementation planning: files to touch in dependency order, risks, phases, tests; structured plan table + open questions |
| `/subagents` | — | List running `geto-*` tmux sessions |

### Flags

- `--model <id>` — explicit model (`anthropic/claude-sonnet-4-5`, `gemini-3.6-flash:high`, ...). A positional last token that looks like a model (`provider/id`, `:thinking`, or a known model id) is also consumed, e.g. `/review check the diff gemini-3.6-flash`.
- `--no-attach` — spawn without printing the attach hint.

## Example

```
/review the indexer refactor in packages/geto-graph/src/indexer.ts
→ spawned reviewer subagent — model: AI picks the default
  tmux session: geto-review-9f18fe
  attach (any terminal): tmux attach -t geto-review-9f18fe
  session id: 9f18feb7-5172-4a89-a589-ae59da087b9a
```

Then, from any other terminal:

```bash
tmux attach -t geto-review-9f18fe
```

The reviewer works autonomously (using `geto_graph_*` tools when available), you can watch it live, and once it's done you can continue the conversation with it before detaching (`Ctrl+B D`).

## How it works

1. The command parses `<prompt> [model]`, detects the model via the available-model catalog (`ctx.modelRegistry`), and collects context (git state + recent parent-session messages).
2. It writes the role system prompt to a temp file and builds a pi invocation:
   `pi --session-id <uuid> --name "geto <role> <short>" --append-system-prompt <role-file> [--model <id>] "<task>"`
3. `tmux new-session -d -s geto-<role>-<short> -c <cwd> "<invocation>"` — detached, so it survives your main pi session closing.

## Notes

- The subagent loads your installed extensions, so `geto_graph_*` tools are available inside it (the finder is instructed to use them as its primary instrument).
- Sessions are stored per-project by pi (`--session-id`), so `/resume` can reopen a finished subagent conversation.
- Role prompts live in `agents.ts` — edit and `/reload` to tweak behavior.
