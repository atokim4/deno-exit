import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scan, writeChanges } from "../src/scanner.js";
import { project } from "./helpers.js";

function fixFile(code: string, file = "main.ts"): { text: string; findings: ReturnType<typeof scan>["findings"] } {
  const dir = project({ "deno.json": "{}", [file]: code });
  const result = scan(dir, { target: "node", fix: true });
  writeChanges(dir, result.changes);
  return { text: readFileSync(join(dir, file), "utf8"), findings: result.findings.filter((f) => f.file === file) };
}

describe("Web APIs Node got late", () => {
  it("flags Uint8Array base64/hex methods, not an unrelated toHex()", () => {
    const { findings } = fixFile('const a = bytes.toBase64();\nconst b = Uint8Array.fromHex("ff");\nconst c = color.toHex();\n');
    expect(findings.filter((f) => f.rule === "uint8array-base64").map((f) => f.line)).toEqual([1, 2]);
  });
});

describe("Deno.* rewrites", () => {
  it("Deno.serve with an async handler method becomes a valid function; a two-argument method stays manual", () => {
    const { text } = fixFile("Deno.serve({ port: 3000, async handler(req) {\n  return new Response(await req.text());\n} });\n");
    expect(text).toContain("serve({ fetch: async function (req) {");
    const two = fixFile("Deno.serve({ handler(req, info) {\n  return new Response(info.remoteAddr.hostname);\n} });\n");
    expect(two.text).toContain("Deno.serve");
    expect(two.findings.find((f) => f.message.startsWith("Deno.serve"))!.fix).toBe("manual");
  });

  it("folds a nested rewrite at its own position when the same text is in the test name", () => {
    const { text } = fixFile('Deno.test("Deno.cwd()", () => {\n  Deno.cwd();\n});\n', "a_test.ts");
    expect(text).toContain('test("Deno.cwd()", () => {\n  process.cwd();\n});');
  });

  it("Deno.test(options, fn) keeps ignore as skip and the name", () => {
    const { text } = fixFile('Deno.test({ name: "slow", ignore: true }, () => {});\n', "a_test.ts");
    expect(text).toContain('test("slow", { skip: true }, () => {});');
  });

  it("does not change template-literal content when a Deno.test fn moves left", () => {
    const code = 'Deno.test({\n  name: "t",\n  fn() {\n    const s = `a\n    b`;\n  },\n});\n';
    const { text } = fixFile(code, "a_test.ts");
    expect(text).toContain("const s = `a\n    b`;");
  });

  it("flags Deno used as a value; leaves typeof guards and Deno.x alone", () => {
    const { findings } = fixFile('const { env } = Deno;\nconst d = Deno;\nDeno["cwd"]();\nif (typeof Deno !== "undefined") {}\nconst x = "Deno" in globalThis;\n');
    expect(findings.filter((f) => f.rule === "deno-value").map((f) => f.line)).toEqual([1, 2, 3]);
  });

  it("an invalid package.json is reported, not a crash", () => {
    const dir = project({ "deno.json": '{ "tasks": { "start": "deno run main.ts" } }', "package.json": "{ nope", "main.ts": 'console.log(Deno.cwd());\n' });
    const result = scan(dir, { target: "node", fix: true });
    expect(result.findings.some((f) => f.rule === "package-json" && f.fix === "manual")).toBe(true);
    expect(result.changes.some((c) => c.file === "package.json")).toBe(false);
  });

  it("rewrites a multi-line Deno call inside a Deno.test({ fn }) body that moves left", () => {
    const code = 'Deno.test({\n  name: "loads",\n  async fn() {\n    const s = await Deno.readTextFile(\n      "a.sql",\n    );\n  },\n});\n';
    const { text, findings } = fixFile(code, "db.test.ts");
    expect(findings.some((f) => f.rule === "scan-error")).toBe(false);
    expect(text).toContain('test("loads", async function () {\n  const s = await readFile("a.sql", "utf8");\n});');
  });

  it("makeTempDir: default prefix, dir and prefix options, sync form; suffix stays manual", () => {
    const { text, findings } = fixFile('const a = await Deno.makeTempDir();\nconst b = Deno.makeTempDirSync({ dir: root, prefix: "x-" });\nconst c = await Deno.makeTempDir({ suffix: ".d" });\n');
    expect(text).toContain("const a = await mkdtemp(join(tmpdir(), \"tmp-\"));");
    expect(text).toContain('const b = mkdtempSync(join(root, "x-"));');
    expect(text).toContain("Deno.makeTempDir({ suffix");
    expect(findings.find((f) => /suffix/.test(f.message))!.fix).toBe("manual");
  });

  it("env: get/has/set/delete/toObject", () => {
    const { text } = fixFile('Deno.env.set("A", "1");\nconst b = Deno.env.has("B");\nDeno.env.delete("C");\nconst all = Deno.env.toObject();\n');
    expect(text).toBe('process.env["A"] = "1";\nconst b = (process.env["B"] !== undefined);\ndelete process.env["C"];\nconst all = ({ ...process.env });\n');
  });

  it("does not rewrite Deno.env.set used as an expression", () => {
    const { text, findings } = fixFile('const r = Deno.env.set("A", "1");\n');
    expect(text).toContain("Deno.env.set");
    expect(findings[0]!.fix).toBe("manual");
  });

  it("process and os renames, execPath call becomes a property", () => {
    const { text } = fixFile("console.log(Deno.pid, Deno.execPath(), Deno.hostname());\nDeno.exit(1);\n");
    expect(text).toBe('import { hostname } from "node:os";\n\nconsole.log(process.pid, process.execPath, hostname());\nprocess.exit(1);\n');
  });

  it("reuses an existing node:fs/promises import and aliases clashing names", () => {
    const { text } = fixFile('import { readFile } from "node:fs/promises";\nconst writeFile = 1;\nawait readFile("a");\nawait Deno.writeTextFile("b", "x");\nawait Deno.readFile("c");\n');
    expect(text).toContain('import { writeFile as nodeWriteFile } from "node:fs/promises";');
    expect(text).toContain('await nodeWriteFile("b", "x");');
    expect(text).toContain('await readFile("c");');
    expect(text.match(/import \{ readFile \}/g)).toHaveLength(1);
  });

  it("leaves calls with an options argument for a person", () => {
    const { text, findings } = fixFile('await Deno.writeTextFile("log.txt", "x", { append: true });\n');
    expect(text).toContain("Deno.writeTextFile");
    expect(findings[0]!.message).toMatch(/options/);
  });

  it("Deno.remove only with { recursive: true }", () => {
    expect(fixFile('await Deno.remove("dir", { recursive: true });\n').text).toBe('import { rm } from "node:fs/promises";\n\nawait rm("dir", { recursive: true });\n');
    expect(fixFile('await Deno.remove("file.txt");\n').findings[0]!.fix).toBe("manual");
  });

  it("errors with two codes, and complex subjects stay manual", () => {
    expect(fixFile("try {} catch (e) { if (e instanceof Deno.errors.PermissionDenied) throw e; }\n").text).toContain('if (e instanceof Error && "code" in e && (e.code === "EACCES" || e.code === "EPERM")) throw e;');
    expect(fixFile("const x = getErr() instanceof Deno.errors.NotFound;\n").findings[0]!.fix).toBe("manual");
  });

  it("Deno.serve: default port 8000 kept, unsafe shapes left alone", () => {
    expect(fixFile("Deno.serve((req) => new Response(req.url));\n").text).toContain("serve({ fetch: (req) => new Response(req.url), port: 8000 });");
    expect(fixFile('Deno.serve({ port: 3000, hostname: "0.0.0.0" }, handler);\n').text).toContain('serve({ fetch: handler, port: 3000, hostname: "0.0.0.0" });');
    expect(fixFile("Deno.serve({ port: 3000, handler: app.fetch });\n").text).toContain("serve({ fetch: app.fetch, port: 3000 });");
    expect(fixFile("const server = Deno.serve(handler);\nawait server.finished;\n").findings[0]!.fix).toBe("manual");
    expect(fixFile("Deno.serve((req, info) => new Response(info.remoteAddr.hostname));\n").findings[0]!.fix).toBe("manual");
    expect(fixFile("Deno.serve({ onListen() {} }, handler);\n").findings[0]!.fix).toBe("manual");
  });

  it("Deno.test options map to node:test options", () => {
    const { text } = fixFile('Deno.test("slow", { ignore: true, permissions: { net: true } }, () => {});\n', "a_test.ts");
    expect(text).toBe('import { test } from "node:test";\n\ntest("slow", { skip: true }, () => {});\n');
  });

  it("decisions and manual items are never rewritten", () => {
    const code = "const kv = await Deno.openKv();\nDeno.cron(\"x\", \"* * * * *\", () => {});\nconst p = new Deno.Command(\"ls\");\nDeno.upgradeWebSocket(req);\n";
    const { text, findings } = fixFile(code);
    expect(text).toBe(code);
    expect(findings.map((f) => f.fix)).toEqual(["decision", "decision", "manual", "manual"]);
  });

  it("leaves Deno.* behind a typeof Deno guard", () => {
    const code = 'const v = typeof Deno !== "undefined" ? Deno.env.get("A") : process.env.A;\n';
    const { text, findings } = fixFile(code);
    expect(text).toBe(code);
    expect(findings.map((f) => f.rule)).toEqual(["runtime-guard"]);
  });

  it("nested Deno calls fold into one rewrite (crashed on 7 real repos before)", () => {
    const { text } = fixFile('Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, app.fetch);\nconst t = await Deno.readTextFile(Deno.env.get("FILE")!);\n');
    expect(text).toContain('serve({ fetch: app.fetch, port: Number(process.env["PORT"] ?? 8000) });');
    expect(text).toContain('await readFile(process.env["FILE"]!, "utf8");');
  });

  it("Deno.test inside a regular module stays manual (node:test would run it on import)", () => {
    const { text, findings } = fixFile('export const add = (a: number, b: number) => a + b;\nDeno.test("add", () => {});\n', "util.ts");
    expect(text).toContain("Deno.test");
    expect(findings[0]!.message).toMatch(/not a test file/);
  });

  it("Deno.test with fn written as a method", () => {
    const { text } = fixFile('Deno.test({\n  name: "m",\n  async fn(t) {\n    await t.step("s", () => {});\n  },\n});\n', "m_test.ts");
    expect(text).toContain('test("m", async function (t) {\n  await t.test("s", () => {});\n})');
  });

  it("all Deno.Kv* names belong to the KV decision; symlink is a rename; stdin members use the stdin rule", () => {
    const { text, findings } = fixFile('let k: Deno.KvKey;\nconst n = new Deno.KvU64(1n);\nawait Deno.symlink("a", "b");\nDeno.stdin.setRaw(true);\n');
    expect(findings.map((f) => f.rule)).toEqual(["deno-kv", "deno-kv", "deno-api", "deno-api"]);
    expect(findings[3]!.replacement).toMatch(/process\.stdin/);
    expect(text).toContain('await symlink("a", "b");');
  });

  it("@std/testing/bdd imports become node:test (found on a real repo: bdd calls Deno.test inside)", () => {
    const dir = project({
      "deno.json": '{ "imports": { "@std/testing": "jsr:@std/testing@^1.0.0" } }',
      "a.test.ts": 'import { afterAll, describe, it } from "@std/testing/bdd";\ndescribe("x", () => { it("y", () => {}); afterAll(() => {}); });\n',
      "b.test.ts": 'import { describe, it } from "@std/testing/bdd";\ndescribe.ignore("x", () => {});\n',
    });
    const result = scan(dir, { target: "node", fix: true });
    writeChanges(dir, result.changes);
    expect(readFileSync(join(dir, "a.test.ts"), "utf8")).toMatch(/^import \{ after as afterAll, describe, it \} from "node:test";/);
    expect(result.findings.find((f) => f.file === "b.test.ts")).toMatchObject({ rule: "specifier-caveat", fix: "manual" });
  });

  it("removes Deno lib references", () => {
    expect(fixFile('/// <reference lib="deno.ns" />\nconsole.log(Deno.args);\n').text).toBe("console.log(process.argv.slice(2));\n");
  });

  it("Deno type references are manual, Deno.Kv is a decision", () => {
    const { findings } = fixFile("let k: Deno.Kv;\nfunction h(i: Deno.ServeHandlerInfo) {}\n");
    expect(findings.map((f) => [f.rule, f.fix])).toEqual([["deno-kv", "decision"], ["deno-type", "manual"]]);
  });
});
