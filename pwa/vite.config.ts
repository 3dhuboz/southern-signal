import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  plugins: [react(), sqliteWasmUnhashedCopy()],
})
