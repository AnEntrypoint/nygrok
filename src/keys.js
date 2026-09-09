// Seed helpers. nygrok v1 is WebRTC-only (see src/rtc-node.js) — there is no
// HyperDHT transport, so unlike sharesies this doesn't need a DHT keypair,
// just a random seed string to derive the WebRTC room id from.

import { randomBytes } from 'node:crypto'

export function randomSeed() {
  return randomBytes(16).toString('hex')
}
