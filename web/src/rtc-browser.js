// Browser-side wireweave bootstrap — the mirror of src/rtc-node.js but for a
// real browser, which already has RTCPeerConnection/localStorage/WebSocket
// natively so no polyfills are needed. Uses an in-memory (not localStorage)
// identity: a guest joining someone's shared terminal has no reason to keep a
// persistent nostr identity across visits.

import { RelayPool, NostrAuth, createDataSession, createFSM } from 'wireweave'
import * as NostrTools from 'nostr-tools'
import * as XState from 'xstate'

function createMemoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) }
  }
}

export async function deriveRoomFromSeed(seed) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('nygrok:' + String(seed)))
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

export function createRtcTransport({ namespace = 'nygrok' } = {}) {
  const storage = createMemoryStorage()
  const auth = new NostrAuth({ nostrTools: NostrTools, storage, extension: null })
  auth.generateKey()

  const relayPool = new RelayPool({ verifyEvent: NostrTools.verifyEvent })
  relayPool.connect()

  const fsm = createFSM(XState)
  const session = createDataSession({ fsm, xstate: XState, relayPool, auth, namespace })

  return { session, relayPool, auth }
}

// Browser mirror of src/rtc-node.js's describeSelectedCandidatePair — real
// RTCPeerConnection has no synchronous accessor for this (that's a
// node-datachannel-specific extension), so it goes through the standard
// async getStats() API and cross-references the succeeded candidate pair
// against its local/remote candidate records.
export async function describeSelectedCandidatePair(pc) {
  try {
    const stats = await pc.getStats()
    let pair = null
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)) { pair = report; break }
    }
    if (!pair) return null
    const local = stats.get(pair.localCandidateId)
    const remote = stats.get(pair.remoteCandidateId)
    const localType = local?.candidateType || 'unknown'
    const remoteType = remote?.candidateType || 'unknown'
    return { localType, remoteType, relayed: localType === 'relay' || remoteType === 'relay' }
  } catch {
    return null
  }
}
