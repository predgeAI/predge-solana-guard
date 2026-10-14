import { sha256 as nobleSha256 } from "@noble/hashes/sha2";

export type Bytes = Uint8Array;

export function sha256(data: string | Uint8Array): Uint8Array {
  return nobleSha256(typeof data === "string" ? new TextEncoder().encode(data) : data);
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`invalid hex string`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function expectLength(b: Uint8Array, n: number, what: string): void {
  if (!(b instanceof Uint8Array) || b.length !== n) {
    throw new Error(`${what} must be ${n} bytes, got ${b instanceof Uint8Array ? b.length : typeof b}`);
  }
}
