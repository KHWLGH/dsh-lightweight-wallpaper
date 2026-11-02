/**
 * Host-half smoke test with a fake Cordis context — no DSH, no network.
 *
 *   node tools/host-smoke.mjs
 *
 * Covers state persistence, CSRF guard, allowlist, path traversal, upload type
 * checks, pin/download, asset serving, graceful upstream failure, the
 * recent-wallpaper history and cache statistics/clearing.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const home = await mkdtemp(join(tmpdir(), 'lww-smoke-'))
process.env.DSH_HOME = home

const { apply, normalizeState } = await import('../src/index.js')
const { standardThumbWidth, thumbUrl } = await import('../src/sources.js')

/** Build one Host instance with its own route table (all instances share DSH_HOME). */
function createHarness() {
  const table = new Map()
  apply({
    effect(callback) {
      return callback()
    },
    webServer: {
      register(route) {
        table.set(route.path, route)
        return () => table.delete(route.path)
      },
    },
  })
  return table
}

const routes = createHarness()
assert.ok(routes.size >= 8, `expected >= 8 routes, got ${routes.size}`)

const P = '/api/lightweight-wallpaper'
const HEADERS = { 'x-dsh-plugin': 'lightweight-wallpaper' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

function pickRoute(urlPath, table = routes) {
  const clean = urlPath.split('?')[0]
  for (const route of table.values()) {
    if (route.kind === 'exact') {
      if (route.path === clean) return route
    } else if (urlPath.startsWith(route.path)) {
      return route
    }
  }
  throw new Error(`no route for ${urlPath}`)
}

async function callOn(table, method, urlPath, options = {}) {
  const route = pickRoute(urlPath, table)
  const res = makeRes()
  await route.handler(makeReq({ method, url: urlPath, headers: options.headers || {}, body: options.body }), res)
  return res
}

async function call(method, urlPath, options = {}) {
  return callOn(routes, method, urlPath, options)
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

/* ------------------------------------------------------------------------- */
/* Paging, list disk cache and thumbnail proxy                               */
/* ------------------------------------------------------------------------- */

const wikiPagePayload = {
  continue: { gsroffset: 24 },
  query: {
    pages: [
      {
        pageid: 9001,
        title: 'File:Pagination probe one.jpg',
        imageinfo: [
          {
            mime: 'image/jpeg',
            width: 2400,
            height: 1600,
            thumburl:
              'https://upload.wikimedia.org/wikipedia/commons/thumb/1/11/Pagination_probe_one.jpg/960px-Pagination_probe_one.jpg',
            extmetadata: { Artist: { value: 'Probe' }, LicenseShortName: { value: 'CC0' } },
          },
        ],
      },
    ],
  },
}

const cmaPagePayload = {
  info: { total: 300 },
  data: [
    {
      id: 42,
      accession_number: '2024.1',
      title: 'Pagination Probe',
      share_license_status: 'CC0',
      creators: [{ description: 'Probe' }],
      culture: [],
      images: {
        print: { url: 'https://openaccess-cdn.clevelandart.org/probe_print.jpg', width: 3000, height: 2000 },
        web: { url: 'https://openaccess-cdn.clevelandart.org/probe_web.jpg', width: 900, height: 600 },
      },
    },
  ],
}

let wikiPageOneItems = []

await step('/art page=1 paginates Commons with gsroffset and Cleveland with skip', async () => {
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    const payload = url.includes('openaccess-api.clevelandart.org') ? cmaPagePayload : wikiPagePayload
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const wiki = await call('GET', `${P}/art?source=wikimedia&q=${encodeURIComponent('pagination probe')}&limit=24&page=1`)
    assert.equal(wiki.statusCode, 200)
    const wikiBody = wiki.json()
    assert.equal(wikiBody.page, 1)
    assert.equal(wikiBody.limit, 24)
    assert.equal(wikiBody.hasMore, true)
    assert.equal(wikiBody.total, 0)
    wikiPageOneItems = wikiBody.items
    assert.ok(wikiPageOneItems.length >= 1, 'page 1 must return items')
    const wikiRequest = requests.find((entry) => entry.includes('commons.wikimedia.org'))
    assert.ok(wikiRequest, 'Commons request missing')
    const wikiUrl = new URL(wikiRequest)
    assert.equal(wikiUrl.searchParams.get('gsroffset'), '24')
    assert.equal(wikiUrl.searchParams.get('gsrlimit'), '24')
    assert.equal(wikiUrl.searchParams.get('iiurlwidth'), '960')

    const cma = await call('GET', `${P}/art?source=cleveland&q=monet&limit=24&page=1`)
    assert.equal(cma.statusCode, 200)
    const cmaBody = cma.json()
    assert.equal(cmaBody.page, 1)
    assert.equal(cmaBody.hasMore, true)
    assert.equal(cmaBody.total, 300)
    assert.ok(cmaBody.items.length >= 1, 'page 1 must return Cleveland items')
    const cmaRequest = requests.find((entry) => entry.includes('openaccess-api.clevelandart.org'))
    assert.ok(cmaRequest, 'Cleveland request missing')
    const cmaUrl = new URL(cmaRequest)
    assert.equal(cmaUrl.searchParams.get('skip'), '24')
    assert.equal(cmaUrl.searchParams.get('limit'), '24')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await step('/bing page=1 uses idx=8, clamps page=2 and drops page-0 duplicates', async () => {
  const requests = []
  const image = (hsh, day) => ({
    hsh,
    startdate: day,
    urlbase: `/th?id=OHR.${hsh}`,
    title: `Bing ${hsh}`,
    copyright: `credit ${hsh}`,
    copyrightlink: 'https://www.bing.com',
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    const idx = Number(new URL(url).searchParams.get('idx'))
    const images =
      idx === 0
        ? [image('alpha', '20260101'), image('beta', '20260102')]
        : [image('alpha', '20260101'), image('gamma', '20260103')]
    return new Response(JSON.stringify({ images }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const first = await call('GET', `${P}/bing?mkt=ja-JP&n=8&page=0`)
    const firstBody = first.json()
    assert.equal(firstBody.page, 0)
    assert.equal(firstBody.hasMore, true)
    assert.deepEqual(
      firstBody.items.map((item) => item.id),
      ['alpha', 'beta'],
    )

    const second = await call('GET', `${P}/bing?mkt=ja-JP&n=8&page=1`)
    const secondBody = second.json()
    assert.equal(secondBody.page, 1)
    assert.equal(secondBody.hasMore, false)
    assert.deepEqual(
      secondBody.items.map((item) => item.id),
      ['gamma'],
    )
    assert.ok(requests.some((entry) => entry.includes('idx=8')), 'page 1 request must carry idx=8')

    const clamped = await call('GET', `${P}/bing?mkt=ja-JP&n=8&page=2`)
    const clampedBody = clamped.json()
    assert.equal(clampedBody.page, 1)
    assert.deepEqual(
      clampedBody.items.map((item) => item.id),
      ['gamma'],
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

/** Path a proxied thumbnail is cached under (mirrors the Host's key). */
const thumbPath = (proxyUrl, width) =>
  join(home, 'lightweight-wallpaper', 'thumbs', `${createHash('sha1').update(thumbUrl(proxyUrl, width)).digest('hex')}.img`)

await step('thumbnail widths snap to the sizes Wikimedia actually serves', async () => {
  assert.equal(standardThumbWidth(480), 500, 'the tile request must land on the 500px step')
  assert.equal(standardThumbWidth(500), 500)
  assert.equal(standardThumbWidth(330), 330)
  assert.equal(standardThumbWidth(321), 330, 'a size between steps rounds up')
  assert.equal(standardThumbWidth(9999), 3840, 'nothing exceeds the largest step')
  const snapped = thumbUrl(
    'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/X.jpg/960px-X.jpg',
    480,
  )
  assert.ok(snapped.includes('/500px-'), snapped)
  // Non-Wikimedia thumbs keep the size their source published.
  const cleveland = 'https://openaccess-cdn.clevelandart.org/probe_web.jpg'
  assert.equal(thumbUrl(cleveland, 480), cleveland)
})

await step('GET /proxy snaps Commons thumbs to 500px and serves the second hit from disk', async () => {
  const source =
    'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/960px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg'
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    requests.push(String(input))
    return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  try {
    const first = await call('GET', `${P}/proxy?u=${encodeURIComponent(source)}&w=480`)
    assert.equal(first.statusCode, 200)
    assert.equal(first.headers['x-lww-thumb'], 'miss')
    assert.equal(first.headers['cache-control'], 'public, max-age=604800, immutable')
    assert.equal(first.headers['x-content-type-options'], 'nosniff')
    assert.deepEqual(first.buffer(), jpeg)
    assert.equal(requests.length, 1)
    assert.ok(requests[0].includes('/500px-'), `expected the 500px step, got ${requests[0]}`)

    const second = await call('GET', `${P}/proxy?u=${encodeURIComponent(source)}&w=480`)
    assert.equal(second.statusCode, 200)
    assert.equal(second.headers['x-lww-thumb'], 'hit')
    assert.equal(requests.length, 1, 'a disk hit must not call upstream')
    assert.deepEqual(second.buffer(), jpeg)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await step('GET /proxy falls back to the original URL when the 500px step is refused', async () => {
  // Wikimedia answers 400 for widths outside its steps, and some files have no
  // thumbnail at the requested step yet: the proxy must retry the list's URL.
  const source =
    'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/Two_Poplars_in_the_Alpilles_near_Saint-R%C3%A9my.jpg/960px-Two_Poplars_in_the_Alpilles_near_Saint-R%C3%A9my.jpg'
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/500px-')) {
      return new Response('use standard sizes', { status: 400, headers: { 'content-type': 'text/html' } })
    }
    return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  try {
    const res = await call('GET', `${P}/proxy?u=${encodeURIComponent(source)}&w=480`)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-lww-thumb'], 'miss-original')
    assert.deepEqual(res.buffer(), jpeg)
    assert.ok(requests.some((entry) => entry.includes('/500px-')), 'the standard step is tried first')
    assert.ok(
      requests.some((entry) => entry.includes('/960px-')),
      `expected a fallback to the original URL, got ${requests.join(', ')}`,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

await step('GET /proxy serves the expired thumbnail when upstream is unreachable', async () => {
  const source =
    'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/Irises_probe.jpg/960px-Irises_probe.jpg'
  const file = thumbPath(source, 480)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  try {
    const first = await call('GET', `${P}/proxy?u=${encodeURIComponent(source)}&w=480`)
    assert.equal(first.headers['x-lww-thumb'], 'miss')
  } finally {
    globalThis.fetch = originalFetch
  }
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  await utimes(file, old, old)
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  try {
    const res = await call('GET', `${P}/proxy?u=${encodeURIComponent(source)}&w=480`)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-lww-thumb'], 'stale')
    assert.equal(res.headers['cache-control'], 'public, max-age=3600, immutable')
    assert.deepEqual(res.buffer(), jpeg)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await step('GET /proxy keeps rejecting a non-allowlisted host even with w', async () => {
  const res = await call('GET', `${P}/proxy?u=${encodeURIComponent('https://evil.example.com/x.jpg')}&w=480`)
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error.code, 'URL_NOT_ALLOWED')
})

await step('art-cache.json persists pages and serves stale items after an upstream failure', async () => {
  const cachePath = join(home, 'lightweight-wallpaper', 'art-cache.json')
  let onDisk = null
  for (let attempt = 0; attempt < 30 && !onDisk; attempt += 1) {
    try {
      onDisk = JSON.parse(await readFile(cachePath, 'utf8'))
    } catch {
      await sleep(100)
    }
  }
  assert.ok(onDisk, 'art-cache.json was never written')
  assert.equal(onDisk.version, 1)
  const keys = Object.keys(onDisk.entries ?? {})
  assert.ok(
    keys.some((key) => key.includes('|1')),
    `expected a page-1 entry, got ${keys.join(', ')}`,
  )

  const fresh = await call('GET', `${P}/art?source=wikimedia&q=${encodeURIComponent('pagination probe')}&limit=24&page=1`)
  assert.equal(fresh.json().stale, false)

  // A second Host instance shares DSH_HOME but starts with an empty memory cache,
  // which is exactly the cold-start case the disk replay exists for.
  const routes2 = createHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  try {
    const stale = await callOn(
      routes2,
      'GET',
      `${P}/art?source=wikimedia&q=${encodeURIComponent('pagination probe')}&limit=24&page=1`,
    )
    assert.equal(stale.statusCode, 200)
    const body = stale.json()
    assert.equal(body.stale, true)
    assert.equal(body.page, 1)
    assert.equal(body.hasMore, true)
    assert.deepEqual(body.items, wikiPageOneItems)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await step('GET /health reports thumbnails and art cache entries', async () => {
  const res = await call('GET', `${P}/health`)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(body.thumbs >= 1, `thumbs=${body.thumbs}`)
  assert.ok(body.thumbsBytes > 0, `thumbsBytes=${body.thumbsBytes}`)
  assert.ok(body.artEntries >= 1, `artEntries=${body.artEntries}`)
})

/* ------------------------------------------------------------------------- */
/* Recent-wallpaper history, cache statistics and cache clearing             */
/* ------------------------------------------------------------------------- */

const baseDir = join(home, 'lightweight-wallpaper')
const historyPath = join(baseDir, 'history.json')
const assetNameOf = (buffer, ext) => `${createHash('sha1').update(buffer).digest('hex')}.${ext}`
const jpegAsset = `${P}/asset/${assetNameOf(jpeg, 'jpg')}`
const pngAsset = `${P}/asset/${assetNameOf(png, 'png')}`

/** Independent disk scan: the numbers /cache must agree with. */
async function dirTotals(dir, pattern) {
  const names = []
  let bytes = 0
  try {
    for (const name of await readdir(dir)) {
      if (!pattern.test(name)) continue
      try {
        bytes += (await stat(join(dir, name))).size
        names.push(name)
      } catch {
        /* raced */
      }
    }
  } catch {
    /* no directory yet */
  }
  return { files: names.length, bytes, names }
}

/** Apply one wallpaper through the same route the Client half uses. */
async function applyWallpaper(asset, title) {
  const res = await call('POST', `${P}/state`, {
    headers: HEADERS,
    body: JSON.stringify({ state: { wallpaper: { asset, source: 'upload', title } } }),
  })
  assert.equal(res.statusCode, 200)
  return res.json().state
}

await step('POST /state applying a wallpaper records it in GET /history', async () => {
  const thumb = 'https://example.org/thumbs/first.jpg'
  const res = await call('POST', `${P}/state`, {
    headers: HEADERS,
    body: JSON.stringify({
      state: {
        wallpaper: {
          asset: jpegAsset,
          source: 'upload',
          title: 'First probe',
          credit: 'Smoke test',
          page: 'https://example.org/first',
          thumb,
        },
      },
    }),
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().state.wallpaper.thumb, thumb)

  // thumb is an http(s) URL or nothing, clipped like every other URL field.
  assert.equal(
    normalizeState({ wallpaper: { asset: jpegAsset, thumb: 'javascript:alert(1)' } }).wallpaper.thumb,
    '',
  )
  const longThumb = normalizeState({
    wallpaper: { asset: jpegAsset, thumb: `https://example.org/${'x'.repeat(600)}` },
  })
  assert.equal(longThumb.wallpaper.thumb.length, 500)

  const history = await call('GET', `${P}/history`)
  assert.equal(history.statusCode, 200)
  const body = history.json()
  assert.equal(body.ok, true)
  assert.equal(body.current, jpegAsset)
  assert.equal('available' in body, false, 'GET /history must not expose an available flag')
  assert.equal(body.entries.length, 1)
  assert.equal(body.entries[0].asset, jpegAsset)
  assert.equal(body.entries[0].thumb, thumb)
  assert.equal(body.entries[0].title, 'First probe')
  assert.ok(body.entries[0].usedAt, 'usedAt must be recorded')

  const onDisk = JSON.parse(await readFile(historyPath, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.entries.length, 1)
})

await step('re-applying a wallpaper moves it to the front without duplicating history', async () => {
  await applyWallpaper(pngAsset, 'Second probe')
  let history = (await call('GET', `${P}/history`)).json()
  assert.equal(history.entries.length, 2)
  assert.equal(history.current, pngAsset)
  assert.equal(history.entries[0].asset, pngAsset)

  await applyWallpaper(jpegAsset, 'First probe again')
  history = (await call('GET', `${P}/history`)).json()
  assert.equal(history.entries.length, 2, 're-applying must not append a duplicate')
  assert.equal(history.current, jpegAsset)
  assert.equal(history.entries[0].asset, jpegAsset)
  assert.equal(history.entries[1].asset, pngAsset)

  // A slider-only write carries the same wallpaper and must not touch history.
  await call('POST', `${P}/state`, {
    headers: HEADERS,
    body: JSON.stringify({
      state: { opacity: 44, wallpaper: { asset: jpegAsset, source: 'upload', title: 'First probe again' } },
    }),
  })
  history = (await call('GET', `${P}/history`)).json()
  assert.equal(history.entries.length, 2, 'an unchanged wallpaper must not append')

  await applyWallpaper(pngAsset, 'Second probe')
  history = (await call('GET', `${P}/history`)).json()
  assert.equal(history.entries[0].asset, pngAsset)
  assert.equal(history.current, pngAsset)
})

await step('GET /cache reports asset, thumbnail and list totals from disk', async () => {
  const assets = await dirTotals(join(baseDir, 'assets'), /^[a-f0-9]{40}\.(jpg|png|webp)$/)
  const thumbs = await dirTotals(join(baseDir, 'thumbs'), /^[a-f0-9]{40}\.img$/)
  const lists = await dirTotals(baseDir, /^(art-cache|bing-.*)\.json$/)
  assert.equal(assets.files, 2, 'uploaded JPEG and PNG are two content-addressed files')
  assert.ok(thumbs.files >= 1, `thumbs=${thumbs.files}`)
  assert.ok(lists.files >= 1, `lists=${lists.files}`)

  const res = await call('GET', `${P}/cache`)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.assets, { files: assets.files, bytes: assets.bytes, kept: 1 })
  assert.deepEqual(body.thumbs, { files: thumbs.files, bytes: thumbs.bytes })
  assert.deepEqual(body.lists, { files: lists.files, bytes: lists.bytes })
  assert.equal(body.history.entries, 2)
})

await step('POST /cache/clear thumbs empties thumbnails and leaves assets and history alone', async () => {
  const before = (await call('GET', `${P}/cache`)).json()
  assert.ok(before.thumbs.files >= 1, `thumbs=${before.thumbs.files}`)
  assert.ok(before.thumbs.bytes > 0, `thumbsBytes=${before.thumbs.bytes}`)

  const res = await call('POST', `${P}/cache/clear`, {
    headers: HEADERS,
    body: JSON.stringify({ what: 'thumbs' }),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.what, 'thumbs')
  assert.equal(body.freedBytes, before.thumbs.bytes)
  assert.deepEqual(body.cache.thumbs, { files: 0, bytes: 0 })
  assert.deepEqual(body.cache.assets, before.assets)
  assert.equal(body.cache.history.entries, before.history.entries)

  const onDisk = await dirTotals(join(baseDir, 'thumbs'), /^[a-f0-9]{40}\.img$/)
  assert.equal(onDisk.files, 0)
})

await step('POST /cache/clear assets keeps the current wallpaper and trims history', async () => {
  const res = await call('POST', `${P}/cache/clear`, {
    headers: HEADERS,
    body: JSON.stringify({ what: 'assets' }),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.what, 'assets')
  assert.ok(body.freedBytes > 0, `freedBytes=${body.freedBytes}`)
  assert.equal(body.cache.assets.files, 1)
  assert.equal(body.cache.assets.kept, 1)
  assert.equal(body.cache.history.entries, 1)

  const onDisk = await dirTotals(join(baseDir, 'assets'), /^[a-f0-9]{40}\.(jpg|png|webp)$/)
  assert.deepEqual(onDisk.names, [assetNameOf(png, 'png')], 'only the current wallpaper survives')

  const history = (await call('GET', `${P}/history`)).json()
  assert.equal(history.current, pngAsset)
  assert.deepEqual(
    history.entries.map((entry) => entry.asset),
    [pngAsset],
  )
})

await step('POST /cache/clear needs the plugin header and lists clears the art cache', async () => {
  const denied = await call('POST', `${P}/cache/clear`, { body: JSON.stringify({ what: 'all' }) })
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.json().error.code, 'FORBIDDEN')

  const before = (await call('GET', `${P}/cache`)).json()
  assert.ok(before.lists.files >= 1, `lists=${before.lists.files}`)
  const cleared = await call('POST', `${P}/cache/clear`, {
    headers: HEADERS,
    body: JSON.stringify({ what: 'lists' }),
  })
  assert.equal(cleared.statusCode, 200)
  const body = cleared.json()
  assert.equal(body.what, 'lists')
  assert.equal(body.freedBytes, before.lists.bytes)
  assert.deepEqual(body.cache.lists, { files: 0, bytes: 0 })

  const health = (await call('GET', `${P}/health`)).json()
  assert.equal(health.artEntries, 0)
})

await step('GET /history forgets a deleted asset and /cache reports it unkept', async () => {
  // Rebuild a two-row history: the JPEG file was removed by the assets clear above.
  const uploaded = await call('POST', `${P}/upload`, {
    headers: { ...HEADERS, 'content-type': 'image/jpeg' },
    body: jpeg,
  })
  assert.equal(uploaded.json().asset, jpegAsset, 'the same bytes keep the same asset URL')
  await applyWallpaper(jpegAsset, 'First probe again')
  await applyWallpaper(pngAsset, 'Second probe')
  let history = (await call('GET', `${P}/history`)).json()
  assert.deepEqual(
    history.entries.map((entry) => entry.asset),
    [pngAsset, jpegAsset],
  )

  await rm(join(baseDir, 'assets', assetNameOf(jpeg, 'jpg')))
  history = (await call('GET', `${P}/history`)).json()
  assert.deepEqual(
    history.entries.map((entry) => entry.asset),
    [pngAsset],
    'the vanished asset is dropped from the answer',
  )
  const onDisk = JSON.parse(await readFile(historyPath, 'utf8'))
  assert.deepEqual(
    onDisk.entries.map((entry) => entry.asset),
    [pngAsset],
    'history.json must be rewritten after a prune',
  )

  await rm(join(baseDir, 'assets', assetNameOf(png, 'png')))
  const cache = (await call('GET', `${P}/cache`)).json()
  assert.equal(cache.assets.kept, 0)
  assert.equal(cache.assets.files, 0)
})

await step('the entry shim keeps package exports and applies inline without fibers', async () => {
  const entry = await import('../src/index.js')
  assert.equal(entry.name, 'lightweight-wallpaper', 'the loader reads the plugin name from the shim')
  assert.deepEqual(entry.inject, ['webServer'], 'the shim keeps the service dependency')
  assert.equal(typeof entry.apply, 'function', 'the shim exports apply')
  assert.equal(typeof entry.normalizeState, 'function', 'state helpers stay re-exported')
  assert.equal(entry.normalizeState({ dim: 999 }).dim <= 100, true, 're-exported normalizer still clamps')
  const table = createHarness()
  assert.ok(table.size >= 11, `inline apply must register every route, got ${table.size}`)
})

await step('the shim mounts the Host half as one disposable child generation', async () => {
  const entry = await import('../src/index.js')
  const table = new Map()
  const cleanups = []
  const children = []
  const parent = {
    effect(callback) {
      const result = callback()
      if (typeof result === 'function') cleanups.push(result)
      return result
    },
    plugin(plugin) {
      const scoped = {
        effect(callback) {
          const result = callback()
          if (typeof result === 'function') cleanups.push(result)
          return result
        },
        webServer: {
          register(route) {
            table.set(route.path, route)
            return () => table.delete(route.path)
          },
        },
      }
      plugin.apply(scoped)
      const child = {
        disposed: false,
        dispose() {
          this.disposed = true
          table.clear()
        },
      }
      children.push(child)
      return child
    },
  }
  /* Count the reload poll timer the shim arms (and clears) without touching
     the real one: the plugin must not leave a timer behind after unload. */
  const timers = new Set()
  const realInterval = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = (fn, ms, ...rest) => {
    const id = realInterval(fn, ms, ...rest)
    timers.add(id)
    return id
  }
  globalThis.clearInterval = (id) => {
    timers.delete(id)
    return realClear(id)
  }
  try {
    entry.apply(parent)
    assert.equal(children.length, 1, 'exactly one Host generation is mounted')
    assert.ok(table.size >= 11, `the child generation registers every route, got ${table.size}`)
    assert.equal(timers.size, 1, 'one reload poll timer is armed')
    for (const dispose of cleanups) dispose()
    assert.equal(children[0].disposed, true, 'unloading disposes the generation')
    assert.equal(table.size, 0, 'unloading removes every route')
    assert.equal(timers.size, 0, 'unloading clears the reload timer')
  } finally {
    globalThis.setInterval = realInterval
    globalThis.clearInterval = realClear
  }
})

await rm(home, { recursive: true, force: true })

console.log('\n' + '='.repeat(64))
console.log(`${passed}/${passed + failed} checks passed`)
if (failed > 0) {
  for (const entry of failures) console.log(`  FAILED: ${entry.label} — ${entry.error?.message ?? entry.error}`)
  process.exitCode = 1
}
