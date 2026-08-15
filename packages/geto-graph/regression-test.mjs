import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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
  writeFileSync(join(root, "animal.h"), `
#ifndef ANIMAL_H
#define ANIMAL_H
namespace zoo {
enum class Species { CAT, DOG };
class Animal {
public:
  explicit Animal(Species s);
  Species species() const;
};
Species makeSpecies(int x);
}
#endif
`);
  writeFileSync(join(root, "animal.cpp"), `
#include "animal.h"
#include <vector>
namespace zoo {
Animal::Animal(Species s) {}
Species Animal::species() const { return Species::CAT; }
Species makeSpecies(int x) {
  Animal a(x > 0 ? Species::CAT : Species::DOG);
  return a.species();
}
}
`);

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
  assert.equal(second.skipped, 4);
  assert.equal(second.symbols, 0, "an incremental no-op must report no additions");
  assert.equal(second.edges, 0);
  assert.equal(second.configEntries, 0);
  assert.equal(second.totalSymbols, first.totalSymbols, "persisted totals must survive a no-op");
  assert.equal(second.totalEdges, first.totalEdges);
  assert.equal(second.totalConfigEntries, first.totalConfigEntries);

  const forced = await indexProject(root, { force: true });
  assert.equal(forced.mode, "forced_reindex");
  assert.equal(forced.indexed, 4);

  // C++ extraction: symbols, signatures, scoped names, cross-file includes, calls
  {
    const dbc = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(dbc.prepare("SELECT COUNT(*) n FROM files WHERE language = 'cpp'").get().n, 2,
      "cpp files must be indexed with language 'cpp'");
    const cls = dbc.prepare("SELECT name, kind, qualified FROM symbols WHERE qualified = 'zoo.Animal'").get();
    assert.ok(cls && cls.kind === "class", "class Animal must be extracted with scoped name zoo.Animal");
    assert.ok(dbc.prepare("SELECT 1 FROM symbols WHERE qualified = 'zoo.Species.CAT'").get(),
      "scoped enum members must be extracted");
    assert.ok(dbc.prepare("SELECT 1 FROM symbols WHERE qualified = 'zoo.makeSpecies' AND signature LIKE '%int%'").get(),
      "function signatures must capture parameter types");
    assert.ok(dbc.prepare("SELECT 1 FROM symbols WHERE qualified = 'zoo.Animal.Animal'").get(),
      "out-of-line constructors must land on the header method name");
    assert.ok(dbc.prepare("SELECT 1 FROM symbols WHERE qualified = 'zoo.Animal.species'").get(),
      "out-of-line definitions must match the header qualified name");
    const inc = dbc.prepare(`
      SELECT s.fully_qualified AS target FROM edges e
      JOIN files f ON f.id = e.file_id JOIN symbols s ON s.id = e.to_id
      WHERE f.path = 'animal.cpp' AND e.kind = 'imports' AND e.to_text = 'animal.h'`).get();
    assert.ok(inc, "quoted includes must resolve to the header's module symbol");
    const call = dbc.prepare(`
      SELECT e.to_text FROM edges e JOIN files f ON f.id = e.file_id
      WHERE f.path = 'animal.cpp' AND e.kind = 'calls' AND e.to_text LIKE '%species%'`).get();
    assert.ok(call, "member calls must be extracted");
    dbc.close();
  }

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

  // indexing errors must be logged so an agent can read them, and cleared on recovery
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    const bad = join(root, "broken.ts");
    writeFileSync(bad, "export const fine = 1;\n");
    chmodSync(bad, 0o000);
    try {
      const withErr = await indexProject(root);
      assert.ok(withErr.totalParseErrors >= 0);
      const dbe = new DatabaseSync(dbPath, { readOnly: true });
      const errRows = dbe.prepare("SELECT file, message FROM index_errors").all();
      dbe.close();
      assert.ok(errRows.some((r) => r.file === "broken.ts" && String(r.message).startsWith("cannot read file")),
        "unreadable file must be logged in index_errors");
    } finally {
      chmodSync(bad, 0o644);
    }
    await indexProject(root, { force: true });
    const dbe2 = new DatabaseSync(dbPath, { readOnly: true });
    const errRows2 = dbe2.prepare("SELECT file FROM index_errors").all();
    dbe2.close();
    assert.ok(!errRows2.some((r) => r.file === "broken.ts"), "successful reindex must clear the file's error");
  }

  console.log("geto-graph regression checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
