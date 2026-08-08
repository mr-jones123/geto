import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = "1";

export function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true }); // DB dir may not exist yet
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id        INTEGER PRIMARY KEY,
  path      TEXT NOT NULL UNIQUE,
  language  TEXT NOT NULL,
  mtime     INTEGER NOT NULL,
  size      INTEGER NOT NULL,
  hash      TEXT,
  status    TEXT NOT NULL DEFAULT 'indexed',
  reason    TEXT,
  indexed_at INTEGER
);

CREATE TABLE IF NOT EXISTS symbols (
  id              INTEGER PRIMARY KEY,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  qualified       TEXT NOT NULL,
  fully_qualified TEXT NOT NULL,
  kind            TEXT NOT NULL,
  signature       TEXT,
  sig_key         TEXT NOT NULL,
  doc             TEXT,
  line_start      INTEGER NOT NULL,
  line_end        INTEGER,
  col_start       INTEGER,
  is_exported     INTEGER NOT NULL DEFAULT 0,
  is_local        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (file_id, qualified, sig_key)
);
CREATE INDEX IF NOT EXISTS idx_symbols_name      ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified);
CREATE INDEX IF NOT EXISTS idx_symbols_file      ON symbols(file_id, line_start);
CREATE INDEX IF NOT EXISTS idx_symbols_exported  ON symbols(file_id) WHERE is_exported = 1;

CREATE TABLE IF NOT EXISTS edges (
  id        INTEGER PRIMARY KEY,
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  from_id   INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  from_text TEXT,
  kind      TEXT NOT NULL,
  to_id     INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  to_text   TEXT,
  line      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_file ON edges(file_id);
CREATE INDEX IF NOT EXISTS idx_edges_text ON edges(to_text) WHERE to_id IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS syms_fts USING fts5(
  name, qualified, signature, doc,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS config_entries (
  id      INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  value   TEXT,
  line    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_config_file ON config_entries(file_id);
`);
  return db;
}

export function rebuildFts(db: DatabaseSync) {
  db.exec("DELETE FROM syms_fts");
  db.exec(`
    INSERT INTO syms_fts (rowid, name, qualified, signature, doc)
    SELECT id, name, qualified, signature, doc FROM symbols
    WHERE kind NOT IN ('module','variable','const')
  `);
}

export function readMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function writeMeta(db: DatabaseSync, key: string, value: string) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
