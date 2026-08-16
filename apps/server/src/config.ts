// HTTP server configuration, loaded from environment variables. See
// .env.example and docs/PLAN.md, Phase 3.

export interface ServerConfig {
  /** Base directory holding tbfb.db and media/ (shared with the bot) */
  dataDir: string;
  port: number;
  /** Server-side secret keying the per-share fake-id HMAC. Combined with the
   *  share id it forms the sanitizer's shareSecret, so fake ids cannot be
   *  recomputed offline from a leaked share id (docs/PLAN.md §2.6). */
  sanitizeSecret: string;
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
    port,
    sanitizeSecret,
  };
}
