import { describe, expect, it } from 'vitest';

import { loadServerConfig } from '../src/config.js';

const BASE_ENV = {
  SANITIZE_SECRET: 'sanitize-secret',
  INTERNAL_MEDIA_SECRET: 'internal-secret',
};

describe('loadServerConfig', () => {
  it('applies the bounded cache defaults', () => {
    expect(loadServerConfig(BASE_ENV)).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      internalMediaPort: 3001,
      internalMediaSecret: 'internal-secret',
      mediaCacheMaxBytes: 5 * 1024 * 1024 * 1024,
      mediaCacheLowWatermarkBytes: 4 * 1024 * 1024 * 1024,
      mediaCacheTtlSeconds: 86400,
      mediaCacheSweepIntervalSeconds: 300,
      mediaFetchConcurrency: 2,
      mediaDownloadTimeoutMs: 120000,
      mediaRequestsPerMinute: 120,
      mediaRequestBurst: 20,
      mediaBandwidthBytesPerSecond: 8 * 1024 * 1024,
      mediaBandwidthBurstBytes: 16 * 1024 * 1024,
      trustProxy: false,
    });
  });

  it('requires both public sanitization and internal origin secrets', () => {
    expect(() => loadServerConfig({ ...BASE_ENV, SANITIZE_SECRET: '' })).toThrow(
      'SANITIZE_SECRET',
    );
    expect(() => loadServerConfig({ ...BASE_ENV, INTERNAL_MEDIA_SECRET: '' })).toThrow(
      'INTERNAL_MEDIA_SECRET',
    );
  });

  it('rejects an invalid cache watermark', () => {
    expect(() =>
      loadServerConfig({
        ...BASE_ENV,
        MEDIA_CACHE_MAX_BYTES: '100',
        MEDIA_CACHE_LOW_WATERMARK_BYTES: '100',
      }),
    ).toThrow('MEDIA_CACHE_LOW_WATERMARK_BYTES');
  });

  it('only exposes the server when HOST is explicitly overridden', () => {
    expect(loadServerConfig({ ...BASE_ENV, HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('requires an explicit valid flag before trusting a reverse proxy', () => {
    expect(loadServerConfig({ ...BASE_ENV, TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(() => loadServerConfig({ ...BASE_ENV, TRUST_PROXY: 'yes' })).toThrow('TRUST_PROXY');
  });
});
