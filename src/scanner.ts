import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { applyEdits as applyJsoncEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { Project, ts } from "ts-morph";
import { readDenoConfig, type DenoConfig } from "./deno-config.js";
import { scanDeployFile } from "./deploy.js";
import { walk } from "./files.js";
import { ImportResolver, configDirOf, planMapEntry, type MapEntryPlan } from "./import-map.js";
import { renderMigration } from "./report.js";
import { buildServeEntry } from "./serve-entry.js";
import { HONO_NODE_SERVER, WEB_TYPE_GLOBALS, scanSource } from "./source.js";
import { TypeExportIndex } from "./type-exports.js";
import { convertTask, DENO_TEST_GLOB, hintFor, type Runner } from "./tasks.js";
import type { DependencyPlan, FileChange, Finding, ScanOptions, ScanResult } from "./types.js";

export const TOOL_VERSIONS = {
  typescript: "^6.0.3",
  "@types/node": "^24.19.2",
  tsx: "^4.23.15",
};

const DENO_SIGNAL = /\b(?:from|import)\s*\(?\s*["'](?:jsr:|npm:|https:\/\/(?:esm\.town|deno\.land)\/)/;

const JSR_NPMRC = "@jsr:registry=https://npm.jsr.io";
const TS_KEYS_COPIED = [
  "strict",
  "noImplicitAny",
  "noImplicitReturns",
  "noImplicitThis",
  "noImplicitOverride",
  "noFallthroughCasesInSwitch",
  "noUnusedLocals",
  "noUnusedParameters",
  "noUncheckedIndexedAccess",
  "noPropertyAccessFromIndexSignature",
  "exactOptionalPropertyTypes",
  "useUnknownInCatchVariables",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictPropertyInitialization",
  "allowJs",
  "checkJs",
  "jsxImportSource",
  "jsxFactory",
  "jsxFragmentFactory",
  "experimentalDecorators",
  "emitDecoratorMetadata",
  "allowUnreachableCode",
  "allowUnusedLabels",
];

interface PackagePlan {
  dir: string;
  config: DenoConfig | null;
  deps: DependencyPlan;
  hasTests: boolean;
  subpathImports: Map<string, string>;
}

function newDeps(): DependencyPlan {
  return { dependencies: new Map(), devDependencies: new Map(), origin: new Map(), needsJsrRegistry: false };
}

export function scan(rootArg: string, options: ScanOptions): ScanResult {
  const root = resolve(rootArg);
  const files = walk(root);
  const findings: Finding[] = [];
  const changes: FileChange[] = [];
  const fixing = options.fix && options.target === "node";

  // ---- deno.json -----------------------------------------------------------------------------------------------
  const configs: DenoConfig[] = [];
  for (const rel of files.denoConfigs) {
    const cfg = readDenoConfig(root, rel);
    if ("error" in cfg) findings.push({ rule: "deno-config", category: "config", fix: "manual", file: rel, line: 1, message: `could not parse: ${cfg.error}` });
    else configs.push(cfg);
  }
  // Val Town exports and single-file scripts often have no deno.json: Deno-only specifiers count too.
  const isDenoProject = configs.length > 0 || files.source.some((rel) => DENO_SIGNAL.test(readFileSync(join(root, rel), "utf8")));
  const packages = new Map<string, PackagePlan>();
  const packageFor = (dir: string): PackagePlan => {
    let p = packages.get(dir);
    if (!p) packages.set(dir, (p = { dir, config: configs.find((c) => c.dir === dir) ?? null, deps: newDeps(), hasTests: false, subpathImports: new Map() }));
    return p;
  };
  for (const cfg of configs) packageFor(cfg.dir);
  const configDirs = configs.map((c) => c.dir);

  const addDependency = (dir: string, name: string, spec: string, origin: string): void => {
    const deps = packageFor(dir).deps;
    const existing = deps.dependencies.get(name);
    if (existing && existing !== spec) {
      findings.push({
        rule: "dependency-conflict",
        category: "specifier",
        fix: "manual",
        file: origin.replace(/:\d+$/, ""),
        line: Number(/:(\d+)$/.exec(origin)?.[1] ?? 1),
        message: `${name} is imported as ${existing} (${deps.origin.get(name)}) and as ${spec}: pick one version`,
      });
      return;
    }
    deps.dependencies.set(name, spec);
    if (!deps.origin.has(name)) deps.origin.set(name, origin);
    if (spec.startsWith("npm:@jsr/")) deps.needsJsrRegistry = true;
  };

  const mapPlans: Array<{ dir: string; entries: MapEntryPlan[]; lock: DenoConfig["lock"] }> = [];
  for (const cfg of configs) {
    const entries = cfg.imports.map((e) => planMapEntry(e, cfg));
    mapPlans.push({ dir: cfg.dir, entries, lock: cfg.lock });
    for (const e of entries) findings.push(...mapEntryFindings(e, options.target === "node"));
    if (fixing) for (const e of entries) if (e.subpathImport) packageFor(cfg.dir).subpathImports.set(e.subpathImport.key, e.subpathImport.target);
    findings.push(...configFindings(cfg, options));
  }
  const resolver = new ImportResolver(mapPlans);
  const memberNames = new Set(configs.map((c) => c.name).filter((n): n is string => !!n));
  const packageJsonDeps = new Map<string, Set<string>>();
  const depsIn = (d: string): Set<string> => {
    let deps = packageJsonDeps.get(d);
    if (deps) return deps;
    deps = new Set();
    const pkgPath = join(root, d, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string> | undefined>;
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) for (const n of Object.keys(pkg[field] ?? {})) deps.add(n);
      } catch {
        // A broken package.json is reported by npm; the import is then treated as unknown.
      }
    }
    packageJsonDeps.set(d, deps);
    return deps;
  };
  /** Deno resolves a bare import through the nearest package.json, a workspace member's name, or the package's own name. */
  const bareImport = (dir: string, name: string, origin: string): ReturnType<NonNullable<Parameters<typeof scanSource>[2]["bareImport"]>> => {
    if (memberNames.has(name)) return { kind: "known" };
    let known = false;
    for (let d = dirname(origin.replace(/:\d+$/, "")); ; d = dirname(d)) {
      if (depsIn(d).has(name)) known = true;
      if (d === "." || d === "/" || known) break;
    }
    if (known || packageFor(dir).deps.dependencies.has(name) || packages.get(".")?.deps.dependencies.has(name)) return { kind: "known" };
    const cfg = configs.find((c) => c.dir === dir) ?? configs.find((c) => c.dir === ".");
    const versions = cfg?.lockedNpm.get(name);
    if (versions?.size === 1) {
      const version = [...versions][0]!;
      if (fixing) addDependency(dir, name, version, origin);
      return { kind: "pinned", version };
    }
    return { kind: "unknown" };
  };
  const typeExports = options.target === "node" ? new TypeExportIndex(root) : undefined;

  // ---- source --------------------------------------------------------------------------------------------------
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve },
  });
  const runnerReasons: string[] = [];
  let usesDenoTest = false;
  const webTypes = new Set<string>();
  const quick = /\bDeno\b|jsr:|npm:|https?:\/\/|BroadcastChannel|import\.meta\.main|\bassert\s*\{|<reference/;
  for (const rel of files.source) {
    const text = readFileSync(join(root, rel), "utf8");
    const dir = configDirOf(rel, configDirs);
    if (/(^|[/_.])test\.[cm]?[jt]sx?$/.test(rel)) packageFor(dir).hasTests = isDenoProject || packageFor(dir).hasTests;
    if (!isDenoProject && !quick.test(text)) continue;
    const sf = project.createSourceFile(rel, text, { overwrite: true });
    let result;
    try {
      result = scanSource(rel, sf, {
        target: options.target,
        isDenoProject,
        resolver,
        typeExports,
        bareImport: (name, origin) => bareImport(dir, name, origin),
        addDependency: (name, spec, origin) => addDependency(dir, name, spec, origin),
      });
    } catch (err) {
      findings.push({ rule: "scan-error", category: "api", fix: "manual", file: rel, line: 1, message: `not scanned: ${(err as Error).message}` });
      continue;
    } finally {
      project.removeSourceFile(sf);
    }
    findings.push(...result.findings);
    for (const t of result.webTypes) webTypes.add(t);
    if (isDenoProject) runnerReasons.push(...result.runnerReasons);
    if (result.findings.some((f) => f.rule === "deno-api" && /^test\(\) from node:test/.test(f.replacement ?? ""))) usesDenoTest = true;
    if (fixing && result.after !== null) changes.push({ file: rel, before: text, after: result.after });
  }

  // ---- import-map aliases become dependencies only when something imports them --------------------------------
  for (const cfg of configs) {
    const jsxSource = cfg.compilerOptions?.value.jsxImportSource;
    if (typeof jsxSource === "string") resolver.resolve(jsxSource, join(cfg.dir, "deno.json"));
  }
  // Fresh's own modules import preact & co. through the project's map, and @types/* entries only feed the checker.
  const usesFresh = findings.some((f) => f.rule === "fresh");
  for (const { dir, entries } of mapPlans) {
    for (const e of entries) {
      if (!e.alias) continue;
      if (resolver.used.has(e) || usesFresh || e.key.startsWith("@types/")) {
        if (fixing) addDependency(dir, e.alias.name, e.alias.spec, `${e.file}:${e.line}`);
      } else {
        const at = findings.findIndex((f) => f.rule === "import-map-entry" && f.file === e.file && f.line === e.line);
        if (at !== -1) findings.splice(at, 1);
        findings.push({ rule: "import-map-unused", category: "config", fix: "info", file: e.file, line: e.line, message: `import-map entry "${e.key}" is not imported by any file: left out of package.json` });
      }
    }
  }

  // ---- deploy / CI ---------------------------------------------------------------------------------------------
  for (const rel of files.deploy) {
    findings.push(...scanDeployFile(rel, readFileSync(join(root, rel), "utf8"), options.target));
  }
  for (const cfg of configs) {
    if (cfg.deploy) {
      findings.push({ rule: "deno-json-deploy", category: "deploy", fix: "manual", file: cfg.file, line: cfg.deploy.line, message: "deno.json \"deploy\" settings (Deno Deploy project, entrypoint)", replacement: options.target === "workers" ? "wrangler.jsonc" : "your new host's config" });
    }
  }

  const tool: ScanResult["runner"]["tool"] =
    options.target === "bun" ? "bun" : options.target === "workers" ? "wrangler" : runnerReasons.length ? "tsx" : "node";
  const runner: Runner = tool === "bun" ? "bun" : tool === "tsx" ? "tsx" : "node";

  // ---- tasks (need the runner) ---------------------------------------------------------------------------------
  const scripts = new Map<string, Map<string, string>>();
  const serveEntries = new Map<string, string>();
  const serveEntryFor = (cfg: DenoConfig, script: string, port: number, line: number): string | null => {
    const key = join(cfg.dir, script);
    if (serveEntries.has(key)) return serveEntries.get(key)!;
    const entry = buildServeEntry(cfg.dir, script, port, root);
    if (!entry || existsSync(join(root, cfg.dir, entry.file))) return null;
    const file = join(cfg.dir, entry.file);
    serveEntries.set(key, entry.file);
    findings.push({ rule: "serve-entry", category: "config", fix: "auto", file: cfg.file, line, message: `\`deno serve ${script}\`: Node entry ${file} serves the default export with @hono/node-server`, replacement: entry.file });
    if (fixing) {
      changes.push({ file, before: null, after: entry.text });
      addDependency(cfg.dir, HONO_NODE_SERVER.name, HONO_NODE_SERVER.range, `${cfg.file}:${line}`);
    }
    return entry.file;
  };
  for (const cfg of configs) {
    const out = new Map<string, string>();
    for (const task of cfg.tasks) {
      const conv = convertTask(task.command, task.dependencies, runner, {
        serveEntry: options.target === "node" ? (script, port) => serveEntryFor(cfg, script, port, task.line) : undefined,
        isDirectory: (path) => isDirectory(join(root, cfg.dir, path)),
      });
      out.set(task.name, conv.script);
      const notes = conv.notes.length ? ` (${conv.notes.join("; ")})` : "";
      if (conv.manual.length) {
        findings.push({
          rule: "task",
          category: "config",
          fix: "manual",
          file: cfg.file,
          line: task.line,
          message: `task "${task.name}" still needs: ${conv.manual.join(", ")}${notes}`,
          replacement: conv.manual.map(hintFor).filter(Boolean).join("; ") || undefined,
        });
      } else {
        findings.push({ rule: "task", category: "config", fix: options.target === "node" ? "auto" : "manual", file: cfg.file, line: task.line, message: `task "${task.name}" → npm script${notes}`, replacement: conv.script });
      }
      if (conv.usesTsc) packageFor(cfg.dir).deps.devDependencies.set("typescript", TOOL_VERSIONS.typescript);
    }
    scripts.set(cfg.dir, out);
  }

  if (isDenoProject && runnerReasons.length && options.target === "node") {
    findings.push({
      rule: "ts-runner",
      category: "typescript",
      fix: "info",
      file: runnerReasons[0]!.split(":")[0]!,
      line: Number(/:(\d+):/.exec(runnerReasons[0]!)?.[1] ?? 1),
      message: `TypeScript that Node's type stripping cannot run (${runnerReasons.length} file${runnerReasons.length > 1 ? "s" : ""}): scripts use tsx`,
      replacement: runnerReasons.slice(0, 5).join("; "),
    });
  }

  const result: ScanResult = {
    root,
    target: options.target,
    denoConfigs: configs.map((c) => c.file),
    findings: sortFindings(findings),
    changes,
    fixed: [],
    runner: { tool, reasons: runnerReasons },
  };

  if (fixing && webTypes.size && !existsSync(join(root, "deno-globals.d.ts"))) {
    const lines = [...webTypes].sort().map((t) => `  type ${t} = ${WEB_TYPE_GLOBALS[t]};`);
    changes.push({
      file: "deno-globals.d.ts",
      before: null,
      after: ["// Web API type names that Deno declares globally and @types/node does not (written by deno-exit).", "declare global {", ...lines, "}", "export {};", ""].join("\n"),
    });
  }

  if (fixing && (isDenoProject || changes.length)) {
    if (!packages.size) packageFor(".");
    for (const pkg of packages.values()) {
      if (usesDenoTest) pkg.hasTests = true;
      pinNodeServerForHono(root, pkg, packages.get(".") ?? pkg, result);
      changes.push(...packageChanges(root, pkg, scripts.get(pkg.dir) ?? new Map(), runner, configs, result));
    }
    result.fixed = result.findings.filter((f) => f.fix === "auto");
    changes.push(fileChange(root, "MIGRATION.md", renderMigration(result)));
  }
  return result;
}

function mapEntryFindings(e: MapEntryPlan, nodeTarget: boolean): Finding[] {
  const at = { file: e.file, line: e.line, snippet: `"${e.key}": "${e.target}"` };
  if (e.subpathImport) {
    return [{ rule: "import-map-entry", category: "config", fix: nodeTarget ? "auto" : "manual", ...at, message: `import-map alias "${e.key}" → package.json "imports" (Node subpath imports; imports stay as written)`, replacement: `"${e.subpathImport.key}": "${e.subpathImport.target}"` }];
  }
  if (e.relativeTarget !== undefined) {
    return [{ rule: "import-map-alias", category: "config", fix: "info", ...at, message: `import-map alias "${e.key}" → ${e.relativeTarget}: imports through it become relative paths` }];
  }
  const plan = e.plan;
  if (!plan) return [];
  if (/^jsr:@fresh\/|deno\.land\/x\/fresh@?/.test(e.target)) {
    return [{ rule: "fresh", category: "decision", fix: "decision", ...at, message: "Fresh framework in the import map", replacement: "see MIGRATION.md: Fresh" }];
  }
  if (e.alias) {
    return [{ rule: "import-map-entry", category: "config", fix: nodeTarget ? "auto" : "manual", ...at, message: `import map → package.json dependency (imports stay as written)`, replacement: `"${e.alias.name}": "${e.alias.spec}"` }];
  }
  if (plan.fix === "auto") {
    return [{ rule: "import-map-entry", category: "config", fix: "info", ...at, message: `${plan.message}; imports through "${e.key}" are rewritten where used` }];
  }
  return [{ rule: `specifier-${plan.kind}`, category: plan.fix === "decision" ? "decision" : "config", fix: plan.fix, ...at, message: plan.message, replacement: plan.replacement }];
}

function configFindings(cfg: DenoConfig, options: ScanOptions): Finding[] {
  const out: Finding[] = [];
  const f = (rule: string, line: number, fix: Finding["fix"], message: string, replacement?: string): void => {
    out.push({ rule, category: "config", fix, file: cfg.file, line, message, replacement });
  };
  const nodeTarget = options.target === "node";
  if (cfg.compilerOptions) {
    const jsx = cfg.compilerOptions.value.jsx;
    f("compiler-options", cfg.compilerOptions.line, nodeTarget ? "auto" : "manual", `compilerOptions → tsconfig.json${jsx ? ` (jsx: ${String(jsx)}${jsx === "precompile" ? " is Deno-only; becomes react-jsx" : ""})` : ""}`);
  }
  if (cfg.lint) f("lint-config", cfg.lint.line, "manual", "deno lint settings", "ESLint or Biome; rules are not converted");
  if (cfg.fmt) f("fmt-config", cfg.fmt.line, "manual", "deno fmt settings", "Prettier or Biome (e.g. lineWidth → printWidth)");
  if (cfg.nodeModulesDir) f("node-modules-dir", cfg.nodeModulesDir.line, "info", `nodeModulesDir: ${JSON.stringify(cfg.nodeModulesDir.value)}: npm always installs into node_modules`);
  if (cfg.unstable?.value.length) f("unstable", cfg.unstable.line, "info", `unstable features: ${cfg.unstable.value.join(", ")} (each use is listed by file)`);
  if (cfg.hasScopes) f("import-map-scopes", cfg.hasScopes.line, "manual", "import map \"scopes\"", "npm overrides in package.json");
  if (cfg.workspace?.value.length) f("workspace", cfg.workspace.line, nodeTarget ? "auto" : "manual", `Deno workspace (${cfg.workspace.value.join(", ")})`, "npm workspaces in the root package.json");
  if (cfg.importMap) f("import-map-file", cfg.importMap.line, "info", `external import map ${cfg.importMap.value}: read like "imports"`);
  if (cfg.name) f("jsr-package", 1, "info", `JSR package ${cfg.name}: \`npx jsr publish\` publishes from Node (needs a jsr.json or this deno.json)`);
  return out;
}

const SEVERITY: Record<Finding["fix"], number> = { decision: 0, manual: 1, auto: 2, info: 3 };

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || SEVERITY[a.fix] - SEVERITY[b.fix]);
}

function fileChange(root: string, rel: string, after: string): FileChange {
  const abs = join(root, rel);
  const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  return { file: rel, before, after };
}

function packageName(cfg: DenoConfig | null, dir: string, root: string): string {
  const raw = cfg?.name ?? basename(dir === "." ? root : dir);
  const clean = raw.toLowerCase().replace(/[^a-z0-9@/._-]+/g, "-").replace(/^[._-]+/, "");
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(clean) ? clean : "app";
}

function packageChanges(root: string, pkg: PackagePlan, tasks: Map<string, string>, runner: Runner, configs: DenoConfig[], result: ScanResult): FileChange[] {
  const changes: FileChange[] = [];
  const rel = (name: string): string => (pkg.dir === "." ? name : join(pkg.dir, name));
  const pkgPath = join(root, rel("package.json"));
  const existing = existsSync(pkgPath) ? readJsonObject(pkgPath) : null;
  if (existing === undefined) {
    result.findings.push({ rule: "package-json", category: "config", fix: "manual", file: rel("package.json"), line: 1, message: "package.json is not valid JSON, so it was left as is", replacement: "fix the JSON, then run --fix again" });
    return changes;
  }
  const out: Record<string, unknown> = existing ? { ...existing } : { name: packageName(pkg.config, pkg.dir, root), private: true };

  if (!out.type) out.type = "module";
  else if (out.type !== "module") {
    result.findings.push({ rule: "package-type", category: "config", fix: "manual", file: rel("package.json"), line: 1, message: `package.json has "type": "${String(out.type)}"; Deno code is ESM`, replacement: "\"type\": \"module\" or .mts/.mjs file names" });
  }
  if (!out.engines) out.engines = { node: ">=22.18" };

  const scripts = { ...((out.scripts as Record<string, string> | undefined) ?? {}) };
  for (const [name, cmd] of tasks) if (!(name in scripts)) scripts[name] = cmd;
  // Node's own default also runs every file under test/ folders (fixtures, helpers); deno test does not.
  if (pkg.hasTests && !scripts.test) scripts.test = runner === "bun" ? "bun test" : `${runner === "tsx" ? "tsx --test" : "node --test"} "**/${DENO_TEST_GLOB}"`;
  if (!scripts.typecheck && !Object.values(scripts).some((s) => /\btsc\b/.test(s))) scripts.typecheck = "tsc --noEmit";
  out.scripts = scripts;

  // deno.json "exports" → package.json "exports": Node then resolves self-imports and workspace links the same way.
  const exp = pkg.config?.exports?.value;
  if (exp && !out.exports && (typeof exp === "string" || (typeof exp === "object" && Object.values(exp).every((v) => typeof v === "string")))) {
    out.exports = typeof exp === "string" ? { ".": exp } : exp;
  }

  const workspace = pkg.config?.workspace?.value;
  if (workspace?.length && !out.workspaces) out.workspaces = workspace.map((w) => w.replace(/^\.\//, ""));

  const deps = { ...((out.dependencies as Record<string, string> | undefined) ?? {}) };
  for (const [name, spec] of pkg.deps.dependencies) if (!(name in deps)) deps[name] = spec;
  if (Object.keys(deps).length) out.dependencies = sortObject(deps);

  if (pkg.subpathImports.size) {
    const imports = { ...((out.imports as Record<string, string> | undefined) ?? {}) };
    for (const [key, target] of pkg.subpathImports) if (!(key in imports)) imports[key] = target;
    out.imports = imports;
  }

  const isRootPackage = pkg.dir === "." || !configs.some((c) => c.dir === "." && c.workspace);
  if (isRootPackage) {
    const dev = { ...((out.devDependencies as Record<string, string> | undefined) ?? {}) };
    const wanted: Record<string, string> = { typescript: TOOL_VERSIONS.typescript, "@types/node": TOOL_VERSIONS["@types/node"] };
    if (runner === "tsx") wanted.tsx = TOOL_VERSIONS.tsx;
    for (const [name, v] of Object.entries(wanted)) if (!(name in dev) && !(name in deps)) dev[name] = v;
    out.devDependencies = sortObject(dev);
  }
  changes.push({ file: rel("package.json"), before: existing ? readFileSync(pkgPath, "utf8") : null, after: `${JSON.stringify(out, null, 2)}\n` });

  if (pkg.deps.needsJsrRegistry) {
    const npmrcRel = pkg.dir === "." || !configs.some((c) => c.dir === ".") ? rel(".npmrc") : ".npmrc";
    const abs = join(root, npmrcRel);
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (!before?.includes(JSR_NPMRC) && !changes.some((c) => c.file === npmrcRel)) {
      changes.push({ file: npmrcRel, before, after: `${before ? `${before.trimEnd()}\n` : ""}${JSR_NPMRC}\n` });
    }
  }

  const tsconfigPath = join(root, rel("tsconfig.json"));
  if (!existsSync(tsconfigPath) && (pkg.dir === "." || pkg.config?.compilerOptions)) {
    changes.push({ file: rel("tsconfig.json"), before: null, after: `${JSON.stringify(buildTsconfig(pkg.config, runner, result.runner.reasons.some((r) => /JSX\/TSX/.test(r))), null, 2)}\n` });
  } else if (existsSync(tsconfigPath)) {
    const before = readFileSync(tsconfigPath, "utf8");
    const after = allowTsExtensions(before);
    if (after) {
      changes.push({ file: rel("tsconfig.json"), before, after });
      result.findings.push({ rule: "tsconfig-exists", category: "typescript", fix: "auto", file: rel("tsconfig.json"), line: 1, message: "existing tsconfig.json (noEmit): allowImportingTsExtensions added so tsc accepts the .ts import paths Node needs; nothing else changed" });
    } else {
      result.findings.push({ rule: "tsconfig-exists", category: "typescript", fix: "manual", file: rel("tsconfig.json"), line: 1, message: "tsconfig.json already exists: not overwritten", replacement: "add allowImportingTsExtensions, noEmit, module nodenext, types [\"node\"]" });
    }
  }
  return changes;
}

/**
 * True when no version the spec allows reaches `min`: an exact pin or a ~/x-range below it. Caret ranges and bare
 * majors install the newest matching release, so `^4.4.0` still gets a hono >= 4.6.7.
 */
function cannotReach(spec: string, min: readonly number[]): boolean {
  const range = spec.replace(/^npm:(@?[^@]+)@/, "").trim();
  const m = /^([~^=v]?)\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(range);
  if (!m) return false;
  const [op, major, minor, patch] = [m[1], Number(m[2]), m[3], m[4]];
  if (major !== min[0]) return major < min[0]!;
  if (op === "^" || minor === undefined || minor === "x" || minor === "*") return false;
  const mi = Number(minor);
  if (mi !== min[1]) return mi < min[1]!;
  if (op === "~" || patch === undefined || patch === "x" || patch === "*") return false;
  return Number(patch) < min[2]!;
}

/** A project that pins an older hono gets @hono/node-server 1.x, which does not need hono/ws. */
function pinNodeServerForHono(root: string, pkg: PackagePlan, rootPkg: PackagePlan, result: ScanResult): void {
  const deps = pkg.deps.dependencies;
  if (deps.get(HONO_NODE_SERVER.name) !== HONO_NODE_SERVER.range) return;
  let hono = deps.get("hono") ?? rootPkg.deps.dependencies.get("hono");
  const pkgPath = join(root, pkg.dir, "package.json");
  if (!hono && existsSync(pkgPath)) hono = (readJsonObject(pkgPath)?.dependencies as Record<string, string> | undefined)?.hono;
  if (!hono || !cannotReach(hono, HONO_NODE_SERVER.minHono)) return;
  deps.set(HONO_NODE_SERVER.name, HONO_NODE_SERVER.legacyRange);
  result.findings.push({
    rule: "node-server-version",
    category: "config",
    fix: "auto",
    file: pkg.dir === "." ? "package.json" : join(pkg.dir, "package.json"),
    line: 1,
    message: `hono ${hono} stays below 4.6.7, which @hono/node-server 2.x needs (hono/ws): using @hono/node-server ${HONO_NODE_SERVER.legacyRange}`,
  });
}

/**
 * Adds `allowImportingTsExtensions: true` to an existing tsconfig, keeping its comments and layout. Only when the file
 * itself sets noEmit (TypeScript allows the option only with noEmit or emitDeclarationOnly); null otherwise.
 */
export function allowTsExtensions(text: string): string | null {
  const errors: ParseError[] = [];
  const json = parseJsonc(text, errors, { allowTrailingComma: true }) as { compilerOptions?: Record<string, unknown> } | undefined;
  const co = json?.compilerOptions;
  if (errors.length || !co || co.noEmit !== true || co.allowImportingTsExtensions === true) return null;
  const edits = modify(text, ["compilerOptions", "allowImportingTsExtensions"], true, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  return applyJsoncEdits(text, edits);
}

export function buildTsconfig(cfg: DenoConfig | null, runner: Runner, hasJsx = false): Record<string, unknown> {
  const deno = cfg?.compilerOptions?.value ?? {};
  const co: Record<string, unknown> = {
    target: "esnext",
    module: "nodenext",
    noEmit: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    ...(runner === "node" ? { erasableSyntaxOnly: true } : {}),
    strict: true,
    skipLibCheck: true,
    types: ["node"],
  };
  // deno.ns / deno.window pull in esnext, so a lib list that only kept "dom" next to them needs it back.
  const denoLib = Array.isArray(deno.lib) ? (deno.lib as string[]) : [];
  const lib = denoLib.filter((l) => !/^deno\./i.test(l));
  const hadDenoLib = lib.length < denoLib.length;
  if (!lib.some((l) => /^esnext$/i.test(l)) && (hadDenoLib || !lib.some((l) => /^es(\d{4}|[3-6])$/i.test(l)))) lib.unshift("esnext");
  co.lib = lib;
  for (const key of TS_KEYS_COPIED) if (key in deno) co[key] = deno[key];
  const jsx = deno.jsx;
  if (typeof jsx === "string") co.jsx = jsx === "precompile" || jsx === "react-jsxdev" ? "react-jsx" : jsx;
  if (deno.jsxImportSource && !co.jsx) co.jsx = "react-jsx";
  // Deno's built-in default is the classic transform (docs.deno.com/runtime/reference/jsx).
  if (hasJsx && !co.jsx) co.jsx = "react";
  const exclude = (cfg?.exclude ?? []).filter((e) => !e.startsWith("!"));
  return { compilerOptions: co, exclude: ["node_modules", ...exclude.map((e) => e.replace(/^\.\//, ""))] };
}

function sortObject(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

export function writeChanges(root: string, changes: FileChange[]): void {
  for (const c of changes) {
    const abs = join(root, c.file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, c.after);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The parsed object, null when the file holds something else, undefined when it is not valid JSON. */
function readJsonObject(path: string): Record<string, unknown> | null | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return undefined;
  }
}
