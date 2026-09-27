export class Logger {
  private prefix: string;
  constructor(prefix: string) { this.prefix = prefix; }
  info(msg: string) { console.log(`[INFO] [${this.prefix}] ${msg}`); }
  error(msg: string, error?: Error) { console.error(`[ERROR] [${this.prefix}] ${msg}`, error?.stack); }
  warn(msg: string) { console.warn(`[WARN] [${this.prefix}] ${msg}`); }
}