// Downloads tree-sitter grammar .wasm files into ./wasm.
// Run once at setup:  node scripts/download-grammars.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(HERE, "..", "wasm");
mkdirSync(WASM_DIR, { recursive: true });

// repo -> asset names. Latest release of each is fetched.
const GRAMMARS = [
  { repo: "tree-sitter/tree-sitter-typescript", assets: ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"] },
  { repo: "tree-sitter/tree-sitter-python", assets: ["tree-sitter-python.wasm"] },
  { repo: "tree-sitter-grammars/tree-sitter-yaml", assets: ["tree-sitter-yaml.wasm"] },
];

for (const g of GRAMMARS) {
  const api = `https://api.github.com/repos/${g.repo}/releases/latest`;
  const res = await fetch(api, { headers: { "User-Agent": "geto-graph" } });
  if (!res.ok) { console.error(`!! ${g.repo}: ${res.status} ${res.statusText}`); continue; }
  const release = await res.json();
  console.log(`${g.repo} @ ${release.tag_name}`);
  for (const asset of release.assets ?? []) {
    if (!g.assets.includes(asset.name)) continue;
    const r = await fetch(asset.browser_download_url);
    if (!r.ok) { console.error(`!! download failed: ${asset.name}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(join(WASM_DIR, asset.name), buf);
    console.log(`  wrote ${asset.name} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
  }
}
console.log("done.");
