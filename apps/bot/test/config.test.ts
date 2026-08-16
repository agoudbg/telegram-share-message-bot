// loadConfig tests: defaults, required-variable validation and the
// TELEGRAM_TEST_SERVER switch.

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const BASE_ENV = {
  API_ID: '12345',
  API_HASH: 'deadbeef',
  BOT_TOKEN: '123:abc',
  PUBLIC_ORIGIN: 'https://share.example.com/',
  BOT_USERNAME: '@mybot',
};

describe('loadConfig', () => {
  it('parses the required variables and applies defaults', () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config).toMatchObject({
      apiId: 12345,
      apiHash: 'deadbeef',
      botToken: '123:abc',
      session: '',
      publicOrigin: 'https://share.example.com', // trailing slash stripped
      botUsername: 'mybot', // leading @ stripped
      miniAppShortName: undefined,
      dataDir: './data',
      mediaHostLimitBytes: 500 * 1024 * 1024,
      batchSilenceMs: 2000,
      testServer: false,
    });
  });

  it('requires API_ID/API_HASH/BOT_TOKEN/PUBLIC_ORIGIN/BOT_USERNAME', () => {
    for (const key of ['API_ID', 'API_HASH', 'BOT_TOKEN', 'PUBLIC_ORIGIN', 'BOT_USERNAME']) {
      const env = { ...BASE_ENV, [key]: '' };
      expect(() => loadConfig(env), key).toThrow(key);
    }
  });

  it('parses TELEGRAM_TEST_SERVER as a boolean', () => {
    for (const value of ['1', 'true', 'YES']) {
      expect(loadConfig({ ...BASE_ENV, TELEGRAM_TEST_SERVER: value }).testServer).toBe(true);
    }
    for (const value of ['0', 'false', '']) {
      expect(loadConfig({ ...BASE_ENV, TELEGRAM_TEST_SERVER: value }).testServer).toBe(false);
    }
  });

  it('rejects non-numeric API_ID and invalid numeric overrides', () => {
    expect(() => loadConfig({ ...BASE_ENV, API_ID: 'abc' })).toThrow('API_ID');
    expect(() => loadConfig({ ...BASE_ENV, BATCH_SILENCE_MS: '-5' })).toThrow('BATCH_SILENCE_MS');
  });
});
