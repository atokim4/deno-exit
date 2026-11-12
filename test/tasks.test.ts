import { describe, expect, it } from "vitest";
import { convertTask } from "../src/tasks.js";

describe("convertTask", () => {
  it("drops permission flags and keeps --watch", () => {
    expect(convertTask("deno run -A --watch main.ts", [], "node").script).toBe("node --watch main.ts");
    expect(convertTask("deno run --allow-net --allow-env=PORT --unstable-kv main.ts --port 80", [], "node").script).toBe("node main.ts --port 80");
  });

  it("carries --env-file and uses tsx when the code needs it", () => {
    expect(convertTask("deno run --env-file=.env.local -A main.ts", [], "node").script).toBe("node --env-file=.env.local main.ts");
    expect(convertTask("deno run -A --watch=static/ dev.ts", [], "tsx").script).toBe("tsx watch dev.ts");
  });

  it("turns a test directory into the glob deno test uses (node --test cannot load a directory)", () => {
    const glob = '"tests/**/{*_,*.,}test.{ts,tsx,mts,js,mjs,jsx}"';
    expect(convertTask("deno test -A tests/", [], "tsx").script).toBe(`tsx --test ${glob}`);
    expect(convertTask("deno test -A tests", [], "node", { isDirectory: (p) => p === "tests" }).script).toBe(`node --test ${glob}`);
    expect(convertTask("deno test tests/a_test.ts", [], "node", { isDirectory: () => false }).script).toBe("node --test tests/a_test.ts");
    expect(convertTask("deno test tests/", [], "bun").script).toBe("bun test tests/");
  });

  it("flags with optional values only take them with =; --filter maps to --test-name-pattern; task args go after --", () => {
    expect(convertTask("deno run --inspect main.ts", [], "node").script).toBe("node --inspect main.ts");
    expect(convertTask("deno run --env-file main.ts", [], "node").script).toBe("node --env-file=.env main.ts");
    expect(convertTask("deno test --filter login tests/a_test.ts", [], "node").script).toBe("node --test --test-name-pattern=login tests/a_test.ts");
    expect(convertTask("deno task build --prod", [], "node").script).toBe("npm run build -- --prod");
    expect(convertTask("deno task build", [], "node").script).toBe("npm run build");
  });

  it("converts test, check and task chains", () => {
    expect(convertTask("deno test -A", [], "node").script).toBe('node --test "**/{*_,*.,}test.{ts,tsx,mts,js,mjs,jsx}"');
    expect(convertTask("deno test -A tests/*_test.ts", [], "node").script).toBe('node --test "tests/*_test.ts"');
    const check = convertTask("deno check main.ts && deno task build", [], "node");
    expect(check.script).toBe("tsc --noEmit && npm run build");
    expect(check.usesTsc).toBe(true);
  });

  it("runs npm: scripts with npx and keeps Deno-only tools as manual", () => {
    expect(convertTask("deno run -A npm:vite build", [], "node").script).toBe("npx vite build");
    const fmt = convertTask("deno fmt && deno lint", [], "node");
    expect(fmt.manual).toEqual(["deno fmt", "deno lint"]);
    expect(convertTask("deno run -A jsr:@std/http/file-server", [], "node").manual).toHaveLength(1);
    expect(convertTask("deployctl deploy --project=x main.ts", [], "node").manual).toHaveLength(1);
  });

  it("understands the Deno 2 shorthand without `run`", () => {
    expect(convertTask("deno --watch --unstable-kv --allow-net main.ts", [], "node").script).toBe("node --watch main.ts");
  });

  it("warns when test globs match files that are not tests", () => {
    expect(convertTask("deno test -A ./*.ts", [], "node").notes[0]).toMatch(/own entry/);
  });

  it("runs task dependencies first", () => {
    const t = convertTask("node server.ts", ["build"], "node");
    expect(t.script).toBe("npm run build && node server.ts");
    expect(t.notes[0]).toMatch(/parallel/);
  });

  it("targets bun", () => {
    expect(convertTask("deno run -A --watch main.ts", [], "bun").script).toBe("bun --watch main.ts");
    expect(convertTask("deno test", [], "bun").script).toBe("bun test");
  });
});
