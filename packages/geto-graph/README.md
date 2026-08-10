# geto-graph

SQLite + BM25 codebase symbol graph for [pi](https://github.com/earendil-works/pi). Agents query the graph instead of guessing how the codebase is connected — then read only what's necessary.

Part of the [geto monorepo](../../README.md).

## Install

### Via pi (npm package)

```bash
pi install npm:geto-graph@0.1.0
```

### From source (this monorepo)

```bash
npm install                            # from repo root (links workspaces)
node packages/geto-graph/scripts/download-grammars.mjs   # fetch tree-sitter .wasm grammars
ln -s "$PWD/packages/geto-graph" ~/.pi/agent/extensions/geto-graph   # global
# or: ln -s "$PWD/packages/geto-graph" .pi/extensions/geto-graph      # project-local
```

Then `/reload` in pi. The index auto-builds (lazily) on first `geto_graph_*` tool call for the current project, stored in `<project>/.geto-graph/index.db` (add `.geto-graph/` to your project's `.gitignore`).

Requires pi >= 0.84 (declared as a peer dependency).

## Commands

- `/geto-graph status` — index size/freshness
- `/geto-graph reindex [--force] [path]` — incremental (mtime/size) or forced full reindex

## Tools

| Tool | Purpose |
|---|---|
| `geto_graph_search` | BM25 symbol search (name/signature/doc) |
| `geto_graph_symbol` | Exact lookup, all definitions across files |
| `geto_graph_refs` | Direct edges in/out: calls, imports, extends, implements, uses |
| `geto_graph_file` | All symbols + imports + config keys of one file |
| `geto_graph_overview` | Per-file symbol counts — the map |
| `geto_graph_blastradius` | BFS impact analysis (reverse/forward, depth, scope) |
| `geto_graph_status` | Index freshness |

## Supported files

- `.ts/.tsx/.js/.jsx/.mts/.cts` — tree-sitter (WASM) full symbol + call/type/import graph
- `.yaml/.yml` — structural key-path scanner (`services.web.image`)
- `Dockerfile`/`Containerfile` — instruction scanner

## Dev

```bash
node packages/geto-graph/test.mjs <project-root>   # end-to-end: index + all queries
```

## Notes

- Parse-extract-free per file: memory stays flat regardless of repo size (~1MB for 4000 files). Per-file ceiling is ~35MB (wasm32); files over 20MB are skipped.
- `.geto-graph/` should be gitignored.
- Requires pi >= 0.84 (declared as a peer dependency).
