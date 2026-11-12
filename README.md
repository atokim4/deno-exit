# deno-exit

Move a Deno, Deno Deploy or Val Town project to Node (or plan the move to Bun or Cloudflare Workers).

On 2026-10-09 Deno announced that the runtime gets one more year of monthly bug and security releases before
development ends, and that Deno Deploy keeps running for six months (the Deno docs say "Deno Deploy will be sunset in
April 2027"). Val Town goes read-only on 2026-12-10 and shuts down on 2027-01-10, and its guide recommends Node, Bun or
a provider runtime such as Workers.

`deno-exit` reads the project offline and lists what ties it to Deno, each with `file:line`. With
`--fix` it rewrites the parts that map 1:1 onto Node and writes a `MIGRATION.md` with the rest. It never touches the
items that need a decision (Deno KV, `Deno.cron`, Fresh, BroadcastChannel, Val Town services).

```sh
npx github:atokim4/deno-exit ./my-app                 # report only
npx github:atokim4/deno-exit ./my-app --fix           # rewrite for Node, write MIGRATION.md
npx github:atokim4/deno-exit ./my-app --fix --dry-run # list the files it would change
npx github:atokim4/deno-exit ./my-app --target workers --json
```

Exit codes: `0` nothing left, `1` items need a person or a decision, `2` usage error. CI can run it as a check.

## What it finds

| Area | Examples | `--fix` (Node) |
| --- | --- | --- |
| `deno.json` / `deno.jsonc` | `tasks`, `imports` / `importMap`, `compilerOptions` (jsx), `lint`, `fmt`, `nodeModulesDir`, `unstable`, `workspace`, `scopes` | tasks → npm scripts, import map → `package.json` deps, compilerOptions → `tsconfig.json`, workspace → npm workspaces |
| Specifiers | `jsr:`, `npm:`, `https://deno.land/std` and `/x`, `esm.sh`, jsDelivr / unpkg / Skypack / jspm, `esm.town`, other URLs | `jsr:` → `@jsr/*` npm alias + `.npmrc`; `npm:`, `esm.sh` and CDN URLs with a version → plain packages; versions kept, unversioned ones pinned from `deno.lock` |
| `Deno.*` APIs | `env`, `args`, `exit`, `cwd`, `readTextFile` / `writeTextFile` / `readFile` / `mkdir` / `remove` …, `errors.NotFound`, `serve`, `test`, `Command`, `upgradeWebSocket`, `stat`, `permissions` … | `process.*`, `node:fs/promises`, `node:os`, `@hono/node-server`, `node:test` for the safe shapes; the rest is listed with the Node replacement |
| Decisions | `Deno.openKv` and `Deno.Kv*`, `Deno.cron`, Fresh, `BroadcastChannel`, Val Town `std/sqlite`, `std/blob`, `std/email` … | never rewritten; `MIGRATION.md` explains the options |
| Deploy and CI | `denoland/deployctl` action, `deployctl deploy`, `denoland/setup-deno`, `FROM denoland/deno`, `deno task/test/…` in CI, `deploy` key in `deno.json` | listed with the replacement |
| TypeScript | enums, runtime namespaces, parameter properties, decorators, `.tsx` | scripts use `tsx` instead of Node's type stripping |
| Imports Node resolves differently | names used only as types, extensionless paths (`--sloppy-imports`), `#`-prefixed import-map keys | adds `type` (Node keeps the import otherwise, and it fails at runtime), adds the real file extension, writes package.json `"imports"` |
| `deno serve` tasks | `deno serve --port 8080 src/server.ts` with `export default app` (Hono) or `export default { fetch }` | writes `src/server.node.ts` that serves the default export with `@hono/node-server`, keeps the port; anything else stays manual |

### What is not rewritten, and why

- **`Deno.stat` / `lstat`.** `FileInfo.isFile` is a boolean in Deno, but `Stats.isFile` is a method in Node, so a
  mechanical rename turns `if (info.isFile)` into a check that is always true.
- **`Deno.remove(path)` without `{ recursive: true }`.** Deno removes a file or an empty directory. Node needs you to pick `rm` or `rmdir`.
- **`Deno.serve` whose return value is used.** `server.finished` and `server.shutdown()` have no counterpart on Node's `http.Server`.
  The same goes for handlers that read `info.remoteAddr` and for options other than `port` / `hostname`.
- **`Deno.test` in a module that is not a test file.** Deno skips it outside `deno test`, but `node:test` would run it every time the module is imported.
- **`deno.land/std@0.x` URLs.** The JSR `@std/*` 1.x packages changed some APIs, so the tool prints the Node or JSR replacement instead of guessing.
- **`@std/*` packages that call `Deno.*` themselves.** They install under Node and then fail at runtime: `@std/dotenv`, the stable `@std/fs` helpers
  (`exists`, `walk`, `ensure*`, `copy`, `move`, `emptyDir`, `expandGlob`), `@std/http/file-server`, the `@std/log` file handlers, `@std/net`,
  `@std/testing/snapshot`, and the prompts in `@std/cli`. This list comes from grepping the published `@jsr/std__*` tarballs on 2026-11-13.
- **Code behind `typeof Deno !== "undefined"`.** That code is already cross-runtime, so it is left alone.

Small things it does so `npm install` and `tsc` work on the first try: only import-map entries that a file imports
go into `package.json` (Deno never fetches an unused one, npm fails on one that no longer exists); an import map passed
as `--import-map` in a task is read too; `VAR=value deno test` keeps its variables; an existing `tsconfig.json` that
sets `noEmit` only gets `allowImportingTsExtensions` added.

### Known limits

- **Some JSR packages are not Node-ready on npm.jsr.io.** `@spy4x/preact-icons@5.0.1`, for example, ships `+index.tsx`
  that still imports `npm:preact@^10.29.8`. Node cannot load it and `tsc` cannot resolve it; a bundler (Vite) can.
  The tool cannot see this offline: look inside the installed package when `tsc` reports errors in `node_modules` for a JSR dependency.
- **`await res.json()` becomes `unknown`.** Deno types `json()` as `Promise<any>` (cli/tsc/dts/lib.deno_fetch.d.ts),
  @types/node as `Promise<unknown>`, so `tsc` reports TS18046 where Deno did not. Annotate the value or validate it.
- **Browser files in the repo.** Files served to the browser (absolute `/lib/x.ts` paths, an HTML import map) are not
  Node code. The tool leaves them alone, but `tsc` checks them unless the tsconfig excludes them.

### How TypeScript runs afterwards

Node 22.18+ runs `.ts` files directly through type stripping, so imports keep their `.ts` extensions. The generated
`tsconfig.json` sets `allowImportingTsExtensions`, `noEmit`, `module: nodenext`, `verbatimModuleSyntax` and
`erasableSyntaxOnly`, which makes `tsc` reject what Node would reject. If the code uses syntax Node cannot strip
(enums, parameter properties, decorators, JSX), the scripts use `tsx` and the report names the files.

## Example (abridged)

```
$ deno-exit test/fixtures/deploy-app
main.ts
     2  auto     import-map alias "@/routes.ts" → relative path
     6  DECISION Deno.openKv: Deno KV has no Node runtime; data on Deploy has to be exported first
     8  DECISION Deno.cron: Deno.cron schedules are UTC and run inside Deno/Deploy
    13  auto     Deno.serve → serve({ fetch, port }) from @hono/node-server
src/config.ts
     7  auto     Deno.readTextFile → readFile(path, "utf8") from node:fs/promises
    10  auto     Deno.errors.NotFound → code === "ENOENT"
    17  manual   Deno.stat: Deno's FileInfo.isFile is a boolean; Node's Stats.isFile is a method …
```

After `--fix` on that sample app (Hono + KV + cron, written for the tests), `npm install` pulls the JSR packages
through `npm.jsr.io`. Once the three flagged lines are handled by hand, `tsc --noEmit` passes, `node --test` runs 3/3,
and `node main.ts` serves the routes.

## Tested on real repos

I ran it on 27 public Deno repos (Deno.serve apps, Hono, Oak, Fresh, KV, cron, a Discord bot, CLIs and three Val Town
projects), each a fresh shallow clone: `--fix`, then `npm install`, `tsc --noEmit` and the repo's own tests on Node
22.23. Results from 2026-11-13:

- 4285 findings rewritten, 568 listed as manual, 127 decisions left alone (Deno KV in 7 repos, `Deno.cron` in 1,
  Fresh in 3, Val Town `std/sqlite` / `std/blob` / `std/openai` in 1).
- `npm install` worked in all 27. `tsc --noEmit` was clean in 7; most remaining errors sit on flagged lines, in one
  repo's JSR dependency, or are `json()` typed `unknown`.
- The repo's own tests passed on Node with the same count as on Deno in 5 repos. Where they fail, the failing files
  load a flagged item (KV, a `Deno.serve` server object, `deno.land/x` or std 0.x URLs).
- Every file that still contains `Deno.` after `--fix` has a manual or decision line in the report.

The repos (default branch, shallow clone, 2026-11-13): [0f-0b/kv-relay](https://github.com/0f-0b/kv-relay), [5ouma/reproxy](https://github.com/5ouma/reproxy), [Atticus64/BibleApi](https://github.com/Atticus64/BibleApi), [Danushka-Madushan/burnlink](https://github.com/Danushka-Madushan/burnlink), [SSbit01/secure-otp-server](https://github.com/SSbit01/secure-otp-server), [Simon256px/shorturl-dashboard](https://github.com/Simon256px/shorturl-dashboard), [StigNygaard/lastfm-widgets](https://github.com/StigNygaard/lastfm-widgets), [arthrod/editors-arena](https://github.com/arthrod/editors-arena), [arthrod/open-docs](https://github.com/arthrod/open-docs), [arthrod/open-docs-viewer](https://github.com/arthrod/open-docs-viewer), [guildenstern70/SmartDeno](https://github.com/guildenstern70/SmartDeno), [gulfaniputra/remote-rupiah](https://github.com/gulfaniputra/remote-rupiah), [jobiwanken0bi/atmosphere-account](https://github.com/jobiwanken0bi/atmosphere-account), [kawarimidoll/bluestream](https://github.com/kawarimidoll/bluestream), [kawarimidoll/deno-github-contributions-api](https://github.com/kawarimidoll/deno-github-contributions-api), [kawarimidoll/pax.deno.dev](https://github.com/kawarimidoll/pax.deno.dev), [kinde-starter-kits/deno-starter-kit](https://github.com/kinde-starter-kits/deno-starter-kit), [kt3k/times-kt3k](https://github.com/kt3k/times-kt3k), [pwh-pwh/douyinVd](https://github.com/pwh-pwh/douyinVd), [redpeacock78/tw-dl-bot](https://github.com/redpeacock78/tw-dl-bot), [ryoppippi/curxy](https://github.com/ryoppippi/curxy), [simonneutert/unreachable_tiles_map_editor](https://github.com/simonneutert/unreachable_tiles_map_editor), [so1ve/dlvr](https://github.com/so1ve/dlvr), [spy4x/caldav-tasks-web](https://github.com/spy4x/caldav-tasks-web), [ssuyu0829/food-log](https://github.com/ssuyu0829/food-log), [synit-io/kvMagicLinkAuth](https://github.com/synit-io/kvMagicLinkAuth), [vikiboss/60s](https://github.com/vikiboss/60s). The harness was a shell loop around exactly the commands
above; it is not part of this package.

Two bugs came out of that run and are fixed with tests: a nested rewrite inside a re-indented `Deno.test({ fn })`
body, and `deno test tests/` (Node cannot load a directory, so it now becomes deno's test-file glob).

## Stack

TypeScript on Node 22.18+, [ts-morph](https://ts-morph.com) for the AST, `jsonc-parser` for `deno.jsonc`, Vitest.

```sh
npm install
npm test        # builds, then runs the Vitest suite
npm run lint
npm run typecheck
```

## Sources

- deno.com/blog/cloudflare (2026-10-09), docs.deno.com/deploy/kv/node, docs.deno.com/runtime/reference/deno_json
- docs.val.town/migration and docs.val.town/migration/cloudflare/migrate-code
- jsr.io/docs/npm-compatibility
- nodejs.org/api/typescript.html, nodejs.org/api/esm.html (`import.meta.main`), nodejs.org/api/test.html

## License

MIT © Sunnatulla E. A personal project. It is not affiliated with Deno, Val Town or Cloudflare.
