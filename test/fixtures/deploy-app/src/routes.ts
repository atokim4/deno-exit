import { Hono } from "hono";
import { z } from "zod";
import { nanoid } from "npm:nanoid@5.0.9";

export const Note = z.object({ text: z.string().min(1) });

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, region: Deno.env.get("REGION") ?? "local" }));
app.post("/notes", async (c) => {
  const note = Note.parse(await c.req.json());
  return c.json({ id: nanoid(), ...note }, 201);
});
