// The reverse-proxy service worker. Intercepts every fetch under this scope
// whose path names an active tunnel (`<scope>t/<seed>/...`) and answers it
// with real bytes fetched, over WebRTC, from the tunnel host — see
// web/src/client.js for the other half of this bridge (it owns the actual
// RTCDataChannel; a service worker has no WebRTC APIs of its own).
//
// Everything outside that path (the bootstrap page itself, bundle.js,
// sw.js, favicons, ...) is left to the network exactly as a normal page load
// would be — this worker only ever intercepts tunnel traffic.

import { rewriteHtml, rewriteCss, rewriteUrl } from './rewrite.js'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// seed -> { clientId, targetHost }. Purely in-memory: a browser is free to
// terminate an idle service worker at any time, which silently wipes this —
// waitForBridge() below recovers from that by asking every window client
// "who has this seed" and waiting briefly for a re-announce, rather than
// requiring the bridge to have never gone away.
const bridges = new Map()
const waiters = new Map() // seed -> Array<() => void>

function notifyBridgeReady(seed) {
  const list = waiters.get(seed)
  if (!list) return
  waiters.delete(seed)
  for (const fn of list) fn()
}

self.addEventListener('message', (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'nygrok-bridge-ready') {
    bridges.set(msg.seed, { clientId: event.source.id, targetHost: bridges.get(msg.seed)?.targetHost || '' })
    notifyBridgeReady(msg.seed)
  } else if (msg.type === 'nygrok-info') {
    const existing = bridges.get(msg.seed)
    bridges.set(msg.seed, { clientId: existing?.clientId || event.source.id, targetHost: msg.targetHost || '' })
    notifyBridgeReady(msg.seed)
  }
})

async function waitForBridge(seed, timeoutMs) {
  // A cached entry isn't enough on its own: with a reusable seed (`--key`),
  // an earlier tab's bridge can still be sitting in `bridges` after that tab
  // closed — the service worker is long-lived across tabs/reloads and
  // nothing proactively evicts a dead entry. Confirm the client is actually
  // still there before trusting it; otherwise fall through to rediscovery
  // exactly as if the seed were never seen.
  const existing = bridges.get(seed)
  if (existing) {
    const client = await self.clients.get(existing.clientId)
    if (client) return existing
    bridges.delete(seed)
  }
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const c of clients) c.postMessage({ type: 'nygrok-who-has', seed })
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    const list = waiters.get(seed) || []
    list.push(() => { clearTimeout(timer); resolve() })
    waiters.set(seed, list)
  })
  return bridges.get(seed) || null
}

function scopePath() {
  return new URL(self.registration.scope).pathname
}

// Matches "<scope>t/<seed>/<rest...>" (or no trailing rest = "/"). Returns
// null for anything else, which falls through to the network untouched.
function matchTunnel(url) {
  const prefixBase = scopePath() + 't/'
  if (!url.pathname.startsWith(prefixBase)) return null
  const rest = url.pathname.slice(prefixBase.length)
  const slash = rest.indexOf('/')
  const seed = slash === -1 ? rest : rest.slice(0, slash)
  if (!seed) return null
  const upstreamPath = (slash === -1 ? '/' : rest.slice(slash)) + url.search
  return { seed, upstreamPath, prefix: prefixBase + seed }
}

// A dynamic `import()` with a hardcoded absolute path (e.g. a plugin
// loader doing `import('/plugins/foo/client.js')`) can never be caught by
// rewriteHtml/rewriteCss or the injected fetch/XHR/WebSocket shim — none of
// those run for the browser's native module resolver. If the service
// worker's own scope is the origin root (see README: only achievable when
// nygrok is hosted at a domain/org root, not a GitHub Pages project
// subpage, since there's no way to send a Service-Worker-Allowed header on
// a project page), such a request still reaches this fetch handler; it just
// won't match matchTunnel()'s /t/<seed>/ prefix. Recover the seed from the
// requesting document's own (prefixed) location instead of the URL.
async function resolveSeedForClient(clientId) {
  if (!clientId) return null
  const client = await self.clients.get(clientId)
  if (!client) return null
  try {
    const u = new URL(client.url)
    const m = /^\/t\/([^/]+)/.exec(u.pathname.slice(scopePath().length - 1))
    return m ? m[1] : null
  } catch {
    return null
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const match = matchTunnel(url)
  if (match) {
    event.respondWith(proxyFetch(match, event.request))
    return
  }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath())) return
  // event.clientId only — NOT event.resultingClientId. A navigation request's
  // resulting client doesn't exist until AFTER this fetch event resolves, so
  // awaiting self.clients.get(resultingClientId) here is circular: the
  // navigation can't complete until we respond, and we'd be waiting for the
  // client that navigation would create. Confirmed by hand: this deadlocked
  // every reload of the bootstrap page itself once the service worker was
  // actually controlling it (a fresh, uncontrolled first load never hit this
  // path at all, masking the bug until a second visit). event.clientId is
  // already correctly empty for navigations, which is exactly right here —
  // a real navigation always matches matchTunnel() directly (its URL already
  // carries /t/<seed>/) or isn't tunnel content at all.
  event.respondWith((async () => {
    const seed = await resolveSeedForClient(event.clientId)
    if (!seed) return fetch(event.request)
    const fallbackMatch = { seed, upstreamPath: url.pathname + url.search, prefix: scopePath() + 't/' + seed }
    return proxyFetch(fallbackMatch, event.request)
  })())
})

function isTextType(contentType) {
  return /^(text\/|application\/(javascript|json|xml|xhtml\+xml)|image\/svg\+xml)/i.test(contentType || '')
}

// Node's http IncomingMessage.headers gives repeated headers (set-cookie in
// particular) as an array; the Headers constructor can't take array values
// directly, so build it by hand, appending each so multiple Set-Cookie
// headers survive instead of getting silently merged into one.
//
// Forces Cache-Control: no-store on every response regardless of what the
// upstream sent, redirects included. Confirmed by hand: Chrome caches a 3xx
// Location answer for a given URL independent of the service worker, so a
// redirect target computed while the rewrite was buggy (or before a peer
// with a different targetHost connected) stays wrong forever for that exact
// URL until the browser's HTTP cache is cleared — no-store prevents that
// class of bug from ever getting a chance to stick.
function toHeaders(obj) {
  const h = new Headers()
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.toLowerCase() === 'cache-control' || k.toLowerCase() === 'expires') continue
    if (Array.isArray(v)) for (const vv of v) h.append(k, vv)
    else if (v != null) h.append(k, String(v))
  }
  h.set('cache-control', 'no-store')
  return h
}

async function proxyFetch(match, request) {
  const bridge = await waitForBridge(match.seed, 2000)
  if (!bridge) {
    return new Response('nygrok: no active tunnel for this link. Reload the page to reconnect.', { status: 502, headers: { 'content-type': 'text/plain' } })
  }
  const client = await self.clients.get(bridge.clientId)
  if (!client) {
    return new Response('nygrok: tunnel bridge was lost. Reload the page to reconnect.', { status: 502, headers: { 'content-type': 'text/plain' } })
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const body = hasBody ? await request.clone().arrayBuffer() : null
  const reqHeaders = {}
  for (const [k, v] of request.headers.entries()) reqHeaders[k] = v

  const { port1, port2 } = new MessageChannel()

  const rawResponse = await new Promise((resolve) => {
    let controller = null
    let resolved = false
    const stream = new ReadableStream({
      start(c) { controller = c }
    })
    port1.onmessage = (ev) => {
      const msg = ev.data
      if (msg.type === 'head') {
        resolved = true
        resolve({ status: msg.status, statusText: msg.statusText, headers: msg.headers, stream, controller })
      } else if (msg.type === 'body') {
        try { controller.enqueue(new Uint8Array(msg.chunk)) } catch {}
      } else if (msg.type === 'end') {
        try { controller.close() } catch {}
        port1.close()
      } else if (msg.type === 'error') {
        if (resolved) { try { controller.error(new Error(msg.message)) } catch {} } else resolve({ error: msg.message })
        port1.close()
      }
    }
    const transfer = body ? [port2, body] : [port2]
    client.postMessage({ type: 'nygrok-fetch', seed: match.seed, method: request.method, path: match.upstreamPath, headers: reqHeaders, body }, transfer)
  })

  if (rawResponse.error) {
    return new Response('nygrok: ' + rawResponse.error, { status: 502, headers: { 'content-type': 'text/plain' } })
  }

  // A redirect's Location points at the tunnel target's own origin (e.g. a
  // static-file server 301ing "client.js" -> "client/index.js") — left
  // unrewritten, the browser would follow it straight to our proxy's domain
  // root instead of back through the /t/<seed>/ prefix, escaping the tunnel
  // entirely. Same rewrite rules as HTML/CSS URLs, applied to every response
  // (not just text ones), since a redirect can point at any resource type.
  if (rawResponse.headers.location) {
    rawResponse.headers = { ...rawResponse.headers, location: rewriteUrl(rawResponse.headers.location, { prefix: match.prefix, targetHost: bridge.targetHost }) }
  }

  const contentType = rawResponse.headers['content-type'] || ''
  if (!isTextType(contentType)) {
    return new Response(rawResponse.stream, { status: rawResponse.status, statusText: rawResponse.statusText, headers: toHeaders(rawResponse.headers) })
  }

  // Text content needs URL rewriting, which needs the whole body — buffer it
  // (bounded by real page/CSS sizes, unlike the streaming path used for
  // everything else).
  const text = await new Response(rawResponse.stream).text()
  const opts = { prefix: match.prefix, targetHost: bridge.targetHost, pageOrigin: self.location.origin }
  const rewritten = /html/i.test(contentType) ? rewriteHtml(text, opts) : /css/i.test(contentType) ? rewriteCss(text, opts) : text
  const headers = toHeaders(rawResponse.headers)
  headers.delete('content-length')
  return new Response(rewritten, { status: rawResponse.status, statusText: rawResponse.statusText, headers })
}
