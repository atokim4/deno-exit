import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowTsExtensions, buildTsconfig, scan, writeChanges } from "../src/scanner.js";
import type { Finding } from "../src/types.js";
import { copyFixture, fixture, project } from "./helpers.js";

const at = (findings: Finding[], file: string, rule?: string): Finding[] =>
  findings.filter((f) => f.file === file && (!rule || f.rule === rule));

describe("deploy-app (Hono + KV + cron on Deno Deploy)", () => {
  const result = scan(fixture("deploy-app"), { target: "node", fix: false });

  it("lists every kind of finding with file:line", () => {
    const kv = result.findings.find((f) => f.rule === "deno-kv")!;
    expect(kv).toMatchObject({ file: "main.ts", line: 6, fix: "decision" });
    expect(result.findings.find((f) => f.rule === "deno-cron")).toMatchObject({ file: "main.ts", line: 8, fix: "decision" });
    expect(at(result.findings, "src/config.ts").map((f) => [f.line, f.fix])).toEqual([
      [7, "auto"],
      [10, "auto"],
      [10, "auto"],
      [16, "auto"],
      [17, "manual"],
    ]);
    expect(at(result.findings, "Dockerfile").map((f) => f.rule)).toEqual(["docker-deno-image", "deno-command"]);
    expect(at(result.findings, ".github/workflows/deploy.yml").map((f) => f.rule)).toEqual(["setup-deno", "deno-command", "deployctl-action"]);
    expect(at(result.findings, "deno.json", "fmt-config")[0]!.fix).toBe("manual");
  });

  it("explains why Deno.stat is not rewritten", () => {
    const stat = at(result.findings, "src/config.ts").find((f) => f.line === 17)!;
    expect(stat.message).toMatch(/always be true/);
  });

  it("writes nothing without --fix", () => {
    expect(result.changes).toEqual([]);
  });
});

describe("deploy-app --fix", () => {
  const dir = copyFixture("deploy-app");
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);
  const read = (rel: string): string => readFileSync(join(dir, rel), "utf8");

  it("writes package.json with the import map as aliases and tasks as scripts", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies).toEqual({
      "@hono/node-server": "^2.1.8",
      "@std/assert": "npm:@jsr/std__assert@^1.0.0",
      "@std/path": "npm:@jsr/std__path@^1.0.0",
      hono: "npm:@jsr/hono__hono@^4.6.0",
      nanoid: "5.0.9",
      zod: "^3.23.8",
    });
    expect(pkg.scripts).toMatchObject({ dev: "node --watch main.ts", start: "node main.ts", test: 'node --test "**/{*_,*.,}test.{ts,tsx,mts,js,mjs,jsx}"', check: "tsc --noEmit" });
    expect(read(".npmrc")).toBe("@jsr:registry=https://npm.jsr.io\n");
  });

  it("writes a tsconfig for Node type stripping, jsx from deno.json", () => {
    const co = JSON.parse(read("tsconfig.json")).compilerOptions;
    expect(co).toMatchObject({ module: "nodenext", noEmit: true, allowImportingTsExtensions: true, erasableSyntaxOnly: true, jsx: "react-jsx", jsxImportSource: "hono/jsx" });
  });

  it("rewrites the mechanical calls and leaves KV, cron and stat alone", () => {
    const main = read("main.ts");
    expect(main).toContain('import { app } from "./src/routes.ts";');
    expect(main).toContain('import { serve } from "@hono/node-server";');
    expect(main).toContain("serve({ fetch: app.fetch, port: config.port });");
    expect(main).toContain("join(process.cwd(), ");
    expect(main).toContain("Deno.openKv()");
    expect(main).toContain('Deno.cron("cleanup"');
    const config = read("src/config.ts");
    expect(config).toContain('import { readFile, writeFile } from "node:fs/promises";');
    expect(config).toContain('await readFile(path, "utf8")');
    expect(config).toContain('if (err instanceof Error && "code" in err && err.code === "ENOENT")');
    expect(config).toContain('process.env["PORT"]');
    expect(config).toContain("await Deno.stat(path)");
    expect(read("src/routes.ts")).toContain('import { nanoid } from "nanoid";');
  });

  it("turns Deno.test into node:test, t.step into t.test", () => {
    const t = read("main_test.ts");
    expect(t).toContain('import { test } from "node:test";');
    expect(t).toContain('test("health", async (t) => {');
    expect(t).toContain('await t.test("returns ok"');
    expect(t).toContain('test("rejects empty notes", async () => {\n  const res');
    expect(t).not.toContain("Deno.");
  });

  it("writes MIGRATION.md with decisions first", () => {
    const md = read("MIGRATION.md");
    expect(md.indexOf("## Decisions")).toBeLessThan(md.indexOf("## Needs a person"));
    expect(md).toContain("### Deno KV");
    expect(md).toContain("`main.ts:6`");
    expect(md).toContain("node-cron");
  });

  it("finds nothing auto-fixable on a second run", () => {
    const again = scan(dir, { target: "node", fix: false });
    expect(again.findings.filter((f) => f.fix === "auto" && f.category !== "config")).toEqual([]);
  });
});

describe("no false positives on Node projects", () => {
  it("ignores docs that mention Deno and cross-runtime guards", () => {
    const result = scan(fixture("node-repo"), { target: "node", fix: true });
    expect(result.findings).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  it("ignores this repository itself", () => {
    const result = scan(join(import.meta.dirname, ".."), { target: "node", fix: false });
    expect(result.findings.filter((f) => !f.file.startsWith("test/fixtures/"))).toEqual([]);
  });
});

describe("Val Town export without deno.json", () => {
  const result = scan(fixture("val-town"), { target: "node", fix: false });
  it("flags std/sqlite and std/blob as decisions, other vals as manual", () => {
    expect(result.findings.filter((f) => f.fix === "decision").map((f) => f.line)).toEqual([2, 3]);
    expect(result.findings.find((f) => f.rule === "specifier-esm-town")!.fix).toBe("manual");
    expect(result.findings.find((f) => f.rule === "specifier-npm")!.replacement).toBe("hono");
    expect(result.runner.tool).toBe("tsx");
  });
});

describe("Fresh", () => {
  const result = scan(fixture("fresh-app"), { target: "node", fix: false });
  it("is a decision, in the import map and in the route", () => {
    expect(result.findings.filter((f) => f.rule === "fresh").map((f) => f.file)).toEqual(["deno.json", "routes/index.tsx"]);
  });
});

describe("TypeScript runner", () => {
  it("picks tsx for enums and parameter properties", () => {
    const result = scan(fixture("tsx-needed"), { target: "node", fix: false });
    expect(result.runner).toEqual({ tool: "tsx", reasons: ["main.ts:1: enum"] });
    expect(result.findings.find((f) => f.rule === "task")!.replacement).toBe("tsx main.ts");
    expect(result.findings.find((f) => f.message === "Deno.args")!.fix).toBe("auto");
  });
});

describe("legacy URL imports", () => {
  const dir = copyFixture("legacy-urls");
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);
  const server = readFileSync(join(dir, "server.ts"), "utf8");
  it("rewrites what maps 1:1 and keeps the rest for a person", () => {
    expect(server).toContain('import { Hono } from "hono";');
    expect(server).toContain('import confetti from "canvas-confetti";');
    expect(server).toContain('import dayjs from "dayjs";');
    expect(server).toContain('with { type: "json" }');
    expect(server).toContain("https://deno.land/std@0.177.0/http/server.ts");
    expect(server).toContain("https://deno.land/x/oak@v12.6.1/mod.ts");
    expect(server).toContain("https://example.com/lib/helper.ts");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({ "canvas-confetti": "1.9.2", dayjs: "1.11.10", hono: "3.12.0" });
  });
});

describe("workspace", () => {
  const dir = copyFixture("workspace");
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);
  const pkg = (rel: string) => JSON.parse(readFileSync(join(dir, rel, "package.json"), "utf8"));

  it("writes npm workspaces and one package.json per member", () => {
    expect(pkg(".").workspaces).toEqual(["packages/api", "packages/web"]);
    // The root map's @std/assert is not imported anywhere, so it is reported and not installed.
    expect(pkg(".").dependencies).toBeUndefined();
    expect(result.findings.find((f) => f.rule === "import-map-unused")).toMatchObject({ file: "deno.json", fix: "info" });
    expect(pkg("packages/api")).toMatchObject({ name: "@sample/api", dependencies: { "@std/dotenv": "npm:@jsr/std__dotenv@^0.225.2" }, scripts: { dev: "node --watch mod.ts" } });
    expect(readFileSync(join(dir, ".npmrc"), "utf8")).toContain("@jsr:registry=https://npm.jsr.io");
  });

  it("warns that @std/dotenv needs Deno at runtime and flags BroadcastChannel", () => {
    expect(result.findings.find((f) => f.file === "packages/api/mod.ts" && f.rule === "specifier-caveat")!.message).toMatch(/fails at runtime/);
    expect(result.findings.find((f) => f.rule === "broadcast-channel")).toMatchObject({ file: "packages/web/mod.ts", fix: "decision" });
  });
});

describe("other targets", () => {
  it("workers: same findings, Workers replacements, nothing auto", () => {
    const result = scan(fixture("deploy-app"), { target: "workers", fix: false });
    expect(result.findings.some((f) => f.fix === "auto")).toBe(false);
    expect(result.findings.find((f) => f.message === "Deno.serve")!.replacement).toBe("export default { fetch: handler }");
  });
});

describe("import-map keys that start with #", () => {
  const dir = project({
    "deno.json": JSON.stringify({ imports: { "#src/": "./src/", "#config": "./config.ts", "#/": "./" } }),
    "main.ts": 'import { a } from "#src/a.ts";\nimport { port } from "#config";\nimport { b } from "#/b.ts";\nconsole.log(a, port, b);\n',
    "src/a.ts": "export const a = 1;\n",
    "config.ts": "export const port = 8000;\n",
    "b.ts": "export const b = 2;\n",
  });
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);

  it("become package.json subpath imports and the imports stay as written", () => {
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).imports).toEqual({ "#src/*": "./src/*", "#config": "./config.ts" });
    const main = readFileSync(join(dir, "main.ts"), "utf8");
    expect(main).toContain('from "#src/a.ts"');
    expect(main).toContain('from "#config"');
  });

  it("rewrites #/ to a relative path (Node accepts it only from v25.4)", () => {
    expect(readFileSync(join(dir, "main.ts"), "utf8")).toContain('from "./b.ts"');
  });
});

describe("type-only imports", () => {
  const dir = project({
    "deno.json": "{}",
    "types.ts": "export interface User { id: string }\nexport type Id = string;\nexport const VERSION = 1;\nexport interface Both {}\nexport const Both = 1;\n",
    "index.ts": 'export * from "./types.ts";\nexport type { Shape } from "./shape.ts";\n',
    "shape.ts": "export class Shape {}\n",
    "a.ts": 'import { User, Id } from "./types.ts";\nexport const u: User = { id: "1" as Id };\n',
    "b.ts": 'import { type User, VERSION, Both } from "./types.ts";\nimport { Id } from "./index.ts";\nexport const v: [User, Id] | number = VERSION + Both;\n',
    "c.ts": 'import { Shape } from "./index.ts";\nimport { Missing, used } from "./nowhere.ts";\nexport type S = Shape | Missing;\nused();\n',
  });
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);
  const read = (f: string) => readFileSync(join(dir, f), "utf8");

  it("turns an import of only types into import type", () => {
    expect(read("a.ts")).toMatch(/^import type \{ User, Id \} from "\.\/types\.ts";/);
  });

  it("marks single names, follows export * and keeps values and names declared as both", () => {
    expect(read("b.ts")).toContain('import { type User, VERSION, Both } from "./types.ts";');
    expect(read("b.ts")).toContain('import type { Id } from "./index.ts";');
  });

  it("follows export type { } from; for unreadable modules only the file's own use counts", () => {
    expect(read("c.ts")).toContain('import type { Shape } from "./index.ts";');
    expect(read("c.ts")).toContain('import { type Missing, used } from "./nowhere.ts";');
  });
});

describe("deno serve tasks", () => {
  const dir = project({
    "deno.json": JSON.stringify({
      tasks: { start: "deno serve -P --env-file=.env --port 8080 src/server.ts", dev: "deno serve --watch --parallel src/server.ts", worker: "deno serve worker.ts", other: "deno serve unclear.ts" },
      imports: { hono: "jsr:@hono/hono@^4.6.0" },
    }),
    "src/server.ts": 'import { Hono } from "hono";\nconst app = new Hono();\napp.get("/", (c) => c.text("hi"));\nexport default app;\n',
    "worker.ts": 'export default {\n  fetch(request: Request) {\n    return new Response(new URL(request.url).pathname);\n  },\n} satisfies Deno.ServeDefaultExport;\n',
    "unclear.ts": 'import { makeApp } from "./make.ts";\nexport default makeApp();\n',
    "make.ts": "export const makeApp = () => ({ fetch: () => new Response() });\n",
  });
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

  it("generates a Node entry for a Hono app and keeps the port and flags", () => {
    expect(pkg.scripts.start).toBe("node --env-file=.env src/server.node.ts");
    expect(pkg.scripts.dev).toBe("node --watch src/server.node.ts");
    const entry = readFileSync(join(dir, "src/server.node.ts"), "utf8");
    expect(entry).toContain('import handler from "./server.ts";');
    expect(entry).toContain("process.env.PORT ?? 8080");
    expect(entry).toContain("fetch: handler.fetch");
    expect(pkg.dependencies["@hono/node-server"]).toBe("^2.1.8");
  });

  it("wraps a { fetch } default export", () => {
    expect(pkg.scripts.worker).toBe("node worker.node.ts");
    expect(readFileSync(join(dir, "worker.node.ts"), "utf8")).toContain("fetch: (request: Request) => handler.fetch(request), port");
  });

  it("leaves an export it cannot read for a person", () => {
    expect(pkg.scripts.other).toBe("deno serve unclear.ts");
    expect(result.findings.find((f) => f.rule === "task" && /"other"/.test(f.message))!.fix).toBe("manual");
  });
});

describe("extensionless imports (--sloppy-imports)", () => {
  const dir = project({
    "deno.json": JSON.stringify({ imports: { "#src/": "./src/", "@/": "./src/" }, unstable: ["sloppy-imports"] }),
    "main.ts": 'import { a } from "./src/a";\nimport { b } from "#src/lib";\nimport { c } from "@/c";\nimport data from "./data.json" with { type: "json" };\nimport { d } from "./src/d.ts";\nconsole.log(a, b, c, d, data);\n',
    "src/a.ts": "export const a = 1;\n",
    "src/lib/index.ts": "export const b = 2;\n",
    "src/c.tsx": "export const c = 3;\n",
    "src/d.ts": "export const d = 4;\n",
    "data.json": "{}\n",
  });
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);
  const main = readFileSync(join(dir, "main.ts"), "utf8");

  it("adds the extension of the file Deno resolved, through subpath and import-map keys too", () => {
    expect(main).toContain('from "./src/a.ts"');
    expect(main).toContain('from "#src/lib/index.ts"');
    expect(main).toContain('from "./src/c.tsx"');
  });

  it("leaves full paths alone", () => {
    expect(main).toContain('from "./data.json"');
    expect(main).toContain('from "./src/d.ts"');
    expect(result.findings.filter((f) => f.rule === "extensionless-import")).toHaveLength(2);
  });
});

describe("existing tsconfig.json", () => {
  it("gets allowImportingTsExtensions when it sets noEmit, comments kept", () => {
    const out = allowTsExtensions('{\n  // dual runtime\n  "compilerOptions": {\n    "noEmit": true,\n    "strict": true\n  }\n}\n')!;
    expect(out).toContain("// dual runtime");
    expect(JSON.parse(out.replace(/\/\/.*$/m, "")).compilerOptions).toEqual({ noEmit: true, strict: true, allowImportingTsExtensions: true });
  });

  it("is left alone without noEmit, or when the option is already there", () => {
    expect(allowTsExtensions('{ "compilerOptions": { "outDir": "dist" } }')).toBeNull();
    expect(allowTsExtensions('{ "compilerOptions": { "noEmit": true, "allowImportingTsExtensions": true } }')).toBeNull();
  });
});

describe("config found on real repos", () => {
  it("tsconfig lib: deno.ns brings esnext, an explicit ES2020 without deno libs stays", () => {
    const cfg = (lib: string[]) => ({ compilerOptions: { value: { lib }, line: 1 } }) as unknown as Parameters<typeof buildTsconfig>[0];
    expect(buildTsconfig(cfg(["dom", "dom.iterable", "deno.ns"]), "node").compilerOptions).toMatchObject({ lib: ["esnext", "dom", "dom.iterable"] });
    expect(buildTsconfig(cfg(["ES2020", "DOM"]), "node").compilerOptions).toMatchObject({ lib: ["ES2020", "DOM"] });
    expect(buildTsconfig(null, "node").compilerOptions).toMatchObject({ lib: ["esnext"] });
    expect(buildTsconfig(null, "tsx", true).compilerOptions).toMatchObject({ jsx: "react" });
    expect(buildTsconfig(null, "node").compilerOptions).not.toHaveProperty("jsx");
  });

  it("reads an import map passed with --import-map in a task, keeps env assignments in front of a task", () => {
    const dir = project({
      "deno.json": JSON.stringify({ tasks: { test: "TOKEN=x DEBUG='1 2' deno test --allow-env --import-map import_map.json tests/" } }),
      "import_map.json": JSON.stringify({ imports: { hono: "jsr:@hono/hono@^4.6.0", "@libs/": "./src/libs/" } }),
      "tests/a_test.ts": 'import { Hono } from "hono";\nimport { x } from "@libs/x.ts";\nDeno.test("a", () => { new Hono(); x(); });\n',
      "src/libs/x.ts": "export const x = () => 1;\n",
    });
    const result = scan(dir, { target: "node", fix: true });
    writeChanges(dir, result.changes);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies.hono).toBe("npm:@jsr/hono__hono@^4.6.0");
    expect(pkg.scripts.test).toBe("TOKEN=x DEBUG='1 2' node --test \"tests/**/{*_,*.,}test.{ts,tsx,mts,js,mjs,jsx}\"");
    expect(readFileSync(join(dir, "tests/a_test.ts"), "utf8")).toContain('from "../src/libs/x.ts"');
  });
});

describe("names only used as types", () => {
  const dir = project({
    "deno.json": JSON.stringify({ imports: { hono: "jsr:@hono/hono@^4.6.0" } }),
    "a.ts": [
      'import { Hono, Context, MiddlewareHandler } from "hono";',
      'import { Env as E, Schema } from "hono";',
      'import { HTTPException } from "hono/http-exception";',
      "const app = new Hono<{ Bindings: E }>();",
      "export const mw: MiddlewareHandler = async (c: Context, next) => { await next(); };",
      "export class X implements Schema {}",
      "export const isErr = (e: unknown) => e instanceof HTTPException;",
      "export const cfg = { Context: 1 };",
      "export default app;",
      "",
    ].join("\n"),
  });
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);
  const a = readFileSync(join(dir, "a.ts"), "utf8");

  it("marks package imports that the file only uses in type positions", () => {
    expect(a).toContain('import { Hono, type Context, type MiddlewareHandler } from "hono";');
    expect(a).toContain('import type { Env as E, Schema } from "hono";');
  });

  it("keeps values: new, instanceof; a property named like the import is not a use", () => {
    expect(a).toContain('import { HTTPException } from "hono/http-exception";');
  });
});

describe("web type globals", () => {
  const dir = project({
    "deno.json": "{}",
    "utils.ts": "export const h: HeadersInit = { a: \"b\" };\nexport function f(x: RequestInfo, b?: BodyInit) { return [x, b]; }\n",
    "own.ts": "type HeadersInit = string;\nexport const y: HeadersInit = \"\";\n",
  });
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);

  it("declares the ones that are used, not the ones a file declares itself", () => {
    const dts = readFileSync(join(dir, "deno-globals.d.ts"), "utf8");
    expect(dts).toContain("type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;");
    expect(dts).toContain("type RequestInfo =");
    expect(dts).toContain("type BodyInit =");
    expect(dts).not.toContain("BlobPart");
    expect(result.findings.filter((f) => f.rule === "web-type-global").map((f) => f.file)).toEqual(["utils.ts", "utils.ts", "utils.ts"]);
  });
});

describe("bare imports without an import-map entry", () => {
  const dir = project({
    "deno.json": JSON.stringify({ nodeModulesDir: "manual", imports: { preact: "npm:preact@^10.27.2" } }),
    "deno.lock": JSON.stringify({ version: "5", specifiers: { "npm:preact@^10.27.2": "10.29.8" }, npm: { "preact@10.29.8": {}, "preact-render-to-string@6.7.0_preact@10.29.8": {}, "dup@1.0.0": {}, "dup@2.0.0": {} } }),
    "a.test.ts": 'import { h } from "preact";\nimport { renderToString } from "preact-render-to-string";\nimport x from "dup/sub";\nimport { readFile } from "node:fs/promises";\nimport { join } from "path";\nconsole.log(h, renderToString, x, readFile, join);\n',
  });
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const bare = result.findings.filter((f) => f.rule === "bare-import");

  it("pins a transitive package from deno.lock, flags one with two versions, skips builtins", () => {
    expect(pkg.dependencies).toEqual({ preact: "^10.27.2", "preact-render-to-string": "6.7.0" });
    expect(bare.map((f) => [f.line, f.fix])).toEqual([[2, "auto"], [3, "manual"]]);
  });
});

describe("unused import-map entries that still matter", () => {
  it("keeps @types/* entries", () => {
    const dir = project({ "deno.json": JSON.stringify({ imports: { "@types/pg": "npm:@types/pg@^8.11.0", nanoid: "npm:nanoid@^5.0.0" } }), "main.ts": "console.log(1);\n" });
    const result = scan(dir, { target: "node", fix: true });
    writeChanges(dir, result.changes);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies).toEqual({ "@types/pg": "^8.11.0" });
  });
});

describe("bare imports Deno resolves without a map", () => {
  const dir = project({
    "deno.json": JSON.stringify({ name: "@me/lib", exports: { ".": "./mod.ts", "./extra": "./extra.ts" }, workspace: ["./packages/auth"] }),
    "packages/auth/deno.json": JSON.stringify({ name: "@me/auth", exports: "./mod.ts" }),
    "packages/auth/mod.ts": "export const auth = 1;\n",
    "mod.ts": "export const lib = 1;\n",
    "extra.ts": "export const extra = 1;\n",
    "mod_test.ts": 'import { lib } from "@me/lib";\nimport { extra } from "@me/lib/extra";\nimport { auth } from "@me/auth";\nconsole.log(lib, extra, auth);\n',
    "examples/web/package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    "examples/web/app.tsx": 'import { useState } from "react";\nexport const s = useState;\n',
  });
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);

  it("knows the package's own name, workspace members and a nested package.json", () => {
    expect(result.findings.filter((f) => f.rule === "bare-import")).toEqual([]);
  });

  it("writes exports so Node resolves the self-import and the member", () => {
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).exports).toEqual({ ".": "./mod.ts", "./extra": "./extra.ts" });
    expect(JSON.parse(readFileSync(join(dir, "packages/auth/package.json"), "utf8")).exports).toEqual({ ".": "./mod.ts" });
  });
});

describe("@hono/node-server version", () => {
  const run = (hono: string) => {
    const dir = project({
      "deno.json": JSON.stringify({ imports: { hono: hono } }),
      "main.ts": 'import { Hono } from "hono";\nconst app = new Hono();\nDeno.serve({ port: 8000 }, app.fetch);\n',
    });
    const result = scan(dir, { target: "node", fix: true });
    writeChanges(dir, result.changes);
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["@hono/node-server"];
  };

  it("uses 1.x when the hono range cannot reach 4.6.7, 2.x otherwise", () => {
    expect(run("npm:hono@4.4.0")).toBe("^1.19.19");
    expect(run("jsr:@hono/hono@~4.5.0")).toBe("^1.19.19");
    expect(run("jsr:@hono/hono@^4.4.0")).toBe("^2.1.8");
    expect(run("npm:hono@^4.6.7")).toBe("^2.1.8");
    expect(run("jsr:@hono/hono@^4.12.0")).toBe("^2.1.8");
  });
});
