import { dirname, join, normalize, relative, sep } from "node:path";
import type { DenoConfig } from "./deno-config.js";
import { relativeSpecifier } from "./files.js";
import { isValidNpmName, planSpecifier, type LockedVersions, type SpecPlan } from "./specifiers.js";

export type Resolution =
  /** Import map points at a local path: the import becomes a relative path. */
  | { kind: "relative"; relative: string }
  /** The key works as a package.json (alias) dependency name: the import stays. */
  | { kind: "alias"; caveat?: SpecPlan["caveat"] }
  /** Key of a package.json subpath import ("#src/"): the import stays; `local` is the file it points at, from the root. */
  | { kind: "subpath"; local: string }
  /** Resolve to the map's target and plan that. */
  | { kind: "target"; resolved: string; lock: LockedVersions };

export interface MapEntryPlan {
  key: string;
  target: string;
  file: string;
  line: number;
  configDir: string;
  /** Set when the entry becomes a package.json dependency named after the key. */
  alias?: { name: string; spec: string };
  plan: SpecPlan | null;
  relativeTarget?: string;
  /** `"#src/": "./src/"` becomes package.json `"imports": { "#src/*": "./src/*" }`, so the imports stay as written. */
  subpathImport?: { key: string; target: string };
}

function isFreshTarget(target: string): boolean {
  return /^jsr:@fresh\/|deno\.land\/x\/fresh@?/.test(target);
}

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Plans one import-map entry. The package.json alias form (`"hono": "npm:@jsr/hono__hono@^4"`) keeps every import
 * in the code unchanged, so it is used whenever the key is a valid npm name and the target has no subpath.
 */
export function planMapEntry(entry: DenoConfig["imports"][number], config: Pick<DenoConfig, "dir" | "lock">): MapEntryPlan {
  const base: MapEntryPlan = { key: entry.key, target: entry.target, file: entry.file, line: entry.line, configDir: config.dir, plan: null };
  if (/^\.{0,2}\//.test(entry.target)) {
    const subpath = subpathImportFor(entry.key, entry.target);
    if (subpath) return { ...base, subpathImport: subpath };
    const path = normalize(join(config.dir, entry.target));
    return { ...base, relativeTarget: entry.target.endsWith("/") && !path.endsWith("/") ? `${path}/` : path };
  }
  const plan = planSpecifier(stripSlash(entry.target), config.lock);
  const result = { ...base, plan };
  if (!plan || plan.fix !== "auto" || !plan.name || !plan.dep || isFreshTarget(entry.target)) return result;
  const keyName = stripSlash(entry.key);
  const prefixPair = entry.key.endsWith("/") === entry.target.endsWith("/");
  if (!isValidNpmName(keyName) || plan.rewrite !== plan.name || !prefixPair) return result;
  const spec = keyName === plan.name ? plan.dep : plan.dep.startsWith("npm:") ? plan.dep : `npm:${plan.name}@${plan.dep}`;
  return { ...result, alias: { name: keyName, spec } };
}

/**
 * Node's package.json "imports" field takes keys that start with "#" (nodejs.org/api/packages: subpath imports), and
 * TypeScript resolves them under module nodenext. "#/" is left out: Node only accepts it from v25.4.
 */
function subpathImportFor(key: string, target: string): MapEntryPlan["subpathImport"] {
  if (!/^#[^/]/.test(key) || !target.startsWith("./") || key.includes("*") || target.includes("*")) return undefined;
  if (key.endsWith("/") !== target.endsWith("/")) return undefined;
  return key.endsWith("/") ? { key: `${key}*`, target: `${target}*` } : { key, target };
}

interface ScopeMap {
  dir: string;
  entries: MapEntryPlan[];
  lock: LockedVersions;
}

/** Resolves bare specifiers through the import map of the deno.json that owns a file (workspace members inherit the root's). */
export class ImportResolver {
  private readonly maps: ScopeMap[];
  private readonly rootLock: LockedVersions;
  /** Entries some import went through: only those become dependencies (Deno never fetches an unused entry). */
  readonly used = new Set<MapEntryPlan>();

  constructor(configs: Array<{ dir: string; entries: MapEntryPlan[]; lock: LockedVersions }>) {
    // Deepest directory first, so a member's map wins over the root's.
    this.maps = [...configs].sort((a, b) => b.dir.length - a.dir.length);
    this.rootLock = this.maps.find((m) => m.dir === ".")?.lock ?? new Map();
  }

  private mapsFor(file: string): ScopeMap[] {
    return this.maps.filter((m) => m.dir === "." || file.startsWith(m.dir + sep) || file.startsWith(m.dir + "/"));
  }

  lockFor(file: string): LockedVersions {
    const own = this.mapsFor(file)[0]?.lock;
    return own && own.size ? own : this.rootLock;
  }

  resolve(spec: string, file: string): Resolution | null {
    if (/^\.{0,2}\/|^[a-z]+:/i.test(spec)) return null;
    for (const map of this.mapsFor(file)) {
      let best: MapEntryPlan | undefined;
      for (const e of map.entries) {
        // Deno lets a jsr:/npm: entry without a trailing slash cover its subpaths too ("@std/path" → "@std/path/join").
        const packageEntry = /^(jsr|npm):/.test(e.target) && !e.key.endsWith("/");
        const hit = e.key === spec || (e.key.endsWith("/") && spec.startsWith(e.key)) || (packageEntry && spec.startsWith(`${e.key}/`));
        if (hit && (!best || e.key.length > best.key.length)) best = e;
      }
      if (!best) continue;
      this.used.add(best);
      const rest = spec.slice(best.key.length);
      if (best.subpathImport) return { kind: "subpath", local: normalize(join(map.dir, best.target + rest)) };
      if (best.relativeTarget !== undefined) {
        return { kind: "relative", relative: relativeSpecifier(file, best.relativeTarget + rest) };
      }
      if (best.alias) return { kind: "alias", caveat: rest ? stdCaveatForSubpath(best, rest) : best.plan?.caveat };
      const lock = map.lock.size ? map.lock : this.rootLock;
      return { kind: "target", resolved: best.target + rest, lock };
    }
    return null;
  }
}

/** For `"@std/fs/": "jsr:@std/fs@^1/"` the caveat depends on the imported subpath, so plan it again. */
function stdCaveatForSubpath(entry: MapEntryPlan, rest: string): SpecPlan["caveat"] {
  return planSpecifier(stripSlash(entry.target) + "/" + rest.replace(/^\//, ""))?.caveat;
}

export function configDirOf(file: string, configDirs: string[]): string {
  let best = ".";
  for (const dir of configDirs) {
    if (dir === ".") continue;
    const rel = relative(dir, dirname(file));
    if (!rel.startsWith("..") && dir.length > best.length) best = dir;
  }
  return best;
}
