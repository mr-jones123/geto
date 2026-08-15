import { Parser, Language } from "web-tree-sitter";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = typeof __dirname !== "undefined" && __dirname ? __dirname : fileURLToPath(new URL(".", import.meta.url));
const WASM_CANDIDATES = [
  join(HERE, "..", "wasm"),   // src/../wasm (normal install)
  join(HERE, "wasm"),          // node -e / cjs shim contexts
  join(process.cwd(), "wasm"),
  join(process.cwd(), "geto-graph", "wasm"),
];
const WASM_DIR = WASM_CANDIDATES.find((p) => existsSync(p)) ?? join(HERE, "..", "wasm");

const GRAMMARS = {
  ts:   { wasm: "tree-sitter-typescript.wasm" },
  tsx:  { wasm: "tree-sitter-tsx.wasm" },
  python: { wasm: "tree-sitter-python.wasm" },
  yaml: { wasm: "tree-sitter-yaml.wasm" },
  cpp:  { wasm: "tree-sitter-cpp.wasm" },
} as const;

export type GrammarId = keyof typeof GRAMMARS;

let inited = false;
const cache = new Map<GrammarId, Parser>();

export async function getParser(id: GrammarId): Promise<Parser> {
  if (!cache.has(id)) {
    if (!inited) {
      await Parser.init();
      inited = true;
    }
    const g = GRAMMARS[id];
    const lang = await Language.load(readFileSync(join(WASM_DIR, g.wasm)));
    const p = new Parser();
    p.setLanguage(lang);
    cache.set(id, p);
  }
  return cache.get(id)!;
}
