import { timingSafeEqual } from "node:crypto"

/** Constant-time string compare. Unequal lengths fail closed. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}
