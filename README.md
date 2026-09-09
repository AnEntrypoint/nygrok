# nygrok

A peer-to-peer localhost tunnel, viewed straight from a browser page over
WebRTC — no ports opened, no relay server to run, no account. Sibling
project to [sharesies](https://github.com/AnEntrypoint/sharesies) (shared
terminals): same zero-server transport, applied to HTTP instead of a PTY.

```bash
npx nygrok 3000
```

```
nygrok — tunneling a local server over WebRTC, peer to peer
-------------------------------------------------------------
Target:  http://localhost:3000

Give this link to anyone who should be able to view it:

  https://anentrypoint.github.io/#a1b2c3...

Whoever opens it browses your local site straight from their
browser — no install, no public port. Ctrl+C to stop sharing.
```

Send that link to a friend. They open it in a normal browser tab — no
install — and it renders whatever's running on your local port, live,
straight from their browser. Nothing is uploaded anywhere; the two browsers
(or your CLI and their browser) talk directly over a WebRTC data channel,
signaled peer-to-peer over public [nostr](https://nostr.com) relays.

---

## Why this is different from ngrok

ngrok gives you a real public URL that *anyone* — curl, webhooks, bots, a
browser with no special software — can hit. That requires a company's cloud
relay terminating real HTTP traffic on a public IP.

nygrok has no relay and no account. What it gives you instead: the seed in
the invite link *is* the connection — whoever has it opens the nygrok page,
and their browser negotiates a direct (or TURN-relayed, when NAT requires
it) WebRTC connection straight to your machine. That means:

- **No public HTTP endpoint.** Only a browser that opens the actual invite
  link can reach your site — not curl, not a webhook sender, not a bot.
  This is a deliberate scope choice (see `../sharesies`'s same trade-off for
  terminal sharing), not a missing feature.
- **The seed is the password.** Anyone with the link can view — and, for
  apps that accept it, interact with — whatever's on that port. Treat it
  like a password; don't log or commit it. `--key <seed>` gives a stable,
  reusable one instead of a fresh random seed each run.
- **Nothing persists anywhere.** No account, no server logs your traffic —
  it never passes through a third party at all (beyond WebRTC's own STUN/TURN
  infrastructure for NAT traversal, which only ever sees encrypted DTLS
  bytes, and the nostr relays used purely for connection signaling).

## How it works

```
[localhost:PORT] <--http/ws--> [nygrok host] <==WebRTC==> [viewer's browser]
                                                                 |
                                                     service worker (virtual
                                                     HTTP server) + injected
                                                     shim, both same-origin
```

1. `npx nygrok <port>` derives a WebRTC room id from a seed
   (`sha256('nygrok:' + seed)`) and joins it, the same way sharesies derives
   its HyperDHT keypair — see `src/rtc-node.js` (copied from sharesies
   unmodified; it's already transport-agnostic).
2. The invite link's `#<seed>` fragment tells the browser page which room to
   join. Once its `RTCDataChannel` is open, it registers a **service
   worker** scoped to the page and loads the tunneled site in an iframe
   under a per-seed path (`/t/<seed>/`).
3. Every resource request the browser makes under that path — HTML, CSS,
   JS, images, `fetch`/XHR calls — is intercepted by the service worker,
   turned into a `REQ_HEAD`/`REQ_BODY` frame sent over the data channel (see
   `src/tunnel-protocol.js`), answered by a real HTTP request the host makes
   against your local server, and streamed back as `RES_HEAD`/`RES_BODY`
   frames the service worker turns into a real `Response`.
4. `WebSocket` connections get the same treatment via a small virtual
   `WebSocket` object (service workers can't intercept the WS upgrade
   itself, so this part is a JS-level replacement — see
   `web/src/rewrite.js`), relaying `WS_OPEN`/`WS_MSG`/`WS_CLOSE` frames
   against a real WebSocket the host opens to your local server.

The proxy lives at a path prefix (`/t/<seed>/`), not the domain root, so
`rewrite.js` also does best-effort rewriting of root-relative and
tunnel-origin-absolute URLs — in served HTML/CSS attributes, `<script
type="importmap">` entries, redirect `Location` headers, and at runtime via
an injected shim that patches `fetch`/`XHR`/`WebSocket` in the tunneled
page — so they resolve back through the prefix instead of escaping it.

One class of request slips past all of that: a dynamic `import()` with a
hardcoded absolute path (some plugin-loader systems do this) is never
routed through `fetch`/`XHR`, so no shim can catch it — only the service
worker's `fetch` event can, and only if the request falls inside its scope.
A service worker's scope is capped at the directory it's served from, and
GitHub Pages gives no way to widen that for a project page (no custom
response headers, so `Service-Worker-Allowed` isn't achievable). That's why
the hosted client lives at **`https://anentrypoint.github.io/`** (an org
root Pages site, [`AnEntrypoint/AnEntrypoint.github.io`](https://github.com/AnEntrypoint/AnEntrypoint.github.io))
rather than a `/nygrok/` project page — root scope means the service worker
sees these requests too. When one arrives without the `/t/<seed>/` prefix,
`sw.js` recovers the seed from the requesting document's own (still
prefixed) location instead of the URL, then proxies it the same way.

## Usage

```bash
npx github:AnEntrypoint/nygrok 3000                  # tunnel http://localhost:3000
npx github:AnEntrypoint/nygrok http://localhost:3000  # equivalent
npx github:AnEntrypoint/nygrok --key my-seed 3000     # stable invite link across restarts
```

### NAT-traversal tuning

Same flags as sharesies' `--web` mode, for the same reasons (see its README
for the full rationale):

```bash
npx nygrok --rtc-port-range 50000-51000 3000
npx nygrok --rtc-udp-mux 3000
npx nygrok --rtc-proxy socks5://user:pass@proxyhost:1080 3000
```

> **Needs a native binary.** Like sharesies' `--web` mode, this uses
> [node-datachannel](https://github.com/murat-dogan/node-datachannel)'s
> native WebRTC binding. If install didn't fetch the prebuilt binary (you'll
> see `Cannot find module '.../node_datachannel.node'`), fetch it directly:
> `cd node_modules/node-datachannel && npx prebuild-install -r napi`.

### SDK

```js
import { runServer } from 'nygrok'
await runServer({ target: 'http://localhost:3000' })
```

### Local development

```bash
npm run dev:web    # rebuild web/bundle.js + web/sw.js on change
npm run build:web  # one-off production build
```

Serve `web/` with any static file server (service workers require a secure
context, but `http://localhost:*` counts as one — no TLS needed for local
testing) and open it with `#<seed>` matching a locally running
`node nygrok.mjs <port>`.

## Known limitations

This is a best-effort browser-side reverse proxy, not a guarantee for every
possible app — the same honest caveat any service-worker-based proxy has:

- **URL rewriting is regex/attribute-based, not a full HTML/CSS/JS parser.**
  It catches `href`/`src`/`action`/`srcset` attributes, CSS `url()`, import
  map entries, redirect `Location` headers, and JS-initiated
  `fetch`/`XHR`/`WebSocket` calls with root-relative or tunnel-origin-
  absolute URLs — plus, since the hosted client runs at root scope, a
  same-origin request that skips all of that (a hardcoded-absolute-path
  dynamic `import()`) still gets caught and resolved via the requesting
  document's own location. A site that constructs URLs in truly unusual ways
  (e.g. string-concatenating a hostname deep inside a minified bundle, then
  posting it to a *different* origin) may still not render correctly.
- **No public plain-HTTP URL.** curl, webhooks, and bots can't reach a
  tunnel — only a WebRTC-capable browser that opens the actual invite link.
  This is deliberate (see "Why this is different from ngrok" above), not a
  bug.
- **No CLI-native client.** v1 is WebRTC/browser-only; there's no
  `--connect` mode like sharesies has for its HyperDHT transport.
- **Service workers are ephemeral.** A browser is free to terminate an idle
  one; `web/src/sw.js` recovers automatically (it asks the page to
  re-announce itself and waits briefly) but a request that lands in that
  narrow recovery window can be slightly delayed.
- **Third-party cross-origin requests** (analytics, CDNs, a WebSocket to a
  genuinely different service) are deliberately left alone to hit the
  network directly rather than being proxied — usually the right behavior,
  but means they run under the viewer's own network conditions, not yours.

## Security

Same posture as sharesies:

- WebRTC traffic is encrypted via DTLS/SRTP per the WebRTC spec; signaling
  happens over public nostr relays using a fresh, in-memory-only identity
  generated per process — never persisted, never your real identity.
- The seed is effectively a password: only someone with it can derive the
  WebRTC room id. Generate a fresh one per session (the default) unless you
  specifically want a stable, reusable link via `--key`.
- Your local machine is the only place the tunneled server runs — nygrok
  relays traffic, it doesn't execute anything on your behalf.

## License

MIT
