// Best-effort URL rewriting for HTML/CSS served through the tunnel, plus the
// injected client-side shim script.
//
// The proxy lives at a path prefix (e.g. `/nygrok/t/<seed>`), not at the
// domain root, so any root-relative URL in the tunneled site's own HTML/CSS
// ("/logo.png") would otherwise resolve to our own origin's root and escape
// the proxy. This rewrites those (and any URL that literally names the
// tunnel target's original host:port, common in dev-server-generated HTML)
// to stay under the prefix.
//
// This is regex/attribute-based, not a full HTML parser — it covers the
// common cases (href/src/action/srcset attributes, CSS url()) but, like any
// browser-side reverse proxy, isn't a guarantee for every possible app. What
// it can't catch statically (JS-constructed URLs passed to fetch/XHR/
// WebSocket) is instead caught at runtime by the injected shim below, which
// intercepts those calls before the page's own script runs.

const ATTR_RE = /\b(href|src|action|formaction)(\s*=\s*)(["'])(\/(?!\/)[^"']*)\3/gi
const SRCSET_RE = /\bsrcset(\s*=\s*)(["'])([^"']*)\2/gi
const CSS_URL_RE = /url\(\s*(["']?)(\/(?!\/)[^"')]*)\1\s*\)/gi

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function prefixPath(path, prefix) {
  return prefix.replace(/\/$/, '') + path
}

// Rewrites a single URL (as opposed to rewriteHtml/rewriteCss, which rewrite
// URLs embedded in a larger text blob) — for response headers like
// `Location` on a redirect, which point at the tunnel target's own origin
// and would otherwise send the browser to our proxy's domain root instead
// of back through the `/t/<seed>/` prefix.
export function rewriteUrl(rawUrl, { prefix, targetHost }) {
  if (!rawUrl) return rawUrl
  if (rawUrl[0] === '/' && rawUrl[1] !== '/') return prefixPath(rawUrl, prefix)
  if (targetHost) {
    try {
      const u = new URL(rawUrl)
      if (u.host === targetHost) return prefixPath(u.pathname + u.search + u.hash, prefix)
    } catch {}
  }
  return rawUrl
}

function rewriteAbsoluteOrigins(text, { prefix, targetHost, pageOrigin }) {
  if (!targetHost) return text
  const re = new RegExp('(https?|wss?):(//)' + escapeRegExp(targetHost) + '(/[^"\'\\s)>]*)?', 'gi')
  return text.replace(re, (m, scheme, slashes, path) => {
    const p = path || '/'
    const outScheme = scheme === 'ws' || scheme === 'wss' ? (pageOrigin.startsWith('https') ? 'wss:' : 'ws:') : (pageOrigin.startsWith('https') ? 'https:' : 'http:')
    return outScheme + '//' + pageOrigin.replace(/^https?:\/\//, '') + prefixPath(p, prefix)
  })
}

const IMPORTMAP_RE = /(<script[^>]*\btype\s*=\s*["']importmap["'][^>]*>)([\s\S]*?)(<\/script>)/i

// Import maps declare bare-specifier -> URL mappings as raw JSON, not
// href/src attributes, so the browser's own module resolver reads them
// directly — ATTR_RE above never sees them. A root-relative or
// tunnel-target-absolute entry left unrewritten sends every `import
// '<bare-specifier>'` straight to the proxy's domain root instead of back
// through the /t/<seed>/ prefix.
function rewriteImportMap(html, opts) {
  return html.replace(IMPORTMAP_RE, (m, openTag, json, closeTag) => {
    let map
    try {
      map = JSON.parse(json)
    } catch {
      return m
    }
    const rewriteValues = (obj) => {
      if (!obj) return
      for (const k of Object.keys(obj)) obj[k] = rewriteUrl(obj[k], opts)
    }
    rewriteValues(map.imports)
    if (map.scopes) {
      const rewrittenScopes = {}
      for (const scopeKey of Object.keys(map.scopes)) {
        rewriteValues(map.scopes[scopeKey])
        rewrittenScopes[rewriteUrl(scopeKey, opts)] = map.scopes[scopeKey]
      }
      map.scopes = rewrittenScopes
    }
    return openTag + JSON.stringify(map) + closeTag
  })
}

export function rewriteHtml(html, opts) {
  const { prefix } = opts
  let out = rewriteImportMap(html, opts)
  out = out.replace(ATTR_RE, (m, attr, eq, q, path) => `${attr}${eq}${q}${prefixPath(path, prefix)}${q}`)
  out = out.replace(SRCSET_RE, (m, eq, q, value) => {
    const rewritten = value
      .split(',')
      .map((entry) => {
        const trimmed = entry.trim()
        if (!trimmed) return trimmed
        const spaceIdx = trimmed.indexOf(' ')
        const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
        const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx)
        if (url[0] !== '/' || url[1] === '/') return trimmed
        return prefixPath(url, prefix) + rest
      })
      .join(', ')
    return `srcset${eq}${q}${rewritten}${q}`
  })
  out = rewriteAbsoluteOrigins(out, opts)
  out = injectShim(out, opts)
  return out
}

export function rewriteCss(css, opts) {
  const { prefix } = opts
  let out = css.replace(CSS_URL_RE, (m, q, path) => `url(${q}${prefixPath(path, prefix)}${q})`)
  out = rewriteAbsoluteOrigins(out, opts)
  return out
}

function injectShim(html, opts) {
  const script = `<script>${buildShimSource(opts)}</script>`
  const headMatch = /<head[^>]*>/i.exec(html)
  if (headMatch) {
    const idx = headMatch.index + headMatch[0].length
    return html.slice(0, idx) + script + html.slice(idx)
  }
  const htmlMatch = /<html[^>]*>/i.exec(html)
  if (htmlMatch) {
    const idx = htmlMatch.index + htmlMatch[0].length
    return html.slice(0, idx) + script + html.slice(idx)
  }
  return script + html
}

// Runs inside the tunneled page itself (injected as the very first script).
// Rewrites URLs passed to fetch/XHR/WebSocket that are root-relative or
// point at the tunnel's original host:port, so JS-initiated requests stay
// under the proxy the same way statically-rewritten HTML/CSS does. A
// WebSocket to the tunnel's own origin can't be handled by the service
// worker (fetch events don't cover the WS upgrade), so it's replaced
// entirely with a virtual socket that pipes through the RTCDataChannel via
// window.top.__nygrokBridge (see web/src/client.js) — anything to a
// genuinely different, external origin is left alone and connects for real.
export function buildShimSource({ prefix, targetHost }) {
  return `(function(){
  var PREFIX = ${JSON.stringify(prefix)};
  var TARGET_HOST = ${JSON.stringify(targetHost || '')};
  function isTunnelUrl(u) {
    try {
      var a = new URL(u, document.baseURI);
      // Compare host, not origin: a ws:/wss: URL never shares an origin with
      // an http:/https: page even on the identical host:port, since origin
      // serialization includes the scheme.
      if (a.host === location.host) return a.pathname.indexOf(PREFIX) !== 0 ? 'root' : false;
      if (TARGET_HOST && a.host === TARGET_HOST) return 'origin';
      return false;
    } catch (e) { return false; }
  }
  function rewrite(u) {
    try {
      var a = new URL(u, document.baseURI);
      var kind = isTunnelUrl(u);
      if (!kind) return u;
      var path = a.pathname + a.search + a.hash;
      var scheme = (a.protocol === 'ws:' || a.protocol === 'wss:') ? (location.protocol === 'https:' ? 'wss:' : 'ws:') : location.protocol;
      return scheme + '//' + location.host + PREFIX.replace(/\\/$/, '') + path;
    } catch (e) { return u; }
  }
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input, init) {
      try {
        if (typeof input === 'string') input = rewrite(input);
        else if (input && typeof input.url === 'string') input = new Request(rewrite(input.url), input);
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var args = Array.prototype.slice.call(arguments);
    try { args[1] = rewrite(url); } catch (e) {}
    return origOpen.apply(this, args);
  };
  var OrigWS = window.WebSocket;
  if (OrigWS && window.top && window.top.__nygrokBridge) {
    var bridge = window.top.__nygrokBridge;
    function VirtualWebSocket(url, protocols) {
      var self = this;
      self.url = url;
      self.readyState = 0;
      self.bufferedAmount = 0;
      self.binaryType = 'blob';
      self.protocol = '';
      self._listeners = { open: [], message: [], close: [], error: [] };
      var a;
      try { a = new URL(url, document.baseURI); } catch (e) { a = null; }
      var upath = a ? (a.pathname.indexOf(PREFIX) === 0 ? a.pathname.slice(PREFIX.length) || '/' : a.pathname) + (a.search || '') : '/';
      self._sock = bridge.openWs(upath, protocols, {
        onAccept: function(protocol) {
          self.readyState = 1;
          self.protocol = protocol || '';
          self._dispatch('open', {});
        },
        onMessage: function(data, isBinary) {
          var payload = isBinary ? data : new TextDecoder().decode(data);
          self._dispatch('message', { data: payload });
        },
        onClose: function(code, reason) {
          self.readyState = 3;
          self._dispatch('close', { code: code, reason: reason });
        }
      });
    }
    VirtualWebSocket.prototype.send = function(data) {
      var isBinary = !(typeof data === 'string');
      this._sock.send(isBinary ? data : new TextEncoder().encode(data), isBinary);
    };
    VirtualWebSocket.prototype.close = function(code, reason) {
      this.readyState = 2;
      this._sock.close(code, reason);
    };
    VirtualWebSocket.prototype.addEventListener = function(type, cb) {
      if (this._listeners[type]) this._listeners[type].push(cb);
    };
    VirtualWebSocket.prototype.removeEventListener = function(type, cb) {
      if (!this._listeners[type]) return;
      var i = this._listeners[type].indexOf(cb);
      if (i !== -1) this._listeners[type].splice(i, 1);
    };
    VirtualWebSocket.prototype._dispatch = function(type, detail) {
      var handlerProp = 'on' + type;
      if (typeof this[handlerProp] === 'function') { try { this[handlerProp](detail); } catch (e) {} }
      this._listeners[type].slice().forEach(function(cb) { try { cb(detail); } catch (e) {} });
    };
    VirtualWebSocket.CONNECTING = 0; VirtualWebSocket.OPEN = 1; VirtualWebSocket.CLOSING = 2; VirtualWebSocket.CLOSED = 3;
    window.WebSocket = function(url, protocols) {
      if (isTunnelUrl(url)) return new VirtualWebSocket(url, protocols);
      return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;
  }
})();`
}
