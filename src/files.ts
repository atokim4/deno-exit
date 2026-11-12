import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative, sep } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".deno",
  ".next",
  ".output",
  ".turbo",
  ".vercel",
  ".wrangler",
  ".cache",
  "_fresh",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  ".agents",
  ".claude",
  ".cursor",
  ".codex",
  ".gemini",
]);

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const MAX_FILE_BYTES = 1_000_000;

export function isSourceFile(rel: string): boolean {
  return SOURCE_EXT.test(rel) && !rel.endsWith(".d.ts") && !/\.min\.js$/.test(rel);
}

export function isDenoConfig(name: string): boolean {
  return name === "deno.json" || name === "deno.jsonc";
}

/** Files where deploy and CI settings live. */
export function isDeployFile(rel: string): boolean {
  const name = basename(rel);
  if (/^(Dockerfile|Containerfile)(\..*)?$|\.dockerfile$/i.test(name)) return true;
  if (/^(docker-)?compose(\..*)?\.ya?ml$/i.test(name)) return true;
  if (/^(fly|render|railway|netlify)\.(toml|json|ya?ml)$/i.test(name)) return true;
  if (/^(Makefile|Procfile|justfile)$/.test(name) || /\.(sh|bash)$/.test(name)) return true;
  if (/\.ya?ml$/i.test(name)) {
    const parts = rel.split(sep);
    return parts.includes(".github") || /^\.gitlab-ci\.ya?ml$/.test(name);
  }
  return false;
}

export interface ProjectFiles {
  source: string[];
  denoConfigs: string[];
  packageJson: string[];
  deploy: string[];
}

export function walk(root: string): ProjectFiles {
  const out: ProjectFiles = { source: [], denoConfigs: [], packageJson: [], deploy: [] };

  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, abs);
      if (statSync(abs).size > MAX_FILE_BYTES) continue;
      if (isDenoConfig(entry.name)) out.denoConfigs.push(rel);
      else if (entry.name === "package.json") out.packageJson.push(rel);
      else if (isSourceFile(rel)) out.source.push(rel);
      if (isDeployFile(rel)) out.deploy.push(rel);
    }
  };

  visit(root);
  for (const list of Object.values(out)) list.sort();
  return out;
}

export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Relative import specifier from `fromFile` to `toPath` (both relative to the scan root). */
export function relativeSpecifier(fromFile: string, toPath: string): string {
  let rel = relative(dirname(fromFile), toPath).split(sep).join(posix.sep);
  if (toPath.endsWith("/") && !rel.endsWith("/")) rel += "/";
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}
