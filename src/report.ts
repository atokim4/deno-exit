import type { Finding, ScanResult } from "./types.js";

/** Longer notes for the items that need a decision. Every claim here comes from the docs linked next to it. */
export const DECISIONS: Record<string, { title: string; body: string }> = {
  "deno-kv": {
    title: "Deno KV",
    body: [
      "Deno KV only exists inside Deno and Deno Deploy, and the Deploy-hosted databases go away with Deploy (docs.deno.com: \"Deno Deploy will be sunset in April 2027\").",
      "",
      "1. **Export first.** The `@deno/kv` npm package opens a Deploy database from Node over KV Connect:",
      "   `openKv(\"https://api.deno.com/v2/databases/<id>/connect\")`, token from `DENO_KV_ACCESS_TOKEN` (docs.deno.com/deploy/kv/node).",
      "   Walk `kv.list({ prefix: [] })` and write the entries out (JSON lines keep key parts and versionstamps readable).",
      "   Deploy's continuous S3/GCS backup plus the `denokv` tool is the other route (docs.deno.com/deploy/kv/backup).",
      "2. **Pick the new store.** Small app on one server: SQLite (`node:sqlite`, a table of `key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER`).",
      "   Several servers: Postgres or Redis. Cloudflare: Workers KV (eventually consistent) or D1 (SQLite, transactional).",
      "3. **Replace the calls.** `get/set/delete/list` map onto any of these; `atomic()` needs a transaction (SQLite/Postgres/D1);",
      "   `enqueue/listenQueue` need a queue (Cloudflare Queues, a Postgres jobs table, BullMQ); `expireIn` needs a TTL column or Redis EX.",
    ].join("\n"),
  },
  "deno-cron": {
    title: "Deno.cron",
    body: [
      "`Deno.cron(name, schedule, handler)` schedules are in UTC (docs.deno.com/api/deno/~/Deno.cron) and run inside Deno / Deploy.",
      "",
      "- Cloudflare Workers: Cron Triggers (`triggers.crons` in wrangler config) calling a `scheduled()` handler.",
      "- One long-running Node process: `node-cron` with `{ timezone: \"UTC\" }` so the times stay the same.",
      "- Several instances or serverless: the host's scheduler (GitHub Actions `schedule`, Render/Fly cron jobs, systemd timers) hitting an endpoint, so the job runs once.",
      "- `backoffSchedule` retries have no built-in equivalent in node-cron: wrap the handler in your own retry.",
    ].join("\n"),
  },
  fresh: {
    title: "Fresh",
    body: [
      "Fresh is Deno's own framework; its docs (fresh.deno.dev) cover Deno only, and we found no supported way to run it on Node.",
      "The runtime keeps getting monthly bug and security releases for a year (deno.com/blog/cloudflare), so two honest options:",
      "",
      "- Keep Fresh on the Deno runtime and move hosting off Deploy (a Docker image `denoland/deno` on Fly, Render or a VPS). Buys time, not an exit.",
      "- Port it: routes → Hono (`hono/jsx`) or Astro pages; islands → Preact components hydrated by the new framework. Plan it as a rewrite of the routing layer.",
    ].join("\n"),
  },
  "broadcast-channel": {
    title: "BroadcastChannel",
    body: [
      "On Deno Deploy, BroadcastChannel carried messages between the app's instances (docs.deno.com/deploy/api/runtime-broadcast-channel).",
      "Node has BroadcastChannel too, but it only reaches worker threads of the same process, so code that relied on cross-instance messages",
      "will silently stop syncing. Use Redis pub/sub, Postgres LISTEN/NOTIFY, or a Durable Object on Workers.",
    ].join("\n"),
  },
  "specifier-val-town-std": {
    title: "Val Town std services",
    body: [
      "Val Town becomes read-only on 2026-12-10 and shuts down on 2027-01-10 (docs.val.town/migration).",
      "Its migration guide maps std/sqlite → D1, std/blob → R2, std/email → Email Service, std/openai → AI Gateway on Cloudflare",
      "(docs.val.town/migration/cloudflare). On Node, std/sqlite data can go to Turso/libSQL (Val Town SQLite runs on Turso) or node:sqlite.",
      "Export the data before the read-only date.",
      "",
      "HTTP vals export their fetch handler as the default export. On Node, add an entry file that calls",
      "`serve({ fetch: handler, port })` from @hono/node-server; on Workers, `export default { fetch: handler }`.",
    ].join("\n"),
  },
};

const FIX_LABEL: Record<Finding["fix"], string> = { auto: "auto", manual: "manual", decision: "DECISION", info: "info" };

export function counts(findings: Finding[]): Record<Finding["fix"], number> {
  const c = { auto: 0, manual: 0, decision: 0, info: 0 };
  for (const f of findings) c[f.fix]++;
  return c;
}

export function renderText(result: ScanResult, fixed: boolean): string {
  const lines: string[] = [];
  const c = counts(result.findings);
  if (!result.findings.length) {
    lines.push(result.denoConfigs.length ? "deno-exit: nothing Deno-specific left." : "deno-exit: no deno.json and no Deno APIs found. Nothing to do.");
    return lines.join("\n");
  }
  lines.push(`deno-exit → ${result.target}   ${result.denoConfigs.length ? result.denoConfigs.join(", ") : "(no deno.json)"}`);
  lines.push("");
  let lastFile = "";
  for (const f of result.findings) {
    if (f.file !== lastFile) {
      lines.push(f.file);
      lastFile = f.file;
    }
    const tag = fixed && f.fix === "auto" ? "fixed" : FIX_LABEL[f.fix];
    lines.push(`  ${String(f.line).padStart(4)}  ${tag.padEnd(8)} ${f.message}${f.replacement ? `\n${" ".repeat(16)}→ ${f.replacement}` : ""}`);
  }
  lines.push("");
  lines.push(`${c.auto} ${fixed ? "fixed" : "auto-fixable"}, ${c.manual} manual, ${c.decision} decision${c.decision === 1 ? "" : "s"}, ${c.info} info`);
  if (result.target === "node") lines.push(`TypeScript runs with: ${result.runner.tool === "tsx" ? "tsx (see ts-runner)" : "node (type stripping, Node >= 22.18)"}`);
  if (!fixed && c.auto && result.target === "node") lines.push("Run again with --fix to apply the auto items and write MIGRATION.md.");
  if (!fixed && c.auto && result.target !== "node") lines.push(`--fix writes Node output only; for ${result.target} the list above is the plan.`);
  return lines.join("\n");
}

function bullet(f: Finding): string {
  return `- \`${f.file}:${f.line}\` ${f.message}${f.replacement ? `. Use: ${f.replacement}` : ""}`;
}

export function renderMigration(result: ScanResult): string {
  const by = (fix: Finding["fix"]): Finding[] => result.findings.filter((f) => f.fix === fix);
  const decisions = by("decision");
  const manual = by("manual");
  const auto = by("auto");
  const out: string[] = [];
  out.push("# Moving off Deno: migration report", "");
  out.push(`Written by \`deno-exit --fix --target ${result.target}\`. deno.json is left in place: delete it once the app runs on Node.`, "");
  out.push("## Next steps", "");
  out.push("```sh", "npm install", "npx tsc --noEmit", "npm test", "```", "");
  out.push(
    result.runner.tool === "tsx"
      ? "Scripts run TypeScript with `tsx`, because some files use syntax Node's type stripping cannot run:"
      : "Scripts run `.ts` files directly with Node (type stripping, on by default since Node 22.18; nodejs.org/api/typescript.html). Imports keep their `.ts` extensions; tsconfig has `allowImportingTsExtensions` + `noEmit` so `tsc` checks them.",
  );
  if (result.runner.tool === "tsx") out.push(...result.runner.reasons.slice(0, 10).map((r) => `- ${r}`));
  out.push("");
  if (decisions.length) {
    out.push(`## Decisions (${decisions.length})`, "");
    const rules = [...new Set(decisions.map((f) => f.rule))];
    for (const rule of rules) {
      const d = DECISIONS[rule];
      out.push(`### ${d?.title ?? rule}`, "");
      out.push(...decisions.filter((f) => f.rule === rule).map(bullet), "");
      if (d) out.push(d.body, "");
    }
  }
  if (manual.length) {
    out.push(`## Needs a person (${manual.length})`, "");
    out.push(...manual.map(bullet), "");
  }
  out.push(
    "## Type errors that come from the types, not the code",
    "",
    "- `'x' is of type 'unknown'` (TS18046) after `await res.json()`: Deno's types say `json(): Promise<any>`, @types/node (undici-types) says `Promise<unknown>`. Annotate the value (`const data: Payload = await res.json()`) or validate it.",
    "- `Cannot find name 'Deno'` (TS2304/TS2503) on lines listed above under Decisions or Needs a person: they go away as those items are done.",
    "",
  );
  if (auto.length) {
    out.push(`## Done by the tool (${auto.length})`, "");
    out.push("<details><summary>List</summary>", "");
    out.push(...auto.map(bullet), "", "</details>", "");
  }
  return out.join("\n");
}
