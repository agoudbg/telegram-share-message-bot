import { describe, expect, it } from 'vitest';

import { loadServerConfig } from '../src/config.js';

const BASE_ENV = {
  SANITIZE_SECRET: 'sanitize-secret',
};

describe('loadServerConfig', () => {
  it('binds to loopback by default', () => {
    expect(loadServerConfig(BASE_ENV)).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
    });
  });

  it('allows an explicit host override', () => {
    expect(loadServerConfig({ ...BASE_ENV, HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });
});
