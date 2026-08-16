// Unknown-constructor alert hook tests (docs/PLAN.md §2.2): teleproto's
// "Type ... not found" lines must reach the dedicated alert channel.

import { describe, expect, it } from 'vitest';

import { createBotLogger } from '../src/logging.js';

describe('createBotLogger', () => {
  it('mirrors all records and alerts on unknown constructors', () => {
    const lines: string[] = [];
    const alerts: string[] = [];
    const logger = createBotLogger(
      (line) => lines.push(line),
      (line) => alerts.push(line),
    );

    logger.info('Running teleproto version 1.228.5');
    logger.info('Type 123456789 not found, remaining data 42');
    logger.warn('Unknown constructor 999 while decrypting');

    expect(lines).toHaveLength(3);
    expect(alerts).toEqual([
      'Type 123456789 not found, remaining data 42',
      'Unknown constructor 999 while decrypting',
    ]);
  });
});
