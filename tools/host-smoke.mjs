/**
 * Host-half smoke test with a fake Cordis context — no DSH, no network.
 *
 *   node tools/host-smoke.mjs
 *
 * Covers state persistence, CSRF guard, allowlist, path traversal, upload type
 * checks, pin/download, asset serving and graceful upstream failure.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const home = await mkdtemp(join(tmpdir(), 'lww-smoke-'))
process.env.DSH_HOME = home

const { apply, normalizeState } = await import('../src/index.js')

const routes = new Map()
const ctx = {
  effect(callback) {
    return callback()
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}

apply(ctx)
assert.ok(routes.size >= 8, `expected >= 8 routes, got ${routes.size}`)

const P = '/api/lightweight-wallpaper'
const HEADERS = { 'x-dsh-plugin': 'lightweight-wallpaper' }

function makeReq({ method = 'GET', url, headers = {}, body }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers || {}
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      this.ended = true
    },
    buffer() {
      return Buffer.concat(this.chunks)
    },
    json() {
      try {
        return JSON.parse(this.buffer().toString('utf8'))
      } catch {
        return null
      }
    },
  }
}

function pickRoute(urlPath) {
  const clean = urlPath.split('?')[0]
  for (const route of routes.values()) {
    if (route.kind === 'exact') {
      if (route.path === clean) return route
    } else if (urlPath.startsWith(route.path)) {
      return route
    }
  }
  throw new Error(`no route for ${urlPath}`)
}

async function call(method, urlPath, options = {}) {
  const route = pickRoute(urlPath)
  const res = makeRes()
  await route.handler(makeReq({ method, url: urlPath, headers: options.headers || {}, body: options.body }), res)
  return res
}

let passed = 0
let failed = 0
const failures = []

async function step(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${label}`)
  } catch (error) {
    failed += 1
    failures.push({ label, error })
    console.log(`FAIL  ${label} — ${error?.message ?? error}`)
  }
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

await step('GET /state returns defaults', async () => {
  const res = await call('GET', `${P}/state`)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.state.enabled, true)
  assert.equal(body.state.fit, 'cover')
})

await step('POST /state without plugin header is rejected', async () => {
  const res = await call('POST', `${P}/state`, { body: JSON.stringify({ state: {} }) })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().error.code, 'FORBIDDEN')
})

await step('POST /state clamps and persists', async () => {
  const res = await call('POST', `${P}/state`, {
    headers: HEADERS,
    body: JSON.stringify({ state: { opacity: 999, dim: -4, fit: 'weird' } }),
  })
  assert.equal(res.statusCode, 200)
  const saved = res.json().state
  assert.equal(saved.opacity, 100)
  assert.equal(saved.dim, 0)
  assert.equal(saved.fit, 'cover')
  const onDisk = JSON.parse(await readFile(join(home, 'lightweight-wallpaper', 'state.json'), 'utf8'))
  assert.equal(onDisk.opacity, 100)
})

await step('normalizeState strips unknown wallpaper assets', async () => {
  const state = normalizeState({ wallpaper: { asset: '/etc/passwd', source: 'bing' } })
  assert.equal(state.wallpaper, null)
})

await step('GET /proxy rejects a non-allowlisted host', async () => {
  const res = await call('GET', `${P}/proxy?u=${encodeURIComponent('https://evil.example.com/x.jpg')}`)
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error.code, 'URL_NOT_ALLOWED')
})

await step('GET /asset rejects path traversal', async () => {
  const res = await call('GET', `${P}/asset/..%2F..%2Fstate.json`)
  assert.equal(res.statusCode, 404)
})

await step('POST /upload rejects a non-image content type', async () => {
  const res = await call('POST', `${P}/upload`, {
    headers: { ...HEADERS, 'content-type': 'text/plain' },
    body: 'hello',
  })
  assert.equal(res.statusCode, 415)
})

let uploadedAsset = ''
await step('POST /upload stores bytes and /asset serves them', async () => {
  const res = await call('POST', `${P}/upload`, {
    headers: { ...HEADERS, 'content-type': 'image/jpeg' },
    body: jpeg,
  })
  assert.equal(res.statusCode, 200)
  uploadedAsset = res.json().asset
  assert.match(uploadedAsset, /^\/api\/lightweight-wallpaper\/asset\/[a-f0-9]{40}\.jpg$/)
  const served = await call('GET', uploadedAsset)
  assert.equal(served.statusCode, 200)
  assert.equal(served.headers['content-type'], 'image/jpeg')
  assert.deepEqual(served.buffer(), jpeg)
})

await step('POST /pin downloads an allowlisted image', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  try {
    const res = await call('POST', `${P}/pin`, {
      headers: HEADERS,
      body: JSON.stringify({ url: 'https://www.bing.com/th?id=OHR.Test_UHD.jpg', source: 'bing' }),
    })
    assert.equal(res.statusCode, 200)
    assert.match(res.json().asset, /\/asset\/[a-f0-9]{40}\.jpg$/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await step('POST /pin rejects a non-allowlisted URL', async () => {
  const res = await call('POST', `${P}/pin`, {
    headers: HEADERS,
    body: JSON.stringify({ url: 'https://evil.example.com/x.jpg' }),
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error.code, 'URL_NOT_ALLOWED')
})

await step('GET /bing degrades to an empty stale payload when upstream fails', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  try {
    const res = await call('GET', `${P}/bing?mkt=en-US`)
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.deepEqual(body.items, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

await step('GET /art falls back to the built-in artwork when Commons fails', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  try {
    const res = await call('GET', `${P}/art?source=wikimedia&q=${encodeURIComponent('Vincent van Gogh paintings')}`)
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.ok(body.items.length >= 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await step('GET /health reports the cache', async () => {
  const res = await call('GET', `${P}/health`)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  // Uploaded and pinned bytes are identical, so the content-addressed store
  // keeps ONE file; the assertion is that the cache is populated at all.
  assert.ok(body.assets >= 1, `assets=${body.assets}`)
})

await step('POST /upload accepts PNG magic bytes', async () => {
  const res = await call('POST', `${P}/upload`, {
    headers: { ...HEADERS, 'content-type': 'image/png' },
    body: png,
  })
  assert.equal(res.statusCode, 200)
  assert.match(res.json().asset, /\.png$/)
})

await step('defaults ship the glass panel values', async () => {
  const res = await call('GET', `${P}/state`)
  assert.equal(res.statusCode, 200)
  const state = res.json().state
  assert.equal(state.panelEnabled, true)
  assert.equal(state.panelAlpha, 55)
  assert.equal(state.panelBlur, 24)
  assert.equal(state.contrastEnabled, true)
  // The clamp test above persisted opacity=100, so the default is checked purely.
  assert.equal(normalizeState({}).opacity, 62)
})

await step('POST /state clamps glass panel values', async () => {
  const res = await call('POST', `${P}/state`, {
    headers: HEADERS,
    body: JSON.stringify({
      state: { panelAlpha: 999, panelBlur: -5, panelEnabled: false, contrastEnabled: false },
    }),
  })
  assert.equal(res.statusCode, 200)
  const saved = res.json().state
  assert.equal(saved.panelAlpha, 100)
  assert.equal(saved.panelBlur, 0)
  assert.equal(saved.panelEnabled, false)
  assert.equal(saved.contrastEnabled, false)
})

await step('legacy state without glass fields hydrates defaults', async () => {
  const state = normalizeState({ opacity: 70, dim: 20 })
  assert.equal(state.panelEnabled, true)
  assert.equal(state.panelAlpha, 55)
  assert.equal(state.panelBlur, 24)
  assert.equal(state.contrastEnabled, true)
  assert.equal(state.opacity, 70)
  assert.equal(state.dim, 20)
})

await rm(home, { recursive: true, force: true })

console.log('\n' + '='.repeat(64))
console.log(`${passed}/${passed + failed} checks passed`)
if (failed > 0) {
  for (const entry of failures) console.log(`  FAILED: ${entry.label} — ${entry.error?.message ?? entry.error}`)
  process.exitCode = 1
}
