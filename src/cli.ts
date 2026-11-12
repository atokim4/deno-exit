#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { counts, renderText } from "./report.js";
import { scan, writeChanges } from "./scanner.js";
import type { Target } from "./types.js";

const HELP = `deno-exit [dir] [--target node|bun|workers] [--fix] [--dry-run] [--json]

Finds what ties a project to Deno, Deno Deploy or Val Town (file:line) and plans the move.

  --target   node (default), bun or workers: changes the suggested replacements
  --fix      node target: write package.json, tsconfig.json, .npmrc, rewrite imports and the
             mechanical Deno.* calls, and write MIGRATION.md with what is left
  --dry-run  with --fix: list the files that would change, write nothing
  --json     machine-readable output

Exit codes: 0 nothing left to do, 1 items need a person or a decision, 2 usage error.`;

const TARGETS: Target[] = ["node", "bun", "workers"];

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        target: { type: "string", default: "node" },
        fix: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(`deno-exit: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const target = values.target as Target;
  if (!TARGETS.includes(target)) {
    console.error(`deno-exit: --target must be one of ${TARGETS.join(", ")}`);
    return 2;
  }
  if (values.fix && target !== "node") {
    console.error("deno-exit: --fix writes Node output only for now; run without --fix to get the plan for this target");
    return 2;
  }
  const dir = positionals[0] ?? ".";
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`deno-exit: ${dir} is not a directory`);
    return 2;
  }

  const result = scan(dir, { target, fix: values.fix });
  const write = values.fix && !values["dry-run"];
  if (write) writeChanges(result.root, result.changes);

  const remaining = result.findings.filter((f) => f.fix === "manual" || f.fix === "decision" || (f.fix === "auto" && !values.fix));
  if (values.json) {
    console.log(
      JSON.stringify(
        {
          root: result.root,
          target,
          denoConfigs: result.denoConfigs,
          runner: result.runner,
          counts: counts(result.findings),
          findings: result.findings,
          changedFiles: values.fix ? result.changes.map((c) => ({ file: c.file, created: c.before === null })) : [],
          written: write,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderText(result, values.fix));
    if (values.fix) {
      console.log("");
      console.log(`${write ? "Wrote" : "Would write"} ${result.changes.length} file${result.changes.length === 1 ? "" : "s"}:`);
      for (const c of result.changes) console.log(`  ${c.before === null ? "+" : "~"} ${c.file}`);
    }
  }
  return remaining.length ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
