import { isBuiltin } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { Node, SyntaxKind, type CallExpression, type ObjectLiteralExpression, type SourceFile } from "ts-morph";
import { API_RULES, ERROR_CODES, FS_RENAMES, PROCESS_RENAMES, ruleKey } from "./apis.js";
import { lineAt } from "./files.js";
import type { ImportResolver } from "./import-map.js";
import type { TypeExportIndex } from "./type-exports.js";
import { planSpecifier } from "./specifiers.js";
import { applyEdits, foldNestedEdits, type TextEdit } from "./text-edit.js";
import type { Finding, Target } from "./types.js";

export const HONO_NODE_SERVER = {
  name: "@hono/node-server",
  range: "^2.1.8",
  /**
   * 2.x imports defineWebSocketHelper from "hono/ws", which hono only has from 4.6.7 (checked in the npm tarballs:
   * 4.6.6 no, 4.6.7 yes), although its peer range says "^4". 1.19.19 does not import it and has the same serve().
   */
  legacyRange: "^1.19.19",
  minHono: [4, 6, 7] as const,
};

export interface SourceContext {
  target: Target;
  /** Deno-specific findings (BroadcastChannel, import.meta.main) only make sense in a Deno project. */
  isDenoProject: boolean;
  resolver: ImportResolver;
  /** Called for every dependency the rewritten imports need. */
  addDependency(name: string, spec: string, origin: string): void;
  /**
   * A bare package import that no import map covers (Deno found it in node_modules or a package.json). Returns how
   * it was handled: "known" (already a dependency), "pinned" (added with the deno.lock version), or "unknown".
   */
  bareImport?(name: string, origin: string): { kind: "known" } | { kind: "pinned"; version: string } | { kind: "unknown" };
  /** Reads local modules to tell type-only exports (for the `type` keyword Node's type stripping needs). */
  typeExports?: TypeExportIndex;
}

export interface SourceResult {
  findings: Finding[];
  /** Rewritten text, or null when nothing changed. */
  after: string | null;
  /** Why this file needs a TypeScript runner that transforms (tsx) instead of Node's type stripping. */
  runnerReasons: string[];
  /** Web API type names Deno declares globally and @types/node does not, used here without a declaration. */
  webTypes: string[];
}

/**
 * Global type names from Deno's lib (lib.deno_fetch.d.ts, lib.deno_web.d.ts) that @types/node 24 does not declare.
 * Each is derived from the Node constructor that takes it, so it matches what Node accepts.
 */
export const WEB_TYPE_GLOBALS: Record<string, string> = {
  HeadersInit: "NonNullable<ConstructorParameters<typeof Headers>[0]>",
  BodyInit: "NonNullable<ConstructorParameters<typeof Response>[0]>",
  RequestInfo: "ConstructorParameters<typeof Request>[0]",
  BlobPart: "NonNullable<ConstructorParameters<typeof Blob>[0]> extends Iterable<infer P> ? P : never",
};

interface Imports {
  wanted: Map<string, Map<string, string>>;
  taken: Set<string>;
}

const NAMESPACES = new Set(["env", "errors", "permissions", "build", "stdout", "stdin", "stderr", "version", "telemetry", "jupyter"]);

const GUARD = /typeof\s+Deno\b|["']Deno["']\s+in\s+globalThis|globalThis\.Deno|\bDeno\s*\?\./;

/** True when the node sits in a branch that only runs on Deno (`typeof Deno !== "undefined" && …`). */
function isRuntimeGuarded(node: Node): boolean {
  for (let cur: Node | undefined = node; cur; cur = cur.getParent()) {
    const parent = cur.getParent();
    if (!parent) break;
    if (Node.isIfStatement(parent) && parent.getThenStatement() === cur && GUARD.test(parent.getExpression().getText())) return true;
    if (Node.isConditionalExpression(parent) && parent.getCondition() !== cur && GUARD.test(parent.getCondition().getText())) return true;
    if (Node.isBinaryExpression(parent)) {
      const op = parent.getOperatorToken().getKind();
      if ((op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) && parent.getRight() === cur && GUARD.test(parent.getLeft().getText())) {
        return true;
      }
    }
    if (Node.isPropertyAccessExpression(cur) && cur.hasQuestionDotToken() && /^(globalThis\.)?Deno$/.test(cur.getExpression().getText())) return true;
  }
  return false;
}

/**
 * A bare `Deno` identifier that is not `Deno.x` (handled elsewhere), a guard (`typeof Deno`), a type query, a
 * declaration of its own name or a property name: `const { env } = Deno`, `const d = Deno`, `Deno["cwd"]()`.
 */
function isOtherDenoValueUse(id: Node): boolean {
  const parent = id.getParent();
  if (!parent) return false;
  if (Node.isTypeOfExpression(parent) || Node.isTypeQuery(parent)) return false;
  if (Node.isPropertyAccessExpression(parent)) return false; // Deno.x is handled; globalThis.Deno alone is a guard
  if (Node.isQualifiedName(parent)) return false;
  if (Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent) || Node.isImportClause(parent)) return false;
  if ((Node.isVariableDeclaration(parent) || Node.isModuleDeclaration(parent) || Node.isInterfaceDeclaration(parent) || Node.isParameterDeclaration(parent)) && parent.getNameNode() === id) return false;
  if ((Node.isPropertyAssignment(parent) || Node.isPropertySignature(parent) || Node.isMethodDeclaration(parent) || Node.isBindingElement(parent)) && parent.getNameNode() === id) return false;
  if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.InKeyword) return false;
  return true;
}

function localName(imports: Imports, module: string, name: string): string {
  let byModule = imports.wanted.get(module);
  if (!byModule) imports.wanted.set(module, (byModule = new Map()));
  const existing = byModule.get(name);
  if (existing) return existing;
  let local = name;
  if (imports.taken.has(local)) {
    local = `node${name[0]!.toUpperCase()}${name.slice(1)}`;
    for (let i = 2; imports.taken.has(local); i++) local = `node${name[0]!.toUpperCase()}${name.slice(1)}${i}`;
  }
  imports.taken.add(local);
  byModule.set(name, local);
  return local;
}

/** Names already imported (`import { readFile } from "node:fs/promises"`) are reused instead of imported twice. */
function seedExistingImports(sf: SourceFile, imports: Imports): void {
  for (const decl of sf.getImportDeclarations()) {
    const module = decl.getModuleSpecifierValue();
    if (!module.startsWith("node:") && module !== "@hono/node-server") continue;
    for (const named of decl.getNamedImports()) {
      if (named.isTypeOnly() || decl.isTypeOnly()) continue;
      let byModule = imports.wanted.get(module);
      if (!byModule) imports.wanted.set(module, (byModule = new Map()));
      byModule.set(named.getName(), named.getAliasNode()?.getText() ?? named.getName());
    }
  }
}

function importEdits(sf: SourceFile, imports: Imports, existing: ReadonlySet<string>): TextEdit[] {
  const lines: string[] = [];
  for (const [module, names] of imports.wanted) {
    const fresh = [...names].filter(([name, local]) => !existing.has(`${module}\0${name}\0${local}`));
    if (!fresh.length) continue;
    const specs = fresh.map(([name, local]) => (name === local ? name : `${name} as ${local}`)).sort();
    lines.push(`import { ${specs.join(", ")} } from "${module}";\n`);
  }
  if (!lines.length) return [];
  const decls = sf.getImportDeclarations();
  const last = decls[decls.length - 1];
  if (last) return [{ start: last.getEnd(), end: last.getEnd(), text: `\n${lines.join("").trimEnd()}` }];
  const first = sf.getStatements()[0];
  const at = first ? first.getStart(true) : sf.getEnd();
  return [{ start: at, end: at, text: lines.join("") + (first ? "\n" : "") }];
}

function existingImportKeys(imports: Imports): Set<string> {
  const keys = new Set<string>();
  for (const [module, names] of imports.wanted) for (const [name, local] of names) keys.add(`${module}\0${name}\0${local}`);
  return keys;
}

function isSimpleRef(text: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(text);
}

export function scanSource(rel: string, sf: SourceFile, ctx: SourceContext): SourceResult {
  const text = sf.getFullText();
  const findings: Finding[] = [];
  const edits: TextEdit[] = [];
  const runnerReasons: string[] = [];
  const ext = extname(rel);
  const isCjs = ext === ".cjs" || ext === ".cts";
  const canFix = ctx.target === "node" && !isCjs;
  const imports: Imports = { wanted: new Map(), taken: declaredNames(sf) };
  seedExistingImports(sf, imports);
  const alreadyImported = existingImportKeys(imports);

  const add = (f: Omit<Finding, "file" | "line"> & { node?: Node; line?: number }): void => {
    if (f.rule === "specifier-caveat" && findings.some((x) => x.rule === f.rule && x.message === f.message)) return;
    const line = f.line ?? (f.node ? lineAt(text, f.node.getStart()) : 1);
    const { node, ...rest } = f;
    findings.push({ ...rest, file: rel, line, snippet: node ? snippetOf(node) : rest.snippet });
  };

  // ---- module specifiers -------------------------------------------------------------------------------------
  const specifierNodes: Node[] = [];
  for (const decl of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
    const lit = decl.getModuleSpecifier();
    if (lit) specifierNodes.push(lit);
    if (/\bassert\s*\{\s*type\s*:/.test(decl.getText())) {
      const m = /\bassert(?=\s*\{\s*type\s*:)/.exec(decl.getText())!;
      const start = decl.getStart() + m.index;
      add({ rule: "import-assert", category: "specifier", fix: canFix ? "auto" : "manual", node: decl, message: "import assertion `assert { type }`: Node 22+ only accepts `with { type }`", replacement: "with { type: \"json\" }" });
      if (canFix) edits.push({ start, end: start + "assert".length, text: "with" });
    }
  }
  sf.forEachDescendant((node) => {
    if (Node.isCallExpression(node) && node.getExpression().getKind() === SyntaxKind.ImportKeyword) {
      const arg = node.getArguments()[0];
      if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) specifierNodes.push(arg);
    } else if (Node.isImportTypeNode(node)) {
      const arg = node.getArgument();
      if (Node.isLiteralTypeNode(arg)) specifierNodes.push(arg.getLiteral());
    }
  });

  for (const lit of specifierNodes) {
    if (!Node.isStringLiteral(lit) && !Node.isNoSubstitutionTemplateLiteral(lit)) continue;
    const spec = lit.getLiteralText();
    const mapped = ctx.resolver.resolve(spec, rel);
    if (bddToNodeTest(lit, spec, mapped?.kind === "target" ? mapped.resolved : spec)) continue;

    if (mapped?.kind === "subpath") {
      addExtension(lit, spec, mapped.local);
      continue;
    }
    if (mapped?.kind === "relative") {
      const suffix = suffixFor(normalize(join(dirname(rel), mapped.relative)));
      const target = mapped.relative + (suffix ?? "");
      add({ rule: "import-map-alias", category: "specifier", fix: canFix ? "auto" : "manual", node: lit, message: `import-map alias "${spec}" → relative path (Node has no import maps; tsconfig paths do not work with type stripping)`, replacement: target });
      if (canFix) edits.push({ start: lit.getStart() + 1, end: lit.getEnd() - 1, text: target });
      continue;
    }
    if (/^\.{1,2}\//.test(spec)) {
      addExtension(lit, spec, normalize(join(dirname(rel), spec)));
      continue;
    }
    if (mapped?.kind === "alias") {
      // The import stays as written; the package.json alias makes it resolve.
      if (mapped.caveat) add({ rule: "specifier-caveat", category: "specifier", fix: mapped.caveat.fix, node: lit, message: mapped.caveat.message, replacement: mapped.caveat.replacement });
      continue;
    }

    const resolvedSpec = mapped?.kind === "target" ? mapped.resolved : spec;
    const plan = planSpecifier(resolvedSpec, mapped?.kind === "target" ? mapped.lock : ctx.resolver.lockFor(rel));
    if (isFresh(spec) || isFresh(resolvedSpec)) {
      addFresh(lit);
      continue;
    }
    if (!plan) {
      const name = bareName(spec);
      if (!mapped && name && ctx.bareImport && ctx.isDenoProject) {
        const r = ctx.bareImport(name, `${rel}:${lineAt(text, lit.getStart())}`);
        if (r.kind === "pinned") add({ rule: "bare-import", category: "specifier", fix: canFix ? "auto" : "manual", node: lit, message: `"${name}" is imported without an import-map entry: added to package.json at ${r.version}, the version in deno.lock`, replacement: `"${name}": "${r.version}"` });
        else if (r.kind === "unknown") add({ rule: "bare-import", category: "specifier", fix: "manual", node: lit, message: `"${name}" is a bare import with no import-map entry, package.json entry or deno.lock version (Deno can only have resolved it from node_modules): add it to package.json`, replacement: `npm install ${name}` });
      }
      continue;
    }
    if (plan.fix === "auto" && plan.rewrite && plan.name && plan.dep) {
      add({ rule: `specifier-${plan.kind}`, category: "specifier", fix: canFix ? "auto" : "manual", node: lit, message: plan.message, replacement: plan.rewrite });
      if (canFix) {
        edits.push({ start: lit.getStart() + 1, end: lit.getEnd() - 1, text: plan.rewrite });
        ctx.addDependency(plan.name, plan.dep, `${rel}:${lineAt(text, lit.getStart())}`);
      }
      if (plan.caveat) add({ rule: "specifier-caveat", category: "specifier", fix: plan.caveat.fix, node: lit, message: plan.caveat.message, replacement: plan.caveat.replacement });
    } else {
      add({ rule: `specifier-${plan.kind}`, category: plan.fix === "decision" ? "decision" : "specifier", fix: plan.fix, node: lit, message: plan.message, replacement: plan.replacement });
    }
  }

  // ---- type-only imports: Deno drops them, Node's type stripping keeps them and the import fails at runtime ---------
  if (ctx.typeExports && ctx.isDenoProject && /\.[cm]?tsx?$/.test(rel)) {
    const usage = identifierUsage(sf);
    for (const decl of sf.getImportDeclarations()) {
      if (decl.isTypeOnly()) continue;
      const spec = decl.getModuleSpecifierValue();
      const mapped = ctx.resolver.resolve(spec, rel);
      const kinds =
        mapped?.kind === "subpath" ? ctx.typeExports.forLocal(mapped.local) : ctx.typeExports.forImport(rel, mapped?.kind === "relative" ? mapped.relative : spec);
      const named = decl.getNamedImports();
      // A name is type-only when its module exports it only as a type, or when this file only uses it in type positions.
      const typeOnly = named.filter((n) => {
        if (n.isTypeOnly()) return false;
        const local = n.getAliasNode()?.getText() ?? n.getName();
        return kinds?.get(n.getName()) === "type" || usage.get(local) === "type";
      });
      if (!typeOnly.length) continue;
      const names = typeOnly.map((n) => n.getName()).join(", ");
      const whole = !decl.getDefaultImport() && !decl.getNamespaceImport() && typeOnly.length === named.length;
      add({
        rule: "type-only-import",
        category: "typescript",
        fix: canFix ? "auto" : "manual",
        node: decl,
        message: `${names}: only used as type${typeOnly.length > 1 ? "s" : ""} but imported without \`type\` (Node's type stripping keeps the import, so it fails at runtime; tsc TS1484 under verbatimModuleSyntax)`,
        replacement: whole ? "import type { … }" : typeOnly.map((n) => `type ${n.getText()}`).join(", "),
      });
      if (!canFix) continue;
      if (whole) {
        const start = decl.getStart() + "import".length;
        edits.push({ start, end: start, text: " type" });
      } else {
        for (const n of typeOnly) edits.push({ start: n.getStart(), end: n.getStart(), text: "type " });
      }
    }
  }

  /** Suffix an extensionless local import needs on Node (".ts", "/index.ts"), or null when it is fine or unknown. */
  function suffixFor(fromRoot: string): string | null {
    if (!ctx.isDenoProject || !ctx.typeExports) return null;
    return ctx.typeExports.missingSuffix(fromRoot) || null;
  }

  function addExtension(lit: Node, spec: string, fromRoot: string): void {
    const suffix = suffixFor(fromRoot);
    if (!suffix) return;
    add({ rule: "extensionless-import", category: "specifier", fix: canFix ? "auto" : "manual", node: lit, message: `"${spec}" has no file extension (Deno --sloppy-imports); Node's ESM loader needs the full path`, replacement: spec + suffix });
    if (canFix) edits.push({ start: lit.getStart() + 1, end: lit.getEnd() - 1, text: spec + suffix });
  }

  /**
   * `import { describe, it } from "@std/testing/bdd"`: @std/testing/bdd registers its tests through Deno.test, so it
   * cannot run on Node, but node:test exports the same names (beforeAll/afterAll are before/after there).
   */
  function bddToNodeTest(lit: Node, spec: string, resolved: string): boolean {
    if (!/^(?:jsr:)?@std\/testing(?:@[^/]+)?\/bdd$|deno\.land\/std@[^/]+\/testing\/bdd\.ts$/.test(spec) && !/^jsr:@std\/testing(?:@[^/]+)?\/bdd$/.test(resolved)) return false;
    const decl = lit.getParent();
    if (!Node.isImportDeclaration(decl) || decl.isTypeOnly() || decl.getDefaultImport() || decl.getNamespaceImport()) return false;
    const names = decl.getNamedImports();
    const map: Record<string, string> = { describe: "describe", it: "it", test: "test", beforeEach: "beforeEach", afterEach: "afterEach", beforeAll: "before", afterAll: "after" };
    if (!names.length || names.some((n) => !(n.getName() in map))) return false;
    const locals = names.map((n) => n.getAliasNode()?.getText() ?? n.getName());
    // Deno's .ignore modifier is .skip in node:test.
    if (locals.some((l) => new RegExp(`\\b${l}\\.ignore\\b`).test(text))) return false;
    const specs = names.map((n) => {
      const local = n.getAliasNode()?.getText() ?? n.getName();
      const target = map[n.getName()]!;
      return target === local ? target : `${target} as ${local}`;
    });
    add({ rule: "std-bdd", category: "specifier", fix: canFix ? "auto" : "manual", node: decl, message: "@std/testing/bdd registers tests with Deno.test; node:test has the same describe/it API", replacement: `import { ${specs.join(", ")} } from "node:test"` });
    if (canFix) edits.push({ start: decl.getStart(), end: decl.getEnd(), text: `import { ${specs.join(", ")} } from "node:test";` });
    return true;
  }

  function addFresh(lit: Node): void {
    if (findings.some((f) => f.rule === "fresh")) return;
    add({
      rule: "fresh",
      category: "decision",
      fix: "decision",
      node: lit,
      message: "Fresh framework: it runs on Deno, and we found no supported Node runtime for it",
      replacement: "keep the app on the Deno runtime on another host, or port routes and islands to a Node framework (Hono + JSX, Astro + Preact)",
    });
  }

  // ---- triple-slash references to Deno libs -------------------------------------------------------------------
  for (const m of text.matchAll(/^[ \t]*\/\/\/\s*<reference\s+(?:lib="deno\.[\w.]+"|types="(?:https?:|jsr:|npm:)[^"]*")\s*\/>[ \t]*\r?\n?/gm)) {
    add({ rule: "deno-reference", category: "typescript", fix: canFix ? "auto" : "manual", line: lineAt(text, m.index), message: "triple-slash reference to Deno types", snippet: m[0].trim() });
    if (canFix) edits.push({ start: m.index, end: m.index + m[0].length, text: "" });
  }

  // ---- Deno.* --------------------------------------------------------------------------------------------------
  let guardedSeen = false;
  sf.forEachDescendant((node, traversal) => {
    if (Node.isQualifiedName(node) && node.getLeft().getText() === "Deno") {
      const name = node.getRight().getText();
      const rule = API_RULES[ruleKey([name]) ?? name];
      if (rule?.fix === "decision") {
        add({ rule: rule.rule ?? "deno-api", category: "decision", fix: "decision", node, message: `Deno.${name} type`, replacement: rule.replacement });
      } else {
        add({ rule: "deno-type", category: "typescript", fix: "manual", node, message: `Deno.${name} type has no global on Node`, replacement: rule?.replacement ?? "a Node type (node:http, node:fs …) or your own interface" });
      }
      traversal.skip();
      return;
    }
    if (Node.isIdentifier(node) && node.getText() === "Deno") {
      if (isOtherDenoValueUse(node) && !isRuntimeGuarded(node)) {
        add({ rule: "deno-value", category: "api", fix: "manual", node, message: "Deno used as a value (destructured, aliased or indexed): the tool cannot follow it", replacement: "replace each use with the Node API by hand" });
      }
      return;
    }
    if (!Node.isPropertyAccessExpression(node)) return;
    const base = node.getExpression();
    const isDeno = Node.isIdentifier(base) ? base.getText() === "Deno" : Node.isPropertyAccessExpression(base) && base.getText() === "globalThis.Deno";
    if (!isDeno) return;
    traversal.skip();

    // Deno.x, or Deno.ns.x for the namespaces (env, errors, …). Anything after that is a member of the result.
    const chain = [node.getName()];
    let top: Node = node;
    while (
      NAMESPACES.has(chain[0]!) &&
      chain.length < 2 &&
      Node.isPropertyAccessExpression(top.getParent()) &&
      (top.getParent() as Node & { getExpression(): Node }).getExpression() === top
    ) {
      top = top.getParent()!;
      chain.push((top as Node & { getName(): string }).getName());
    }

    if (isRuntimeGuarded(node)) {
      if (!guardedSeen && ctx.isDenoProject) {
        guardedSeen = true;
        add({ rule: "runtime-guard", category: "api", fix: "info", node, message: "Deno.* behind a `typeof Deno` check: cross-runtime code, left as is" });
      }
      return;
    }
    handleDenoMember(chain, top);
  });

  function handleDenoMember(chain: string[], top: Node): void {
    const key = ruleKey(chain);
    const rule = key ? API_RULES[key] : undefined;
    const label = `Deno.${chain.join(".")}`;
    const call = top.getParent();
    const callExpr = Node.isCallExpression(call) && call.getExpression() === top ? call : undefined;
    const manual = (why?: string): void =>
      add({
        rule: rule?.rule ?? "deno-api",
        category: rule?.fix === "decision" ? "decision" : "api",
        fix: rule?.fix === "decision" ? "decision" : rule?.fix === "info" ? "info" : "manual",
        node: top,
        message: `${label}${why ? `: ${why}` : rule?.why ? `: ${rule.why}` : ""}`,
        replacement: rule?.replacement ?? "no 1:1 Node API known: check docs.deno.com/api/deno for what it does",
      });

    if (!rule || rule.fix !== "auto" || !canFix) {
      if (rule?.fix === "auto" && !canFix) {
        add({ rule: "deno-api", category: "api", fix: "manual", node: top, message: label, replacement: ctx.target === "workers" ? workersHint(chain) : rule.replacement });
        return;
      }
      if (key === "openKv") return kvFinding(top);
      return manual();
    }

    const auto = (replacement: string, edit: TextEdit): void => {
      add({ rule: "deno-api", category: "api", fix: "auto", node: top, message: label, replacement });
      edits.push(edit);
    };
    const args = callExpr?.getArguments() ?? [];
    const argText = args.map((a) => a.getText());

    // Deno.env.*
    if (chain[0] === "env") {
      const stmt = callExpr?.getParent();
      const isStatement = Node.isExpressionStatement(stmt);
      if (!callExpr) return manual("Deno.env passed around as an object");
      const range = { start: callExpr.getStart(), end: callExpr.getEnd() };
      switch (chain[1]) {
        case "get":
          if (args.length === 1) return auto(`process.env[${argText[0]}]`, { ...range, text: `process.env[${argText[0]}]` });
          break;
        case "has":
          if (args.length === 1) return auto("process.env[name] !== undefined", { ...range, text: `(process.env[${argText[0]}] !== undefined)` });
          break;
        case "set":
          if (args.length === 2 && isStatement) return auto("process.env[name] = value", { ...range, text: `process.env[${argText[0]}] = ${argText[1]}` });
          break;
        case "delete":
          if (args.length === 1 && isStatement) return auto("delete process.env[name]", { ...range, text: `delete process.env[${argText[0]}]` });
          break;
        case "toObject":
          if (args.length === 0) return auto("({ ...process.env })", { ...range, text: "({ ...process.env })" });
          break;
      }
      return manual("call shape not rewritten automatically");
    }

    if (chain.length === 1 && chain[0] === "args") return auto("process.argv.slice(2)", { start: top.getStart(), end: top.getEnd(), text: "process.argv.slice(2)" });

    const proc = PROCESS_RENAMES[chain[0]!];
    if (proc && chain.length === 1) {
      if (chain[0] === "execPath") {
        if (!callExpr) return manual();
        return auto("process.execPath", { start: callExpr.getStart(), end: callExpr.getEnd(), text: "process.execPath" });
      }
      if (proc.call && !callExpr) return manual("passed as a function value");
      return auto(proc.text, { start: top.getStart(), end: top.getEnd(), text: proc.text });
    }

    if (chain[0] === "errors" && chain.length === 2) {
      const codes = ERROR_CODES[chain[1]!];
      const bin = top.getParent();
      if (codes && Node.isBinaryExpression(bin) && bin.getOperatorToken().getKind() === SyntaxKind.InstanceOfKeyword && bin.getRight() === top) {
        const subject = bin.getLeft().getText();
        if (!isSimpleRef(subject)) return manual("instanceof on a complex expression");
        const test = codes.map((c) => `${subject}.code === "${c}"`).join(" || ");
        const inner = `${subject} instanceof Error && "code" in ${subject} && ${codes.length > 1 ? `(${test})` : test}`;
        const host = bin.getParent();
        const bare = Node.isIfStatement(host) || Node.isParenthesizedExpression(host) || Node.isReturnStatement(host) || Node.isVariableDeclaration(host) || Node.isWhileStatement(host);
        const text = bare ? inner : `(${inner})`;
        return auto(`code === "${codes.join('" / "')}"`, { start: bin.getStart(), end: bin.getEnd(), text });
      }
      return manual("Node throws plain Errors with a `code` (ENOENT, EEXIST …), not Deno.errors classes");
    }

    const fsRename = FS_RENAMES[chain[0]!];
    if (fsRename && chain.length === 1) {
      if (!callExpr) return manual("passed as a function value");
      if (args.length > fsRename.maxArgs) return manual("extra options argument: check the Node signature");
      const local = localName(imports, fsRename.module, fsRename.name);
      if (fsRename.utf8) {
        return auto(rule.replacement, { start: callExpr.getStart(), end: callExpr.getEnd(), text: `${local}(${argText.join(", ")}, "utf8")` });
      }
      return auto(rule.replacement, { start: top.getStart(), end: top.getEnd(), text: local });
    }

    if ((chain[0] === "remove" || chain[0] === "removeSync") && chain.length === 1) {
      const opts = args[1];
      if (!callExpr || args.length !== 2 || !Node.isObjectLiteralExpression(opts) || !/^\{\s*recursive\s*:\s*true\s*,?\s*\}$/.test(opts.getText())) {
        return manual("without { recursive: true } Deno.remove deletes files or empty dirs; pick rm() or rmdir() in Node");
      }
      const local = chain[0] === "remove" ? localName(imports, "node:fs/promises", "rm") : localName(imports, "node:fs", "rmSync");
      return auto(rule.replacement, { start: top.getStart(), end: top.getEnd(), text: local });
    }

    if ((chain[0] === "makeTempDir" || chain[0] === "makeTempDirSync") && chain.length === 1) return tempDirRewrite(chain[0], callExpr, args, manual, auto);
    if (chain[0] === "serve" && chain.length === 1) return serveRewrite(callExpr, top, manual, auto);
    if (chain[0] === "test" && chain.length === 1) return testRewrite(callExpr, manual, auto);
    return manual();
  }

  /**
   * Deno.makeTempDir({ dir, prefix }) → mkdtemp(join(dir ?? tmpdir(), prefix ?? "tmp-")). mkdtemp appends six random
   * characters to the path it gets, so the prefix must not be empty (join(tmpdir(), "") would create /tmpXXXXXX).
   */
  function tempDirRewrite(name: string, callExpr: CallExpression | undefined, args: Node[], manual: Manual, auto: Auto): void {
    if (!callExpr) return manual("passed as a function value");
    const opts = args[0];
    let dir: string | undefined;
    let prefix: string | undefined;
    if (opts) {
      if (args.length > 1 || !Node.isObjectLiteralExpression(opts)) return manual("options passed as a variable");
      for (const p of opts.getProperties()) {
        if (!Node.isPropertyAssignment(p)) return manual("options shape not rewritten automatically");
        const value = p.getInitializer()!.getText();
        if (p.getName() === "dir") dir = value;
        else if (p.getName() === "prefix") prefix = value;
        else return manual(`option ${p.getName()} has no mkdtemp equivalent`);
      }
    }
    const sync = name === "makeTempDirSync";
    const mk = localName(imports, sync ? "node:fs" : "node:fs/promises", sync ? "mkdtempSync" : "mkdtemp");
    const join = localName(imports, "node:path", "join");
    const base = dir ?? `${localName(imports, "node:os", "tmpdir")}()`;
    const text = `${mk}(${join}(${base}, ${prefix && !/^(["'`])\1$/.test(prefix) ? prefix : '"tmp-"'}))`;
    return auto(API_RULES[name]!.replacement, { start: callExpr.getStart(), end: callExpr.getEnd(), text });
  }

  function kvFinding(top: Node): void {
    const atomic = /\.atomic\(\)/.test(text);
    const queues = /\.(enqueue|listenQueue)\(/.test(text);
    const watch = /\.watch\(\s*\[/.test(text);
    const extras = [atomic && "atomic()", queues && "queues (enqueue/listenQueue)", watch && "watch()"].filter(Boolean);
    add({
      rule: "deno-kv",
      category: "decision",
      fix: "decision",
      node: top,
      message: `Deno.openKv: Deno KV${extras.length ? ` with ${extras.join(", ")}` : ""} has no Node runtime; data on Deploy has to be exported first`,
      replacement: "@deno/kv (npm) can read a Deploy database over KV Connect for the export; then SQLite (node:sqlite), Postgres, Redis, or Workers KV / D1",
    });
  }

  type Manual = (why?: string) => void;
  type Auto = (replacement: string, edit: TextEdit) => void;

  function serveRewrite(callExpr: CallExpression | undefined, top: Node, manual: Manual, auto: Auto): void {
    if (!callExpr) return manual("Deno.serve passed as a value");
    const parent = callExpr.getParent();
    const resultUsed = !(Node.isExpressionStatement(parent) || (Node.isAwaitExpression(parent) && Node.isExpressionStatement(parent.getParent())));
    if (resultUsed) return manual("the returned Deno.HttpServer (finished, shutdown, addr) differs from Node's http.Server (close(), address())");
    const args = callExpr.getArguments();
    let options: ObjectLiteralExpression | undefined;
    let handler: Node | undefined;
    let handlerFn: Node | undefined;
    if (args.length === 1 && Node.isObjectLiteralExpression(args[0])) options = args[0];
    else if (args.length === 1) handler = args[0];
    else if (args.length === 2 && Node.isObjectLiteralExpression(args[0])) [options, handler] = [args[0], args[1]];
    else return manual("options passed as a variable");

    const props = new Map<string, string>();
    for (const prop of options?.getProperties() ?? []) {
      if (Node.isPropertyAssignment(prop)) {
        props.set(prop.getName(), prop.getInitializerOrThrow().getText());
        if (prop.getName() === "handler") handlerFn = prop.getInitializerOrThrow();
      }
      else if (Node.isShorthandPropertyAssignment(prop)) props.set(prop.getName(), prop.getName());
      else if (Node.isMethodDeclaration(prop) && prop.getName() === "handler" && !prop.isGenerator()) {
        handlerFn = prop;
        props.set("handler", prop.getText().replace(/^(async\s+)?handler\s*/, (_m, a: string | undefined) => `${a ?? ""}function `));
      }
      else return manual("spread or method in the options");
    }
    const unsupported = [...props.keys()].filter((k) => !["port", "hostname", "handler"].includes(k));
    if (unsupported.length) return manual(`options ${unsupported.join(", ")} have no 1:1 @hono/node-server option`);
    const handlerText = handler?.getText() ?? props.get("handler");
    if (!handlerText) return manual("no handler");
    const fn = handler ?? handlerFn;
    if (fn && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn)) && fn.getParameters().length > 1) {
      return manual("the handler reads the second argument (info.remoteAddr); on @hono/node-server it is { incoming, outgoing }");
    }
    const serve = localName(imports, HONO_NODE_SERVER.name, "serve");
    ctx.addDependency(HONO_NODE_SERVER.name, HONO_NODE_SERVER.range, `${rel}:${lineAt(text, top.getStart())}`);
    const parts = [`fetch: ${handlerText}`, `port: ${props.get("port") ?? "8000"}`];
    if (props.has("hostname")) parts.push(`hostname: ${props.get("hostname")}`);
    const replacement = `${serve}({ ${parts.join(", ")} })`;
    auto(`serve({ fetch, port }) from @hono/node-server${props.has("port") ? "" : " (port 8000 kept: Deno's default; the adapter's is 3000)"}`, {
      start: callExpr.getStart(),
      end: callExpr.getEnd(),
      text: replacement,
    });
  }

  function testRewrite(callExpr: CallExpression | undefined, manual: Manual, auto: Auto): void {
    if (!callExpr) return manual();
    if (!isTestFileName(rel)) {
      return manual("Deno.test in a module that is not a test file: Deno skips it outside `deno test`, node:test would run it on every import; move it to a *_test.ts file first");
    }
    const args = callExpr.getArguments();
    const test = (): string => localName(imports, "node:test", "test");
    let name: string | undefined;
    let fn: Node | undefined;
    const optionParts: string[] = [];
    const dropped: string[] = [];
    const readOptions = (obj: ObjectLiteralExpression, allowNameFn: boolean): boolean => {
      for (const prop of obj.getProperties()) {
        const key = Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop) || Node.isMethodDeclaration(prop) ? prop.getName() : null;
        const value = Node.isPropertyAssignment(prop) ? prop.getInitializerOrThrow().getText() : Node.isShorthandPropertyAssignment(prop) ? prop.getName() : null;
        if (!key || (value === null && !(Node.isMethodDeclaration(prop) && key === "fn"))) return false;
        if (allowNameFn && key === "name") name = value!;
        else if (allowNameFn && key === "fn") fn = Node.isPropertyAssignment(prop) ? prop.getInitializerOrThrow() : prop;
        else if (key === "ignore") optionParts.push(`skip: ${value}`);
        else if (key === "only") optionParts.push(`only: ${value}`);
        else if (/^(sanitizeOps|sanitizeResources|sanitizeExit|permissions)$/.test(key)) dropped.push(key);
        else return false;
      }
      return true;
    };

    if (args.length === 1 && Node.isObjectLiteralExpression(args[0])) {
      if (!readOptions(args[0], true)) return manual("test options without a node:test equivalent");
    } else if (args.length === 1) {
      fn = args[0];
    } else if (args.length === 2 && Node.isObjectLiteralExpression(args[0])) {
      // Deno.test({ name, ignore, … }, fn)
      if (!readOptions(args[0], true) || fn) return manual("test options without a node:test equivalent");
      fn = args[1];
    } else if (args.length === 2) {
      [name, fn] = [args[0]!.getText(), args[1]];
    } else if (args.length === 3 && Node.isObjectLiteralExpression(args[1])) {
      name = args[0]!.getText();
      fn = args[2];
      if (!readOptions(args[1], false)) return manual("test options without a node:test equivalent");
    } else return manual();
    if (!fn) return manual("no test function");
    if (Node.isMethodDeclaration(fn) && fn.isGenerator()) return manual("generator test function");

    // t.step(name, fn) → t.test(name, fn)
    const stepEdits: TextEdit[] = [];
    if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn)) {
      const param = fn.getParameters()[0]?.getName();
      if (param) {
        let bad = false;
        fn.forEachDescendant((n) => {
          if (Node.isPropertyAccessExpression(n) && n.getName() === "step" && n.getExpression().getText() === param) {
            const c = n.getParent();
            const stepArgs = Node.isCallExpression(c) ? c.getArguments() : [];
            if (stepArgs.length === 2) stepEdits.push({ start: n.getNameNode().getStart(), end: n.getNameNode().getEnd(), text: "test" });
            else bad = true;
          }
        });
        if (bad) return manual("t.step({ … }) object form: rewrite to t.test(name, fn)");
      }
    }
    const fnStart = fn.getStart();
    let inner = applyEdits(fn.getText(), stepEdits.map((e) => ({ ...e, start: e.start - fnStart, end: e.end - fnStart })));
    // { async fn(t) { … } } → async function (t) { … }
    if (Node.isMethodDeclaration(fn)) inner = inner.replace(/^(async\s+)?fn\s*/, (_m, a: string | undefined) => `${a ?? ""}function `);
    // fn moved out of an options object: shift its body left by the object's extra indentation.
    if (args.length === 1 && Node.isObjectLiteralExpression(args[0])) inner = dedent(inner, indentOf(fn) - indentOf(callExpr), linesInsideTemplates(fn));

    const local = test();
    const parts = [name, optionParts.length ? `{ ${optionParts.join(", ")} }` : undefined, inner].filter(Boolean);
    auto(`test() from node:test${stepEdits.length ? ", t.step → t.test" : ""}${dropped.length ? ` (dropped ${dropped.join(", ")}: node:test has no sanitizers)` : ""}`, {
      start: callExpr.getStart(),
      end: callExpr.getEnd(),
      text: `${local}(${parts.join(", ")})`,
    });
  }

  // ---- other runtime differences -------------------------------------------------------------------------------
  sf.forEachDescendant((node) => {
    const callee = Node.isCallExpression(node) ? node.getExpression() : undefined;
    if (ctx.isDenoProject && callee && Node.isPropertyAccessExpression(callee)) {
      const access = callee;
      const method = access.getName();
      const isStatic = access.getExpression().getText() === "Uint8Array" && (method === "fromBase64" || method === "fromHex");
      if (isStatic || method === "toBase64" || method === "setFromBase64" || method === "setFromHex") {
        add({
          rule: "uint8array-base64",
          category: "api",
          fix: "manual",
          node,
          message: `${isStatic ? "Uint8Array." : "Uint8Array#"}${method}: Deno has it, Node only from v25 (undefined on 22.23 and 24.22, a function on 25.9 and 26.13)`,
          replacement: method.includes("Hex") ? 'Buffer.from(hex, "hex") / Buffer.from(bytes).toString("hex"), or engines.node >= 25' : 'Buffer.from(bytes).toString("base64") / Buffer.from(text, "base64"), or engines.node >= 25',
        });
      }
    }
    if (Node.isNewExpression(node) && node.getExpression().getText() === "BroadcastChannel" && ctx.isDenoProject) {
      add({
        rule: "broadcast-channel",
        category: "decision",
        fix: "decision",
        node,
        message: "BroadcastChannel: on Deno Deploy it linked all instances of the app; on Node it only reaches the same process (worker threads)",
        replacement: "Redis pub/sub, Postgres LISTEN/NOTIFY, or Durable Objects on Workers",
      });
    } else if (Node.isMetaProperty(node) && node.getParent() && Node.isPropertyAccessExpression(node.getParent())) {
      const prop = (node.getParent() as Node & { getName(): string }).getName();
      if (prop === "main" && ctx.isDenoProject) {
        add({
          rule: "import-meta-main",
          category: "api",
          fix: ctx.target === "workers" ? "manual" : "info",
          node: node.getParent()!,
          message: "import.meta.main",
          replacement: ctx.target === "workers" ? "Workers have no entry-module check: export the fetch handler" : "works on Node >= 22.18 / 24.2 (Stability 1.0, early development)",
        });
      } else if ((prop === "dirname" || prop === "filename") && ctx.target === "workers") {
        add({ rule: "import-meta-path", category: "api", fix: "manual", node: node.getParent()!, message: `import.meta.${prop}`, replacement: "Workers have no file system: bundle the file or use static assets" });
      }
    } else if (isCjs && Node.isAwaitExpression(node) && !node.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a))) {
      add({ rule: "tla-in-cjs", category: "typescript", fix: "manual", node, message: "top-level await in a CommonJS file", replacement: "rename to .mjs/.mts or wrap in an async main()" });
    }
  });

  // ---- TypeScript that Node's type stripping cannot run ---------------------------------------------------------
  if (/\.[jt]sx$/.test(rel)) runnerReasons.push(`${rel}: JSX/TSX (Node's type stripping does not transform JSX)`);
  else if (/\.[cm]?ts$/.test(rel)) {
    sf.forEachDescendant((node, traversal) => {
      let reason: string | null = null;
      if (Node.isEnumDeclaration(node) && !node.hasDeclareKeyword()) reason = "enum";
      else if (Node.isModuleDeclaration(node) && !node.hasDeclareKeyword() && node.getDeclarationKind() !== "global" && node.getStatements().some((s) => !Node.isInterfaceDeclaration(s) && !Node.isTypeAliasDeclaration(s))) reason = "namespace with runtime code";
      else if (Node.isParameterDeclaration(node) && node.getScope() !== undefined && Node.isConstructorDeclaration(node.getParent())) reason = "constructor parameter property";
      else if (Node.isParameterDeclaration(node) && node.isReadonly() && Node.isConstructorDeclaration(node.getParent())) reason = "constructor parameter property";
      else if (Node.isDecorator(node)) reason = "decorator";
      else if (Node.isImportEqualsDeclaration(node) && !node.isTypeOnly()) reason = "import = require()";
      if (reason) {
        runnerReasons.push(`${rel}:${lineAt(text, node.getStart())}: ${reason}`);
        traversal.stop();
      }
    });
  }

  if (edits.length) edits.push(...importEdits(sf, imports, alreadyImported));
  const after = edits.length ? applyEdits(text, foldNestedEdits(text, edits)) : null;
  const webTypes = new Set<string>();
  if (ctx.isDenoProject && ctx.target === "node" && /\.[cm]?tsx?$/.test(rel)) {
    const declared = new Set<string>();
    for (const d of [...sf.getTypeAliases(), ...sf.getInterfaces(), ...sf.getClasses()]) declared.add(d.getName() ?? "");
    for (const i of sf.getImportDeclarations()) for (const n of i.getNamedImports()) declared.add(n.getAliasNode()?.getText() ?? n.getName());
    sf.forEachDescendant((node) => {
      if (!Node.isTypeReference(node)) return;
      const name = node.getTypeName().getText();
      if (!(name in WEB_TYPE_GLOBALS) || declared.has(name) || webTypes.has(name)) return;
      webTypes.add(name);
      add({ rule: "web-type-global", category: "typescript", fix: "auto", node, message: `${name}: a global type in Deno, not in @types/node`, replacement: `declared in deno-globals.d.ts as ${WEB_TYPE_GLOBALS[name]}` });
    });
  }
  return { findings, after: after !== text ? after : null, runnerReasons, webTypes: [...webTypes] };
}

/**
 * How each identifier name is used in the file: "type" when every reference sits in a type position (annotations,
 * type arguments, `implements`), "value" as soon as one reference could be a runtime use. Declarations and property
 * names are not references. Conservative: shadowed names count as values.
 */
function identifierUsage(sf: SourceFile): Map<string, "type" | "value"> {
  const usage = new Map<string, "type" | "value">();
  sf.forEachDescendant((node) => {
    if (!Node.isIdentifier(node)) return;
    const parent = node.getParent();
    if (!parent || Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent)) return;
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) return;
    if (Node.isQualifiedName(parent) && parent.getRight() === node) return;
    if (
      (Node.isPropertyAssignment(parent) || Node.isPropertySignature(parent) || Node.isPropertyDeclaration(parent) || Node.isMethodDeclaration(parent) ||
        Node.isMethodSignature(parent) || Node.isGetAccessorDeclaration(parent) || Node.isSetAccessorDeclaration(parent) || Node.isEnumMember(parent)) &&
      parent.getNameNode() === node
    ) return;
    if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === node) return;
    const name = node.getText();
    if (usage.get(name) === "value") return;
    usage.set(name, isTypePosition(node) ? "type" : "value");
  });
  return usage;
}

function isTypePosition(node: Node): boolean {
  for (let cur: Node | undefined = node.getParent(); cur; cur = cur.getParent()) {
    if (Node.isTypeQuery(cur)) return true; // typeof X in a type: fine with import type
    if (Node.isTypeNode(cur) && !Node.isExpressionWithTypeArguments(cur)) return true;
    if (Node.isExpressionWithTypeArguments(cur)) {
      const clause = cur.getParent();
      return Node.isHeritageClause(clause) && (clause.getToken() === SyntaxKind.ImplementsKeyword || Node.isInterfaceDeclaration(clause.getParent()));
    }
    if (Node.isExpression(cur) || Node.isStatement(cur) || Node.isExportSpecifier(cur) || Node.isJsxElement(cur)) return false;
  }
  return false;
}

/** Package name of a bare specifier ("hono/jsx" → "hono", "@a/b/c" → "@a/b"), or null for builtins, paths and URLs. */
function bareName(spec: string): string | null {
  if (/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:|#)/i.test(spec) || isBuiltin(spec)) return null;
  const m = /^(@[a-z0-9][\w.-]*\/[\w.-]+|[a-z0-9][\w.-]*)(?:\/|$)/i.exec(spec);
  return m ? m[1]! : null;
}

/** Identifiers that could clash with a new import: everything except property names (`Deno.serve`, `{ test: 1 }`). */
function declaredNames(sf: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const parent = id.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) continue;
    if ((Node.isPropertyAssignment(parent) || Node.isMethodDeclaration(parent) || Node.isPropertySignature(parent)) && parent.getNameNode() === id) continue;
    if (Node.isQualifiedName(parent) && parent.getRight() === id) continue;
    names.add(id.getText());
  }
  return names;
}

function indentOf(node: Node): number {
  const text = node.getSourceFile().getFullText();
  const lineStart = text.lastIndexOf("\n", node.getStart() - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0].length;
}

/** Removes up to `by` leading spaces from every line but the first, except lines in `keep` (0-based). */
function dedent(code: string, by: number, keep: ReadonlySet<number> = new Set()): string {
  if (by <= 0) return code;
  const re = new RegExp(`^[ ]{1,${by}}`);
  return code
    .split("\n")
    .map((line, i) => (i === 0 || keep.has(i) ? line : line.replace(re, "")))
    .join("\n");
}

/** Line numbers (0-based, relative to `node`) that start inside a template literal: their spaces are string content. */
function linesInsideTemplates(node: Node): Set<number> {
  const startLine = node.getStartLineNumber();
  const out = new Set<number>();
  node.forEachDescendant((d) => {
    if (!Node.isNoSubstitutionTemplateLiteral(d) && !Node.isTemplateExpression(d)) return;
    for (let line = d.getStartLineNumber() + 1; line <= d.getEndLineNumber(); line++) out.add(line - startLine);
  });
  return out;
}

function snippetOf(node: Node): string {
  const line = node.getText().split("\n")[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

function workersHint(chain: string[]): string {
  const first = chain[0] ?? "";
  if (first === "env") return "env bindings: the fetch handler's `env` argument (or process.env with nodejs_compat)";
  if (first === "serve") return "export default { fetch: handler }";
  if (/^(read|write|mkdir|remove|rename|copy|realPath|chmod|truncate)/.test(first)) return "Workers have no writable file system: KV, R2 or D1";
  if (first === "test") return "Vitest with @cloudflare/vitest-pool-workers, or node:test for plain logic";
  return "check the Workers runtime APIs (developers.cloudflare.com/workers/runtime-apis/)";
}

/** Same name patterns `deno test` and `node --test` pick up: *_test.ts, *.test.ts, test.ts, test/ folders. */
export function isTestFileName(rel: string): boolean {
  return /(^|[/\\._-])test\.[cm]?[jt]sx?$|(^|[/\\])tests?[/\\]/.test(rel);
}

function isFresh(spec: string): boolean {
  return /^\$fresh\/|^jsr:@fresh\/|^@fresh\/|deno\.land\/x\/fresh@?/.test(spec);
}
