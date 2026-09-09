// Node-side wireweave bootstrap.
//
// wireweave's DataSession expects a browser: global RTCPeerConnection /
// RTCSessionDescription / RTCIceCandidate, and NostrAuth expects a storage
// adapter ({getItem,setItem,removeItem}) plus WebSocket for relay connections.
// This installs all of that for Node using node-datachannel's WebRTC polyfill,
// an in-memory storage shim, and the `ws` package — so the same DataSession
// class the browser client uses also runs, unmodified, inside the CLI server.
//
// The CLI server is the peer most likely sitting behind a restrictive NAT (a
// home router, carrier-grade NAT, a corporate firewall) — a browser client's
// own OS/network stack is usually more permissive. So the Node side goes
// further than just running a polyfilled RTCPeerConnection: it constructs
// node-datachannel's native peer directly and wraps it, unlocking ICE/UDP
// port muxing, a fixed port range for port-forwarded firewalls, and
// SOCKS5/HTTP proxy passthrough for networks that block direct UDP/TCP —
// none of which the plain W3C polyfill surface exposes.

import { createHash } from 'node:crypto'

let installed = false

export async function installRtcGlobals() {
  if (installed) return
  const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } =
    (await import('node-datachannel/polyfill'))
  if (typeof globalThis.RTCPeerConnection === 'undefined') globalThis.RTCPeerConnection = RTCPeerConnection
  if (typeof globalThis.RTCSessionDescription === 'undefined') globalThis.RTCSessionDescription = RTCSessionDescription
  if (typeof globalThis.RTCIceCandidate === 'undefined') globalThis.RTCIceCandidate = RTCIceCandidate
  installed = true
}

// Ephemeral, in-memory only — never touches disk. A fresh nostr identity per
// server process, used only to sign WebRTC/presence signaling events.
export function createMemoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) }
  }
}

// The room id is a plain sha256(seed) by default — the invite link's #<seed>
// fragment is the only secret needed to compute it. Passing a non-empty
// password mixes it into that hash instead: the link alone (which is all
// that's ever embedded in the URL — the password never is) no longer
// determines the room, so it's useless without the password too, given
// separately. Without it there is literally nothing to guess against — a
// nostr room id is a full SHA-256 hash, not enumerable — so "wrong or no
// password" and "right seed, no password set" look identical from outside:
// the connection just never finds a peer, no distinguishing error to probe.
export function deriveRoomFromSeed(seed, password = '') {
  const input = password ? `nygrok:${String(seed)}|pw:${String(password)}` : `nygrok:${String(seed)}`
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

// Builds a createPeerConnection factory that constructs node-datachannel's
// native PeerConnection (richer RtcConfig than the W3C polyfill accepts) and
// wraps it as a polyfilled RTCPeerConnection, so wireweave's browser-shaped
// code operates on it unmodified. wireweave calls createPeerConnection(config)
// synchronously and wires event handlers on the return value immediately, so
// this must be synchronous too — PeerConnection/PolyfillRTCPeerConnection are
// resolved ahead of time by createRtcTransport, not imported per-call.
//
// udpMux defaults to false. Verified by direct exec test: enableIceUdpMux
// breaks ICE negotiation ONLY when two peer connections in the SAME process
// try to talk to each other (both bind the shared muxed port, so their STUN
// transactions cross wires — "STUN local ufrag check failed" from libjuice's
// debug log). A separate cross-process test confirmed real, genuinely
// separate peers connect fine with udpMux — direct host/prflx candidates, no
// relay fallback, real data round-trip. In actual deployment the server and
// every remote client are always separate processes/machines, so muxing is
// safe and beneficial there (fewer local ports to traverse a firewall for
// when fielding many remote peers). It stays opt-in rather than default
// because local dev/testing routinely spins up same-process peer pairs,
// which would silently break if this defaulted on.
// maxMessageSize is deliberately set well above tunnel-protocol.js's own
// MAX_CHUNK (64KB) — app-level chunking is what actually bounds message size
// today, this just makes the native SCTP association's own ceiling a
// documented, deliberate choice instead of whatever node-datachannel
// defaults to, so headroom stays available if MAX_CHUNK ever grows.
const MAX_MESSAGE_SIZE = 256 * 1024

export function makeNativePeerConnectionFactory({ portRangeBegin, portRangeEnd, proxy, udpMux = false, PeerConnection, PolyfillRTCPeerConnection }) {
  return (config) => {
    const nativeConfig = {
      iceServers: (config.iceServers || []).map((s) => s.urls),
      maxMessageSize: MAX_MESSAGE_SIZE
    }
    // wireweave passes iceTransportPolicy in its createPeerConnection config
    // (defaults to 'all'); node-datachannel's native RtcConfig honors it
    // (unlike bundlePolicy/iceCandidatePoolSize, which are W3C-only concepts
    // with no native-peer equivalent, so those two are correctly not
    // forwarded here) — forward it so nothing upstream is silently dropped.
    if (config.iceTransportPolicy) nativeConfig.iceTransportPolicy = config.iceTransportPolicy
    if (udpMux) nativeConfig.enableIceUdpMux = true
    if (portRangeBegin != null) nativeConfig.portRangeBegin = portRangeBegin
    if (portRangeEnd != null) nativeConfig.portRangeEnd = portRangeEnd
    if (proxy) nativeConfig.proxyServer = proxy
    const nativePc = new PeerConnection('nygrok-peer-' + Math.random().toString(36).slice(2), nativeConfig)
    return new PolyfillRTCPeerConnection({ peerConnection: nativePc })
  }
}

// Reports whether an open peer connection actually punched through directly
// (host/srflx candidate) or fell back to a TURN relay — real diagnostic
// value for "did the punch-friendly config work", not just "is it open".
export function describeSelectedCandidatePair(pc) {
  try {
    const pair = pc.selectedCandidatePair?.()
    if (!pair) return null
    return {
      localType: pair.local?.type || 'unknown',
      remoteType: pair.remote?.type || 'unknown',
      relayed: pair.local?.type === 'relay' || pair.remote?.type === 'relay'
    }
  } catch {
    return null
  }
}

// Minimal wireweave surface: just RelayPool (signaling transport), NostrAuth
// (ephemeral signing identity) and DataSession (the actual RTCDataChannel).
// The full createWireweave() also wires up chat/channels/roles/servers, which
// sharesies has no use for.
export async function createRtcTransport({ namespace = 'nygrok', portRangeBegin, portRangeEnd, proxy, udpMux = false } = {}) {
  await installRtcGlobals()
  const [
    { RelayPool, NostrAuth, createDataSession, createFSM },
    NostrTools,
    XState,
    { WebSocket },
    ndc,
    { RTCPeerConnection: PolyfillRTCPeerConnection }
  ] = await Promise.all([
    import('wireweave'),
    import('nostr-tools'),
    import('xstate'),
    import('ws'),
    import('node-datachannel'),
    import('node-datachannel/polyfill')
  ])

  const storage = createMemoryStorage()
  const auth = new NostrAuth({ nostrTools: NostrTools, storage, extension: null })
  auth.generateKey()

  const relayPool = new RelayPool({ verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket })
  relayPool.connect()

  // Process-wide (node-datachannel's setSctpSettings applies to every future
  // SCTP association, not per-connection — fine for nygrok's one-host-
  // process model). Only delayedSackTime is tuned: it directly shortens the
  // ACK-clocked round trip on the reliable channel every REQ/RES frame rides
  // (default is on the order of 200ms; usrsctp's own minimum is far lower),
  // and is well-understood/low-risk to lower. congestionControlModule and
  // initialCongestionWindow are deliberately left untouched — their valid
  // ranges/semantics aren't pinned down precisely enough here to tune
  // blind without being able to benchmark the effect.
  try {
    ndc.setSctpSettings({ delayedSackTime: 20 })
  } catch {}

  const fsm = createFSM(XState)
  const createPeerConnection = makeNativePeerConnectionFactory({
    portRangeBegin, portRangeEnd, proxy, udpMux,
    PeerConnection: ndc.PeerConnection,
    PolyfillRTCPeerConnection
  })
  const session = createDataSession({ fsm, xstate: XState, relayPool, auth, namespace, createPeerConnection })

  return { session, relayPool, auth }
}
