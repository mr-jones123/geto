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
  from: string;
  to: string | null;
  toText: string;
  line: number;
}

export interface Extraction {
  moduleName: string;
  symbols: RawSymbol[];
  edges: RawEdge[];
  imports: { source: string; line: number }[];
}

const BUILTINS = new Set([
  "str", "int", "float", "bool", "complex", "bytes", "bytearray", "memoryview",
  "list", "dict", "tuple", "set", "frozenset", "range", "slice", "object", "type",
  "None", "NoneType", "Exception", "BaseException", "ValueError", "TypeError",
  "KeyError", "AttributeError", "RuntimeError", "NotImplementedError", "StopIteration",
  "Any", "Optional", "Union", "List", "Dict", "Tuple", "Set", "FrozenSet", "Callable",
  "Iterable", "Iterator", "Generator", "AsyncIterable", "AsyncIterator", "TypeVar",
  "Literal", "ClassVar", "Final", "TypedDict", "Protocol", "Self", "Override",
  "self", "cls", "super", "print", "len", "range", "enumerate", "zip", "map",
  "filter", "sum", "min", "max", "sorted", "reversed", "isinstance", "issubclass",
  "open", "id", "type", "repr", "str", "hash", "getattr", "setattr", "hasattr",
  "property", "classmethod", "staticmethod", "abstractmethod", "dataclass", "field",
  "async", "await", "with", "except", "raise", "assert", "yield", "lambda",
]);

function findChild(n: Node, type: string): Node | null {
  for (const c of n.namedChildren) if (c.type === type) return c;
  return null;
}

const norm = (s: string) => s.replace(/\s+/g, "");

function paramType(p: Node): string {
  for (const c of p.namedChildren) {
    if (c.type === "type") return norm(c.text);
  }
  return "any";
}

function buildSig(fn: Node): { signature: string; sigKey: string } {
  const params = findChild(fn, "parameters");
  const ret = findChild(fn, "type");
  const pTypes = params
    ? params.namedChildren
        .filter((c) => !["list_splat_pattern", "dictionary_splat_pattern"].includes(c.type))
        .map((p) => (p.type === "identifier" ? "any" : paramType(p)))
    : [];
  const retT = ret ? norm(ret.text) : "";
  return {
    signature: params?.text ?? "()",
    sigKey: `(${pTypes.join(",")})${retT ? "->" + retT : ""}`,
  };
}

function docFor(n: Node): string {
  const block = n.namedChildren[n.namedChildren.length - 1];
  if (!block || block.type !== "block") return "";
  const first = block.namedChildren[0];
  if (!first || first.type !== "expression_statement") return "";
  const s = first.namedChildren.find((c) => c.type === "string");
  if (!s) return "";
  return s.text.replace(/^["']{3}|["']{3}$/g, "").trim().slice(0, 200);
}

// scope-qualified name for a declaration node (mirrors extract-ts)
function scopeQualified(n: Node, enclosing: string): string | null {
  switch (n.type) {
    case "function_definition":
    case "class_definition": {
      const id = findChild(n, "identifier");
      return id ? (enclosing ? `${enclosing}.${id.text}` : id.text) : null;
    }
    case "assignment": {
      const left = n.namedChildren.find((c) => c.type === "identifier");
      const right = n.namedChildren.find((c) => c.type === "lambda");
      if (!left || !right) return null;
      return enclosing ? `${enclosing}.${left.text}` : left.text;
    }
    default:
      return null;
  }
}

export function extractPy(source: string, parser: Parser, relPath: string): Extraction {
  const tree = parser.parse(source);
  const moduleName = relPath;
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

  // Pass 1: declarations + imports + inheritance
  function walk(n: Node, enclosing: string, exported: boolean) {
    switch (n.type) {
      case "import_statement": {
        const line = n.startPosition.row + 1;
        for (const c of n.namedChildren) {
          if (c.type === "dotted_name") {
            const src = c.text;
            imports.push({ source: src, line });
            edges.push({ kind: "imports", from: moduleName, to: null, toText: src, line });
          }
        }
        return;
      }
      case "import_from_statement": {
        const line = n.startPosition.row + 1;
        // "from .utils import x" — source is the dotted/relative module
        const srcNode = n.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
        if (srcNode) {
          const src = srcNode.text;
          imports.push({ source: src, line });
          edges.push({ kind: "imports", from: moduleName, to: null, toText: src, line });
        }
        return;
      }
      case "function_definition": {
        const id = findChild(n, "identifier");
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "function", buildSig(n), docFor(n), n, exported);
        const block = findChild(n, "block");
        if (block) walk(block, q, false);
        return;
      }
      case "class_definition": {
        const id = findChild(n, "identifier");
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "class", { signature: "", sigKey: "decl" }, docFor(n), n, exported);
        const sup = findChild(n, "superclasses");
        if (sup) {
          for (const c of sup.namedChildren) {
            if (c.type === "identifier" || c.type === "attribute") {
              edges.push({ kind: "extends", from: q, to: null, toText: c.text, line: c.startPosition.row + 1 });
            }
          }
        }
        const block = findChild(n, "block");
        if (block) walk(block, q, false);
        return;
      }
      case "assignment": {
        const left = n.namedChildren.find((c) => c.type === "identifier");
        const right = n.namedChildren.find((c) => c.type === "lambda");
        if (!left || !right) return;
        const q = enclosing ? `${enclosing}.${left.text}` : left.text;
        const sig = buildSig(right);
        pushSym(left.text, q, "function", sig, "", n, exported);
        return;
      }
      default:
        for (const c of n.namedChildren) walk(c, enclosing, exported);
    }
  }
  // top-level symbols are Python's public API (everything is importable)
  walk(tree.rootNode, "", true);

  // Pass 2: calls + type uses
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
      case "call": {
        const callee = n.namedChildren[0];
        const line = n.startPosition.row + 1;
        if (callee && callee.type === "identifier") {
          const t = resolve(callee.text);
          edges.push({ kind: "calls", from: enclosing, to: t, toText: t ?? callee.text, line });
        } else if (callee && callee.type === "attribute") {
          const obj = callee.child(0)?.text ?? "";
          const prop = callee.lastChild?.text ?? "";
          let target: string | null = null;
          if (obj === "self" || obj === "cls") {
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
      case "type": {
        const tokens = n.text
          .split(/[^A-Za-z0-9_.]/)
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
        const enc = scoped ?? (n.type === "module" ? moduleName : enclosing);
        for (const c of n.namedChildren) walk2(c, enc);
      }
    }
  }
  walk2(tree.rootNode, "", false);

  tree.delete?.();
  return { moduleName, symbols, edges, imports };
}
