import { describe, expect, it } from "vitest";
import { jsrNpmName, parsePackageRef, planSpecifier } from "../src/specifiers.js";

describe("parsePackageRef", () => {
  it("splits scoped names, versions and subpaths", () => {
    expect(parsePackageRef("@std/path@^1.0.0/join")).toEqual({ name: "@std/path", version: "^1.0.0", subpath: "/join" });
    expect(parsePackageRef("zod@3")).toEqual({ name: "zod", version: "3", subpath: "" });
    expect(parsePackageRef("lodash-es/debounce")).toEqual({ name: "lodash-es", version: null, subpath: "/debounce" });
  });
});

describe("planSpecifier", () => {
  it("leaves node:, relative and bare specifiers alone", () => {
    expect(planSpecifier("node:fs")).toBeNull();
    expect(planSpecifier("./a.ts")).toBeNull();
    expect(planSpecifier("hono")).toBeNull();
  });

  it("maps jsr: to the @jsr npm scope (jsr.io/docs/npm-compatibility)", () => {
    expect(jsrNpmName("@std/path")).toBe("@jsr/std__path");
    const plan = planSpecifier("jsr:@std/path@^1.0.8/join")!;
    expect(plan).toMatchObject({ fix: "auto", name: "@std/path", dep: "npm:@jsr/std__path@^1.0.8", rewrite: "@std/path/join" });
    expect(plan.caveat).toBeUndefined();
  });

  it("warns that @std/dotenv and the stable @std/fs helpers call Deno.* at runtime", () => {
    expect(planSpecifier("jsr:@std/dotenv@^0.225.0/load")!.caveat?.fix).toBe("manual");
    expect(planSpecifier("jsr:@std/fs@^1/exists")!.caveat?.fix).toBe("manual");
    expect(planSpecifier("jsr:@std/fs@^1/unstable-read-file")!.caveat).toBeUndefined();
    expect(planSpecifier("jsr:@std/http@^1/file-server")!.caveat?.fix).toBe("manual");
    expect(planSpecifier("jsr:@std/http@^1/cookie")!.caveat).toBeUndefined();
  });

  it("pins an unversioned jsr:/npm: import from deno.lock", () => {
    const lock = new Map([["jsr:@std/assert", "1.0.13"], ["npm:chalk", "5.4.1"]]);
    expect(planSpecifier("jsr:@std/assert", lock)!.dep).toBe("npm:@jsr/std__assert@^1.0.13");
    expect(planSpecifier("npm:chalk", lock)!.dep).toBe("^5.4.1");
    expect(planSpecifier("npm:chalk")!.caveat?.message).toMatch(/pin/);
  });

  it("maps npm: specifiers, including Deno's npm:/ prefix form", () => {
    expect(planSpecifier("npm:express@^4.21.0")).toMatchObject({ name: "express", dep: "^4.21.0", rewrite: "express" });
    expect(planSpecifier("npm:/@types/node@24/")).toMatchObject({ name: "@types/node", dep: "24" });
  });

  it("does not rewrite old deno.land/std URLs (std 0.x and @std 1.x differ)", () => {
    const plan = planSpecifier("https://deno.land/std@0.224.0/path/mod.ts")!;
    expect(plan.fix).toBe("manual");
    expect(plan.replacement).toMatch(/node:path/);
  });

  it("rewrites deno.land/x only for packages published with the same versions", () => {
    expect(planSpecifier("https://deno.land/x/hono@v4.3.11/mod.ts")).toMatchObject({ fix: "auto", name: "hono", dep: "4.3.11" });
    expect(planSpecifier("https://deno.land/x/jose@v4.14.4/index.ts")).toMatchObject({ fix: "auto", name: "jose", dep: "4.14.4" });
    expect(planSpecifier("https://deno.land/x/postgresjs@v3.3.5/mod.js")).toMatchObject({ fix: "auto", name: "postgres", rewrite: "postgres", dep: "3.3.5" });
    expect(planSpecifier("https://deno.land/x/grammy@v1.30.0/mod.ts")).toMatchObject({ fix: "auto", name: "grammy" });
    expect(planSpecifier("https://deno.land/x/oak@v12.6.1/mod.ts")!.fix).toBe("manual");
    expect(planSpecifier("https://deno.land/x/hono@v4.3.11/middleware.ts")!.fix).toBe("manual");
    expect(planSpecifier("https://deno.land/x/unknown_mod@1.0.0/mod.ts")!.fix).toBe("manual");
  });

  it("maps esm.sh and CDN URLs to npm packages", () => {
    expect(planSpecifier("https://esm.sh/v135/preact@10.19.6/hooks")).toMatchObject({ name: "preact", dep: "10.19.6", rewrite: "preact/hooks" });
    expect(planSpecifier("https://esm.sh/canvas-confetti@1.9.2?target=es2022")!.caveat?.fix).toBe("info");
    expect(planSpecifier("https://esm.sh/jsr/@std/encoding@1.0.5")).toMatchObject({ kind: "jsr", dep: "npm:@jsr/std__encoding@1.0.5" });
    expect(planSpecifier("https://cdn.jsdelivr.net/npm/dayjs@1.11.10/+esm")).toMatchObject({ name: "dayjs", rewrite: "dayjs" });
    expect(planSpecifier("https://unpkg.com/lit@3.2.1/index.js")!.fix).toBe("manual");
  });

  it("flags Val Town std services as decisions and other vals for vendoring", () => {
    expect(planSpecifier("https://esm.town/v/std/sqlite")).toMatchObject({ kind: "val-town-std", fix: "decision" });
    expect(planSpecifier("https://esm.town/v/std/utils/index.ts")).toMatchObject({ kind: "val-town-std", fix: "manual" });
    expect(planSpecifier("https://esm.town/v/std/blob?v=12")!.replacement).toMatch(/R2/);
    expect(planSpecifier("https://esm.town/v/someone/helpers")).toMatchObject({ kind: "esm-town", fix: "manual" });
  });

  it("does not treat every URL as a package", () => {
    expect(planSpecifier("https://example.com/lib/helper.ts")).toMatchObject({ kind: "url", fix: "manual" });
  });
});
