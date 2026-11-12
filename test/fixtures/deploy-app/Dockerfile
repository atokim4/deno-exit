FROM denoland/deno:2.1.4
WORKDIR /app
COPY . .
RUN deno cache main.ts
CMD ["deno", "task", "start"]
