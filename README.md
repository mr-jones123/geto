# geto

Codebase intelligence for AI agents: queryable symbol graphs so agents stop guessing how a codebase is connected — and read only what's necessary.

Built for [pi](https://github.com/earendil-works/pi), the coding agent. `geto-graph` is a [pi package](https://pi.dev/packages) that indexes a codebase into a SQLite + BM25 graph (symbols, calls, imports, type uses, blast radius) and exposes it to the agent as query tools.

## Why

Agents burn tokens and time reading files to figure out structure: *where is this function? who calls it? what imports this module? what breaks if I change it?*

geto answers those in milliseconds with zero file reads:

```sql
-- BM25 search: locate the symbol
SELECT ... FROM syms_fts WHERE syms_fts MATCH 'parseOptions*' ORDER BY bm25(syms_fts);

-- Graph: who transitively depends on it (blast radius)
WITH RECURSIVE blast(id, depth) AS (...);
```

## Features

- **Symbols with signatures** — functions, classes, methods, interfaces, types, enums; typed signatures (`format_comment(results_path: str)`) so the agent sees call shapes without opening files
- **Edges** — `imports`, `calls`, `extends`, `implements`, `uses` (type references), resolved to in-repo targets where possible
- **BM25 full-text search** over symbol names, signatures, and doc comments
- **Blast radius** — recursive-CTE BFS (reverse/forward, depth-limited, scope-filtered) for impact analysis
- **Config files** — YAML key paths (`services.web.image`) and Dockerfile instructions, searchable without polluting symbol search
- **Fast** — tree-sitter WASM at ~5MB/s per file, parse-extract-free keeps memory flat (4000 files ≈ 1MB RSS), incremental reindex is content-hash based (unchanged files skip in ~1ms)
- **No native dependencies** — tree-sitter runs as WASM, SQLite is Node's built-in `node:sqlite`

## Quickstart

```bash
# via pi (npm package)
pi install npm:geto-graph@0.2.1

# or from source
npm install
node packages/geto-graph/scripts/download-grammars.mjs   # fetch tree-sitter .wasm grammars
ln -s "$PWD/packages/geto-graph" ~/.pi/agent/extensions/geto-graph
```

Then `/reload` in pi. The index auto-builds on first use in `<project>/.geto-graph/index.db` (gitignore it).

### Commands

- `/geto-graph status` — index size/freshness
- `/geto-graph reindex [--force] [path]` — incremental or forced rebuild

### Agent tools

| Tool | Purpose |
|---|---|
| `geto_graph_index` | Incremental refresh — re-parses only files whose content hash changed |
| `geto_graph_reindex` | Force a full rebuild (re-parse every file) |
| `geto_graph_search` | BM25 symbol search (name/signature/doc) |
| `geto_graph_symbol` | Exact lookup, all definitions across files |
| `geto_graph_refs` | Direct edges in/out: calls, imports, extends, implements, uses |
| `geto_graph_file` | All symbols + imports + config keys of one file |
| `geto_graph_overview` | Per-file symbol counts — the map |
| `geto_graph_blastradius` | BFS impact analysis (reverse/forward, depth, scope) |
| `geto_graph_status` | Index freshness |

## Supported files

| Type | How |
|---|---|
| `.ts/.tsx/.js/.jsx/.mts/.cts` | tree-sitter (WASM): symbols + calls + type uses + imports |
| `.py` | tree-sitter (WASM): defs, classes, methods, typed signatures, docstrings |
| `.yaml/.yml` | structural key-path scanner |
| `Dockerfile`/`Containerfile` | instruction scanner |

## Packages

| Package | Purpose |
|---|---|
| [geto-graph](./packages/geto-graph) | the pi extension: SQLite + BM25 symbol graph |
| [geto-subagents](./packages/geto-subagents) | tmux-hosted subagents (`/review`, `/find`, `/plan`) with isolated sessions |

## Development

```bash
npm test                      # indexes a project and runs every query:
node packages/geto-graph/test.mjs <project-root>
```

## Releases

[Release Please](https://github.com/googleapis/release-please) manages each package independently from Conventional Commit messages that touch its package directory:

- `fix:` creates a patch release.
- `feat:` creates a minor release.
- `feat!:` or a `BREAKING CHANGE:` footer creates a major release.

Release Please opens a separate release PR for each affected package. Merging that PR updates the package version and changelog, creates a package-specific GitHub release and tag, then invokes that package's npm publishing workflow. Do not edit package versions manually.

## Architecture

```
files ──1:N── symbols ──1:N── edges (calls/imports/extends/implements/uses)
   └─ syms_fts (FTS5/BM25 over name, qualified, signature, doc)
   └─ config_entries (yaml/dockerfile key paths)
```

- Identity: `(file_id, qualified, sig_key)` — same name in different files is fine; overloads coexist via normalized signatures
- Incremental: content hash (sha1) per file with a mtime/size fast-path; a touched-but-unchanged file is detected by hash and skipped. Delete-and-reinsert (FK cascade), FTS rebuilt per pass. Hashes for pre-hash indexes are backfilled automatically on the next run.
- Indexes on both edge endpoints → "who calls X" and "what does X call" are index lookups
- Blast radius = `WITH RECURSIVE` CTE, cycle-safe via depth cap, external deps are leaves

## License

MIT
