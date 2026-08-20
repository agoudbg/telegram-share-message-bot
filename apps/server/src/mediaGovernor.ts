export interface MediaGovernorOptions {
  requestsPerMinute: number;
  requestBurst: number;
  bandwidthBytesPerSecond: number;
  bandwidthBurstBytes: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
  lastSeenAt: number;
}

const ENTRY_IDLE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 10_000;

export class MediaRequestGovernor {
  private readonly requestBuckets = new Map<string, BucketState>();
  private readonly bandwidthBuckets = new Map<string, BucketState>();
  private operations = 0;

  constructor(private readonly options: MediaGovernorOptions) {}

  allowRequest(shareId: string, clientId: string): boolean {
    const refillPerMs = this.options.requestsPerMinute / 60_000;
    const shareAllowed = this.consume(
      this.requestBuckets,
      `share:${shareId}`,
      1,
      refillPerMs,
      this.options.requestBurst,
    );
    const clientAllowed = this.consume(
      this.requestBuckets,
      `client:${clientId}`,
      1,
      refillPerMs,
      this.options.requestBurst,
    );
    return shareAllowed && clientAllowed;
  }

  async throttle(
    shareId: string,
    clientId: string,
    bytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await Promise.all([
      this.takeBandwidth(`share:${shareId}`, bytes, signal),
      this.takeBandwidth(`client:${clientId}`, bytes, signal),
    ]);
  }

  private async takeBandwidth(key: string, bytes: number, signal?: AbortSignal): Promise<void> {
    let remaining = bytes;
    const capacity = this.options.bandwidthBurstBytes;
    const refillPerMs = this.options.bandwidthBytesPerSecond / 1000;
    while (remaining > 0) {
      const amount = Math.min(remaining, capacity);
      if (this.consume(this.bandwidthBuckets, key, amount, refillPerMs, capacity)) {
        remaining -= amount;
        continue;
      }
      const state = this.bandwidthBuckets.get(key)!;
      const waitMs = Math.max(1, Math.ceil((amount - state.tokens) / refillPerMs));
      await (this.options.sleep ?? abortableSleep)(waitMs, signal);
    }
  }

  private consume(
    buckets: Map<string, BucketState>,
    key: string,
    amount: number,
    refillPerMs: number,
    capacity: number,
  ): boolean {
    const now = (this.options.now ?? Date.now)();
    let state = buckets.get(key);
    if (state === undefined) {
      state = { tokens: capacity, updatedAt: now, lastSeenAt: now };
      buckets.set(key, state);
    } else {
      state.tokens = Math.min(capacity, state.tokens + (now - state.updatedAt) * refillPerMs);
      state.updatedAt = now;
      state.lastSeenAt = now;
    }
    this.cleanup(now);
    if (state.tokens < amount) return false;
    state.tokens -= amount;
    return true;
  }

  private cleanup(now: number): void {
    this.operations += 1;
    if (this.operations % 1000 !== 0) return;
    for (const buckets of [this.requestBuckets, this.bandwidthBuckets]) {
      for (const [key, state] of buckets) {
        if (state.lastSeenAt < now - ENTRY_IDLE_MS || buckets.size > MAX_ENTRIES) {
          buckets.delete(key);
        }
      }
    }
  }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const handleAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Media request aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}
