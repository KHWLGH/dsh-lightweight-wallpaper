/**
 * dsh-lightweight-wallpaper — Host entry (stable shim).
 *
 * The real Host half lives in ./impl.js. Node caches ES modules by URL, so a
 * host edit would normally need a Harness restart; this entry file stays stable
 * and swaps in a fresh `?rev=` generation whenever ./impl.js or ./sources.js
 * changes on disk — the same idea as the official Client HMR, which polls every
 * client bundle and calls clientModules.rebuilt().
 *
 * The Client half already hot-reloads through that official channel, so
 * code-only edits on either side take effect in about a second. Only
 * registration-level files (package.json, cordis.patch.yml, locale meta) still
 * need one restart.
 *
 * The route table, state layout and the `$DSH_HOME` contract are documented in
 * ./impl.js — this file only owns the reload loop.
 */
import { statSync } from 'node:fs'

import * as impl from './impl.js'

export const name = impl.name
export const inject = impl.inject
export { DEFAULT_STATE, normalizeState } from './impl.js'

/** Host files whose change installs a new generation. */
const WATCHED = ['./impl.js', './sources.js'].map((file) => new URL(file, import.meta.url))
const POLL_MS = 800
/** Child plugin name: the shim keeps the package name for the loader. */
const GENERATION = `${impl.name}:host`

/** mtime + ctime + size for every watched file — the same triple HMR compares. */
function stamp() {
  let value = ''
  for (const url of WATCHED) {
    try {
      const info = statSync(url)
      value += `${info.mtimeMs}:${info.ctimeMs}:${info.size}|`
    } catch {
      value += 'missing|'
    }
  }
  return value
}

/** Run one generation of the Host half in its own fiber (disposable in place). */
function mount(ctx, plugin) {
  return ctx.plugin({ name: GENERATION, inject: plugin.inject, apply: plugin.apply })
}

export function apply(ctx) {
  /* The smoke harness has no Cordis fibers: run the Host half inline, exactly
     like the single-module entry did before, so its checks stay synchronous. */
  if (typeof ctx.plugin !== 'function') {
    impl.apply(ctx)
    return
  }

  let generation = mount(ctx, impl)
  let seen = stamp()
  let busy = false

  const reload = async () => {
    busy = true
    try {
      /* Import first: a syntax error keeps the running generation alive. */
      const next = await import(new URL(`./impl.js?rev=${Date.now().toString(36)}`, import.meta.url))
      const retiring = generation
      generation = undefined
      try {
        retiring?.dispose?.()
      } catch {
        /* the fiber is already gone */
      }
      generation = mount(ctx, next)
      ctx.logger?.info?.('lightweight-wallpaper: host half reloaded')
    } catch (error) {
      /* The previous generation was already retired: put the bundled one back so
         the plugin never ends up without routes. */
      if (!generation) {
        try {
          generation = mount(ctx, impl)
        } catch {
          /* nothing left to fall back to */
        }
      }
      ctx.logger?.warn?.(
        `lightweight-wallpaper: host reload failed, keeping the running generation — ${error?.message ?? error}`,
      )
    } finally {
      busy = false
      seen = stamp()
    }
  }

  const timer = setInterval(() => {
    if (busy) return
    const next = stamp()
    if (next === seen) return
    seen = next
    void reload()
  }, POLL_MS)
  timer.unref?.()

  ctx.effect(() => () => {
    clearInterval(timer)
    try {
      generation?.dispose?.()
    } catch {
      /* already disposed with the parent fiber */
    }
  })
}
