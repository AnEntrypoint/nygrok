// Server side: tunnel a local URL to anyone who opens the invite link.
//
// `npx nygrok <port>` picks a fresh random seed, and relays every browser
// peer that opens `https://<pages-base>/#<seed>` straight to
// `http://localhost:<port>` — no ports opened, no relay server, no account.

import { randomSeed } from './keys.js'
import { attachTunnelTransport } from './tunnel-server.js'

function normalizeTarget(input) {
  if (/^https?:\/\//i.test(input)) return input
  if (/^\d+$/.test(input)) return `http://localhost:${input}`
  return `http://${input}`
}

export async function runServer(opts = {}) {
  if (!opts.target) {
    throw new Error('runServer requires opts.target — the local URL (or port) to tunnel')
  }
  const target = normalizeTarget(String(opts.target))
  const seed = opts.seed || randomSeed()

  const rtc = await attachTunnelTransport({
    seed,
    target,
    portRangeBegin: opts.rtcPortRangeBegin,
    portRangeEnd: opts.rtcPortRangeEnd,
    proxy: opts.rtcProxy,
    udpMux: opts.rtcUdpMux,
    onPeerConnected: (peerPubkey, desc) => {
      const path = desc.relayed ? 'via TURN relay' : `direct (${desc.localType}/${desc.remoteType})`
      console.log(`nygrok: viewer ${peerPubkey.slice(0, 12)} connected ${path}`)
    },
    onLog: (msg) => console.log('nygrok: ' + msg)
  })

  // Root, not the /nygrok/ project page: a service worker's scope is capped
  // at the directory it's served from, and GitHub Pages gives no way to
  // widen that (no custom response headers, so Service-Worker-Allowed isn't
  // achievable) — some real apps dynamically import() plugins/chunks by
  // absolute root path, which only a root-scoped worker can intercept. See
  // https://github.com/AnEntrypoint/AnEntrypoint.github.io.
  const webBase = opts.webBase || 'https://anentrypoint.github.io/'
  const inviteUrl = `${webBase}#${seed}`

  console.log('')
  console.log('nygrok — tunneling a local server over WebRTC, peer to peer')
  console.log('-------------------------------------------------------------')
  console.log('Target:  ' + target)
  console.log('')
  console.log('Give this link to anyone who should be able to view it:')
  console.log('')
  console.log('  ' + inviteUrl)
  console.log('')
  console.log('Whoever opens it browses your local site straight from their')
  console.log('browser — no install, no public port. Ctrl+C to stop sharing.')
  console.log('')

  let closed = false
  async function shutdown(code = 0) {
    if (closed) return
    closed = true
    await Promise.race([rtc.close(), new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => {})
    process.exit(typeof code === 'number' ? code : 0)
  }

  process.on('SIGINT', () => shutdown(130))
  process.on('SIGTERM', () => shutdown(143))

  return { rtc, seed, target, inviteUrl, shutdown }
}
