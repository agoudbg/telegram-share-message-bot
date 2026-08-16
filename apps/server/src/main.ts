// HTTP entry point: share data API + media streaming, serving from the same
// DATA_DIR (SQLite + media files) the bot writes to (docs/PLAN.md, Phase 3).

import { existsSync } from 'node:fs';
import path from 'node:path';

import { serve } from '@hono/node-server';

import { createServerApp } from './api/app.js';
import { loadServerConfig } from './config.js';
import { openDatabase } from './storage/database.js';

/** Load the first .env found walking up from the cwd (same convention as the
 *  bot: operators keep .env at the repo root while pnpm runs packages with
 *  their own directory as cwd). */
function loadEnvFile(): void {
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function main(): void {
  loadEnvFile();
  const config = loadServerConfig();
  const db = openDatabase(path.join(config.dataDir, 'tbfb.db'));
  const app = createServerApp({
    db,
    sanitizeSecret: config.sanitizeSecret,
    dataDir: config.dataDir,
    botUsername: config.botUsername,
  });

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Share server listening on :${info.port} (data dir: ${config.dataDir})`);
  });
}

main();
