// Bootstrap page for a nygrok invite link (`#<seed>`). Owns the actual
// WebRTC connection to the tunnel host (a service worker has no WebRTC APIs
// of its own — see web/src/sw.js) and bridges it two ways:
//   - fetch/CSS/HTML resource requests the service worker intercepts get
//     relayed here via postMessage, turned into REQ_HEAD/REQ_BODY frames,
//     and their RES_* responses relayed back.
//   - WebSocket connections opened by the injected shim (rewrite.js, running
//     inside the tunneled iframe) call window.top.__nygrokBridge.openWs()
//     directly (same-origin, no postMessage needed) and get WS_OPEN/WS_MSG/
//     WS_CLOSE frames the same way.
// Once both the RTCDataChannel and the service worker are ready, the actual
// tunneled site loads in an iframe — never in this top-level page, which
// must stay alive as long as the tunnel is open.

import { createRtcTransport, deriveRoomFromSeed, describeSelectedCandidatePair } from './rtc-browser.js'
import { FRAME, encodeFrame, decodeFrame, chunkBody } from '../../src/tunnel-protocol.js'

const statusEl = document.getElementById('status')
const frameEl = document.getElementById('frame')

function setStatus(text, isError) {
  if (!statusEl) return
  statusEl.textContent = text
  statusEl.classList.toggle('error', !!isError)
}

const seed = decodeURIComponent(location.hash.slice(1))
if (!seed) {
  setStatus('No invite seed in the URL. Ask for a fresh link (it looks like ...#<seed>).', true)
  throw new Error('nygrok: missing seed')
}

const BUFFERED_AMOUNT_HIGH = 256 * 1024

function waitForDrain(dc) {
  if (!dc || dc.bufferedAmount <= BUFFERED_AMOUNT_HIGH) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (done) return; done = true; dc.removeEventListener('bufferedamountlow', finish); resolve() }
    dc.bufferedAmountLowThreshold = Math.floor(BUFFERED_AMOUNT_HIGH / 2)
    dc.addEventListener('bufferedamountlow', finish)
    setTimeout(finish, 250)
  })
}

async function main() {
  setStatus('registering local proxy…')
  const reg = await navigator.serviceWorker.register('./sw.js')
  await navigator.serviceWorker.ready

  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      const onChange = () => { navigator.serviceWorker.removeEventListener('controllerchange', onChange); resolve() }
      navigator.serviceWorker.addEventListener('controllerchange', onChange)
      setTimeout(resolve, 3000)
    })
  }
  if (!navigator.serviceWorker.controller) {
    setStatus('Proxy worker did not take control — try reloading this page.', true)
    return
  }

  // Fetch-proxy requests (from sw.js, via MessageChannel) for the currently
  // in-flight stream ids this page originated.
  const pendingFetches = new Map() // id -> MessagePort
  // Open virtual WebSockets (from the injected shim in the iframe) keyed by
  // stream id.
  const wsCallbacks = new Map() // id -> { onAccept, onMessage, onClose }

  function announceBridge() {
    navigator.serviceWorker.controller?.postMessage({ type: 'nygrok-bridge-ready', seed })
    navigator.serviceWorker.controller?.postMessage({ type: 'nygrok-info', seed, targetHost })
  }

  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data
    if (msg && msg.type === 'nygrok-who-has' && msg.seed === seed) {
      announceBridge()
      return
    }
    if (!msg || msg.type !== 'nygrok-fetch') return
    if (msg.seed !== seed) return
    const port = event.ports[0]
    const id = nextStreamId()
    pendingFetches.set(id, port)
    sendFrame(FRAME.REQ_HEAD, id, { method: msg.method, path: msg.path, headers: msg.headers })
    if (msg.body && msg.body.byteLength) {
      ;(async () => {
        for (const chunk of chunkBody(new Uint8Array(msg.body))) await sendFrame(FRAME.REQ_BODY, id, chunk)
      })()
    } else {
      sendFrame(FRAME.REQ_BODY, id, new Uint8Array(0))
    }
  })

  setStatus('connecting to host…')
  const { session, relayPool } = createRtcTransport({ namespace: 'nygrok' })
  const roomId = await deriveRoomFromSeed(seed)

  let hostPubkey = null
  let dataChannelOpen = false
  let targetHost = ''

  async function sendFrame(type, id, payload) {
    if (!hostPubkey) return
    const dc = session.peers.get(hostPubkey)?.dc
    await waitForDrain(dc)
    session.send(hostPubkey, encodeFrame(type, id, payload))
  }

  let nextId = 1
  function nextStreamId() {
    const id = nextId++
    if (nextId > 0xffffffff) nextId = 1
    return id
  }

  function maybeStartIframe() {
    if (!dataChannelOpen || frameEl.src) return
    setStatus('connected — loading site…')
    // Tell the service worker which client (this page) is the RTC bridge
    // for this seed, and which host:port the tunneled app's own absolute
    // URLs refer to (see rewrite.js).
    announceBridge()
    const prefix = new URL('./t/' + seed + '/', location.href).pathname
    frameEl.src = prefix
    frameEl.hidden = false
    if (statusEl) statusEl.hidden = true
  }

  session.addEventListener('peer-open', (e) => {
    if (e.detail.unreliable) return
    hostPubkey = e.detail.peerPubkey
    dataChannelOpen = true
    const pc = session.peers.get(hostPubkey)?.pc
    if (pc) {
      describeSelectedCandidatePair(pc).then((desc) => {
        if (desc) console.log('nygrok: connected ' + (desc.relayed ? 'via TURN relay' : `direct (${desc.localType}/${desc.remoteType})`))
      })
    }
    maybeStartIframe()
  })

  session.addEventListener('peer-close', (e) => {
    if (e.detail.unreliable) return
    if (e.detail.peerPubkey !== hostPubkey) return
    dataChannelOpen = false
    hostPubkey = null
    setStatus('Host disconnected. The tunnel has ended.', true)
  })

  session.addEventListener('data', (e) => {
    const frame = decodeFrame(e.detail.data)
    if (!frame) return
    if (frame.type === FRAME.INFO) {
      targetHost = frame.payload.targetHost || ''
      return
    }
    if (frame.type === FRAME.RES_HEAD || frame.type === FRAME.RES_BODY || frame.type === FRAME.RES_ERROR) {
      const port = pendingFetches.get(frame.id)
      if (!port) return
      if (frame.type === FRAME.RES_HEAD) {
        port.postMessage({ type: 'head', status: frame.payload.status, statusText: frame.payload.statusText, headers: frame.payload.headers })
      } else if (frame.type === FRAME.RES_BODY) {
        if (frame.payload.length === 0) {
          port.postMessage({ type: 'end' })
          pendingFetches.delete(frame.id)
        } else {
          const buf = frame.payload.slice().buffer
          port.postMessage({ type: 'body', chunk: buf }, [buf])
        }
      } else {
        port.postMessage({ type: 'error', message: frame.payload.message })
        pendingFetches.delete(frame.id)
      }
      return
    }
    if (frame.type === FRAME.WS_ACCEPT) {
      wsCallbacks.get(frame.id)?.onAccept(frame.payload.protocol)
    } else if (frame.type === FRAME.WS_MSG) {
      wsCallbacks.get(frame.id)?.onMessage(frame.payload.data, frame.payload.binary)
    } else if (frame.type === FRAME.WS_CLOSE) {
      wsCallbacks.get(frame.id)?.onClose(frame.payload.code, frame.payload.reason)
      wsCallbacks.delete(frame.id)
    }
  })

  // Exposed to the tunneled site's injected shim (rewrite.js), running in
  // the iframe, via window.top.__nygrokBridge — same-origin, so a direct
  // property access works with no postMessage plumbing needed.
  window.__nygrokBridge = {
    openWs(path, protocols, { onAccept, onMessage, onClose }) {
      const id = nextStreamId()
      wsCallbacks.set(id, { onAccept, onMessage, onClose })
      sendFrame(FRAME.WS_OPEN, id, { path, protocols: protocols || [], headers: {} })
      return {
        send(data, isBinary) { sendFrame(FRAME.WS_MSG, id, { binary: isBinary, data }) },
        close(code, reason) { sendFrame(FRAME.WS_CLOSE, id, { code: code || 1000, reason: reason || '' }); wsCallbacks.delete(id) }
      }
    }
  }

  await session.connect(roomId, { displayName: 'viewer' })

  window.addEventListener('beforeunload', () => {
    session.disconnect().catch(() => {})
    relayPool.disconnect()
  })
}

main().catch((err) => {
  console.error(err)
  setStatus('nygrok failed to start: ' + (err && err.message ? err.message : err), true)
})
