import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export const fixture = (name: string): string => join(import.meta.dirname, "fixtures", name);

/** Copy of a fixture in a temp dir, so --fix can write to it. */
export function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "deno-exit-"));
  dirs.push(dir);
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

/** Temp project from a { path: contents } map. */
export function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "deno-exit-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
