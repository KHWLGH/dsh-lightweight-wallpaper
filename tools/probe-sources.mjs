/**
 * Live source probe — proves the three upstream sources answer from THIS machine
 * and that the adapters normalize what they return.
 *
 *   node tools/probe-sources.mjs
 *
 * Not shipped with the bundle; run it after changing `src/sources.js`.
 * Wikimedia is measured with retries because its CDN is flaky on some
 * residential networks; the reported note says how many attempts were needed.
 */
import assert from 'node:assert/strict'

import {
  UA,
  bingRequestUrl,
  clevelandRequestUrl,
  isAllowedRemote,
  parseBing,
  parseCleveland,
  parseWikimedia,
  wikimediaRequestUrl,
} from '../src/sources.js'

const results = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function timed(label, task) {
  const started = Date.now()
  try {
    const value = await task()
    results.push({ label, ok: true, ms: Date.now() - started })
    console.log(`PASS  ${label}  (${Date.now() - started} ms)  ${value ?? ''}`)
    return true
  } catch (error) {
    results.push({ label, ok: false, ms: Date.now() - started, note: String(error?.message ?? error) })
    console.log(`FAIL  ${label}  (${Date.now() - started} ms)  ${error?.message ?? error}`)
    return false
  }
}

async function getJson(url, timeout = 30_000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'user-agent': UA, accept: 'application/json' },
  })
  assert.equal(response.status, 200, `GET ${url} -> ${response.status}`)
  return response.json()
}

async function imageBytes(url, timeout = 60_000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'user-agent': UA, accept: 'image/*' },
  })
  assert.equal(response.status, 200, `GET ${url} -> ${response.status}`)
  const type = String(response.headers.get('content-type') || '')
  assert.ok(type.startsWith('image/'), `content-type ${type}`)
  const bytes = (await response.arrayBuffer()).byteLength
  assert.ok(bytes > 5_000, `only ${bytes} bytes`)
  return `${type.split('/')[1]} ${Math.round(bytes / 1024)} KB`
}

/** Fetch with retries; the note reports the number of attempts used. */
async function probeImage(url, attempts = 1) {
  assert.ok(isAllowedRemote(url), `not allowlisted: ${url}`)
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const note = await imageBytes(url)
      return attempts > 1 ? `${note} (attempt ${attempt}/${attempts})` : note
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(900)
    }
  }
  throw lastError
}

console.log('== allowlist ==')
assert.equal(isAllowedRemote('https://www.bing.com/th?id=x_UHD.jpg'), true)
assert.equal(isAllowedRemote('https://upload.wikimedia.org/x.jpg'), true)
assert.equal(isAllowedRemote('http://www.bing.com/th?id=x'), false, 'http must be rejected')
assert.equal(isAllowedRemote('https://evil.example.com/x.jpg'), false)
const userinfoUrl = 'https://' + 'user' + ':' + 'pw' + '@www.bing.com/x.jpg'
assert.equal(isAllowedRemote(userinfoUrl), false)
console.log('PASS  allowlist accepts https bing/wikimedia/cleveland only')

console.log('\n== Bing daily ==')
let bingItem = null
await timed('Bing list + normalize', async () => {
  const items = parseBing(await getJson(bingRequestUrl('zh-CN', 8)))
  assert.ok(items.length >= 1, 'no images returned')
  bingItem = items[0]
  assert.ok(bingItem.thumb.startsWith('https://www.bing.com/'), bingItem.thumb)
  assert.ok(bingItem.full.includes('_UHD.jpg'), bingItem.full)
  return `${items.length} images; first: ${bingItem.title}`
})
if (bingItem) {
  await timed('Bing thumbnail (400x240)', () => probeImage(bingItem.thumb, 2))
  await timed('Bing UHD wallpaper', () => probeImage(bingItem.full, 2))
}

console.log('\n== Wikimedia Commons (retries enabled) ==')
let wikiItem = null
await timed('Wikimedia search (Van Gogh paintings)', async () => {
  let items = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      items = parseWikimedia(await getJson(wikimediaRequestUrl('Van Gogh paintings', 6)))
      if (items.length > 0) break
    } catch (error) {
      if (attempt === 3) throw error
      await sleep(1200)
    }
  }
  assert.ok(items.length >= 1, 'no usable results')
  wikiItem = items[0]
  assert.ok(wikiItem.full.includes('/1920px-'), wikiItem.full)
  return `${items.length} results; first: ${wikiItem.title}`
})
if (wikiItem) {
  await timed('Wikimedia 960px thumb', () => probeImage(wikiItem.thumb, 3))
  await timed('Wikimedia 1920px wallpaper', () => probeImage(wikiItem.full, 3))
}

console.log('\n== Cleveland Museum (CC0) ==')
let cmaItem = null
await timed('Cleveland search (monet)', async () => {
  const items = parseCleveland(await getJson(clevelandRequestUrl('monet', 6)))
  assert.ok(items.length >= 1, 'no usable results')
  cmaItem = items[0]
  return `${items.length} results; first: ${cmaItem.title} (${cmaItem.license})`
})
if (cmaItem) {
  await timed('Cleveland thumb', () => probeImage(cmaItem.thumb, 2))
  await timed('Cleveland large JPEG', () => probeImage(cmaItem.full, 2))
}

const failed = results.filter((entry) => !entry.ok)
console.log('\n' + '='.repeat(64))
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const entry of failed) console.log(`  FAILED: ${entry.label} — ${entry.note}`)
  process.exitCode = 1
}
