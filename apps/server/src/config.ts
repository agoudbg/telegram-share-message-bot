// HTTP server configuration, loaded from environment variables. See
// .env.example and docs/PLAN.md, Phase 3.

export interface ServerConfig {
  /** Base directory holding tbfb.db and media/ (shared with the bot) */
  dataDir: string;
  /** Interface exposed by the HTTP server; loopback keeps Nginx as the only
   *  public entry point. */
  host: string;
  port: number;
  /** Server-side secret keying the per-share fake-id HMAC. Combined with the
   *  share id it forms the sanitizer's shareSecret, so fake ids cannot be
   *  recomputed offline from a leaked share id (docs/PLAN.md §2.6). */
  sanitizeSecret: string;
  /** Bot username (without @) building the `get_<shareId>_<seq>` deep links
   *  for unhosted media (docs/PLAN.md §2.5); undefined disables the button */
  botUsername?: string;
}

const DEFAULT_PORT = 3000;

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const sanitizeSecret = env.SANITIZE_SECRET;
  if (sanitizeSecret === undefined || sanitizeSecret === '') {
    throw new Error('Missing required environment variable SANITIZE_SECRET (see .env.example)');
  }
  const portValue = env.PORT;
  const port = portValue === undefined || portValue === '' ? DEFAULT_PORT : Number(portValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Environment variable PORT must be a valid port number, got ${portValue}`);
  }
  return {
    dataDir: env.DATA_DIR || './data',
    host: env.HOST || '127.0.0.1',
    port,
    sanitizeSecret,
    botUsername: env.BOT_USERNAME?.replace(/^@/, '') || undefined,
  };
}
