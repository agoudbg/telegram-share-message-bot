import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../src/base64.js';

describe('base64', () => {
  it('known vectors', () => {
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
    expect(new TextDecoder().decode(base64ToBytes('aGVsbG8='))).toBe('hello');
  });

  it('round-trips lengths 0..9', () => {
    for (let len = 0; len <= 9; len++) {
      const bytes = new Uint8Array(len).map((_, i) => i * 37 + len);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it('round-trips 1024 pseudo-random bytes', () => {
    const bytes = new Uint8Array(1024).map((_, i) => (i * 131 + 7) & 0xff);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('throws on invalid characters', () => {
    expect(() => base64ToBytes('aGV!')).toThrow();
  });
});
