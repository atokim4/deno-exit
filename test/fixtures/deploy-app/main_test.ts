import { assertEquals } from "@std/assert";
import { app } from "./src/routes.ts";

Deno.test("health", async (t) => {
  await t.step("returns ok", async () => {
    const res = await app.request("/health");
    assertEquals(res.status, 200);
  });
});

Deno.test({
  name: "rejects empty notes",
  sanitizeOps: false,
  fn: async () => {
    const res = await app.request("/notes", { method: "POST", body: JSON.stringify({ text: "" }) });
    assertEquals(res.status, 500);
  },
});
