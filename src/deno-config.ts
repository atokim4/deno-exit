import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { findNodeAtLocation, getNodeValue, parseTree, type Node as JsonNode } from "jsonc-parser";
import { lineAt } from "./files.js";
import type { LockedVersions } from "./specifiers.js";

export interface ConfigEntry<T> {
  value: T;
  line: number;
}

export interface DenoConfig {
  file: string;
  dir: string;
  text: string;
  tasks: Array<{ name: string; command: string; dependencies: string[]; line: number }>;
  imports: Array<{ key: string; target: string; line: number; file: string }>;
  hasScopes: ConfigEntry<true> | null;
  compilerOptions: ConfigEntry<Record<string, unknown>> | null;
  lint: ConfigEntry<unknown> | null;
  fmt: ConfigEntry<unknown> | null;
  nodeModulesDir: ConfigEntry<unknown> | null;
  unstable: ConfigEntry<string[]> | null;
  deploy: ConfigEntry<unknown> | null;
  workspace: ConfigEntry<string[]> | null;
  exclude: string[];
  /** External import map file (`"importMap": "./import_map.json"`). */
  importMap: ConfigEntry<string> | null;
  name: string | null;
  /** deno.json "exports" (a path, or a map of subpaths to paths). */
  exports: ConfigEntry<unknown> | null;
  lock: LockedVersions;
  /** npm packages in deno.lock by name, with every resolved version (transitive ones included). */
  lockedNpm: Map<string, Set<string>>;
}

function entry<T>(tree: JsonNode, text: string, key: string): ConfigEntry<T> | null {
  const node = findNodeAtLocation(tree, [key]);
  if (!node) return null;
  return { value: getNodeValue(node) as T, line: lineAt(text, node.parent?.offset ?? node.offset) };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** deno.lock v3-v5 keep `"specifiers": { "jsr:@std/path@^1": "1.0.8", "npm:zod@3": "3.23.8" }`. */
export function readLock(dir: string): LockedVersions {
  const out: LockedVersions = new Map();
  const file = join(dir, "deno.lock");
  if (!existsSync(file)) return out;
  try {
    const lock = JSON.parse(readFileSync(file, "utf8")) as { specifiers?: Record<string, string>; packages?: { specifiers?: Record<string, string> } };
    const specs = lock.specifiers ?? lock.packages?.specifiers ?? {};
    for (const [spec, resolved] of Object.entries(specs)) {
      // v3: "npm:zod@3" -> "npm:zod@3.23.8"; v4+: -> "3.23.8" (npm entries may carry "_peer" suffixes)
      const version = /(\d+\.\d+\.\d+[\w.+-]*?)(?:_.*)?$/.exec(resolved)?.[1];
      if (version) out.set(spec, version);
    }
  } catch {
    // An unreadable lockfile only costs us version pins.
  }
  return out;
}

export function readLockedNpm(dir: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const file = join(dir, "deno.lock");
  if (!existsSync(file)) return out;
  try {
    const lock = JSON.parse(readFileSync(file, "utf8")) as { npm?: Record<string, unknown>; packages?: { npm?: Record<string, unknown> } };
    for (const key of Object.keys(lock.npm ?? lock.packages?.npm ?? {})) {
      // "preact-render-to-string@6.7.0" or "@scope/name@1.2.3_peer@4.5.6"
      const m = /^(@?[^@]+)@(\d+\.\d+\.\d+[^_]*)/.exec(key);
      if (!m) continue;
      const versions = out.get(m[1]!) ?? new Set<string>();
      versions.add(m[2]!);
      out.set(m[1]!, versions);
    }
  } catch {
    // An unreadable lockfile only costs us version pins.
  }
  return out;
}

function importsFrom(tree: JsonNode | undefined, text: string, file: string): DenoConfig["imports"] {
  const node = tree && findNodeAtLocation(tree, ["imports"]);
  const out: DenoConfig["imports"] = [];
  for (const prop of node?.children ?? []) {
    const [k, v] = prop.children ?? [];
    if (k && v && typeof k.value === "string" && typeof v.value === "string") {
      out.push({ key: k.value, target: v.value, line: lineAt(text, prop.offset), file });
    }
  }
  return out;
}

/** `deno test --import-map import_map.json`: a map passed only on the command line still decides how imports resolve. */
function importMapFromTasks(tasks: DenoConfig["tasks"]): ConfigEntry<string> | null {
  for (const task of tasks) {
    const m = /(?:^|\s)--import-map(?:=|\s+)(["']?)([^\s"']+)\1/.exec(task.command);
    if (m) return { value: m[2]!, line: task.line };
  }
  return null;
}

export function readDenoConfig(root: string, rel: string): DenoConfig | { file: string; error: string } {
  const text = readFileSync(join(root, rel), "utf8");
  const tree = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  if (!tree || tree.type !== "object") return { file: rel, error: "not a JSON object" };

  const dir = dirname(rel);
  const tasks: DenoConfig["tasks"] = [];
  for (const prop of findNodeAtLocation(tree, ["tasks"])?.children ?? []) {
    const [k, v] = prop.children ?? [];
    if (!k || !v || typeof k.value !== "string") continue;
    const value = getNodeValue(v) as unknown;
    const line = lineAt(text, prop.offset);
    if (typeof value === "string") tasks.push({ name: k.value, command: value, dependencies: [], line });
    else if (value && typeof value === "object") {
      const obj = value as { command?: unknown; dependencies?: unknown };
      tasks.push({
        name: k.value,
        command: typeof obj.command === "string" ? obj.command : "",
        dependencies: stringArray(obj.dependencies),
        line,
      });
    }
  }

  let imports = importsFrom(tree, text, rel);
  let importMap = entry<string>(tree, text, "importMap");
  if (!importMap && !imports.length) importMap = importMapFromTasks(tasks);
  if (importMap && typeof importMap.value === "string") {
    const mapFile = join(root, dir, importMap.value);
    if (existsSync(mapFile)) {
      const mapText = readFileSync(mapFile, "utf8");
      const mapTree = parseTree(mapText, [], { allowTrailingComma: true });
      imports = imports.concat(importsFrom(mapTree, mapText, normalize(join(dir, importMap.value))));
    }
  }

  const unstable = entry<unknown>(tree, text, "unstable");
  const workspace = entry<unknown>(tree, text, "workspace");
  const scopes = entry<unknown>(tree, text, "scopes");
  const excludeNode = findNodeAtLocation(tree, ["exclude"]);
  const exclude = excludeNode ? stringArray(getNodeValue(excludeNode)) : [];
  const nameNode = findNodeAtLocation(tree, ["name"]);

  return {
    file: rel,
    dir,
    text,
    tasks,
    imports,
    hasScopes: scopes ? { value: true, line: scopes.line } : null,
    compilerOptions: entry<Record<string, unknown>>(tree, text, "compilerOptions"),
    lint: entry(tree, text, "lint"),
    fmt: entry(tree, text, "fmt"),
    nodeModulesDir: entry(tree, text, "nodeModulesDir"),
    unstable: unstable ? { value: stringArray(unstable.value), line: unstable.line } : null,
    deploy: entry(tree, text, "deploy"),
    workspace: workspace
      ? { value: Array.isArray(workspace.value) ? stringArray(workspace.value) : stringArray((workspace.value as { members?: unknown })?.members), line: workspace.line }
      : null,
    exclude,
    importMap,
    name: typeof nameNode?.value === "string" ? nameNode.value : null,
    exports: entry<unknown>(tree, text, "exports"),
    lock: readLock(join(root, dir)),
    lockedNpm: readLockedNpm(join(root, dir)),
  };
}
