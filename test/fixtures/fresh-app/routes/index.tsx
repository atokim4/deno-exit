import { Handlers, PageProps } from "$fresh/server.ts";

export const handler: Handlers = {
  GET(_req, ctx) {
    return ctx.render({ name: Deno.env.get("NAME") ?? "world" });
  },
};

export default function Home({ data }: PageProps<{ name: string }>) {
  return <h1>Hello {data.name}</h1>;
}
