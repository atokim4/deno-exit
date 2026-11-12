import { join } from "@std/path";
import { app } from "@/routes.ts";
import { loadConfig } from "./src/config.ts";

const config = await loadConfig(join(Deno.cwd(), "config.json"));
const kv = await Deno.openKv();

Deno.cron("cleanup", "0 3 * * *", async () => {
  for await (const entry of kv.list({ prefix: ["sessions"] })) await kv.delete(entry.key);
});

if (import.meta.main) {
  Deno.serve({ port: config.port }, app.fetch);
}
