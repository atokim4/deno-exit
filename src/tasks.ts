export interface ConvertedTask {
  script: string;
  /** Parts of the command that still run Deno or a Deno tool and need a person. */
  manual: string[];
  notes: string[];
  usesTsc: boolean;
}

export type Runner = "node" | "tsx" | "bun";

export interface TaskOptions {
  /** Writes a Node entry for the module `deno serve` runs; returns its path, or null when the export shape is unclear. */
  serveEntry?(script: string, port: number): string | null;
  /** True when a path in a task (relative to its deno.json) is a directory. */
  isDirectory?(path: string): boolean;
}

/** The file names `deno test` collects from a directory: {*_,*.,}test.{ts,tsx,mts,js,mjs,jsx}. */
export const DENO_TEST_GLOB = "{*_,*.,}test.{ts,tsx,mts,js,mjs,jsx}";

/**
 * Deno flags that take a value in the next argument when written without `=`. Flags whose value is optional
 * (`--inspect[=host]`, `--env-file[=file]`, `--lock[=file]`, `--v8-flags[=flags]`) only take it with `=`.
 */
const VALUE_FLAGS = new Set(["--config", "-c", "--import-map", "--cert", "--location", "--seed", "--port", "--host", "--filter", "--reporter", "--junit-path"]);

/** The value of `--flag=value` or `--flag value` in a parsed flag list. */
function flagValue(flags: string[], name: string): string | undefined {
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === name) return flags[i + 1];
    if (flags[i]!.startsWith(`${name}=`)) return flags[i]!.slice(name.length + 1);
  }
  return undefined;
}

function splitArgs(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) out.push(m[0]);
  return out;
}

function isDenoFlag(arg: string): boolean {
  return arg.startsWith("-");
}

interface RunParts {
  flags: string[];
  script: string | null;
  rest: string[];
}

function parseRun(args: string[]): RunParts {
  const flags: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (!isDenoFlag(a)) break;
    flags.push(a);
    if (VALUE_FLAGS.has(a) && i + 1 < args.length) flags.push(args[++i]!);
  }
  const script = args[i] ?? null;
  const rest = args.slice(i + 1);
  if (rest[0] === "--") rest.shift();
  return { flags, script, rest };
}

/** Node flags that keep the meaning of the Deno flags we can carry over. */
function nodeFlags(flags: string[], runner: Runner, notes: string[]): string[] {
  const out: string[] = [];
  for (const f of flags) {
    if (f === "--watch" || f.startsWith("--watch=")) {
      out.push(runner === "tsx" ? "watch" : "--watch");
      if (f.includes("=")) notes.push("watch paths dropped (Node --watch follows the import graph)");
    } else if (f === "--env" || f === "--env-file") out.push("--env-file=.env");
    else if (f.startsWith("--env-file=") || f.startsWith("--env=")) out.push(`--env-file=${f.split("=")[1]}`);
    else if (f.startsWith("--inspect")) out.push(f);
  }
  return out;
}

function runCommand(runner: Runner, flags: string[], target: string, rest: string[]): string {
  if (runner === "bun") return ["bun", ...flags, target, ...rest].join(" ");
  if (runner === "tsx") {
    const watch = flags.includes("watch");
    const others = flags.filter((f) => f !== "watch");
    return ["tsx", ...(watch ? ["watch"] : []), ...others, target, ...rest].join(" ");
  }
  return ["node", ...flags, target, ...rest].join(" ");
}

/** `deno run npm:vite` → `npx vite`. JSR scripts have no npx equivalent. */
function npmScript(spec: string): string | null {
  const m = /^npm:(@?[^@/]+(?:\/[^@/]+)?)/.exec(spec);
  return m ? `npx ${m[1]}` : null;
}

function convertSegment(segment: string, runner: Runner, out: ConvertedTask, options: TaskOptions): string {
  // `A=1 B=2 deno test`: keep the variable assignments in front of the converted command.
  const env = /^\s*((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+)(?=deno\b)/.exec(segment);
  if (env) return `${env[1]}${convertSegment(segment.slice(env[0].length), runner, out, options)}`;
  const trimmed = segment.trim();
  const args = splitArgs(trimmed);
  if (args[0] !== "deno") {
    if (/^deployctl\b/.test(trimmed)) out.manual.push(trimmed);
    return trimmed;
  }
  let sub = args[1] ?? "";
  let tail = args.slice(2);
  // Deno 2 shorthand: `deno --watch main.ts` / `deno main.ts` mean `deno run`.
  if (sub.startsWith("-") || /\.[cm]?[jt]sx?$/.test(sub)) {
    tail = args.slice(1);
    sub = "run";
  }
  switch (sub) {
    case "run": {
      const { flags, script, rest } = parseRun(tail);
      if (!script) {
        out.manual.push(trimmed);
        return trimmed;
      }
      const npx = npmScript(script);
      if (npx) return [npx, ...rest].join(" ");
      if (/^(?:https?|jsr):/.test(script)) {
        out.manual.push(trimmed);
        return trimmed;
      }
      return runCommand(runner, nodeFlags(flags, runner, out.notes), script, rest);
    }
    case "task":
      // npm run takes flags after the name as its own config unless they come after `--`.
      if (!tail.length) return trimmed;
      return tail.length > 1 ? `npm run ${tail[0]} -- ${tail.slice(1).join(" ")}` : `npm run ${tail[0]}`;
    case "test": {
      const { flags, script, rest } = parseRun(tail);
      const paths = [script, ...rest].filter((p): p is string => !!p && !isDenoFlag(p));
      const watch = flags.some((f) => f.startsWith("--watch"));
      if (paths.some((p) => !/test/.test(p))) {
        out.notes.push("node --test runs every matched file as its own entry (import.meta.main is true there): keep the globs to test files");
      }
      const base = runner === "bun" ? "bun test" : runner === "tsx" ? "tsx --test" : "node --test";
      const filter = flagValue(flags, "--filter");
      const filterFlag = filter === undefined ? [] : [runner === "bun" ? `--test-name-pattern ${filter}` : `--test-name-pattern=${filter}`];
      // Without paths deno test collects its own file names; Node's default would also run everything under test/.
      if (!paths.length && runner !== "bun") paths.push(".");
      // node --test takes files and globs; a directory is loaded as a module and fails (ERR_UNSUPPORTED_DIR_IMPORT).
      const asGlob = (p: string): string =>
        runner !== "bun" && (p.endsWith("/") || p === "." || options.isDirectory?.(p)) ? (p === "." || p === "./" ? `**/${DENO_TEST_GLOB}` : `${p.replace(/\/+$/, "")}/**/${DENO_TEST_GLOB}`) : p;
      return [base, ...(watch ? ["--watch"] : []), ...filterFlag, ...paths.map(asGlob).map((p) => (/[*?{]/.test(p) ? `"${p}"` : p))].join(" ");
    }
    case "check":
      out.usesTsc = true;
      return "tsc --noEmit";
    case "install":
    case "cache":
      if (tail.some((a) => !isDenoFlag(a))) {
        out.manual.push(trimmed);
        return trimmed;
      }
      return "npm install";
    case "publish":
      out.notes.push("JSR publishing works from Node with `npx jsr publish` (jsr.io/docs/publishing-packages)");
      return ["npx jsr publish", ...tail.filter((a) => a === "--dry-run" || a === "--allow-dirty")].join(" ");
    case "serve": {
      const { flags, script, rest } = parseRun(tail);
      const portFlag = flags.findIndex((f) => f === "--port" || f.startsWith("--port="));
      const portText = portFlag === -1 ? "8000" : flags[portFlag]!.includes("=") ? flags[portFlag]!.split("=")[1]! : flags[portFlag + 1];
      const entry = script && !rest.length && /^\d+$/.test(portText ?? "") ? options.serveEntry?.(script, Number(portText)) : null;
      if (entry) {
        if (flags.includes("--parallel")) out.notes.push("--parallel dropped (run several Node processes behind a load balancer, or node:cluster)");
        if (flags.some((f) => f === "--host" || f.startsWith("--host="))) out.notes.push("--host dropped (the generated entry listens on all interfaces)");
        out.notes.push(`\`deno serve\` → generated ${entry} (fetch gets the Request only, no Deno ServeHandlerInfo)`);
        return runCommand(runner, nodeFlags(flags, runner, out.notes), entry, []);
      }
      out.manual.push(`${trimmed} (\`deno serve\` runs a module's default { fetch } export; Node needs an explicit serve() entry)`);
      return trimmed;
    }
    default:
      // fmt, lint, compile, bundle, bench, doc, coverage, deploy, jupyter, upgrade, eval…
      out.manual.push(trimmed);
      return trimmed;
  }
}

/** Converts one `deno task` command line into an npm script. Shell operators are kept. */
export function convertTask(command: string, dependencies: string[], runner: Runner, options: TaskOptions = {}): ConvertedTask {
  const out: ConvertedTask = { script: "", manual: [], notes: [], usesTsc: false };
  const parts = command.split(/(\s*(?:&&|\|\||;|\|)\s*)/);
  const converted = parts.map((part, i) => (i % 2 === 1 ? part : convertSegment(part, runner, out, options)));
  let script = converted.join("");
  if (dependencies.length) {
    script = [...dependencies.map((d) => `npm run ${d}`), ...(script ? [script] : [])].join(" && ");
    out.notes.push("task dependencies now run one after another (deno task ran them in parallel)");
  }
  out.script = script;
  return out;
}

const FRAMEWORK_FMT_LINT: Record<string, string> = {
  fmt: "Prettier or Biome (`deno fmt` settings are not converted)",
  lint: "ESLint or Biome (`deno lint` rules are not converted)",
  compile: "Node single executable applications (nodejs.org/api/single-executable-applications.html) or `bun build --compile`",
  bundle: "esbuild or Vite",
  bench: "a benchmark runner (mitata, tinybench)",
  doc: "TypeDoc",
  coverage: "node --test --experimental-test-coverage or Vitest coverage",
};

export function hintFor(manualSegment: string): string | undefined {
  const sub = /^deno\s+(\w+)/.exec(manualSegment)?.[1];
  if (sub && FRAMEWORK_FMT_LINT[sub]) return FRAMEWORK_FMT_LINT[sub];
  if (/^deployctl|^deno\s+deploy/.test(manualSegment)) return "your new host's deploy command (wrangler deploy, a Docker image, …)";
  return undefined;
}
