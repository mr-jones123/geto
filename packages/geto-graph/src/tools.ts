import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { openDb, readMeta } from "./db.ts";
import { indexProject, DB_DIR, DB_FILE } from "./indexer.ts";

// ── lazy per-project index ────────────────────────────────────────────────────
let state: { root: string; db: DatabaseSync } | null = null;

async function ensureIndexed(cwd: string): Promise<DatabaseSync> {
  const absRoot = resolve(cwd);
  const dir = join(absRoot, DB_DIR);
  const dbPath = join(dir, DB_FILE);
  if (state && state.root === absRoot) return state.db;

  const needsIndex = !existsSync(dbPath) || readMetaSafe(dbPath) !== absRoot;
  if (needsIndex) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await indexProject(absRoot, { dbPath, quiet: true });
  }
  state?.db.close();
  state = { root: absRoot, db: openDb(dbPath) };
  return state.db;
}

function readMetaSafe(dbPath: string): string | null {
  try {
    const db = openDb(dbPath);
    const r = readMeta(db, "root");
    db.close();
    return r;
  } catch {
    return null;
  }
}

function truncate(text: string, maxBytes = 40000): string {
  const buf = Buffer.from(text);
  return buf.length <= maxBytes ? text : buf.subarray(0, maxBytes).toString("utf8") + "\n…[truncated]";
}

// FTS5-safe query: prefix-match each word, OR them
function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[^A-Za-z0-9_]/g, "") + "*")
    .filter((t) => t !== "*")
    .join(" OR ");
}

interface SymbolRow { id: number; name: string; kind: string; qualified: string; fully_qualified: string; signature: string; line_start: number; path: string }

function resolveSymbols(db: DatabaseSync, target: string): SymbolRow[] {
  return db.prepare(`
    SELECT s.id, s.name, s.kind, s.qualified, s.fully_qualified, s.signature, s.line_start, f.path
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.name = ? OR s.qualified = ? OR s.fully_qualified = ? OR s.name = ?
    ORDER BY f.path, s.line_start
  `).all(target, target, target, target.replace(/^.*::/, "")) as unknown as SymbolRow[];
}

const fmt = (r: SymbolRow) =>
  `${r.name}  [${r.kind}]  ${r.path}:${r.line_start}  ${r.signature || ""}  (${r.fully_qualified})`;

// ── tools ─────────────────────────────────────────────────────────────────────
export function registerTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "codegraph_search",
    label: "Codegraph Search",
    description:
      "BM25 full-text search over the codebase symbol index (functions, classes, interfaces, types, enums). Returns qualified names, file paths, line numbers and signatures — never file bodies. Use before reading files to locate symbols fast.",
    promptSnippet: "Search indexed codebase symbols by name or keyword (BM25)",
    promptGuidelines: [
      "Use codegraph_search to locate symbols across the codebase before reading files; the index is always cheaper than guessing paths.",
      "Use codegraph_symbol for exact lookups and codegraph_blastradius before modifying shared symbols.",
      "Use codegraph_overview to get a map of the codebase instead of listing directories.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or keyword, e.g. 'formatDate', 'auth handler', 'parseOptions'" }),
      limit: Type.Optional(Type.Integer({ default: 10, minimum: 1, maximum: 50 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = await ensureIndexed(ctx.cwd);
      const rows = db.prepare(`
        SELECT s.name, s.kind, s.fully_qualified, s.signature, s.line_start, f.path, bm25(syms_fts) AS score
        FROM syms_fts JOIN symbols s ON s.id = syms_fts.rowid JOIN files f ON f.id = s.file_id
        WHERE syms_fts MATCH ? AND s.kind NOT IN ('module','variable','const')
        ORDER BY score LIMIT ?
      `).all(ftsQuery(params.query), params.limit ?? 10) as unknown as {
        name: string; kind: string; fully_qualified: string; signature: string; line_start: number; path: string; score: number;
      }[];
      const lines = rows.map((r) => `${r.name}  [${r.kind}]  ${r.path}:${r.line_start}  ${r.signature || ""}  (score ${r.score.toFixed(2)})`);
      const text = lines.length ? lines.join("\n") : "No matches. Broader terms may help; run /codegraph status to check the index.";
      return { content: [{ type: "text", text: truncate(text) }], details: { count: rows.length } };
    },
  });

  pi.registerTool({
    name: "codegraph_symbol",
    label: "Codegraph Symbol",
    description:
      "Exact lookup of a symbol by name (returns all definitions across files — same name in different modules is common). Shows kind, file:line, signature. Optionally filter to one file.",
    promptSnippet: "Look up a symbol exactly (all files)",
    parameters: Type.Object({
      name: Type.String({ description: "Symbol name, e.g. 'formatDate', or qualified 'Indexer.walk'" }),
      file: Type.Optional(Type.String({ description: "Restrict to this file path (optional)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = await ensureIndexed(ctx.cwd);
      let rows = resolveSymbols(db, params.name);
      if (params.file) rows = rows.filter((r) => r.path === params.file);
      if (!rows.length) {
        rows = db.prepare(`
          SELECT s.id, s.name, s.kind, s.qualified, s.fully_qualified, s.signature, s.line_start, f.path
          FROM symbols s JOIN files f ON f.id = s.file_id
          WHERE s.name LIKE ? OR s.qualified LIKE ?
          ORDER BY f.path, s.line_start LIMIT 25
        `).all(`%${params.name}%`, `%${params.name}%`) as unknown as SymbolRow[];
      }
      const text = rows.length ? rows.map(fmt).join("\n") : `No symbol named '${params.name}' in the index.`;
      return { content: [{ type: "text", text: truncate(text) }], details: { count: rows.length } };
    },
  });

  pi.registerTool({
    name: "codegraph_refs",
    label: "Codegraph Refs",
    description:
      "Direct graph edges of a symbol: who calls/extends/uses it ('in') or what it calls/uses ('out'). Kinds: calls, imports, extends, implements, uses.",
    promptSnippet: "Find callers/callees and type usages of a symbol",
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name or qualified name" }),
      direction: StringEnum(["in", "out"] as const),
      kinds: Type.Optional(Type.Array(StringEnum(["calls", "imports", "extends", "implements", "uses"] as const))),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = await ensureIndexed(ctx.cwd);
      const targets = resolveSymbols(db, params.symbol);
      if (!targets.length) return { content: [{ type: "text", text: `No symbol '${params.symbol}' in the index.` }], details: {} };
      const kinds = params.kinds ?? ["calls", "imports", "extends", "implements", "uses"];
      const ph = kinds.map(() => "?").join(",");
      const lines: string[] = [];
      const details: unknown[] = [];
      for (const t of targets) {
        if (params.direction === "in") {
          const rows = db.prepare(`
            SELECT e.kind, e.line, s.name, s.fully_qualified AS fq, f.path, e.from_text
            FROM edges e JOIN symbols s ON s.id = e.from_id JOIN files f ON f.id = s.file_id
            WHERE e.to_id = ? AND e.kind IN (${ph}) ORDER BY e.kind, f.path
          `).all(t.id, ...kinds) as unknown as { kind: string; line: number; name: string; fq: string; path: string; from_text: string }[];
          for (const r of rows) {
            lines.push(`${r.kind}  ${r.fq}  (${r.path}:${r.line})  →  ${t.name}`);
            details.push(r);
          }
        } else {
          const rows = db.prepare(`
            SELECT e.kind, e.line, COALESCE(s.fully_qualified, e.to_text) AS target, f.path
            FROM edges e JOIN files f ON f.id = e.file_id
            LEFT JOIN symbols s ON s.id = e.to_id
            WHERE e.from_id = ? AND e.kind IN (${ph}) ORDER BY e.kind
          `).all(t.id, ...kinds) as unknown as { kind: string; line: number; target: string; path: string }[];
          for (const r of rows) {
            lines.push(`${t.name}  ${r.kind}→  ${r.target}  (${r.path}:${r.line})`);
            details.push(r);
          }
        }
      }
      const text = lines.length ? lines.join("\n") : `No ${params.direction} refs found for '${params.symbol}'.`;
      return { content: [{ type: "text", text: truncate(text) }], details: { count: lines.length } };
    },
  });

  pi.registerTool({
    name: "codegraph_file",
    label: "Codegraph File",
    description:
      "Everything the index knows about one file: all symbols with lines, import edges, and config keys (yaml/dockerfile). Read this instead of the file when you only need structure.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative file path, e.g. 'src/auth/handler.ts'" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = await ensureIndexed(ctx.cwd);
      const file = db.prepare("SELECT id, path FROM files WHERE path = ?").get(params.path) as { id: number; path: string } | undefined;
      if (!file) return { content: [{ type: "text", text: `File '${params.path}' not in index. Try codegraph_overview or /codegraph status.` }], details: {} };
      const syms = db.prepare("SELECT name, kind, qualified, signature, line_start, is_exported FROM symbols WHERE file_id = ? AND kind != 'module' ORDER BY line_start").all(file.id) as unknown as { name: string; kind: string; qualified: string; signature: string; line_start: number; is_exported: number }[];
      const imports = db.prepare("SELECT to_text, COALESCE(s.fully_qualified, '') AS resolved, e.line FROM edges e LEFT JOIN symbols s ON s.id = e.to_id WHERE e.file_id = ? AND e.kind = 'imports'").all(file.id) as unknown as { to_text: string; resolved: string; line: number }[];
      const cfg = db.prepare("SELECT name, value FROM config_entries WHERE file_id = ? ORDER BY line LIMIT 100").all(file.id) as unknown as { name: string; value: string | null }[];
      const lines: string[] = [];
      lines.push(`== ${file.path} (${syms.length} symbols, ${imports.length} imports)`);
      for (const s of syms) lines.push(`  ${s.line_start}: ${s.kind} ${s.qualified}${s.is_exported ? " (exported)" : ""}  ${s.signature}`);
      if (imports.length) {
        lines.push("  imports:");
        for (const i of imports) lines.push(`    ${i.to_text}${i.resolved ? ` → ${i.resolved}` : ""}`);
      }
      if (cfg.length) {
        lines.push(`  config keys (${cfg.length}):`);
        for (const c of cfg.slice(0, 30)) lines.push(`    ${c.name}${c.value ? " = " + c.value : ""}`);
      }
      return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { symbols: syms.length, imports: imports.length, config: cfg.length } };
    },
  });

  pi.registerTool({
    name: "codegraph_overview",
    label: "Codegraph Overview",
    description:
      "Map of the codebase: per-file symbol counts (and config-entry counts for yaml/dockerfile). The 'zoom out' tool — use it to decide which files matter before zooming in.",
    promptSnippet: "Get a per-file map of the codebase (symbol counts)",
    parameters: Type.Object({
      dir: Type.Optional(Type.String({ description: "Restrict to a subdirectory (optional)" })),
      limit: Type.Optional(Type.Integer({ default: 60, minimum: 1, maximum: 200 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = await ensureIndexed(ctx.cwd);
      const prefix = params.dir ? (params.dir.endsWith("/") ? params.dir : params.dir + "/") : "";
      const where = prefix ? "WHERE f.path LIKE ?" : "";
      const args = prefix ? [`${prefix}%`] : [];
      const rows = db.prepare(`
        SELECT f.path, COUNT(s.id) AS symbols FROM files f
        JOIN symbols s ON s.id IN (SELECT id FROM symbols WHERE file_id = f.id AND kind NOT IN ('module','variable','const'))
        ${where} GROUP BY f.id ORDER BY symbols DESC LIMIT ?
      `).all(...args, params.limit ?? 60) as unknown as { path: string; symbols: number }[];
      const cfgRows = db.prepare(`
        SELECT f.path, COUNT(c.id) AS configs FROM files f JOIN config_entries c ON c.file_id = f.id
        ${where} GROUP BY f.id ORDER BY configs DESC
      `).all(...args) as unknown as { path: string; configs: number }[];
      const cfgMap = new Map(cfgRows.map((r) => [r.path, r.configs]));
      const totals = db.prepare("SELECT (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM symbols WHERE kind NOT IN ('module','variable','const')) AS symbols, (SELECT COUNT(*) FROM edges) AS edges, (SELECT COUNT(*) FROM config_entries) AS configs").get() as unknown as { files: number; symbols: number; edges: number; configs: number };
      const lines: string[] = [`index: ${totals.files} files, ${totals.symbols} symbols, ${totals.edges} edges, ${totals.configs} config entries`];
      for (const r of rows) {
        const cfg = cfgMap.get(r.path);
        lines.push(`  ${r.symbols.toString().padStart(4)} symbols  ${r.path}${cfg ? `  (${cfg} config)` : ""}`);
      }
      return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { totals } };
    },
  });

  pi.registerTool({
    name: "codegraph_blastradius",
    label: "Codegraph Blast Radius",
    description:
      "Impact analysis over the graph. Reverse: everything that transitively depends on a symbol/file (what breaks if you change it). Forward: everything it depends on. Returns files ranked by proximity with affected-symbol counts.",
    promptSnippet: "Find the blast radius of changing a symbol or file",
    promptGuidelines: [
      "Run codegraph_blastradius before modifying a shared symbol to see which files and tests are affected.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "Symbol name / qualified name / file path" }),
      direction: StringEnum(["reverse", "forward"] as const),
      maxDepth: Type.Optional(Type.Integer({ default: 5, minimum: 1, maximum: 12 })),
      scope: Type.Optional(StringEnum(["dependents", "callers", "type_impact"] as const)),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = await ensureIndexed(ctx.cwd);
      const direction = params.direction ?? "reverse";
      const maxDepth = params.maxDepth ?? 5;
      const scope = params.scope ?? "dependents";
      const kinds = scope === "callers" ? ["calls"]
        : scope === "type_impact" ? ["calls", "uses", "extends", "implements"]
        : ["calls", "imports", "extends", "implements", "uses"];

      // resolve target → symbol ids (or all symbols of a file)
      let starts = resolveSymbols(db, params.target).map((r) => r.id);
      if (!starts.length) {
        const file = db.prepare("SELECT id FROM files WHERE path = ?").get(params.target) as { id: number } | undefined;
        if (file) starts = (db.prepare("SELECT id FROM symbols WHERE file_id = ?").all(file.id) as unknown as { id: number }[]).map((r) => r.id);
      }
      if (!starts.length) return { content: [{ type: "text", text: `'${params.target}' not found in the index.` }], details: {} };

      const seed = starts.map((_, i) => `SELECT ?${i === 0 ? " AS id" : ""}, 0 AS depth`).join(" UNION ALL ");
      const edgeCond = direction === "reverse" ? "e.to_id = blast.id" : "e.from_id = blast.id";
      const pick = direction === "reverse" ? "e.from_id" : "e.to_id";
      const kindsPh = kinds.map(() => "?").join(",");
      const sql = `
        WITH RECURSIVE blast(id, depth) AS (
          ${seed}
          UNION
          SELECT e.${direction === "reverse" ? "from_id" : "to_id"}, blast.depth + 1
          FROM blast JOIN edges e ON e.${direction === "reverse" ? "to_id" : "from_id"} = blast.id
          WHERE blast.depth < ? AND e.kind IN (${kindsPh})
        )
        SELECT f.path, COUNT(DISTINCT b.id) AS affected, MIN(b.depth) AS depth
        FROM blast b JOIN symbols s ON s.id = b.id JOIN files f ON f.id = s.file_id
        GROUP BY f.path ORDER BY depth, affected DESC LIMIT 40`;
      const rows = db.prepare(sql).all(...starts, maxDepth, ...kinds) as unknown as { path: string; affected: number; depth: number }[];
      const total = db.prepare(`
        WITH RECURSIVE blast(id) AS (
          ${seed.replace(", 0 AS depth", "")}
          UNION SELECT e.${direction === "reverse" ? "from_id" : "to_id"} FROM blast JOIN edges e ON e.${direction === "reverse" ? "to_id" : "from_id"} = blast.id
        )
        SELECT COUNT(DISTINCT b.id) AS n FROM blast b`).all(...starts) as unknown as { n: number }[];

      const dirTxt = direction === "reverse" ? "affected by" : "touched by";
      const lines: string[] = [`blast radius (${dirTxt} '${params.target}', scope=${scope}, depth≤${maxDepth}): ${total[0]?.n ?? 0} symbols across ${rows.length}+ files`];
      for (const r of rows) lines.push(`  ${r.depth} hop(s) | ${r.path} | ${r.affected} symbols`);
      return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { files: rows.length, totalSymbols: total[0]?.n } };
    },
  });

  pi.registerTool({
    name: "codegraph_status",
    label: "Codegraph Status",
    description: "Index freshness and size. Run if a codegraph tool returns empty or stale-looking results.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const db = await ensureIndexed(ctx.cwd);
      const t = db.prepare("SELECT (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM symbols) AS symbols, (SELECT COUNT(*) FROM edges) AS edges, (SELECT COUNT(*) FROM config_entries) AS configs, (SELECT value FROM meta WHERE key='indexed_at') AS at, (SELECT value FROM meta WHERE key='root') AS root").get() as unknown as { files: number; symbols: number; edges: number; configs: number; at: string | null; root: string | null };
      const text = `index root: ${t.root}\nfiles: ${t.files}\nsymbols: ${t.symbols}\nedges: ${t.edges}\nconfig entries: ${t.configs}\nindexed at: ${t.at ? new Date(Number(t.at)).toISOString() : "never"}`;
      return { content: [{ type: "text", text }], details: { t } };
    },
  });
}
