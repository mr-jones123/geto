import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { indexProject, DB_DIR, DB_FILE } from "./indexer.ts";
import { openDb } from "./db.ts";

export function registerCommand(pi: ExtensionAPI) {
  pi.registerCommand("codegraph", {
    description: "Rebuild or inspect the codebase symbol index. Usage: /codegraph reindex [--force] [path], /codegraph status",
    getArgumentCompletions(prefix: string) {
      const opts = ["reindex", "reindex --force", "status"];
      return opts.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = parts[0] ?? "status";
      if (cmd === "status") {
        const dbPath = join(ctx.cwd, DB_DIR, DB_FILE);
        const db = openDb(dbPath);
        const t = db.prepare("SELECT (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM symbols) AS symbols, (SELECT COUNT(*) FROM edges) AS edges, (SELECT value FROM meta WHERE key='indexed_at') AS at, (SELECT value FROM meta WHERE key='root') AS root").get() as { files: number; symbols: number; edges: number; at: string | null; root: string | null };
        db.close();
        ctx.ui.notify(`codegraph: ${t.root ?? "(not indexed)"} — ${t.files} files, ${t.symbols} symbols, ${t.edges} edges${t.at ? ` (indexed ${new Date(Number(t.at)).toISOString()})` : ""}`, "info");
        return;
      }
      if (cmd === "reindex") {
        const force = parts.includes("--force");
        const root = parts.find((p) => !p.startsWith("-") && p !== "reindex") ?? ctx.cwd;
        const t0 = Date.now();
        ctx.ui.setStatus("codegraph", force ? `Reindexing ${root} (force)...` : `Incrementally reindexing ${root}...`);
        try {
          const s = await indexProject(root, { force });
          const dbPath = join(s.root, DB_DIR, DB_FILE);
          const db = openDb(dbPath);
          const fresh = db.prepare("SELECT value FROM meta WHERE key='indexed_at'").get() as { value: string };
          db.close();
          ctx.ui.setStatus("codegraph", "");
          ctx.ui.notify(
            `codegraph: ${s.indexed} indexed, ${s.skipped} up-to-date, ${s.removed} removed, ${s.parseErrors} errors — ${s.filesFound} files, ${s.symbols} symbols, ${s.edges} edges (${s.durationMs}ms)`,
            "info",
          );
        } catch (err) {
          ctx.ui.setStatus("codegraph", "");
          ctx.ui.notify(`codegraph reindex failed: ${String(err).slice(0, 300)}`, "error");
        }
        return;
      }
      ctx.ui.notify("codegraph: unknown subcommand. Use 'reindex [--force] [path]' or 'status'.", "info");
    },
  });
}
