// Bundles web/src/client.js -> web/bundle.js (the bootstrap page, ESM) and
// web/src/sw.js -> web/sw.js (the service worker — must be a plain script a
// browser can register directly, so IIFE, not ESM: service worker module
// support is inconsistent enough across browsers to not rely on it here).

import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

const clientOptions = {
  entryPoints: [path.join(dir, 'src/client.js')],
  outfile: path.join(dir, 'bundle.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info'
}

const swOptions = {
  entryPoints: [path.join(dir, 'src/sw.js')],
  outfile: path.join(dir, 'sw.js'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info'
}

if (watch) {
  const [clientCtx, swCtx] = await Promise.all([esbuild.context(clientOptions), esbuild.context(swOptions)])
  await Promise.all([clientCtx.watch(), swCtx.watch()])
  console.log('watching web/src for changes...')
} else {
  await Promise.all([esbuild.build(clientOptions), esbuild.build(swOptions)])
}
