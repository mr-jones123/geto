// End-to-end test: index a real project and run every query the tools expose.
// Usage: node test.mjs [root]
import { indexProject } from "./src/indexer.ts";
import { openDb } from "./src/db.ts";
import { join } from "node:path";

const root = process.argv[2] ?? "../cloudwright";
const t0 = Date.now();
const s = await indexProject(root, { force: true });
console.log(`\n=== indexed ${s.root} ===`);
console.log(`${s.filesFound} files | ${s.indexed} indexed | ${s.skipped} skipped | ${s.parseErrors} errors | ${s.durationMs}ms`);
console.log(`${s.symbols} symbols | ${s.edges} edges | ${s.configEntries} config entries\n`);

const db = openDb(join(root, ".codegraph", "index.db"));

const q = (label, rows) => {
  console.log(`--- ${label} ---`);
  console.log(rows.length ? rows.map((r) => "  " + JSON.stringify(r)).join("\n") : "  (none)");
};

// 1. BM25 search
q("search 'format'", db.prepare(`
  SELECT s.name, s.kind, s.fully_qualified, s.line_start, f.path, round(bm25(syms_fts),2) AS score
  FROM syms_fts JOIN symbols s ON s.id = syms_fts.rowid JOIN files f ON f.id = s.file_id
  WHERE syms_fts MATCH ? AND s.kind NOT IN ('module','variable','const')
  ORDER BY score LIMIT 8`).all("format*"));

// 2. exact symbol lookup (duplicates across files?)
q("symbol 'App'", db.prepare(`
  SELECT s.name, s.kind, s.fully_qualified, s.signature, s.line_start, f.path
  FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = 'App' ORDER BY f.path, s.line_start`).all());

// 3. refs IN (who calls it) — pick a symbol that exists
const probe = db.prepare(`
  SELECT s.id, s.name, s.fully_qualified FROM symbols s
  JOIN files f ON f.id = s.file_id
  WHERE s.kind IN ('function','method') AND f.path LIKE 'src/%'
  ORDER BY s.id LIMIT 1`).get();
if (probe) {
  q(`refs in for '${probe.name}'`, db.prepare(`
    SELECT e.kind, s2.fully_qualified AS caller, f2.path, e.line
    FROM edges e JOIN symbols s2 ON s2.id = e.from_id JOIN files f2 ON f2.id = s2.file_id
    WHERE e.to_id = ? AND e.kind = 'calls' ORDER BY f2.path LIMIT 10`).all(probe.id));
}

// 4. blast radius reverse from a busy symbol
const busy = db.prepare(`
  SELECT e.to_id, COUNT(*) AS n, MIN(s.name) AS name FROM edges e
  JOIN symbols s ON s.id = e.to_id WHERE e.kind = 'calls'
  GROUP BY e.to_id ORDER BY n DESC LIMIT 1`).get();
if (busy) {
  q(`blast radius (reverse) of '${busy.name}'`, db.prepare(`
    WITH RECURSIVE blast(id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT e.from_id, blast.depth + 1 FROM blast JOIN edges e ON e.to_id = blast.id
      WHERE blast.depth < 6 AND e.kind IN ('calls','imports','uses')
    )
    SELECT f.path, COUNT(DISTINCT b.id) AS affected, MIN(b.depth) AS depth
    FROM blast b JOIN symbols s ON s.id = b.id JOIN files f ON f.id = s.file_id
    GROUP BY f.path ORDER BY depth, affected DESC LIMIT 10`).all(busy.to_id));
}

// 5. file structure
const someFile = db.prepare("SELECT path FROM files WHERE path LIKE '%.ts' AND path NOT LIKE '%.d.ts' LIMIT 1").get();
if (someFile) {
  q(`file '${someFile.path}'`, db.prepare(`
    SELECT s.name, s.kind, s.qualified, s.line_start FROM symbols s
    JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.kind != 'module' ORDER BY s.line_start LIMIT 15`).all(someFile.path));
}

// 5b. python file + symbols
const pyFile = db.prepare("SELECT path FROM files WHERE language = 'python' AND path LIKE '%/%' LIMIT 1").get();
if (pyFile) {
  q(`python file '${pyFile.path}'`, db.prepare(`
    SELECT s.name, s.kind, s.qualified, s.signature, s.line_start FROM symbols s
    JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.kind != 'module' ORDER BY s.line_start LIMIT 12`).all(pyFile.path));
  const pySym = db.prepare(`SELECT name FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.language = 'python' AND s.kind = 'function' AND s.qualified NOT LIKE '%.%' LIMIT 1`).get();
  if (pySym) {
    q(`bm25 search '${pySym.name}'`, db.prepare(`
      SELECT s.name, s.kind, s.fully_qualified, s.line_start, f.path, round(bm25(syms_fts),2) AS score
      FROM syms_fts JOIN symbols s ON s.id = syms_fts.rowid JOIN files f ON f.id = s.file_id
      WHERE syms_fts MATCH ? ORDER BY score LIMIT 5`).all(pySym.name + "*"));
  }
}

// 6. overview
q("overview (top 8 files)", db.prepare(`
  SELECT f.path, COUNT(s.id) AS symbols FROM files f
  JOIN symbols s ON s.file_id = f.id
  WHERE s.kind NOT IN ('module','variable','const')
  GROUP BY f.id ORDER BY symbols DESC LIMIT 8`).all());

// 7. config entries
q("config entries", db.prepare("SELECT name, kind, value FROM config_entries LIMIT 8").all());

// 8. unresolved imports (external packages)
q("external imports (sample)", db.prepare(`
  SELECT DISTINCT e.to_text, f.path FROM edges e JOIN files f ON f.id = e.file_id
  WHERE e.kind = 'imports' AND e.to_id IS NULL AND e.to_text NOT LIKE '.%' LIMIT 8`).all());

db.close();
console.log("\n=== done ===");
