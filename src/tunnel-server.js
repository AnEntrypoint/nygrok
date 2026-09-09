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
import { FRAME, encodeFrame, decodeFrame, MAX_CHUNK } from './tunnel-protocol.js'

// Headers we recompute ourselves rather than forward verbatim. accept-encoding
// is handled separately (see ACCEPT_ENCODING below) — we explicitly WANT to
// set it, not strip whatever the browser sent (which is normally nothing:
// Accept-Encoding is a forbidden/browser-managed header the Fetch API
// doesn't expose to JS, so web/src/sw.js's captured request.headers never
// actually carries one anyway).
const STRIP_REQUEST_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding'])
// content-encoding is stripped here too, but only used for the html/css path
// that must decompress to rewrite text — everything else keeps it (see
// RESPONSE_HEADERS_KEEP_ENCODING below) so the browser can decompress the
// passed-through original bytes natively instead of the data channel
// carrying the larger decompressed form.
const STRIP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'upgrade'])
const RESPONSE_HEADERS_KEEP_ENCODING = new Set([...STRIP_RESPONSE_HEADERS].filter((h) => h !== 'content-encoding'))
// Ask the local target to compress non-rewritten responses (JS, JSON,
// images, fonts, binary — the vast majority of a real app's bytes): those
// pass through unmodified (see needsTextRewrite below), so a compressed
// upstream response means fewer bytes crossing the WebRTC data channel,
// with the browser's own fetch/Response machinery decompressing it exactly
// as it would for a normal (non-tunneled) network response.
const ACCEPT_ENCODING = 'gzip, br'

function needsTextRewrite(contentType) {
  return /html/i.test(contentType) || /css/i.test(contentType)
}

const BUFFERED_AMOUNT_HIGH = 256 * 1024

function waitForDrain(dc) {
  if (!dc || typeof dc.bufferedAmount !== 'number' || dc.bufferedAmount <= BUFFERED_AMOUNT_HIGH) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    let timer = null
    const finish = () => {
      if (done) return
      done = true
      if (timer !== null) clearTimeout(timer)
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
    timer = setTimeout(finish, 250)
  })
}

async function sendFrame(session, peerPubkey, type, id, payload) {
  const dc = session.peers.get(peerPubkey)?.dc
  await waitForDrain(dc)
  session.send(peerPubkey, encodeFrame(type, id, payload))
}

function pickHeaders(headers, strip) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (strip.has(k.toLowerCase())) continue
    out[k] = v
  }
  return out
}

// AggregateError (Node's Happy-Eyeballs dual-stack connect, or similar)
// hides the actually-useful detail inside `.errors` — surface those too,
// not just the outer "AggregateError" message.
function describeRequestError(method, upstreamUrl, err) {
  const base = `upstream request failed: ${method} ${upstreamUrl} — ${err?.code || err?.name || 'Error'}: ${err?.message || err}`
  if (Array.isArray(err?.errors) && err.errors.length) {
    const nested = err.errors.map((e) => `${e?.code || e?.name || 'Error'}: ${e?.message || e}`).join('; ')
    return `${base} [${nested}]`
  }
  return base
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
  // Shared across every request to this target (all peers, all requests):
  // without keepAlive, Node's default agent forces "Connection: close",
  // meaning a real app's dozens-to-hundreds of requests each pay a fresh
  // TCP (and, for an https target, TLS) handshake plus teardown into
  // TIME_WAIT. The underlying socket pool is already keyed by host:port, so
  // one shared agent, not one per peer, is both correct and sufficient.
  const agent = new (targetUrl.protocol === 'https:' ? https.Agent : http.Agent)({ keepAlive: true, keepAliveMsecs: 1000 })

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
    // Encourage the local target to compress everything except what we're
    // about to text-rewrite (see needsTextRewrite below) — those bytes never
    // cross the data channel decompressed for anything that doesn't need
    // real text, so a compressed upstream response means fewer data-channel
    // bytes, with the browser decompressing natively exactly as it would
    // for a normal network response.
    if (!headers['accept-encoding'] && !headers['Accept-Encoding']) headers['accept-encoding'] = ACCEPT_ENCODING
    const req = httpMod.request(upstreamUrl, { method: head.method, headers, agent }, (res) => {
      ;(async () => {
        const contentType = res.headers['content-type'] || ''
        const rewrite = needsTextRewrite(contentType)
        await sendFrame(session, peerPubkey, FRAME.RES_HEAD, id, {
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: pickHeaders(res.headers, rewrite ? STRIP_RESPONSE_HEADERS : RESPONSE_HEADERS_KEEP_ENCODING)
        })
        try {
          // Only html/css need real decompressed text (rewriteHtml/
          // rewriteCss in web/src/rewrite.js rewrite URLs inline) — for
          // anything else, relay the original bytes (and Content-Encoding
          // header, above) as-is rather than decompressing server-side and
          // sending the larger plaintext form over the data channel.
          const body = rewrite ? decompressed(res) : res
          for await (const chunk of body) {
            for (let i = 0; i < chunk.length; i += MAX_CHUNK) {
              await sendFrame(session, peerPubkey, FRAME.RES_BODY, id, chunk.subarray(i, Math.min(i + MAX_CHUNK, chunk.length)))
            }
          }
          await sendFrame(session, peerPubkey, FRAME.RES_BODY, id, new Uint8Array(0))
        } catch (err) {
          await sendFrame(session, peerPubkey, FRAME.RES_ERROR, id, { message: String(err?.message || err) }).catch(() => {})
        }
      })().catch(() => {})
    })
    req.on('error', (err) => {
      onLog?.(describeRequestError(head.method, upstreamUrl, err))
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
      // Buffer.concat accepts Uint8Array elements directly (each is copied
      // into the final buffer via .set() regardless of whether it's a
      // Buffer) — the previous .map((c) => Buffer.from(c)) copied every
      // chunk once for that alone, on top of Buffer.concat's own copy, i.e.
      // every uploaded byte was copied twice for no reason.
      dispatchHttp(peerPubkey, id, pending.head, Buffer.concat(pending.chunks))
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
    agent.destroy()
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
export async function attachTunnelTransport({ seed, target, password = '', namespace = 'nygrok', portRangeBegin, portRangeEnd, proxy, udpMux, onPeerConnected, onLog } = {}) {
  if (!target) throw new Error('attachTunnelTransport requires target — the local URL to tunnel')
  const { session, relayPool, auth } = await createRtcTransport({ namespace, portRangeBegin, portRangeEnd, proxy, udpMux })
  const roomId = deriveRoomFromSeed(seed, password)
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
