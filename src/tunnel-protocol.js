// Wire framing for tunneling HTTP + WebSocket traffic over a single
// wireweave RTCDataChannel (isomorphic: runs unmodified in Node and the
// browser).
//
// A PTY is one continuous byte stream (see sharesies' rtc-protocol.js: 5
// fixed logical channels, no ids needed). HTTP is the opposite shape: many
// independent request/response exchanges — and WebSocket connections — can
// be in flight at once over the same peer connection. So every frame here
// carries a 4-byte stream id, and each id is scoped to one HTTP request or
// one WebSocket connection.
//
// Frame layout: [type: u8][id: u32 BE][payload...]
// - *_HEAD frames: payload is UTF-8 JSON.
// - *_BODY / WS_MSG frames: payload is raw bytes (a zero-length BODY frame
//   marks end-of-body; WS_MSG carries a 1-byte binary flag before the bytes).
// - *_ERROR / WS_CLOSE: payload is UTF-8 JSON.

export const FRAME = {
  REQ_HEAD: 0,
  REQ_BODY: 1,
  RES_HEAD: 2,
  RES_BODY: 3,
  RES_ERROR: 4,
  WS_OPEN: 5,
  WS_ACCEPT: 6,
  WS_MSG: 7,
  WS_CLOSE: 8,
  // Sent once, host->client, right after a peer connects: tells the browser
  // which host:port the tunneled app's own absolute URLs refer to (so
  // rewrite.js can catch e.g. a dev server emitting `ws://localhost:5173/...`
  // literally in its HTML/JS, not just root-relative URLs).
  INFO: 9
}

const JSON_TYPES = new Set([FRAME.REQ_HEAD, FRAME.RES_HEAD, FRAME.RES_ERROR, FRAME.WS_OPEN, FRAME.WS_ACCEPT, FRAME.WS_CLOSE, FRAME.INFO])

// Max payload bytes per REQ_BODY frame (RES_BODY/WS_MSG don't go through
// chunkBody() at all — see tunnel-server.js). Well under the ~256KB most
// browsers/node-datachannel reliably deliver in one RTCDataChannel message;
// the frame header itself is only 5 bytes, so headroom is enormous relative
// to that ceiling — 64KB keeps the per-frame count (and its fixed
// encodeFrame/sendFrame/dc.send overhead) an order of magnitude lower than
// 16KB for large uploads while staying well clear of BUFFERED_AMOUNT_HIGH
// (256KB) in tunnel-server.js/client.js's backpressure gate.
export const MAX_CHUNK = 64 * 1024

const te = new TextEncoder()
const td = new TextDecoder()

function toBytes(x) {
  if (x instanceof Uint8Array) return x
  if (x instanceof ArrayBuffer) return new Uint8Array(x)
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength)
  return new Uint8Array(0)
}

export function encodeFrame(type, id, payload) {
  if (JSON_TYPES.has(type)) {
    const json = te.encode(JSON.stringify(payload ?? {}))
    const buf = new Uint8Array(5 + json.length)
    buf[0] = type
    new DataView(buf.buffer).setUint32(1, id >>> 0, false)
    buf.set(json, 5)
    return buf
  }
  if (type === FRAME.WS_MSG) {
    const bytes = toBytes(payload.data)
    const buf = new Uint8Array(6 + bytes.length)
    buf[0] = type
    new DataView(buf.buffer).setUint32(1, id >>> 0, false)
    buf[5] = payload.binary ? 1 : 0
    buf.set(bytes, 6)
    return buf
  }
  // REQ_BODY / RES_BODY: raw bytes, zero-length = end-of-body.
  const bytes = toBytes(payload)
  const buf = new Uint8Array(5 + bytes.length)
  buf[0] = type
  new DataView(buf.buffer).setUint32(1, id >>> 0, false)
  buf.set(bytes, 5)
  return buf
}

export function decodeFrame(data) {
  const bytes = toBytes(data)
  if (bytes.length < 5) return null
  const type = bytes[0]
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const id = view.getUint32(1, false)
  if (JSON_TYPES.has(type)) {
    const json = bytes.subarray(5)
    let payload
    try {
      payload = json.length ? JSON.parse(td.decode(json)) : {}
    } catch {
      return null
    }
    return { type, id, payload }
  }
  if (type === FRAME.WS_MSG) {
    if (bytes.length < 6) return null
    return { type, id, payload: { binary: bytes[5] === 1, data: bytes.subarray(6) } }
  }
  return { type, id, payload: bytes.subarray(5) }
}

// Splits a body into MAX_CHUNK-sized pieces for REQ_BODY/RES_BODY framing.
// Always yields at least the terminating empty chunk, even for an empty body.
export function* chunkBody(bytes) {
  const buf = toBytes(bytes)
  if (buf.length === 0) {
    yield new Uint8Array(0)
    return
  }
  for (let i = 0; i < buf.length; i += MAX_CHUNK) {
    yield buf.subarray(i, Math.min(i + MAX_CHUNK, buf.length))
  }
  yield new Uint8Array(0)
}
