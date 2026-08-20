import { describe, expect, it } from 'vitest';

import { MediaRequestGovernor } from '../src/mediaGovernor.js';

describe('MediaRequestGovernor', () => {
  it('limits request bursts independently per share and client', () => {
    let now = 0;
    const governor = createGovernor({ now: () => now });

    expect(governor.allowRequest('share-a', 'client-a')).toBe(true);
    expect(governor.allowRequest('share-a', 'client-a')).toBe(true);
    expect(governor.allowRequest('share-a', 'client-a')).toBe(false);
    expect(governor.allowRequest('share-b', 'client-a')).toBe(false);

    now += 30_000;
    expect(governor.allowRequest('share-b', 'client-a')).toBe(true);
  });

  it('throttles aggregate bytes with an abortable token bucket', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const governor = createGovernor({
      now: () => now,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    });

    await governor.throttle('share-a', 'client-a', 20);
    expect(sleeps).toEqual([1000, 1000]);
  });
});

function createGovernor(
  overrides: Pick<ConstructorParameters<typeof MediaRequestGovernor>[0], 'now' | 'sleep'> = {},
): MediaRequestGovernor {
  return new MediaRequestGovernor({
    requestsPerMinute: 2,
    requestBurst: 2,
    bandwidthBytesPerSecond: 10,
    bandwidthBurstBytes: 10,
    ...overrides,
  });
}
