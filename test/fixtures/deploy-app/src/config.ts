export interface Config {
  port: number;
}

export async function loadConfig(path: string): Promise<Config> {
  try {
    const raw = await Deno.readTextFile(path);
    return JSON.parse(raw) as Config;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { port: Number(Deno.env.get("PORT") ?? 8000) };
    throw err;
  }
}

export async function saveConfig(path: string, config: Config): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(config));
  const info = await Deno.stat(path);
  if (!info.isFile) throw new Error("not a file");
}
