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

const DOC_LIMIT = 200;

function findChild(n: Node, type: string): Node | null {
  for (const c of n.namedChildren) if (c.type === type) return c;
  return null;
}

const norm = (s: string) => s.replace(/\s+/g, "");

// ---- declarator name handling -------------------------------------------------

interface DeclName {
  name: string;      // simple name: doThing, ~Base, operator+=
  prefix: string[];  // namespace path from a qualified name (Foo::doThing -> ["Foo"])
  node: Node;
}

function declaratorName(fd: Node): DeclName | null {
  const children = fd.namedChildren;
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i];
    const prefix = children.slice(0, i).filter((x) => x.type === "namespace_identifier").map((x) => x.text);
    if (c.type === "identifier" || c.type === "field_identifier") {
      return { name: c.text, prefix, node: c };
    }
    if (c.type === "destructor_name") {
      const inner = findChild(c, "identifier");
      return { name: "~" + (inner?.text ?? ""), prefix, node: inner ?? c };
    }
    if (c.type === "operator_name") {
      return { name: c.text.replace(/\s+/g, ""), prefix, node: c };
    }
    if (c.type === "qualified_identifier") {
      const segs: string[] = [];
      for (const sc of c.namedChildren) {
        if (sc.type === "namespace_identifier") segs.push(sc.text);
        else if (sc.type === "identifier" || sc.type === "field_identifier") return { name: sc.text, prefix: segs, node: sc };
        else if (sc.type === "destructor_name") {
          const inner = findChild(sc, "identifier");
          return { name: "~" + (inner?.text ?? ""), prefix: segs, node: inner ?? sc };
        } else if (sc.type === "operator_name") {
          return { name: sc.text.replace(/\s+/g, ""), prefix: segs, node: sc };
        } else if (sc.type === "template_function") {
          const id = findChild(sc, "identifier");
          if (id) return { name: id.text, prefix: segs, node: id };
        }
      }
    }
  }
  return null;
}

// "Sexy::Foo::doThing" at file scope -> "Sexy.Foo.doThing"; a partial
// "Foo::doThing" inside `namespace Sexy` also -> "Sexy.Foo.doThing" so the
// out-of-line definition lands on the same graph node as the header method.
function qualifyName(dn: DeclName, enclosing: string): string {
  if (dn.prefix.length) {
    const first = dn.prefix[0];
    const encFirst = enclosing.split(".")[0];
    if (enclosing && encFirst !== first) {
      return `${enclosing}.${dn.prefix.join(".")}.${dn.name}`;
    }
    return `${dn.prefix.join(".")}.${dn.name}`;
  }
  return enclosing ? `${enclosing}.${dn.name}` : dn.name;
}

// collect namespace path from `namespace A::B { ... }` (["A","B"])
function namespaceName(n: Node): string[] {
  const out: string[] = [];
  const walk = (nd: Node) => {
    for (const c of nd.namedChildren) {
      if (c.type === "namespace_identifier") out.push(c.text);
      else walk(c);
    }
  };
  walk(n);
  return out;
}

// ---- signatures ---------------------------------------------------------------

function paramType(p: Node): string {
  if (p.type !== "parameter_declaration") return norm(p.text);
  const named = p.namedChildren;
  const last = named[named.length - 1];
  let t = p.text;
  const rel = (idx: number) => idx - p.startIndex;
  if (last && (last.type === "identifier" || last.type === "field_identifier")) {
    t = p.text.slice(0, rel(last.startIndex)) + p.text.slice(rel(last.endIndex));
  } else if (last && (last.type === "reference_declarator" || last.type === "pointer_declarator")) {
    const inner = last.namedChildren.find((c) => c.type === "identifier" || c.type === "field_identifier");
    if (inner) t = p.text.slice(0, rel(inner.startIndex)) + p.text.slice(rel(inner.endIndex));
  }
  return norm(t);
}

function buildSig(fd: Node): { signature: string; sigKey: string } {
  const params = findChild(fd, "parameter_list");
  const pTypes = params ? params.namedChildren.map(paramType) : [];
  let key = `(${pTypes.join(",")})`;
  if (fd.namedChildren.some((c) => c.type === "type_qualifier" && c.text === "const")) key += " const";
  return { signature: params?.text ?? "()", sigKey: key };
}

function docFor(n: Node): string {
  let doc = "";
  let prev = n.previousSibling;
  while (prev && prev.type === "comment") {
    doc = prev.text + "\n" + doc;
    prev = prev.previousSibling;
  }
  return doc.trim().slice(0, DOC_LIMIT);
}

// Is this type_identifier the *name* of its declaration (not a type use)?
function isNamePosition(n: Node): boolean {
  const p = n.parent;
  if (!p) return false;
  switch (p.type) {
    case "class_specifier":
    case "struct_specifier":
    case "union_specifier":
    case "enum_specifier":
    case "alias_declaration":
      return p.namedChildren[0] === n; // name is the first type-ish child
    case "type_definition":
      return p.namedChildren[p.namedChildren.length - 1] === n; // typedef name is last
    case "type_parameter_declaration":
    case "base_class_clause":
      return true;
    default:
      return false;
  }
}

export function extractCpp(source: string, parser: Parser, relPath: string): Extraction {
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

  // Pass 1: declarations + includes + heritage. `inBody` marks function bodies
  // where local declarations are never emitted as symbols.
  function walk(n: Node, enclosing: string, exported: boolean, inBody: boolean) {
    switch (n.type) {
      case "preproc_include": {
        const line = n.startPosition.row + 1;
        let src = "";
        const sl = findChild(n, "string_literal");
        if (sl) {
          const sc = findChild(sl, "string_content");
          src = sc?.text ?? sl.text.replace(/["']/g, "");
        } else {
          const sys = findChild(n, "system_lib_string");
          if (sys) src = sys.text; // keep `<vector>` so the indexer can tell angle includes
        }
        if (src) {
          imports.push({ source: src, line });
          edges.push({ kind: "imports", from: moduleName, to: null, toText: src, line });
        }
        return;
      }
      case "preproc_def":
      case "preproc_function_def": {
        const id = findChild(n, "identifier");
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "macro", { signature: "", sigKey: "decl" }, "", n, exported);
        return;
      }
      case "namespace_definition": {
        const ids = namespaceName(n);
        const body = findChild(n, "declaration_list");
        if (!ids.length) {
          // anonymous namespace: members are TU-local, stay in the enclosing scope
          if (body) for (const c of body.namedChildren) walk(c, enclosing, false, inBody);
          return;
        }
        const ns = ids.join(".");
        const q = enclosing ? `${enclosing}.${ns}` : ns;
        pushSym(ns, q, "namespace", { signature: "", sigKey: "decl" }, "", n, exported);
        if (body) for (const c of body.namedChildren) walk(c, q, exported, inBody);
        return;
      }
      case "template_declaration":
      case "linkage_specification": {
        for (const c of n.namedChildren) walk(c, enclosing, exported, inBody);
        return;
      }
      case "class_specifier":
      case "struct_specifier":
      case "union_specifier": {
        const id = findChild(n, "type_identifier");
        if (!id) return; // anonymous struct/union
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "class", { signature: "", sigKey: "decl" }, docFor(n), n, exported);
        const base = findChild(n, "base_class_clause");
        if (base) {
          for (const c of base.namedChildren) {
            if (c.type === "type_identifier" || c.type === "qualified_identifier" || c.type === "template_type") {
              edges.push({ kind: "extends", from: q, to: null, toText: c.text, line: c.startPosition.row + 1 });
            }
          }
        }
        const body = findChild(n, "field_declaration_list");
        if (body) {
          for (const c of body.namedChildren) {
            if (c.type === "friend_declaration") {
              // friends belong to the enclosing (non-class) scope
              for (const fc of c.namedChildren) walk(fc, enclosing, exported, inBody);
            } else {
              walk(c, q, false, inBody);
            }
          }
        }
        return;
      }
      case "enum_specifier": {
        const id = findChild(n, "type_identifier");
        if (!id) return; // anonymous enum
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "enum", { signature: "", sigKey: "decl" }, docFor(n), n, exported);
        const list = findChild(n, "enumerator_list");
        if (list) {
          for (const e of list.namedChildren) {
            if (e.type !== "enumerator") continue;
            const ei = findChild(e, "identifier");
            if (!ei) continue;
            pushSym(ei.text, `${q}.${ei.text}`, "enum_member", { signature: "", sigKey: "decl" }, "", e, false);
          }
        }
        return;
      }
      case "type_definition": {
        // typedef X Y; — the name is the LAST type_identifier
        const tids = n.namedChildren.filter((c) => c.type === "type_identifier");
        const id = tids[tids.length - 1];
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "type", { signature: "", sigKey: "decl" }, docFor(n), n, exported);
        return;
      }
      case "alias_declaration": {
        const id = findChild(n, "type_identifier");
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "type", { signature: "", sigKey: "decl" }, docFor(n), n, exported);
        return;
      }
      case "concept_definition": {
        const id = findChild(n, "identifier");
        if (!id) return;
        const q = enclosing ? `${enclosing}.${id.text}` : id.text;
        pushSym(id.text, q, "concept", { signature: "", sigKey: "decl" }, docFor(n), n, exported);
        return;
      }
      case "function_definition": {
        const fd = findChild(n, "function_declarator");
        if (!fd) return;
        const dn = declaratorName(fd);
        if (!dn) return;
        const q = qualifyName(dn, enclosing);
        const inClass = n.parent?.type === "field_declaration_list";
        pushSym(dn.name, q, inClass ? "method" : "function", buildSig(fd), docFor(n), n, inClass ? false : exported);
        const body = findChild(n, "compound_statement");
        if (body) walk(body, q, false, true);
        return;
      }
      case "declaration": {
        const fd = findChild(n, "function_declarator");
        if (fd) {
          // prototype (or in-class constructor/destructor)
          const dn = declaratorName(fd);
          if (dn) {
            const q = qualifyName(dn, enclosing);
            const inClass = n.parent?.type === "field_declaration_list";
            pushSym(dn.name, q, inClass ? "method" : "function", buildSig(fd), docFor(n), n, inClass ? false : exported);
          }
          return;
        }
        // plain variable declaration — emit only at namespace scope
        if (inBody) return;
        const names: string[] = [];
        const findDeclared = (x: Node): string | null => {
          if (x.type === "identifier" || x.type === "field_identifier") return x.text;
          for (const c of x.namedChildren) {
            const r = findDeclared(c);
            if (r) return r;
          }
          return null;
        };
        for (const c of n.namedChildren) {
          if (c.type === "identifier") names.push(c.text);
          else if (c.type === "init_declarator") {
            if (findChild(c, "lambda_expression")) continue; // lambdas are not symbols
            const id = findDeclared(c);
            if (id) names.push(id);
          }
        }
        for (const nm of names) {
          const q = enclosing ? `${enclosing}.${nm}` : nm;
          pushSym(nm, q, "variable", { signature: "", sigKey: "decl" }, "", n, exported);
        }
        return;
      }
      case "field_declaration": {
        const fd = findChild(n, "function_declarator");
        if (!fd) return; // data members are noise
        const dn = declaratorName(fd);
        if (!dn) return;
        const q = qualifyName(dn, enclosing);
        pushSym(dn.name, q, "method", buildSig(fd), docFor(n), n, false);
        return;
      }
      default:
        for (const c of n.namedChildren) walk(c, enclosing, exported, inBody);
    }
  }
  walk(tree.rootNode, "", true, false);

  // Pass 2: calls + type uses, attributed to the enclosing symbol
  const nameMap = new Map<string, string>();
  for (const s of symbols) {
    if (s.kind !== "module" && !nameMap.has(s.name)) nameMap.set(s.name, s.qualified);
  }
  const resolve = (name: string) => nameMap.get(name) ?? null;
  const classAncestor = (q: string): string | null => {
    const parts = q.split(".");
    for (let i = parts.length; i >= 1; i--) {
      const cand = parts.slice(0, i).join(".");
      if (symbols.some((s) => s.qualified === cand && s.kind === "class")) return cand;
    }
    return null;
  };

  function walk2(n: Node, enclosing: string) {
    switch (n.type) {
      case "call_expression": {
        const callee = n.namedChildren[0];
        const line = n.startPosition.row + 1;
        let target: string | null = null;
        const text = callee?.text ?? "?";
        if (callee) {
          if (callee.type === "identifier") {
            target = resolve(callee.text);
          } else if (callee.type === "field_expression") {
            const obj = callee.child(0)?.text ?? "";
            const prop = callee.lastChild?.text ?? "";
            if (obj === "this") {
              const cls = classAncestor(enclosing);
              if (cls) target = resolve(cls + "." + prop) ?? resolve(prop);
            } else {
              target = resolve(obj + "." + prop);
            }
          } else if (callee.type === "qualified_identifier" || callee.type === "template_function") {
            const seg = lastSegmentName(callee);
            if (seg) target = resolve(seg);
          }
        }
        edges.push({ kind: "calls", from: enclosing, to: target, toText: target ?? text, line });
        // recurse into arguments only — the callee is handled above
        for (const c of n.namedChildren) {
          if (c === callee) continue;
          walk2(c, enclosing);
        }
        return;
      }
      case "declaration": {
        const fd = findChild(n, "function_declarator");
        const dn = fd ? declaratorName(fd) : null;
        const enc = dn ? qualifyName(dn, enclosing) : enclosing;
        if (!fd) {
          // construction: `Foo f(3)` is a call on the declared type
          for (const c of n.namedChildren) {
            if (c.type !== "init_declarator") continue;
            if (!findChild(c, "argument_list") || findChild(c, "lambda_expression")) continue;
            const tNode = n.namedChildren.find((x) =>
              x.type === "type_identifier" || x.type === "qualified_identifier" || x.type === "template_type");
            if (!tNode) continue;
            const last = tNode.type === "qualified_identifier" ? tNode.namedChildren[tNode.namedChildren.length - 1] : tNode;
            const id = last.type === "template_type" ? findChild(last, "type_identifier") : last.type === "type_identifier" ? last : null;
            if (!id) continue;
            const t = resolve(id.text);
            if (t) edges.push({ kind: "calls", from: enclosing, to: t, toText: t, line: c.startPosition.row + 1 });
          }
        }
        for (const c of n.namedChildren) walk2(c, enc);
        return;
      }
      case "type_identifier": {
        if (isNamePosition(n)) return;
        const line = n.startPosition.row + 1;
        const t = resolve(n.text);
        if (t) edges.push({ kind: "uses", from: enclosing, to: t, toText: t, line });
        return;
      }
      case "qualified_identifier": {
        const line = n.startPosition.row + 1;
        const last = n.namedChildren[n.namedChildren.length - 1];
        if (last && (last.type === "type_identifier" || last.type === "template_type")) {
          const inner = last.type === "template_type" ? findChild(last, "type_identifier") : last;
          if (inner) {
            const t = resolve(inner.text);
            if (t) edges.push({ kind: "uses", from: enclosing, to: t, toText: t, line });
          }
        } else if (last && (last.type === "field_identifier" || last.type === "identifier" || last.type === "destructor_name")) {
          // scoped value reference (enum member, static member, destructor)
          const nm = last.type === "destructor_name" ? findChild(last, "identifier")?.text : last.text;
          if (nm) {
            const t = resolve(nm);
            if (t) edges.push({ kind: "uses", from: enclosing, to: t, toText: t, line });
          }
        }
        return;
      }
      default: {
        const scoped = scopeQualified(n, enclosing);
        const enc = scoped ?? (n.type === "translation_unit" ? moduleName : enclosing);
        for (const c of n.namedChildren) walk2(c, enc);
      }
    }
  }
  walk2(tree.rootNode, "", false);

  tree.delete?.();
  return { moduleName, symbols, edges, imports };
}

// last segment of a scoped callee: Foo::doThing -> doThing, std::make_unique<T> -> make_unique
function lastSegmentName(n: Node): string | null {
  for (let i = n.namedChildren.length - 1; i >= 0; i--) {
    const c = n.namedChildren[i];
    if (c.type === "identifier" || c.type === "field_identifier") return c.text;
    if (c.type === "destructor_name") {
      const inner = findChild(c, "identifier");
      return "~" + (inner?.text ?? "");
    }
    if (c.type === "operator_name") return c.text.replace(/\s+/g, "");
    if (c.type === "template_function") {
      const id = findChild(c, "identifier");
      if (id) return id.text;
    }
  }
  return null;
}

// scope-qualified name for a declaration node (mirrors extract-ts)
function scopeQualified(n: Node, enclosing: string): string | null {
  switch (n.type) {
    case "class_specifier":
    case "struct_specifier":
    case "union_specifier":
    case "enum_specifier": {
      const id = findChild(n, "type_identifier");
      return id ? (enclosing ? `${enclosing}.${id.text}` : id.text) : enclosing;
    }
    case "namespace_definition": {
      const ids = namespaceName(n);
      if (!ids.length) return enclosing; // anonymous
      const ns = ids.join(".");
      return enclosing ? `${enclosing}.${ns}` : ns;
    }
    case "function_definition":
    case "field_declaration":
    case "declaration": {
      const fd = findChild(n, "function_declarator");
      if (fd) {
        const dn = declaratorName(fd);
        if (dn) return qualifyName(dn, enclosing);
      }
      return enclosing;
    }
    default:
      return null;
  }
}
