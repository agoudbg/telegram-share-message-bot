// HTTP entry point: share data API + media streaming, serving from the same
// DATA_DIR (SQLite + media files) the bot writes to (docs/PLAN.md, Phase 3).

import { existsSync } from 'node:fs';
import path from 'node:path';

import { serve } from '@hono/node-server';

import { createServerApp } from './api/app.js';
import { loadServerConfig } from './config.js';
import { openDatabase } from './storage/database.js';
import { HttpMediaOriginClient, MediaCache } from './mediaCache.js';
import { MediaRequestGovernor } from './mediaGovernor.js';

/** Load the first .env found walking up from the cwd. */
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
  const mediaCache = new MediaCache({
    db,
    dataDir: config.dataDir,
    origin: new HttpMediaOriginClient(config.internalMediaPort, config.internalMediaSecret),
    maxBytes: config.mediaCacheMaxBytes,
    lowWatermarkBytes: config.mediaCacheLowWatermarkBytes,
    ttlSeconds: config.mediaCacheTtlSeconds,
    sweepIntervalSeconds: config.mediaCacheSweepIntervalSeconds,
    maxConcurrentFetches: config.mediaFetchConcurrency,
    downloadTimeoutMs: config.mediaDownloadTimeoutMs,
    log: (line) => console.error(`[media-cache] ${line}`),
  });
  const mediaGovernor = new MediaRequestGovernor({
    requestsPerMinute: config.mediaRequestsPerMinute,
    requestBurst: config.mediaRequestBurst,
    bandwidthBytesPerSecond: config.mediaBandwidthBytesPerSecond,
    bandwidthBurstBytes: config.mediaBandwidthBurstBytes,
  });
  const app = createServerApp({
    db,
    sanitizeSecret: config.sanitizeSecret,
    dataDir: config.dataDir,
    botUsername: config.botUsername,
    mediaCache,
    maxHostedMediaBytes: config.mediaCacheMaxBytes,
    mediaGovernor,
    trustProxy: config.trustProxy,
  });

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(
      `Share server listening on ${config.host}:${info.port} (data dir: ${config.dataDir})`,
    );
  });
}

main();
