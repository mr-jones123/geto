export interface ConfigEntry {
  name: string;
  kind: string;
  value: string | null;
  line: number;
}

// YAML: structural key-path scanner (indentation-based). No semantics, never
// chokes on anchors/aliases/tags — we only want "services.web.image" keys.
export function scanYaml(source: string): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  const stack: { key: string; indent: number }[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // skip list items, block scalars, flow sequences
    if (/^[-|>&?]/.test(trimmed) || trimmed.startsWith("[")) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = trimmed.match(/^(["']?)([\w.-]+)\1:(?:\s*(.*))?$/);
    if (!m) continue;
    // strip trailing comment
    const value = m[2]?.replace(/\s+#.*$/, "") ?? null;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ key: m[2], indent });
    out.push({ name: stack.map((s) => s.key).join("."), kind: "yaml:key", value: value || null, line: i + 1 });
  }
  return out;
}

// Dockerfile: rigid INSTRUCTION args lines — regex is 100% reliable.
export function scanDockerfile(source: string): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z][A-Z0-9]*)\s+(.*)$/);
    if (!m) continue;
    const value = m[2].slice(0, 300);
    out.push({ name: `${m[1]} ${value.slice(0, 80)}`, kind: `docker:${m[1].toLowerCase()}`, value, line: i + 1 });
  }
  return out;
}
