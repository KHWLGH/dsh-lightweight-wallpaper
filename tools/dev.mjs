#!/usr/bin/env node
/**
 * Development loop for dsh-lightweight-wallpaper.
 *
 *   node tools/dev.mjs
 *
 * Code-only edits no longer need a Harness restart:
 *
 *   src/client.js                     → the official Client HMR reloads the bundle
 *                                       in ~1s (SSE /plugins/events, no refresh)
 *   src/impl.js, src/sources.js       → the Host entry shim re-imports a fresh
 *                                       generation in ~1s (same idea, Node side)
 *   src/index.js (the shim itself),
 *   package.json, locale meta,
 *   cordis.patch.yml                  → still need one restart (registration layer)
 *
 * What this script adds is a gate in front of that reload: every save is parsed
 * (`node --check` / JSON.parse) and the matching suite runs, so a broken bundle
 * never turns up in the running UI unnoticed. It never writes anything.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const DEBOUNCE_MS = 180
const CLIENT = 'src/client.js'
const HOST_RELOADABLE = new Set(['src/impl.js', 'src/sources.js'])
const HOST_RESTART = new Set(['src/index.js', 'package.json', 'cordis.patch.yml'])
const LABEL = '[lww]'

function rel(file) {
  return relative(root, file).replace(/\\/g, '/')
}

function run(args) {
  const started = Date.now()
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  return { ok: result.status === 0, ms: Date.now() - started, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function tail(text, lines = 8) {
  const rows = text.trimEnd().split(/\r?\n/)
  return rows.slice(-lines).join('\n')
}

/** Syntax gate: the cheapest way to keep a broken save out of the live app. */
function syntaxOf(file) {
  if (file.endsWith('.json')) {
    try {
      JSON.parse(readFileSync(join(root, file), 'utf8'))
      return { ok: true, ms: 0 }
    } catch (error) {
      return { ok: false, ms: 0, out: String(error.message ?? error) }
    }
  }
  if (!/\.(m?js)$/.test(file)) return { ok: true, ms: 0 }
  return run(['--check', file])
}

function check(files) {
  const rows = []
  let ok = true
  for (const file of files) {
    const result = syntaxOf(file)
    ok &&= result.ok
    if (!result.ok) rows.push(`${file}: syntax FAIL\n${tail(result.out)}`)
  }
  if (!ok) return { ok: false, rows, reload: 'no reload: fix the syntax error first' }

  if (files.includes(CLIENT)) {
    const result = run(['tools/client-contract.mjs'])
    ok &&= result.ok
    rows.push(
      result.ok
        ? `client.js ok → HMR reloads the bundle in ~1s (no restart)`
        : `client-contract FAIL (${result.ms}ms)\n${tail(result.out)}`,
    )
  }
  const hostFiles = files.filter((file) => HOST_RELOADABLE.has(file) || file === 'src/index.js')
  if (hostFiles.length > 0) {
    const result = run(['tools/host-smoke.mjs'])
    ok &&= result.ok
    const reloadable = hostFiles.filter((file) => HOST_RELOADABLE.has(file))
    if (result.ok) {
      if (reloadable.length > 0) {
        rows.push(`${reloadable.join(', ')} ok → Host shim reloads a new generation in ~1s (no restart)`)
      }
      if (hostFiles.includes('src/index.js')) {
        rows.push('src/index.js is the shim itself → this edit still needs one restart')
      }
    } else {
      rows.push(`host-smoke FAIL (${result.ms}ms)\n${tail(result.out)}`)
    }
  }
  for (const file of files) {
    if (!/\.(m?js|json)$/.test(file) && !HOST_RESTART.has(file)) continue
    if (file.startsWith('locale/')) rows.push(`${file} changed → restart (registration layer)`)
    if (file === 'package.json') rows.push('package.json changed → restart (registration layer)')
  }
  return { ok, rows, reload: ok ? 'ok' : 'failed' }
}

console.log(`${LABEL} watching src/, tools/, locale/ — Ctrl+C to stop`)
console.log(`${LABEL} client.js: hot reload · impl.js/sources.js: Host reload · index.js/package.json/locale: restart`)

let timer = null
let pending = new Set()

function flush() {
  timer = null
  const files = [...pending].filter((file) => existsSync(join(root, file))).sort()
  pending = new Set()
  if (files.length === 0) return
  console.log(`\n${LABEL} ${files.join(', ')}`)
  const result = check(files)
  for (const row of result.rows) console.log(`${LABEL} ${row}`)
  console.log(`${LABEL} ${result.ok ? 'saved' : 'NOT saved (see above)'}`)
}

for (const dir of ['src', 'tools', 'locale']) {
  try {
    watch(join(root, dir), { recursive: true }, (_event, name) => {
      if (!name) return
      pending.add(rel(join(root, dir, String(name))))
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, DEBOUNCE_MS)
    })
  } catch {
    /* a directory may not exist yet */
  }
}

process.on('SIGINT', () => {
  console.log(`\n${LABEL} stopped`)
  process.exit(0)
})
