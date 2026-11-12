import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { Hono } from "https://deno.land/x/hono@v3.12.0/mod.ts";
import { Application } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import confetti from "https://esm.sh/canvas-confetti@1.9.2?target=es2022";
import dayjs from "https://cdn.jsdelivr.net/npm/dayjs@1.11.10/+esm";
import { helper } from "https://example.com/lib/helper.ts";
import config from "./config.json" assert { type: "json" };

const app = new Hono();
app.get("/", (c) => c.text(String(config.name) + helper() + dayjs().year()));
void Application;
void confetti;
serve(app.fetch, { port: 8080 });
