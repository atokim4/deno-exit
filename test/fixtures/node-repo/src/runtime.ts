// Mentions Deno.env in a comment and in a string: "Deno.readTextFile"
declare const Deno: { env: { get(name: string): string | undefined } } | undefined;

export function envVar(name: string): string | undefined {
  if (typeof Deno !== "undefined") return Deno.env.get(name);
  return globalThis.process?.env[name];
}

export const isDeno = typeof Deno !== "undefined" && Deno?.env !== undefined;
export const docsUrl = "https://deno.land/manual";
