import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Build id used to namespace the service-worker cache. Combines the
// package version with the current timestamp so every build yields a
// unique cache key; old caches get purged in the SW's activate handler.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version?: string }
const BUILD_ID = `${pkg.version ?? '0.0.0'}-${Date.now().toString(36)}`

/**
 * Replace the `__BUILD_ID__` token inside the emitted sw.js so each deploy
 * gets a fresh cache namespace without anyone having to hand-bump VERSION.
 *
 * sw.js lives under `public/` and is copied as-is by Vite — it never enters
 * the bundle graph, so `generateBundle` doesn't see it. Run on `closeBundle`
 * and patch the file on disk instead.
 */
function swVersionInject() {
  return {
    name: 'sw-version-inject',
    apply: 'build' as const,
    closeBundle() {
      const swPath = resolve(__dirname, 'dist/sw.js')
      if (!existsSync(swPath)) return
      const raw = readFileSync(swPath, 'utf8')
      const next = raw.replaceAll('__BUILD_ID__', BUILD_ID)
      if (next !== raw) writeFileSync(swPath, next, 'utf8')
    },
  }
}

/**
 * Vite bundles the sqlite-wasm worker (sqlite3-worker1-*.js) with a content-
 * hashed filename, but the worker's pre-built glue code resolves its wasm
 * companion via `locateFile('sqlite3.wasm')` — i.e. it expects an UNHASHED
 * `sqlite3.wasm` sitting next to the worker JS. Without that file present,
 * Cloudflare Pages' SPA fallback returns index.html for the wasm fetch,
 * `WebAssembly.instantiateStreaming` silently rejects on the bad bytes, the
 * worker's init promise dies inside an unhandled rejection, and every
 * `query()` / `exec()` call queues against a promiser that will never reply.
 *
 * This plugin emits the package's pristine sqlite3.wasm into the build
 * output as `assets/sqlite3.wasm` so the worker's relative locateFile path
 * resolves to the real wasm.
 */
function sqliteWasmUnhashedCopy() {
  return {
    name: 'sqlite-wasm-unhashed-copy',
    apply: 'build' as const,
    generateBundle() {
      const src = resolve(
        __dirname,
        'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm',
      )
      const source = readFileSync(src)
      ;(this as unknown as { emitFile: (f: { type: 'asset'; fileName: string; source: Buffer }) => void }).emitFile({
        type: 'asset',
        fileName: 'assets/sqlite3.wasm',
        source,
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), sqliteWasmUnhashedCopy(), swVersionInject()],
  build: {
    // Tailwind v4 is no longer in the dep tree, so the lightningcss parser
    // bug that originally forced cssMinify: false is moot. Re-enable CSS
    // minification — lightningcss is the default in Vite 8 / rolldown and
    // ships with no extra install needed.
    cssMinify: true,
  },
})
