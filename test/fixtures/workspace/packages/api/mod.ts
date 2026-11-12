import "@std/dotenv/load";

export function port(): number {
  return Number(Deno.env.get("PORT") ?? 8000);
}
