import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { ts } from "ts-morph";

/** What a local module exports, by name: "type" (interface / type alias only) or "value". */
export type ExportKinds = Map<string, "type" | "value">;

const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js", "/mod.ts"];
const MAX_DEPTH = 8;

/**
 * Deno's transpiler drops an import whose names are only used as types, Node's type stripping does not
 * (nodejs.org/api/typescript: "the type keyword is necessary"). This reads the local module an import points at and
 * tells which names are types, following `export … from` and `export *` re-exports.
 */
export class TypeExportIndex {
  private readonly cache = new Map<string, ExportKinds | null>();
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Export kinds of the module `spec` imported from `fromRel`, or null when it is not a readable local TS file. */
  forImport(fromRel: string, spec: string): ExportKinds | null {
    if (!/^\.{1,2}\//.test(spec)) return null;
    return this.forLocal(normalize(join(dirname(fromRel), spec)));
  }

  /** Export kinds of a local module given by its path from the root (extension optional). */
  forLocal(fromRoot: string): ExportKinds | null {
    const rel = this.resolve(fromRoot);
    return rel ? this.kindsOf(rel, 0) : null;
  }

  /**
   * What an extensionless local import needs appended to work on Node ("" when the path exists as written, null when
   * nothing matches). Deno resolves "./util" only with --sloppy-imports; Node's ESM loader never does.
   */
  missingSuffix(fromRoot: string): string | null {
    if (/\.[cm]?[jt]sx?$|\.json$/.test(fromRoot) && existsSync(join(this.root, fromRoot))) return "";
    const found = this.resolve(fromRoot);
    return found ? found.slice(fromRoot.length) : null;
  }

  private resolve(base: string): string | null {
    for (const ext of EXTENSIONS) {
      const rel = base + ext;
      if (/\.[cm]?[jt]sx?$/.test(rel) && existsSync(join(this.root, rel))) return rel;
    }
    return null;
  }

  private kindsOf(rel: string, depth: number): ExportKinds | null {
    if (this.cache.has(rel)) return this.cache.get(rel)!;
    this.cache.set(rel, null); // cycle guard
    if (depth > MAX_DEPTH) return null;
    let text: string;
    try {
      text = readFileSync(join(this.root, rel), "utf8");
    } catch {
      return null;
    }
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const kinds: ExportKinds = new Map();
    const set = (name: string, kind: "type" | "value"): void => {
      // A name declared as both (`interface X` + `const X`) is a value.
      if (kinds.get(name) !== "value") kinds.set(name, kind);
    };
    const local = new Map<string, "type" | "value">();
    const exported = (node: ts.Node): boolean =>
      ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

    for (const st of sf.statements) {
      const isTypeDecl = ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st);
      const named =
        isTypeDecl || ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)
          ? (st as ts.DeclarationStatement).name
          : undefined;
      if (named && ts.isIdentifier(named)) {
        const kind = isTypeDecl ? "type" : "value";
        if (local.get(named.text) !== "value") local.set(named.text, kind);
        if (exported(st)) set(named.text, kind);
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          local.set(d.name.text, "value");
          if (exported(st)) set(d.name.text, "value");
        }
      }
    }

    for (const st of sf.statements) {
      if (!ts.isExportDeclaration(st)) continue;
      const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      const target = from && /^\.{1,2}\//.test(from) ? this.resolve(normalize(join(dirname(rel), from))) : null;
      const targetKinds = target ? this.kindsOf(target, depth + 1) : null;
      if (!st.exportClause) {
        // export * from "./x": unknown when the target cannot be read, so the whole module is unknown.
        if (!targetKinds) return this.done(rel, null);
        for (const [name, kind] of targetKinds) if (!kinds.has(name)) kinds.set(name, kind);
        continue;
      }
      if (!ts.isNamedExports(st.exportClause)) continue; // export * as ns: a value
      for (const el of st.exportClause.elements) {
        const source = (el.propertyName ?? el.name).text;
        const name = el.name.text;
        if (st.isTypeOnly || el.isTypeOnly) set(name, "type");
        else if (from) {
          const k = targetKinds?.get(source);
          if (k) set(name, k);
        } else {
          const k = local.get(source);
          if (k) set(name, k);
        }
      }
    }
    return this.done(rel, kinds);
  }

  private done(rel: string, kinds: ExportKinds | null): ExportKinds | null {
    this.cache.set(rel, kinds);
    return kinds;
  }
}
