import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexProject } from "./src/indexer.ts";

const root = mkdtempSync(join(tmpdir(), "geto-graph-regression-"));
const dbPath = join(root, ".geto-graph", "index.db");

try {
  writeFileSync(join(root, "duplicate.ts"), `
export function suite() {
  { const handler = () => 1; handler(); }
  { const handler = () => 2; handler(); }
}
`);
  writeFileSync(join(root, "config.yml"), "services:\n  web:\n    image: test\n");

  const first = await indexProject(root);
  assert.equal(first.mode, "initial_index");
  assert.equal(first.parseErrors, 0, "duplicate graph names must not reject a file");
  assert.equal(first.totalParseErrors, 0);
  assert.ok(first.totalSymbols > 0);
  assert.ok(first.totalEdges > 0);
  assert.ok(first.totalConfigEntries > 0);

  const second = await indexProject(root);
  assert.equal(second.mode, "incremental_reindex");
  assert.equal(second.indexed, 0);
  assert.equal(second.skipped, 2);
  assert.equal(second.symbols, 0, "an incremental no-op must report no additions");
  assert.equal(second.edges, 0);
  assert.equal(second.configEntries, 0);
  assert.equal(second.totalSymbols, first.totalSymbols, "persisted totals must survive a no-op");
  assert.equal(second.totalEdges, first.totalEdges);
  assert.equal(second.totalConfigEntries, first.totalConfigEntries);

  const forced = await indexProject(root, { force: true });
  assert.equal(forced.mode, "forced_reindex");
  assert.equal(forced.indexed, 2);

  let db = new DatabaseSync(dbPath);
  db.prepare("UPDATE files SET hash = NULL WHERE path = 'duplicate.ts'").run();
  db.close();

  const previousCwd = process.cwd();
  process.chdir(tmpdir());
  await indexProject(root);
  process.chdir(previousCwd);

  db = new DatabaseSync(dbPath, { readOnly: true });
  const file = db.prepare("SELECT hash FROM files WHERE path = 'duplicate.ts'").get();
  const meta = Object.fromEntries(
    db.prepare("SELECT key, value FROM meta WHERE key IN ('symbol_count', 'edge_count')")
      .all()
      .map((row) => [row.key, Number(row.value)]),
  );
  const totals = db.prepare(`SELECT
    (SELECT COUNT(*) FROM symbols) AS symbols,
    (SELECT COUNT(*) FROM edges) AS edges
  `).get();
  db.close();

  assert.ok(file.hash, "hash backfill must resolve paths against the indexed root");
  assert.equal(meta.symbol_count, totals.symbols, "metadata must store persisted totals");
  assert.equal(meta.edge_count, totals.edges);

  console.log("geto-graph regression checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
