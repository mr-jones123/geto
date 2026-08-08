import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, readFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname, extname, basename, resolve, sep } from "node:path";
import { openDb, rebuildFts, readMeta, writeMeta, SCHEMA_VERSION } from "./db.ts";
import { getParser } from "./grammars.ts";
import { extractTs, type Extraction } from "./extract-ts.ts";
import { extractPy } from "./extract-py.ts";
import { scanYaml, scanDockerfile, type ConfigEntry } from "./scanners.ts";

export const DB_DIR = ".codegraph";
export const DB_FILE = "index.db";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".turbo",
  ".cache", ".venv", "venv", "__pycache__", ".ruff_cache", ".coverage", "coverage",
  "target", "vendor", ".pytest_cache", ".mypy_cache", ".DS_Store",
  "static", "assets",   // build outputs / bundled artifacts
]);
const MAX_FILE = 20 * 1024 * 1024;

const LANG_BY_EXT: Record<string, { lang: string; grammar: string }> = {
  ".ts":   { lang: "typescript", grammar: "ts" },
  ".mts":  { lang: "typescript", grammar: "ts" },
  ".cts":  { lang: "typescript", grammar: "ts" },
  ".tsx":  { lang: "typescript", grammar: "tsx" },
  ".js":   { lang: "typescript", grammar: "ts" },
  ".jsx":  { lang: "typescript", grammar: "tsx" },
  ".py":   { lang: "python", grammar: "python" },
  ".yaml": { lang: "yaml", grammar: "yaml" },
  ".yml":  { lang: "yaml", grammar: "yaml" },
};

interface FileEntry { rel: string; abs: string; ext: string; isDockerfile: boolean }

export interface IndexSummary {
  root: string;
  filesFound: number;
  indexed: number;
  skipped: number;
  removed: number;
  parseErrors: number;
  symbols: number;
  edges: number;
  configEntries: number;
  durationMs: number;
}

export function discoverFiles(root: string): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(abs);
      } else if (ent.isFile()) {
        const ext = extname(ent.name).toLowerCase();
        if (ent.name === "Dockerfile" || ent.name === "Containerfile") {
          out.push({ rel: relative(root, abs), abs, ext: ".dockerfile", isDockerfile: true });
        } else if (LANG_BY_EXT[ext]) {
          out.push({ rel: relative(root, abs), abs, ext, isDockerfile: false });
        }
      }
    }
  };
  walk(root);
  return out;
}

async function reindexFile(db: DatabaseSync, root: string, f: FileEntry, stats: IndexSummary) {
  const st = statSync(f.abs);
  const lang = f.isDockerfile ? "dockerfile" : LANG_BY_EXT[f.ext].lang;
  const grammar = f.isDockerfile ? null : LANG_BY_EXT[f.ext].grammar;

  // stale rows cascade (symbols, edges, config_entries) on files delete
  db.prepare("DELETE FROM files WHERE path = ?").run(f.rel);

  if (st.size > MAX_FILE) {
    db.prepare("INSERT INTO files (path, language, mtime, size, status, reason, indexed_at) VALUES (?,?,?,?,?,?,?)")
      .run(f.rel, lang, st.mtimeMs, st.size, "too_large", `file exceeds ${MAX_FILE / 1024 / 1024}MB cap`, Date.now());
    stats.skipped++;
    return;
  }

  let src: string;
  try { src = readFileSync(f.abs, "utf8"); } catch { return; }

  const fileId = db.prepare("INSERT INTO files (path, language, mtime, size, status, indexed_at) VALUES (?,?,?,?,?,?)")
    .run(f.rel, lang, st.mtimeMs, st.size, "indexed", Date.now()).lastInsertRowid as number;

  const insSym = db.prepare(`INSERT INTO symbols (file_id, name, qualified, fully_qualified, kind, signature, sig_key, doc, line_start, line_end, col_start, is_exported, is_local)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insEdge = db.prepare("INSERT INTO edges (file_id, from_id, from_text, kind, to_id, to_text, line) VALUES (?,?,?,?,?,?,?)");
  const insCfg = db.prepare("INSERT INTO config_entries (file_id, name, kind, value, line) VALUES (?,?,?,?,?)");

  db.exec("BEGIN");
  try {
    if (grammar === "yaml") {
      const entries = scanYaml(src);
      for (const e of entries) insCfg.run(fileId, e.name, e.kind, e.value, e.line);
      stats.configEntries += entries.length;
    } else if (f.isDockerfile) {
      const entries = scanDockerfile(src);
      for (const e of entries) insCfg.run(fileId, e.name, e.kind, e.value, e.line);
      stats.configEntries += entries.length;
    } else if (grammar === "python") {
      const parser = await getParser("python");
      insertSymbolsAndEdges(db, fileId, f, extractPy(src, parser, f.rel), insSym, insEdge, stats);
    } else {
      const parser = await getParser(grammar as "ts" | "tsx");
      insertSymbolsAndEdges(db, fileId, f, extractTs(src, parser, f.rel), insSym, insEdge, stats);
    }
    db.exec("COMMIT");
    stats.indexed++;
  } catch (err) {
    db.exec("ROLLBACK");
    db.prepare("UPDATE files SET status = 'parse_error', reason = ? WHERE id = ?").run(String(err).slice(0, 200), fileId);
    stats.parseErrors++;
  }
}

// Shared symbol + edge insertion for TS and Python extractions (same shape).
function insertSymbolsAndEdges(
  db: DatabaseSync,
  fileId: number,
  f: FileEntry,
  ex: Extraction,
  insSym: ReturnType<DatabaseSync["prepare"]>,
  insEdge: ReturnType<DatabaseSync["prepare"]>,
  stats: IndexSummary,
) {
  // module symbol for this file
  insSym.run(fileId, basename(f.rel), f.rel, `${f.rel}::module`, "module", "", "decl", "", 1, 1, 1, 0, 0);
  stats.symbols++;

  const qMap = new Map<string, number>();
  for (const s of ex.symbols) {
    const r = insSym.run(
      fileId, s.name, s.qualified, `${f.rel}::${s.qualified}`, s.kind,
      s.signature || "", s.sigKey, s.doc || "", s.lineStart, s.lineEnd,
      s.colStart, s.isExported ? 1 : 0, s.isExported || s.kind === "module" ? 0 : 1,
    );
    qMap.set(s.qualified, r.lastInsertRowid as number);
    stats.symbols++;
  }

  const moduleId = db.prepare("SELECT id FROM symbols WHERE file_id = ? AND kind = 'module'").get(fileId) as { id: number };
  const mId = moduleId.id;
  for (const e of ex.edges) {
    const fromId = e.from === f.rel || e.from === "" ? mId : qMap.get(e.from) ?? mId;
    const toId = e.to ? qMap.get(e.to) ?? null : null;
    insEdge.run(fileId, fromId, e.from, e.kind, toId, e.toText, e.line);
    stats.edges++;
  }
}

export async function indexProject(root: string, opts: { dbPath?: string; force?: boolean; quiet?: boolean } = {}): Promise<IndexSummary> {
  const started = Date.now();
  const stats: IndexSummary = {
    root, filesFound: 0, indexed: 0, skipped: 0, removed: 0, parseErrors: 0,
    symbols: 0, edges: 0, configEntries: 0, durationMs: 0,
  };
  const absRoot = resolve(root);
  const dbPath = opts.dbPath ?? join(absRoot, DB_DIR, DB_FILE);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);

  writeMeta(db, "schema_version", SCHEMA_VERSION);
  writeMeta(db, "root", absRoot);
  writeMeta(db, "indexed_at", String(Date.now()));

  const files = discoverFiles(absRoot);
  stats.filesFound = files.length;

  for (const f of files) {
    let st;
    try { st = statSync(f.abs); } catch { continue; }
    if (!opts.force) {
      const row = db.prepare("SELECT mtime, size, status FROM files WHERE path = ?").get(f.rel) as { mtime: number; size: number; status: string } | undefined;
      if (row && row.mtime === st.mtimeMs && row.size === st.size && row.status !== "parse_error") {
        stats.skipped++;
        continue;
      }
    }
    await reindexFile(db, absRoot, f, stats);
  }

  // remove files that disappeared
  const known = new Set(files.map((f) => f.rel));
  const stale = db.prepare("SELECT id, path FROM files").all() as { id: number; path: string }[];
  for (const s of stale) {
    if (!known.has(s.path)) { db.prepare("DELETE FROM files WHERE id = ?").run(s.id); stats.removed++; }
  }

  // resolve cross-file imports: to_id = target module symbol
  const pathToFile = new Map<string, number>();
  for (const r of db.prepare("SELECT id, path FROM files").all() as { id: number; path: string }[]) pathToFile.set(r.path, r.id);

  const normalizeRel = (p: string) => {
    const parts = p.split(sep).filter((x) => x && x !== "." && x !== "..");
    return parts.join("/");
  };

  const TS_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".d.ts", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
  const PY_EXTS = [".py", "/__init__.py", ".pyi"];

  const resolveImport = (baseDir: string, src: string, lang: string): number | null => {
    let base: string;
    let exts: string[];
    if (lang === "python") {
      exts = PY_EXTS;
      if (src.startsWith(".")) {
        // relative import: ".utils" = sibling, "..utils" = parent
        const dots = src.match(/^\.+/)?.[0].length ?? 1;
        const modulePath = src.slice(dots).replace(/\./g, sep);
        const rel = dots === 1 ? join(baseDir, modulePath) : join(baseDir, ...Array(dots - 1).fill(".."), modulePath);
        base = rel;
      } else {
        // bare dotted module name: try from the file's dir up to the repo root
        const modulePath = src.replace(/\./g, sep);
        let anc = baseDir;
        for (;;) {
          const fid = pathToFile.get(normalizeRel(join(anc, modulePath) + ".py"));
          if (fid !== undefined) return fid;
          const fidInit = pathToFile.get(normalizeRel(join(anc, modulePath, "__init__.py")));
          if (fidInit !== undefined) return fidInit;
          const i = anc.lastIndexOf(sep);
          if (i <= 0) break;
          anc = anc.slice(0, i);
        }
        return null;
      }
    } else {
      if (!src.startsWith(".")) return null; // bare package / alias — external
      exts = TS_EXTS;
      base = join(baseDir, src);
    }
    for (const ext of exts) {
      const fid = pathToFile.get(normalizeRel(base + ext));
      if (fid !== undefined) return fid;
    }
    return null;
  };

  const pending = db.prepare("SELECT e.id, e.file_id, e.to_text, f.language FROM edges e JOIN files f ON f.id = e.file_id WHERE e.kind = 'imports' AND e.to_id IS NULL").all() as { id: number; file_id: number; to_text: string; language: string }[];
  const upd = db.prepare("UPDATE edges SET to_id = ? WHERE id = ?");
  for (const e of pending) {
    const fileRel = (db.prepare("SELECT path FROM files WHERE id = ?").get(e.file_id) as { path: string }).path;
    const fid = resolveImport(dirname(fileRel), e.to_text, e.language);
    if (fid === null) continue;
    const mod = db.prepare("SELECT id FROM symbols WHERE file_id = ? AND kind = 'module'").get(fid) as { id: number } | undefined;
    if (mod) upd.run(mod.id, e.id);
  }

  rebuildFts(db);

  writeMeta(db, "symbol_count", String(stats.symbols));
  writeMeta(db, "edge_count", String(stats.edges));
  writeMeta(db, "file_count", String(files.length));
  stats.durationMs = Date.now() - started;
  db.close();
  return stats;
}

export function isStale(root: string, dbPath: string): boolean {
  if (!dbPath) return true;
  try {
    const db = openDb(dbPath);
    const r = readMeta(db, "root");
    const ok = r === resolve(root);
    db.close();
    return !ok;
  } catch {
    return true;
  }
}
