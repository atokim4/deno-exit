/** Sample val exported from Val Town (made-up data). */
import { sqlite } from "https://esm.town/v/std/sqlite";
import { blob } from "https://esm.town/v/std/blob?v=12";
import { formatDate } from "https://esm.town/v/sample/helpers";
import { Hono } from "npm:hono@4.6.14";

const app = new Hono();
app.get("/", async (c) => {
  const rows = await sqlite.execute("select * from notes");
  await blob.setJSON("last-visit", { at: formatDate(new Date()) });
  return c.json(rows);
});

export default app.fetch;
