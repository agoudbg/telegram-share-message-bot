// Isomorphic base64 (works in Node and browsers, no Buffer dependency).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  let end = b64.length;
  while (end > 0 && b64[end - 1] === '=') end--;
  const out = new Uint8Array(Math.floor((end * 6) / 8));
  let bitBuffer = 0;
  let bitCount = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const v = LOOKUP.get(b64[i]!);
    if (v === undefined) throw new Error(`Invalid base64 character: ${b64[i]}`);
    bitBuffer = (bitBuffer << 6) | v;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[o++] = (bitBuffer >> bitCount) & 0xff;
    }
  }
  return out;
}
