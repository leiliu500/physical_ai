// Browser compatibility for the isolated simulator. Production uses node:crypto.
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
const bytes = (value: string | Uint8Array): Uint8Array =>
  typeof value === 'string' ? new TextEncoder().encode(value) : value;
const hex = (value: Uint8Array): string =>
  Array.from(value, (v) => v.toString(16).padStart(2, '0')).join('');
export function randomUUID(): string {
  const value = globalThis.crypto.getRandomValues(new Uint8Array(16));
  value[6] = (value[6] & 0x0f) | 0x40;
  value[8] = (value[8] & 0x3f) | 0x80;
  const encoded = hex(value);
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`;
}
export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw new Error('Unsupported simulation digest.');
  const hash = sha256.create();
  const api = {
    update(value: string | Uint8Array) {
      hash.update(bytes(value));
      return api;
    },
    digest(encoding: string) {
      if (encoding !== 'hex') throw new Error('Unsupported digest encoding.');
      return hex(hash.digest());
    },
  };
  return api;
}
export function createHmac(algorithm: string, secret: string | Uint8Array) {
  if (algorithm !== 'sha256') throw new Error('Unsupported simulation signature.');
  const hash = hmac.create(sha256, bytes(secret));
  const api = {
    update(value: string | Uint8Array) {
      hash.update(bytes(value));
      return api;
    },
    digest(encoding: string) {
      if (encoding !== 'hex') throw new Error('Unsupported digest encoding.');
      return hex(hash.digest());
    },
  };
  return api;
}
export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
