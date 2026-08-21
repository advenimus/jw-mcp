import { createHash, timingSafeEqual } from 'node:crypto';

export function safeCompare(left, right) {
  const hashA = createHash('sha256').update(String(left)).digest();
  const hashB = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(hashA, hashB);
}
