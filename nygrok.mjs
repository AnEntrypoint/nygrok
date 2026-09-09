#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { runServer } from './src/server.js'

const HELP = `nygrok — P2P localhost tunnel, viewed straight from a browser page

USAGE:
  npx github:AnEntrypoint/nygrok <port>              Tunnel http://localhost:<port>
  npx github:AnEntrypoint/nygrok http://localhost:3000
  npx github:AnEntrypoint/nygrok --key <seed> 3000   Fixed seed -> stable invite link
  npx github:AnEntrypoint/nygrok --password <pw> 3000
                                     Require a password (given separately,
                                     never in the link) before the page will
                                     connect at all

WEBRTC NAT-TRAVERSAL TUNING:
  --rtc-port-range <begin>-<end>    Pin ICE to a fixed UDP port range
                                     (port-forward that range for strict NATs)
  --rtc-udp-mux                     Share one UDP port across all viewers
  --rtc-proxy <socks5|http>://host:port
                                     Route WebRTC ICE through a proxy, for
                                     networks that block direct UDP/TCP

Notes:
  - Give the printed link to anyone who should be able to view your local
    site. They open it in a normal browser tab; no install needed.
  - The seed is the password: anyone with the link can view (and, for apps
    that accept it, interact with) whatever is running on that local port.
  - No public port is opened. No account, no relay server to run.
`

function parseProxyUrl(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error(`--rtc-proxy: not a valid URL: ${input}`)
  }
  const type = url.protocol === 'socks5:' ? 'Socks5' : url.protocol === 'http:' ? 'Http' : null
  if (!type) throw new Error(`--rtc-proxy: unsupported scheme "${url.protocol}" (use socks5:// or http://)`)
  if (!url.hostname || !url.port) throw new Error(`--rtc-proxy: URL must include host and port: ${input}`)
  const proxy = { type, ip: url.hostname, port: Number(url.port) }
  if (url.username) proxy.username = decodeURIComponent(url.username)
  if (url.password) proxy.password = decodeURIComponent(url.password)
  return proxy
}

function parsePortRange(input) {
  const m = /^(\d+)-(\d+)$/.exec(input || '')
  if (!m) throw new Error(`--rtc-port-range: expected "<begin>-<end>", got "${input}"`)
  const begin = Number(m[1])
  const end = Number(m[2])
  if (begin > end) throw new Error(`--rtc-port-range: begin (${begin}) must be <= end (${end})`)
  return { begin, end }
}

function parseArgs(argv) {
  const out = {
    key: null, webBase: null, password: null,
    rtcPortRangeBegin: undefined, rtcPortRangeEnd: undefined, rtcUdpMux: false, rtcProxy: undefined,
    positionals: [], help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--key') out.key = argv[++i]
    else if (a === '--password' || a === '--pw') out.password = argv[++i]
    else if (a === '--web-base') out.webBase = argv[++i]
    else if (a === '--rtc-port-range') { const r = parsePortRange(argv[++i]); out.rtcPortRangeBegin = r.begin; out.rtcPortRangeEnd = r.end }
    else if (a === '--rtc-udp-mux') out.rtcUdpMux = true
    else if (a === '--rtc-proxy') out.rtcProxy = parseProxyUrl(argv[++i])
    else if (a.startsWith('--')) { /* ignore unknown long flags */ }
    else out.positionals.push(a)
  }
  return out
}

async function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)

  if (args.help) {
    process.stdout.write(HELP)
    return
  }

  const target = args.positionals[0]
  if (!target) {
    process.stderr.write('nygrok shares a local server directly.\n\n')
    process.stderr.write('  npx nygrok <port>                 e.g.  npx nygrok 3000\n')
    process.stderr.write('  npx nygrok http://localhost:3000\n')
    process.stderr.write('  npx nygrok --key <seed> 3000      (stable invite link)\n\n')
    process.exit(1)
  }

  return await runServer({
    seed: args.key || undefined,
    target,
    password: args.password || undefined,
    webBase: args.webBase || undefined,
    rtcPortRangeBegin: args.rtcPortRangeBegin,
    rtcPortRangeEnd: args.rtcPortRangeEnd,
    rtcUdpMux: args.rtcUdpMux,
    rtcProxy: args.rtcProxy
  })
}

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch((err) => {
    process.stderr.write('nygrok fatal: ' + (err && err.message ? err.message : err) + '\n')
    process.exit(1)
  })
}
