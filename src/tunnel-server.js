// Host-side tunnel: for every browser peer that joins the WebRTC room,
// relays REQ_HEAD/REQ_BODY frames (see tunnel-protocol.js) into a real HTTP
// request against the local target server, and streams the real response
// back as RES_HEAD/RES_BODY frames. WS_OPEN/WS_MSG/WS_CLOSE frames get the
// same treatment against a real WebSocket connection.
//
// Structurally this is rtc-server.js's wireRtcTransport/attachRtcTransport,
// but fanned out to many independent request/response exchanges per peer
// instead of one shared PTY.

import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { WebSocket } from 'ws'
import { createRtcTransport, deriveRoomFromSeed, describeSelectedCandidatePair } from './rtc-node.js'
import { FRAME, encodeFrame, decodeFrame, chunkBody } from './tunnel-protocol.js'

// Headers we recompute ourselves rather than forward verbatim.
const STRIP_REQUEST_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding'])
const STRIP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'upgrade'])

const BUFFERED_AMOUNT_HIGH = 256 * 1024

function waitForDrain(dc) {
  if (!dc || typeof dc.bufferedAmount !== 'number' || dc.bufferedAmount <= BUFFERED_AMOUNT_HIGH) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try { dc.removeEventListener('bufferedamountlow', finish) } catch {}
      resolve()
    }
    try {
      dc.bufferedAmountLowThreshold = Math.floor(BUFFERED_AMOUNT_HIGH / 2)
      dc.addEventListener('bufferedamountlow', finish)
    } catch {
      resolve()
      return
    }
    setTimeout(finish, 250)
  })
}

async function sendFrame(session, peerPubkey, type, id, payload) {
  const dc = session.peers.get(peerPubkey)?.dc
  await waitForDrain(dc)
  session.send(peerPubkey, encodeFrame(type, id, payload))
}

async function sendBody(session, peerPubkey, type, id, bodyBytes) {
  for (const chunk of chunkBody(bodyBytes)) {
    await sendFrame(session, peerPubkey, type, id, chunk)
  }
}

function pickHeaders(headers, strip) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (strip.has(k.toLowerCase())) continue
    out[k] = v
  }
  return out
}

function decompressed(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase()
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip())
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress())
  if (enc === 'deflate') return res.pipe(zlib.createInflate())
  return res
}

// One instance per attachTunnelTransport() call; routes frames from every
// connected peer to the same local target.
function makeTunnelRouter(session, { target, onLog }) {
  const targetUrl = new URL(target)
  const httpMod = targetUrl.protocol === 'https:' ? https : http
  const wsProto = targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'

  const peerState = new Map() // peerPubkey -> { pendingReqs: Map<id,{head,chunks}>, sockets: Map<id,WebSocket> }
  const stateFor = (peerPubkey) => {
    let s = peerState.get(peerPubkey)
    if (!s) { s = { pendingReqs: new Map(), sockets: new Map() }; peerState.set(peerPubkey, s) }
    return s
  }

  function dispatchHttp(peerPubkey, id, head, bodyBuf) {
    let upstreamUrl
    try {
      upstreamUrl = new URL(head.path, targetUrl)
    } catch {
      sendFrame(session, peerPubkey, FRAME.RES_ERROR, id, { message: 'bad path: ' + head.path }).catch(() => {})
      return
    }
    const headers = pickHeaders(head.headers, STRIP_REQUEST_HEADERS)
    const req = httpMod.request(upstreamUrl, { method: head.method, headers }, (res) => {
      ;(async () => {
        await sendFrame(session, peerPubkey, FRAME.RES_HEAD, id, {
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: pickHeaders(res.headers, STRIP_RESPONSE_HEADERS)
        })
        try {
          for await (const chunk of decompressed(res)) {
            await sendFrame(session, peerPubkey, FRAME.RES_BODY, id, chunk)
          }
          await sendFrame(session, peerPubkey, FRAME.RES_BODY, id, new Uint8Array(0))
        } catch (err) {
          await sendFrame(session, peerPubkey, FRAME.RES_ERROR, id, { message: String(err?.message || err) }).catch(() => {})
        }
      })().catch(() => {})
    })
    req.on('error', (err) => {
      sendFrame(session, peerPubkey, FRAME.RES_ERROR, id, { message: String(err?.message || err) }).catch(() => {})
    })
    req.end(bodyBuf && bodyBuf.length ? bodyBuf : undefined)
  }

  function handleReqHead(peerPubkey, id, head) {
    stateFor(peerPubkey).pendingReqs.set(id, { head, chunks: [] })
  }

  function handleReqBody(peerPubkey, id, chunk) {
    const state = stateFor(peerPubkey)
    const pending = state.pendingReqs.get(id)
    if (!pending) return
    if (!chunk || chunk.length === 0) {
      state.pendingReqs.delete(id)
      dispatchHttp(peerPubkey, id, pending.head, Buffer.concat(pending.chunks.map((c) => Buffer.from(c))))
      return
    }
    pending.chunks.push(chunk)
  }

  function handleWsOpen(peerPubkey, id, payload) {
    let upstreamUrl
    try {
      upstreamUrl = new URL(payload.path, targetUrl)
      upstreamUrl.protocol = wsProto
    } catch {
      sendFrame(session, peerPubkey, FRAME.RES_ERROR, id, { message: 'bad ws path: ' + payload.path }).catch(() => {})
      return
    }
    const headers = pickHeaders(payload.headers, STRIP_REQUEST_HEADERS)
    let ws
    try {
      ws = new WebSocket(upstreamUrl, payload.protocols || undefined, { headers })
    } catch (err) {
      sendFrame(session, peerPubkey, FRAME.RES_ERROR, id, { message: String(err?.message || err) }).catch(() => {})
      return
    }
    ws.binaryType = 'nodebuffer'
    stateFor(peerPubkey).sockets.set(id, ws)
    ws.on('open', () => {
      sendFrame(session, peerPubkey, FRAME.WS_ACCEPT, id, { protocol: ws.protocol || '' }).catch(() => {})
    })
    ws.on('message', (data, isBinary) => {
      sendFrame(session, peerPubkey, FRAME.WS_MSG, id, { binary: isBinary, data }).catch(() => {})
    })
    ws.on('close', (code, reason) => {
      stateFor(peerPubkey).sockets.delete(id)
      sendFrame(session, peerPubkey, FRAME.WS_CLOSE, id, { code, reason: reason ? reason.toString() : '' }).catch(() => {})
    })
    ws.on('error', (err) => {
      onLog?.('ws upstream error: ' + (err?.message || err))
    })
  }

  function handleWsMsg(peerPubkey, id, payload) {
    const ws = stateFor(peerPubkey).sockets.get(id)
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try { ws.send(payload.data, { binary: !!payload.binary }) } catch {}
  }

  function handleWsClose(peerPubkey, id, payload) {
    const state = stateFor(peerPubkey)
    const ws = state.sockets.get(id)
    state.sockets.delete(id)
    if (ws) { try { ws.close(payload?.code || 1000, payload?.reason || '') } catch {} }
  }

  function handleFrame(peerPubkey, frame) {
    switch (frame.type) {
      case FRAME.REQ_HEAD: return handleReqHead(peerPubkey, frame.id, frame.payload)
      case FRAME.REQ_BODY: return handleReqBody(peerPubkey, frame.id, frame.payload)
      case FRAME.WS_OPEN: return handleWsOpen(peerPubkey, frame.id, frame.payload)
      case FRAME.WS_MSG: return handleWsMsg(peerPubkey, frame.id, frame.payload)
      case FRAME.WS_CLOSE: return handleWsClose(peerPubkey, frame.id, frame.payload)
    }
  }

  function closePeer(peerPubkey) {
    const state = peerState.get(peerPubkey)
    if (!state) return
    for (const ws of state.sockets.values()) {
      try { ws.close() } catch {}
    }
    peerState.delete(peerPubkey)
  }

  function closeAll() {
    for (const peerPubkey of Array.from(peerState.keys())) closePeer(peerPubkey)
  }

  return { handleFrame, closePeer, closeAll, targetHost: targetUrl.host }
}

export function wireTunnelTransport(session, { target, onPeerOpen, onLog } = {}) {
  const router = makeTunnelRouter(session, { target, onLog })
  const openPeers = new Set()

  session.addEventListener('peer-open', (e) => {
    // Mirrors rtc-server.js: wireweave opens a reliable + unreliable channel
    // per peer; only the reliable one carries tunnel traffic.
    if (e.detail.unreliable) return
    const peerPubkey = e.detail.peerPubkey
    if (openPeers.has(peerPubkey)) return
    openPeers.add(peerPubkey)
    // Tell the browser which host:port the tunneled app's own absolute URLs
    // refer to, so it can rewrite those too (not just root-relative ones).
    sendFrame(session, peerPubkey, FRAME.INFO, 0, { targetHost: router.targetHost }).catch(() => {})
    onPeerOpen?.(peerPubkey, session.peers.get(peerPubkey)?.pc)
  })

  session.addEventListener('peer-close', (e) => {
    if (e.detail.unreliable) return
    openPeers.delete(e.detail.peerPubkey)
    router.closePeer(e.detail.peerPubkey)
  })

  session.addEventListener('data', (e) => {
    const frame = decodeFrame(e.detail.data)
    if (!frame) return
    router.handleFrame(e.detail.peerPubkey, frame)
  })

  return { close: () => router.closeAll() }
}

// Joins the WebRTC room derived from `seed` and starts relaying every
// connected browser peer's HTTP/WS traffic to `target` (e.g.
// "http://localhost:3000").
export async function attachTunnelTransport({ seed, target, namespace = 'nygrok', portRangeBegin, portRangeEnd, proxy, udpMux, onPeerConnected, onLog } = {}) {
  if (!target) throw new Error('attachTunnelTransport requires target — the local URL to tunnel')
  const { session, relayPool, auth } = await createRtcTransport({ namespace, portRangeBegin, portRangeEnd, proxy, udpMux })
  const roomId = deriveRoomFromSeed(seed)
  const transport = wireTunnelTransport(session, {
    target,
    onLog,
    onPeerOpen: (peerPubkey, pc) => {
      if (!pc) return
      setTimeout(() => {
        const desc = describeSelectedCandidatePair(pc)
        if (desc) onPeerConnected?.(peerPubkey, desc)
      }, 1000)
    }
  })

  await session.connect(roomId, { displayName: 'host' })

  return {
    roomId,
    pubkey: auth.pubkey,
    async close() {
      transport.close()
      await session.disconnect().catch(() => {})
      relayPool.disconnect()
    }
  }
}
