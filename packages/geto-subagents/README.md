# geto-subagents

Fork-based, tmux-hosted subagents for [pi](https://pi.dev/packages): `/review`, `/find`, `/plan`, `/chain`, plus a generic `subagent` tool.

## Key ideas

- **Child session = fork of your conversation.** Each subagent is a fresh interactive `pi` instance launched with `pi --fork <your-session-file> --session-id <uuid>`, so it inherits the *entire* conversation (no vague handoff of tasks/context) and appears as a **child session of yours in `/resume`'s tree**.
- **Results come back.** The child reports its final output (atomic `result.json` on `agent_settled`) and shuts down; the parent returns the output to the caller. No need to watch or attach unless you want to.
- **Attach anytime.** `pi --attach-subagent <id>` attaches or switches to the child's tmux session from any terminal.
- **View ladder (zellij is optional):**
  1. inside zellij → subagent opens in a **floating pane** (stacked per subagent)
  2. inside tmux → opens as a **new window** (`Ctrl+B n/p` to flip)
  3. otherwise → the attach hint is printed; works everywhere
  Disable the zellij/tmux views with `--no-zellij`, `GETO_SUBAGENTS_VIEW=attach`, or just ignore the hint.

## Install

```bash
pi install npm:geto-subagents
# or from this repo:
mkdir -p ~/.pi/agent/extensions/geto-subagents
ln -s "$PWD/packages/geto-subagents/index.ts" ~/.pi/agent/extensions/geto-subagents/index.ts
ln -s "$PWD/packages/geto-subagents/agents.ts" ~/.pi/agent/extensions/geto-subagents/agents.ts
```

Requires `tmux` (3.x) on PATH. Then `/reload` in pi.

## Commands

| Command | Purpose |
|---|---|
| `/review <prompt> [model]` | Code review: findings table + verdict (APPROVE / APPROVE WITH NITS / REQUEST CHANGES) |
| `/find <prompt> [model]` | Codebase navigation: geto-graph-first, exact file:line pointers |
| `/plan <prompt> [model]` | Implementation planning: dependency-ordered file table, risks, phases |
| `/chain <step1> \| <step2> \| ...` | Sequential subagent chain via an overlay dialog; each step **forks the previous step's session**; `{chain_dir}` is a shared scratch dir |
| `/subagents` | List running `geto-*` tmux sessions |

Flags: `--model <id>`, `--no-attach`, `--no-zellij`. A trailing token that looks like a model (`provider/id`, `:thinking`) is consumed as the model.

## Tool

`subagent` (AI-callable): `{ task, cwd?, provider?, model?, thinking? }` — same machinery as the commands; calls are serialized (one child at a time).

## How it works

1. The command/tool resolves model + trust, then writes the task (and role prompt for `/review` etc.) to a temp run dir under `~/.pi/agent/tmux-subagents/`.
2. Child invocation (each arg shell-quoted):
   ```
   pi --fork <parent-session-file> --session-id <uuid> --name "geto <role> <short>"
      --provider <p> --model <m> --thinking <l> [--approve|--no-approve]
      [--append-system-prompt <role.md>] --extension <this-file> @task.md
   ```
3. `tmux -S ~/.pi/agent/tmux-subagents.sock new-session -d` (dedicated server), `send-keys` the command, `remain-on-exit` on.
4. The child runs in **child mode** (`PI_TMUX_SUBAGENT_CHILD=1`): on `agent_settled` it writes `result.json` (output, stopReason, session file, model) and shuts down. It also sets `GETO_GOALS_DISABLED=1` so the geto-goals loop does not run inside subagents.
5. The parent polls `result.json` + `capture-pane` (live preview) until done, then returns the output (50KB/2000-line cap; full transcript in the child session file).

## Releases

Versions, changelogs, tags, and npm publication are managed by Release Please from Conventional Commits. Do not edit the package version manually.

## Notes

- `pi --attach-subagent <id>` validates the UUID, then `switch-client` (same tmux server) or `attach-session` (elsewhere, `$TMUX` stripped).
- Sessions are stored per-project in the default session dir, so `/resume` shows the child session linked to the parent.
- Role prompts live in `agents.ts` — edit and `/reload` to tweak behavior.
