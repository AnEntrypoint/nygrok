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

// The HyperDHT transport derives a keypair from sha256(seed). The RTC
// transport derives a room id the same deterministic way, so one shared
// seed string is a single invite for both transports at once.
export function deriveRoomFromSeed(seed) {
  return createHash('sha256').update('nygrok:' + String(seed)).digest('hex').slice(0, 32)
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
export function makeNativePeerConnectionFactory({ portRangeBegin, portRangeEnd, proxy, udpMux = false, PeerConnection, PolyfillRTCPeerConnection }) {
  return (config) => {
    const nativeConfig = {
      iceServers: (config.iceServers || []).map((s) => s.urls)
    }
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

  const fsm = createFSM(XState)
  const createPeerConnection = makeNativePeerConnectionFactory({
    portRangeBegin, portRangeEnd, proxy, udpMux,
    PeerConnection: ndc.PeerConnection,
    PolyfillRTCPeerConnection
  })
  const session = createDataSession({ fsm, xstate: XState, relayPool, auth, namespace, createPeerConnection })

  return { session, relayPool, auth }
}
