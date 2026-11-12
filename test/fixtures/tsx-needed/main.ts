enum Level {
  Info,
  Warn,
}

class Logger {
  constructor(private readonly prefix: string) {}
  log(level: Level, msg: string): void {
    console.log(`${this.prefix} ${Level[level]} ${msg}`);
  }
}

new Logger("[app]").log(Level.Info, Deno.args.join(" "));
