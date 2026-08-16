// Bot configuration, loaded from environment variables. See .env.example and
// docs/PLAN.md §2.1 (api_id/api_hash are mandatory for MTProto).

export interface BotConfig {
  apiId: number;
  apiHash: string;
  botToken: string;
  /** teleproto StringSession; may be empty on first login */
  session: string;
  publicOrigin: string;
  botUsername: string;
  miniAppShortName?: string;
  dataDir: string;
  mediaHostLimitBytes: number;
  batchSilenceMs: number;
  /** Connect to the Telegram test DCs instead of production (TELEGRAM_TEST_SERVER) */
  testServer: boolean;
}

const DEFAULT_MEDIA_HOST_LIMIT_BYTES = 500 * 1024 * 1024; // 500MB
const DEFAULT_BATCH_SILENCE_MS = 2000;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function optionalInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got ${value}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const apiId = Number(required(env, 'API_ID'));
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error('API_ID must be a positive integer (from my.telegram.org)');
  }
  return {
    apiId,
    apiHash: required(env, 'API_HASH'),
    botToken: required(env, 'BOT_TOKEN'),
    session: env.SESSION ?? '',
    publicOrigin: required(env, 'PUBLIC_ORIGIN').replace(/\/+$/, ''),
    botUsername: required(env, 'BOT_USERNAME').replace(/^@/, ''),
    miniAppShortName: env.MINIAPP_SHORT_NAME || undefined,
    dataDir: env.DATA_DIR || './data',
    mediaHostLimitBytes: optionalInt(env, 'MEDIA_HOST_LIMIT_BYTES', DEFAULT_MEDIA_HOST_LIMIT_BYTES),
    batchSilenceMs: optionalInt(env, 'BATCH_SILENCE_MS', DEFAULT_BATCH_SILENCE_MS),
    testServer: /^(1|true|yes)$/i.test(env.TELEGRAM_TEST_SERVER ?? ''),
  };
}
