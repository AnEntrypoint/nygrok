# nygrok

**Share your localhost. Skip the server.**

nygrok is a peer-to-peer tunnel for anything running on your machine — point
it at a port, get a link, hand the link to a friend. They open it in a
regular browser tab and see your app live, no install on their end. Under
the hood it's a `RTCDataChannel` straight to your machine, not a cloud
relay — the browser tab *is* the tunnel. Sibling project to
[sharesies](https://github.com/AnEntrypoint/sharesies) (shared terminals):
same zero-server transport, aimed at HTTP instead of a PTY.

## 30-second start

```bash
npx github:AnEntrypoint/nygrok 3000
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

That's it. Send the link. They open it, their browser negotiates a direct
(or TURN-relayed, if NAT is being difficult) WebRTC connection to your
machine, and your site just... shows up for them. Nothing gets uploaded to
a server anywhere — the two of you are talking directly, peer to peer,
found each other via public [nostr](https://nostr.com) relays acting as a
signaling handshake.

---

## Why not just use ngrok?

Because sometimes you don't want a public URL at all.

ngrok gives you a real internet-facing endpoint — curl can hit it, webhooks
can hit it, so can bots scanning the whole internet for open endpoints.
That's the point of ngrok, and it needs a company's cloud relay to pull
off.

nygrok makes a different trade: **no public endpoint exists, period.** The
only way in is through the exact link you handed out, opened in an actual
WebRTC-capable browser.

| | ngrok | nygrok |
|---|---|---|
| Reachable by | anyone/anything with the URL (curl, bots, webhooks) | only a browser opening your exact invite link |
| Runs through | a cloud relay | nothing — direct P2P |
| Needs an account | yes | no |
| Traffic visibility | passes through ngrok's servers | never leaves WebRTC's encrypted channel |

A few things fall out of that trade:

- **The seed *is* the access control.** Whoever holds the link can view
  (and interact with, if the app allows it) whatever's on that port —
  treat the link like a password. `--key <seed>` gives you a stable,
  reusable one instead of a fresh random seed every run.
- **Optional second password, never in the link.** `--password <pw>` folds
  a password into the room id itself, so the link alone stops being enough
  — whoever connects also needs the password, entered into the page before
  it even tries to connect. See below.
- **Nothing to leak.** No account, no logs on a server somewhere — the
  only third parties involved are WebRTC's own STUN/TURN infrastructure
  (sees encrypted bytes only) and the nostr relays used purely to say "hey,
  I'm here" during signaling.

## How it actually works

```
[localhost:PORT] <--http/ws--> [nygrok host] <==WebRTC==> [viewer's browser]
                                                                 |
                                                     service worker (virtual
                                                     HTTP server) + injected
                                                     shim, both same-origin
```

1. `npx github:AnEntrypoint/nygrok <port>` turns your seed into a WebRTC room id
   (`sha256('nygrok:' + seed)`) and joins it — same trick sharesies uses
   for its HyperDHT keypair. See `src/rtc-node.js` (lifted from sharesies
   unmodified; it never cared what was flowing through it).
2. The `#<seed>` in the invite link tells the browser page which room to
   join. Once its `RTCDataChannel` opens, it registers a **service
   worker** and loads your site in an iframe under `/t/<seed>/`.
3. Every request the browser makes under that path — HTML, CSS, JS,
   images, `fetch`/XHR — gets caught by the service worker, turned into a
   `REQ_HEAD`/`REQ_BODY` frame over the data channel (see
   `src/tunnel-protocol.js`), answered by a real HTTP request the host
   fires at your local server, and streamed back as `RES_HEAD`/`RES_BODY`
   frames that become a real `Response` on the other end.
4. `WebSocket`s get the same royal treatment through a small virtual
   `WebSocket` shim (a service worker can't intercept the WS upgrade
   itself — see `web/src/rewrite.js`), relaying `WS_OPEN`/`WS_MSG`/
   `WS_CLOSE` frames against a real socket the host opens locally.

Because the proxy lives under a path prefix (`/t/<seed>/`) rather than the
domain root, `rewrite.js` also rewrites root-relative and
tunnel-origin-absolute URLs on the fly — HTML/CSS attributes, `<script
type="importmap">` entries, redirect `Location` headers, and at runtime via
a shim patching `fetch`/`XHR`/`WebSocket` inside the tunneled page — so
everything keeps resolving through the prefix instead of escaping it.

One thing slips past all of that: a dynamic `import()` with a hardcoded
absolute path (a handful of plugin-loader systems do this) never touches
`fetch`/`XHR`, so no shim can rewrite it — only the service worker's own
`fetch` event stands a chance, and only inside its scope. A service
worker's scope is capped at the directory it's served from, and GitHub
Pages has no way to widen that for a project page. That's why the hosted
client lives at **`https://anentrypoint.github.io/`** — an org *root*
Pages site
([`AnEntrypoint/AnEntrypoint.github.io`](https://github.com/AnEntrypoint/AnEntrypoint.github.io))
instead of a `/nygrok/` subpath — root scope means the service worker sees
those requests too. When one shows up with no `/t/<seed>/` prefix, `sw.js`
recovers the seed from the requesting page's own (still prefixed) URL and
proxies it anyway.

## Usage

```bash
npx github:AnEntrypoint/nygrok 3000                  # tunnel http://localhost:3000
npx github:AnEntrypoint/nygrok http://localhost:3000  # equivalent
npx github:AnEntrypoint/nygrok --key my-seed 3000     # stable invite link across restarts
```

### Password protection

Want the link to not be enough on its own? Add a password:

```bash
npx github:AnEntrypoint/nygrok --password hunter2 3000
```

Now the page shows a small password prompt *before* it even attempts to
connect. Get it wrong (or leave it blank when one's required) and you just
never find a peer — there's no "wrong password" error to probe against,
because the room id itself is derived from `seed + password` together. If
you don't have the right password, you can't even compute which room to
look in.

Give the link and the password out through different channels — putting
both in the same message defeats the point.

`--pw` is shorthand for `--password`. Pair it with `--key <seed>` for a
stable link + password combo you can reuse across restarts.

### NAT-traversal tuning

Same flags as sharesies' `--web` mode, for the same reasons (its README has
the full rationale):

```bash
npx github:AnEntrypoint/nygrok --rtc-port-range 50000-51000 3000
npx github:AnEntrypoint/nygrok --rtc-udp-mux 3000
npx github:AnEntrypoint/nygrok --rtc-proxy socks5://user:pass@proxyhost:1080 3000
```

> **Needs a native binary.** Like sharesies' `--web` mode, this runs on
> [node-datachannel](https://github.com/murat-dogan/node-datachannel)'s
> native WebRTC binding. If install skipped the prebuilt binary (you'll see
> `Cannot find module '.../node_datachannel.node'`), grab it directly:
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

Serve `web/` with any static file server (service workers need a secure
context, but `http://localhost:*` counts — no TLS required locally) and
open it with `#<seed>` matching a locally running `node nygrok.mjs <port>`.

## Known limitations

This is a best-effort browser-side reverse proxy, not a magic guarantee for
every possible app — the same honest caveat any service-worker-based proxy
carries:

- **URL rewriting is regex/attribute-based, not a full parser.** It catches
  `href`/`src`/`action`/`srcset`, CSS `url()`, import map entries, redirect
  `Location` headers, and JS-initiated `fetch`/`XHR`/`WebSocket` calls with
  root-relative or tunnel-origin-absolute URLs — plus, since the hosted
  client runs at root scope, even a same-origin hardcoded-absolute-path
  dynamic `import()` gets caught and resolved. A site that builds URLs in
  truly unusual ways (string-concatenating a hostname deep inside a
  minified bundle, then posting it to a *different* origin) might still
  misbehave.
- **No public plain-HTTP URL.** curl, webhooks, and bots simply can't reach
  a tunnel — only a WebRTC-capable browser opening the actual invite link
  can. Deliberate, not a bug (see "Why not just use ngrok?" above).
- **No CLI-native client.** v1 is WebRTC/browser-only; there's no
  `--connect` mode like sharesies has for its HyperDHT transport.
- **Service workers are ephemeral.** The browser can terminate an idle one
  at any time; `web/src/sw.js` recovers automatically (it asks the page to
  re-announce itself and waits briefly), but a request landing in that
  narrow recovery window can be slightly delayed.
- **Third-party cross-origin requests** (analytics, CDNs, a WebSocket to a
  genuinely different service) are deliberately left alone to hit the
  network directly instead of being proxied — usually correct, but means
  they run under the viewer's own network conditions, not yours.

## Security

Same posture as sharesies:

- WebRTC traffic is encrypted via DTLS/SRTP per spec; signaling runs over
  public nostr relays using a fresh, in-memory-only identity generated per
  process — never persisted, never tied to your real identity.
- The seed is effectively a password: only someone holding it can derive
  the WebRTC room id. A fresh one is generated per session by default;
  reach for `--key` only when you actually want a stable, reusable link.
- Your local machine is the only place the tunneled server runs — nygrok
  relays traffic, it never executes anything on your behalf.

## License

MIT
