import type { Node, Parser } from "web-tree-sitter";

export interface RawSymbol {
  name: string;
  qualified: string;
  kind: string;
  signature: string;
  sigKey: string;
  doc: string;
  lineStart: number;
  lineEnd: number;
  colStart: number;
  isExported: boolean;
}

export interface RawEdge {
  kind: "imports" | "calls" | "extends" | "implements" | "uses";
  from: string;        // qualified name of enclosing symbol, or module name
  to: string | null;   // same-file qualified target, null if unresolved
  toText: string;      // always set: qualified name if resolved, else raw text
  line: number;
}

export interface Extraction {
  moduleName: string;
  symbols: RawSymbol[];
  edges: RawEdge[];
  imports: { source: string; line: number }[];
}

const BUILTINS = new Set([
  "string", "number", "boolean", "void", "any", "unknown", "never", "undefined", "null",
  "true", "false", "this", "Promise", "Array", "Record", "Map", "Set", "Date", "Error",
  "Object", "Function", "RegExp", "Buffer", "globalThis", "NodeJS", "Readable", "Writable",
  "JSON", "Math", "Symbol", "BigInt", "Iterable", "Iterator", "AsyncIterable", "Partial",
  "Required", "Pick", "Omit", "Exclude", "Extract", "Readonly", "ReturnType", "Parameters",
]);

const DECL_TYPES = new Set([
  "function_declaration", "class_declaration", "abstract_class_declaration",
  "interface_declaration", "type_alias_declaration", "enum_declaration",
  "lexical_declaration", "internal_module",
]);

function findChild(n: Node, type: string): Node | null {
  for (const c of n.namedChildren) if (c.type === type) return c;
  return null;
}

const norm = (s: string) => s.replace(/\s+/g, "");

function buildSig(fn: Node): { signature: string; sigKey: string } {
  const params = findChild(fn, "parameters");
  const ret = findChild(fn, "type_annotation");
  const pTypes = params
    ? params.namedChildren.map((p) => {
        const ta = findChild(p, "type_annotation");
        return ta ? norm(ta.text.replace(/^:/, "")) : "any";
      })
    : [];
  const retT = ret ? norm(ret.text.replace(/^:/, "")) : "";
  return {
    signature: params?.text ?? "()",
    sigKey: `(${pTypes.join(",")})${retT ? "->" + retT : ""}`,
  };
}

function docFor(n: Node): string {
  let doc = "";
  let prev = n.previousSibling;
  while (prev && prev.type === "comment") {
    doc = prev.text + "\n" + doc;
    prev = prev.previousSibling;
  }
  if (!doc && n.parent && n.parent.type === "export_statement") {
    let p = n.parent.previousSibling;
    while (p && p.type === "comment") {
      doc = p.text + "\n" + doc;
      p = p.previousSibling;
    }
  }
  return doc.trim().slice(0, 200);
}

function scopeQualified(n: Node, enclosing: string): string | null {
  switch (n.type) {
    case "function_declaration": {
      const id = findChild(n, "identifier");
      return id ? (enclosing ? `${enclosing}.${id.text}` : id.text) : null;
    }
    case "method_definition": {
      const id = findChild(n, "property_identifier");
      return id ? `${enclosing}.${id.text}` : null;
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const id = findChild(n, "identifier");
      return id ? (enclosing ? `${enclosing}.${id.text}` : id.text) : null;
    }
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration": {
      const id = findChild(n, "identifier");
      return id ? (enclosing ? `${enclosing}.${id.text}` : id.text) : null;
    }
    case "lexical_declaration": {
      const d = n.namedChildren.find((c) => c.type === "variable_declarator");
      if (!d) return null;
      const id = findChild(d, "identifier");
      const value = findChild(d, "arrow_function") ?? findChild(d, "function_expression");
      if (!id || !value) return null;
      return enclosing ? `${enclosing}.${id.text}` : id.text;
    }
    default:
      return null;
  }
}

export function extractTs(source: string, parser: Parser, relPath: string): Extraction {
  const tree = parser.parse(source);
  const moduleName = relPath; // the module symbol is identified by its file path
  const symbols: RawSymbol[] = [];
  const edges: RawEdge[] = [];
  const imports: { source: string; line: number }[] = [];

  const pushSym = (name: string, qualified: string, kind: string, sig: { signature: string; sigKey: string }, doc: string, n: Node, isExported: boolean) => {
    symbols.push({
      name, qualified, kind,
      signature: sig.signature, sigKey: sig.sigKey, doc,
      lineStart: n.startPosition.row + 1, lineEnd: n.endPosition.row + 1,
      colStart: n.startPosition.column + 1, isExported,
    });
  };

  // Pass 1: collect declarations + imports + heritage edges
  function walk(n: Node, enclosing: string, exported: boolean) {
    switch (n.type) {
      case "import_statement": {
        const strs = n.children.filter((c) => c.type === "string");
        const src = strs.length ? strs[strs.length - 1].text.replace(/['"]/g, "") : "";
        const line = n.startPosition.row + 1;
        imports.push({ source: src, line });
        edges.push({ kind: "imports", from: moduleName, to: null, toText: src, line });
        return;
      }
      case "export_statement": {
        const decl = n.namedChildren.find((c) => DECL_TYPES.has(c.type));
        if (decl) walk(decl, enclosing, true);
        return;
      }
      case "function_declaration": {
        const id = findChild(n, "identifier");
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "function", buildSig(n), docFor(n), n, exported);
        const body = findChild(n, "statement_block");
        if (body) walk(body, q, false);
        return;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const id = findChild(n, "identifier");
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "class", { signature: "", sigKey: "decl" }, docFor(n), n, exported);
        const h = findChild(n, "class_heritage");
        if (h) {
          let mode: "extends" | "implements" | null = null;
          for (const c of h.children) {
            if (c.type === "extends" || c.type === "implements") { mode = c.type as "extends" | "implements"; continue; }
            if (mode && c.isNamed && c.type !== "list") {
              edges.push({ kind: mode, from: q, to: null, toText: c.text, line: c.startPosition.row + 1 });
            }
          }
        }
        const body = findChild(n, "class_body");
        if (body) walk(body, q, false);
        return;
      }
      case "method_definition": {
        const id = findChild(n, "property_identifier");
        if (!id) return;
        const q = `${enclosing}.${id.text}`;
        pushSym(id.text, q, "method", buildSig(n), docFor(n), n, exported);
        const body = findChild(n, "statement_block");
        if (body) walk(body, q, false);
        return;
      }
      case "interface_declaration": {
        const id = findChild(n, "identifier");
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "interface", { signature: "", sigKey: "decl" }, docFor(n), n, exported);
        const ext = findChild(n, "extends_type_clause");
        if (ext) for (const c of ext.namedChildren) edges.push({ kind: "extends", from: q, to: null, toText: c.text, line: c.startPosition.row + 1 });
        return;
      }
      case "type_alias_declaration": {
        const id = findChild(n, "identifier");
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "type", { signature: "", sigKey: "decl" }, docFor(n), n, exported);
        return;
      }
      case "enum_declaration": {
        const id = findChild(n, "identifier");
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "enum", { signature: "", sigKey: "decl" }, docFor(n), n, exported);
        return;
      }
      case "lexical_declaration": {
        for (const d of n.namedChildren) {
          if (d.type !== "variable_declarator") continue;
          const nameNode = findChild(d, "identifier");
          if (!nameNode) continue;
          const value = findChild(d, "arrow_function") ?? findChild(d, "function_expression");
          if (!value) continue; // plain consts are not callable symbols — skip (avoids clashes + noise)
          const kind = "function";
          const q = enclosing ? `${enclosing}.${nameNode.text}` : nameNode.text;
          const sig = buildSig(value);
          pushSym(nameNode.text, q, kind, sig, docFor(d), d, exported);
          const body = findChild(value, "statement_block");
          if (body) walk(body, q, false);
        }
        return;
      }
      default:
        for (const c of n.namedChildren) walk(c, enclosing, exported);
    }
  }
  walk(tree.rootNode, "", false);

  // Pass 2: calls + type uses, attributed to enclosing symbol
  const nameMap = new Map<string, string>();
  for (const s of symbols) {
    if (s.kind !== "module" && !nameMap.has(s.name)) nameMap.set(s.name, s.qualified);
  }
  const resolve = (name: string) => nameMap.get(name) ?? null;
  const enclosingClass = (q: string) => {
    const first = q.split(".")[0];
    return symbols.some((s) => s.qualified === first && s.kind === "class") ? first : null;
  };

  function walk2(n: Node, enclosing: string) {
    switch (n.type) {
      case "call_expression": {
        const callee = n.namedChildren[0];
        const line = n.startPosition.row + 1;
        if (callee && callee.type === "identifier") {
          const t = resolve(callee.text);
          edges.push({ kind: "calls", from: enclosing, to: t, toText: t ?? callee.text, line });
        } else if (callee && callee.type === "member_expression") {
          const obj = callee.child(0)?.text ?? "";
          const prop = callee.lastChild?.text ?? "";
          let target: string | null = null;
          if (obj === "this") {
            const cls = enclosingClass(enclosing);
            if (cls) target = resolve(cls + "." + prop) ?? resolve(prop);
          } else {
            target = resolve(obj + "." + prop);
          }
          edges.push({ kind: "calls", from: enclosing, to: target, toText: target ?? callee.text, line });
        } else {
          edges.push({ kind: "calls", from: enclosing, to: null, toText: callee?.text ?? "?", line });
        }
        for (const c of n.namedChildren) walk2(c, enclosing);
        return;
      }
      case "new_expression": {
        const callee = n.namedChildren[0];
        const line = n.startPosition.row + 1;
        const t = callee ? resolve(callee.text) : null;
        edges.push({ kind: "calls", from: enclosing, to: t, toText: t ?? callee?.text ?? "?", line });
        for (const c of n.namedChildren) walk2(c, enclosing);
        return;
      }
      case "type_annotation": {
        const tokens = n.text
          .replace(/^:/, "")
          .split(/[^A-Za-z0-9_$.]/)
          .filter((t) => t.length > 1 && !BUILTINS.has(t));
        const line = n.startPosition.row + 1;
        for (const tok of tokens) {
          const t = resolve(tok);
          if (t) edges.push({ kind: "uses", from: enclosing, to: t, toText: t, line });
          else if (tok.includes(".")) edges.push({ kind: "uses", from: enclosing, to: null, toText: tok, line });
        }
        return;
      }
      default: {
        const scoped = scopeQualified(n, enclosing);
        const enc = scoped ?? (n.type === "program" ? moduleName : enclosing);
        for (const c of n.namedChildren) walk2(c, enc);
      }
    }
  }
  walk2(tree.rootNode, "", false);

  tree.delete?.();
  return { moduleName, symbols, edges, imports };
}
