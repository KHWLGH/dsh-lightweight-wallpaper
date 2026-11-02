/**
 * dsh-lightweight-wallpaper — Host half.
 *
 * Owns the small same-origin API the Client half talks to, so the browser never
 * calls Bing, Wikimedia or Cleveland directly (CORS, CSP, hotlink rules and
 * offline caching all live here):
 *
 *   GET  /api/lightweight-wallpaper/state
 *   POST /api/lightweight-wallpaper/state            { state }
 *   GET  /api/lightweight-wallpaper/bing?mkt&n&page
 *   GET  /api/lightweight-wallpaper/art?source&q&limit&page
 *   POST /api/lightweight-wallpaper/pin              { url, fallbacks, ... }
 *   POST /api/lightweight-wallpaper/upload           raw image bytes
 *   GET  /api/lightweight-wallpaper/asset/<sha1>.<ext>
 *   GET  /api/lightweight-wallpaper/proxy?u=<url>&w=<px>
 *   GET  /api/lightweight-wallpaper/history
 *   GET  /api/lightweight-wallpaper/cache
 *   POST /api/lightweight-wallpaper/cache/clear        { what }
 *   GET  /api/lightweight-wallpaper/health
 *
 * Non-GET routes require `x-dsh-plugin: lightweight-wallpaper` (a cross-site
 * form cannot set it, and this server answers no CORS preflight).
 *
 * State, downloaded images, the paged art list cache and proxied thumbnails
 * live under `$DSH_HOME/lightweight-wallpaper/`, not under the browser origin,
 * because the desktop shell's listening port changes between launches and
 * localStorage is origin-scoped.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Pure source adapters. Loaded with the same `?rev=` the reloader put on this
 * module, so editing `sources.js` also takes effect without a restart — a static
 * import would be cached by Node and stay stale. The query is empty on the first
 * load, which keeps the very first import identical to a plain one.
 */
const REV = new URL(import.meta.url).searchParams.get('rev') || ''
const {
  FALLBACK_ART,
  UA,
  bingRequestUrl,
  clevelandRequestUrl,
  isAllowedRemote,
  paginationOf,
  parseBing,
  parseCleveland,
  parseWikimedia,
  thumbUrl,
  wikimediaRequestUrl,
} = await import(`./sources.js${REV ? `?rev=${REV}` : ''}`)

export const name = 'lightweight-wallpaper'
export const inject = ['webServer']

const PREFIX = '/api/lightweight-wallpaper'
const PLUGIN_HEADER = 'x-dsh-plugin'
const PLUGIN_ID = 'lightweight-wallpaper'

const MAX_STATE_BYTES = 256 * 1024
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_JSON_BYTES = 64 * 1024
const ASSET_RE = /^[a-f0-9]{40}\.(jpg|png|webp)$/
const MAX_ASSETS = 20
/** Recent-wallpaper history: newest first, one row per applied asset. */
const MAX_HISTORY = 12
const BING_TTL = 30 * 60 * 1000
const ART_TTL = 30 * 60 * 1000
const FETCH_TIMEOUT = 20_000

/** Paging: /art walks one upstream page at a time, /bing expands by eight days. */
const ART_PAGE_MAX = 40
const ART_LIMIT_MAX = 32
const BING_PAGE_MAX = 1
const BING_PAGE_SIZE = 8

/** List disk cache: a small LRU of pages, so a cold reload still paints fast. */
const ART_DISK_ENTRIES = 16
const ART_SAVE_DEBOUNCE = 800

/** Thumbnail disk cache: fresh for a week, trimmed to a fixed file/byte budget. */
const THUMB_RE = /^[a-f0-9]{40}\.img$/
const THUMB_TTL = 7 * 24 * 60 * 60 * 1000
const THUMB_MAX_BYTES = 4 * 1024 * 1024
const THUMB_MAX_FILES = 240
const THUMB_MAX_TOTAL_BYTES = 48 * 1024 * 1024
const THUMB_PRUNE_INTERVAL = 60_000
/** `lists` cache files: the art page cache plus every Bing market page. */
const LIST_RE = /^(art-cache|bing-.*)\.json$/
const CACHE_WHAT = new Set(['thumbs', 'lists', 'assets', 'all'])
/** Tile width the Client asks for; thumbUrl snaps it to a Wikimedia step (500). */
const THUMB_WIDTH = 500
const THUMB_WIDTH_MIN = 20
const THUMB_WIDTH_MAX = 3840

const MARKETS = new Set(['zh-CN', 'en-US', 'ja-JP', 'en-GB'])
const SOURCES = new Set(['bing', 'wikimedia', 'cleveland', 'upload'])
const FITS = new Set(['cover', 'contain'])

export const DEFAULT_STATE = Object.freeze({
  version: 1,
  enabled: true,
  fit: 'cover',
  dim: 18,
  blur: 0,
  opacity: 62,
  panelEnabled: true,
  panelAlpha: 55,
  panelBlur: 24,
  contrastEnabled: true,
  autoBing: false,
  autoBingDate: '',
  market: 'zh-CN',
  wallpaper: null,
})

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.round(number), min), max)
}

function clipString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** Normalize any state payload (client, disk, corrupt) into the accepted shape. */
export function normalizeState(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const wallpaper = raw.wallpaper && typeof raw.wallpaper === 'object' ? raw.wallpaper : null
  let normalizedWallpaper = null
  if (wallpaper) {
    const asset = clipString(wallpaper.asset, 300)
    const file = asset.startsWith(`${PREFIX}/asset/`) ? asset.slice(`${PREFIX}/asset/`.length) : ''
    if (ASSET_RE.test(file)) {
      normalizedWallpaper = {
        asset,
        source: SOURCES.has(wallpaper.source) ? wallpaper.source : 'upload',
        title: clipString(wallpaper.title, 200),
        credit: clipString(wallpaper.credit, 240),
        page: /^https?:\/\//.test(String(wallpaper.page)) ? clipString(wallpaper.page, 500) : '',
        thumb: /^https?:\/\//.test(String(wallpaper.thumb)) ? clipString(wallpaper.thumb, 500) : '',
        addedAt: clipString(wallpaper.addedAt, 40),
      }
    }
  }
  const autoDate = clipString(raw.autoBingDate, 10)
  return {
    version: 1,
    enabled: raw.enabled !== false,
    fit: FITS.has(raw.fit) ? raw.fit : DEFAULT_STATE.fit,
    dim: clampNumber(raw.dim, 0, 60, DEFAULT_STATE.dim),
    blur: clampNumber(raw.blur, 0, 24, DEFAULT_STATE.blur),
    opacity: clampNumber(raw.opacity, 30, 100, DEFAULT_STATE.opacity),
    panelEnabled: raw.panelEnabled !== false,
    panelAlpha: clampNumber(raw.panelAlpha, 0, 100, DEFAULT_STATE.panelAlpha),
    panelBlur: clampNumber(raw.panelBlur, 0, 40, DEFAULT_STATE.panelBlur),
    contrastEnabled: raw.contrastEnabled !== false,
    autoBing: raw.autoBing === true,
    autoBingDate: /^\d{4}-\d{2}-\d{2}$/.test(autoDate) ? autoDate : '',
    market: MARKETS.has(raw.market) ? raw.market : DEFAULT_STATE.market,
    wallpaper: normalizedWallpaper,
  }
}

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function detectExtension(contentType, buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  const type = String(contentType || '').toLowerCase()
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('png')) return 'png'
  if (type.includes('webp')) return 'webp'
  return null
}

function contentTypeFor(ext) {
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

export function apply(ctx) {
  const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  const baseDir = join(home, 'lightweight-wallpaper')
  const assetsDir = join(baseDir, 'assets')
  const thumbsDir = join(baseDir, 'thumbs')
  const statePath = join(baseDir, 'state.json')
  const historyPath = join(baseDir, 'history.json')
  const artCachePath = join(baseDir, 'art-cache.json')

  /** @type {ReturnType<typeof normalizeState> | null} */
  let stateCache = null
  /** @type {{ version: number, entries: any[] } | null} */
  let historyCache = null
  const bingCache = new Map()
  const artCache = new Map()
  /** @type {{ version: number, entries: Record<string, { at: number, items: any[], hasMore: boolean, total: number }> } | null} */
  let artDisk = null
  /** @type {Promise<unknown> | null} */
  let artDiskLoading = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let artSaveTimer = null
  let thumbPruneAt = 0
  let thumbPruneRunning = false

  /* ---------------------------------------------------------------------- */
  /* State                                                                  */
  /* ---------------------------------------------------------------------- */

  async function readState() {
    if (stateCache) return stateCache
    try {
      const text = await readFile(statePath, 'utf8')
      stateCache = normalizeState(JSON.parse(text))
    } catch {
      stateCache = normalizeState(null)
    }
    return stateCache
  }

  async function writeState(next) {
    const previous = await readState()
    stateCache = normalizeState(next)
    await mkdir(baseDir, { recursive: true })
    const tmp = `${statePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(stateCache, null, 2), 'utf8')
    await rename(tmp, statePath)
    // Slider and panel writes must not grow the history: only a changed
    // wallpaper file counts, and history is never allowed to fail the state save.
    const applied = stateCache.wallpaper
    if (applied && applied.asset !== previous.wallpaper?.asset) {
      await appendHistory(applied).catch(() => {})
    }
    return stateCache
  }

  /* ---------------------------------------------------------------------- */
  /* Art list disk cache                                                    */
  /* ---------------------------------------------------------------------- */

  /** Load `art-cache.json` once; a missing or corrupt file means an empty cache. */
  async function loadArtDisk() {
    if (artDisk) return artDisk
    if (!artDiskLoading) {
      artDiskLoading = (async () => {
        try {
          const parsed = JSON.parse(await readFile(artCachePath, 'utf8'))
          const raw = parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {}
          const entries = {}
          for (const [key, value] of Object.entries(raw)) {
            if (!Array.isArray(value?.items) || value.items.length === 0) continue
            entries[key] = {
              at: Number(value.at) || 0,
              items: value.items,
              hasMore: value.hasMore === true,
              total: Number(value.total) || 0,
            }
          }
          artDisk = { version: 1, entries }
        } catch {
          artDisk = { version: 1, entries: {} }
        }
        return artDisk
      })()
    }
    return artDiskLoading
  }

  /** Remember one page in the on-disk list cache, evicting the 16 oldest keys. */
  async function rememberArt(key, entry) {
    const disk = await loadArtDisk()
    disk.entries[key] = {
      at: entry.at,
      items: entry.items,
      hasMore: entry.hasMore === true,
      total: Number(entry.total) || 0,
    }
    const keys = Object.keys(disk.entries)
    if (keys.length > ART_DISK_ENTRIES) {
      keys.sort((a, b) => (disk.entries[a].at || 0) - (disk.entries[b].at || 0))
      for (const stale of keys.slice(0, keys.length - ART_DISK_ENTRIES)) delete disk.entries[stale]
    }
    scheduleArtSave()
  }

  /** Coalesce bursts of page loads into one debounced write. */
  function scheduleArtSave() {
    if (artSaveTimer) return
    artSaveTimer = setTimeout(() => {
      artSaveTimer = null
      flushArtDisk().catch(() => {})
    }, ART_SAVE_DEBOUNCE)
    artSaveTimer.unref?.()
  }

  async function flushArtDisk() {
    const disk = await loadArtDisk()
    try {
      await mkdir(baseDir, { recursive: true })
      const tmp = `${artCachePath}.${process.pid}.${Date.now().toString(36)}.tmp`
      await writeFile(tmp, JSON.stringify(disk), 'utf8')
      await rename(tmp, artCachePath)
    } catch {
      /* the disk copy is a cache; a failed write just means a cold next launch */
    }
  }

  /* ---------------------------------------------------------------------- */
  /* HTTP helpers                                                           */
  /* ---------------------------------------------------------------------- */

  function readBody(req, limit) {
    return new Promise((resolveBody, rejectBody) => {
      const chunks = []
      let total = 0
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        rejectBody(error)
      }
      req.on('data', (chunk) => {
        if (settled) return
        total += chunk.length
        if (total > limit) {
          fail(httpError(413, 'TOO_LARGE', `body exceeds ${limit} bytes`))
          req.destroy?.()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        resolveBody(Buffer.concat(chunks))
      })
      req.on('error', fail)
      req.on('aborted', () => fail(httpError(400, 'ABORTED', 'request aborted')))
    })
  }

  function guard(handler) {
    return async (req, res) => {
      try {
        if (req.method !== 'GET' && req.headers[PLUGIN_HEADER] !== PLUGIN_ID) {
          throw httpError(403, 'FORBIDDEN', `missing ${PLUGIN_HEADER} header`)
        }
        await handler(req, res)
      } catch (error) {
        const status = Number(error?.statusCode) || 500
        sendJson(res, status, {
          error: { code: error?.code ?? 'INTERNAL', message: String(error?.message ?? error) },
        })
      }
    }
  }

  function methodIs(req, res, method) {
    if (req.method === method) return true
    sendJson(res, 405, { error: { code: 'METHOD', message: `${method} only` } })
    return false
  }

  /** Fetch with a per-hop allowlist check, bounded redirects, an image-only answer and a byte cap. */
  async function fetchRemoteImage(startUrl, maxBytes = MAX_DOWNLOAD_BYTES) {
    let current = String(startUrl)
    for (let hop = 0; hop < 4; hop += 1) {
      if (!isAllowedRemote(current)) throw httpError(400, 'URL_NOT_ALLOWED', `not allowed: ${current}`)
      const response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: { 'user-agent': UA, accept: 'image/*' },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw httpError(502, 'BAD_REDIRECT', 'redirect without location')
        current = new URL(location, current).toString()
        continue
      }
      if (!response.ok) {
        throw httpError(502, 'UPSTREAM_STATUS', `upstream ${response.status} for ${current}`)
      }
      const type = String(response.headers.get('content-type') || '').toLowerCase()
      if (!type.startsWith('image/')) {
        throw httpError(502, 'NOT_AN_IMAGE', `upstream content-type ${type || 'unknown'}`)
      }
      const length = Number(response.headers.get('content-length'))
      if (Number.isFinite(length) && length > maxBytes) {
        throw httpError(413, 'IMAGE_TOO_LARGE', `image is ${length} bytes`)
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxBytes) {
        throw httpError(413, 'IMAGE_TOO_LARGE', `image is ${buffer.length} bytes`)
      }
      return { buffer, contentType: type, finalUrl: current }
    }
    throw httpError(502, 'TOO_MANY_REDIRECTS', 'redirect limit exceeded')
  }

  /** Retry a flaky upstream call; mobile/home networks drop connections mid-handshake. */
  async function withRetry(task, attempts = 2, delayMs = 700) {
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await task()
      } catch (error) {
        lastError = error
        if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
    throw lastError
  }

  async function fetchJson(url, timeout = FETCH_TIMEOUT) {
    const response = await withRetry(async () => {
      const result = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { 'user-agent': UA, accept: 'application/json' },
      })
      if (!result.ok) throw httpError(502, 'UPSTREAM_STATUS', `upstream ${result.status}`)
      return result
    })
    return response.json()
  }

  /* ---------------------------------------------------------------------- */
  /* Paged Bing disk cache                                                  */
  /* ---------------------------------------------------------------------- */

  /** Read a cached Bing page: `bing-<mkt>-<idx>.json`, plus the legacy page-0 name. */
  async function readBingDisk(mkt, idx) {
    const names = [`bing-${mkt}-${idx}.json`]
    if (idx === 0) names.push(`bing-${mkt}.json`)
    for (const filename of names) {
      try {
        const items = JSON.parse(await readFile(join(baseDir, filename), 'utf8'))
        if (Array.isArray(items) && items.length > 0) return items
      } catch {
        /* try the next cache name */
      }
    }
    return null
  }

  /** ids already shown on page 0 for a market, memory first, then disk. */
  async function bingPageZeroIds(mkt) {
    const ids = new Set()
    for (const [key, value] of bingCache) {
      if (!key.startsWith(`${mkt}:`) || !key.endsWith(':0')) continue
      for (const item of value.items ?? []) ids.add(String(item?.id))
    }
    if (ids.size > 0) return ids
    const diskItems = (await readBingDisk(mkt, 0)) ?? []
    for (const item of diskItems) if (item?.id !== undefined) ids.add(String(item.id))
    return ids
  }

  /* ---------------------------------------------------------------------- */
  /* Thumbnail disk cache                                                   */
  /* ---------------------------------------------------------------------- */

  /** Read a cached thumbnail; `fresh` turns false once the file is over a week old. */
  async function readThumb(file) {
    try {
      const info = await stat(file)
      return { buffer: await readFile(file), fresh: Date.now() - info.mtimeMs < THUMB_TTL }
    } catch {
      return null
    }
  }

  /** Serve one thumbnail with the same headers for hits, misses and stale copies. */
  function sendThumb(res, buffer, source, maxAge = 604800) {
    res.writeHead(200, {
      'content-type': contentTypeFor(detectExtension('', buffer) ?? 'jpg'),
      'content-length': buffer.length,
      'cache-control': `public, max-age=${maxAge}, immutable`,
      'x-content-type-options': 'nosniff',
      'x-lww-thumb': source,
    })
    res.end(buffer)
  }

  /**
   * Fetch one thumbnail: first the snapped standard width, then the exact URL
   * the list handed us. The second attempt covers files whose standard step is
   * not generated yet, plus any future change to Wikimedia's width policy.
   */
  async function fetchThumb(primaryUrl, fallbackUrl) {
    try {
      // Thumbnails go through the flaky Commons CDN, so they get one attempt
      // more than a download: a missing tile is visible, an extra try is not.
      const { buffer } = await withRetry(() => fetchRemoteImage(primaryUrl, THUMB_MAX_BYTES), 3, 600)
      return { buffer, variant: 'miss' }
    } catch (error) {
      if (!fallbackUrl || fallbackUrl === primaryUrl) throw error
      const { buffer } = await withRetry(() => fetchRemoteImage(fallbackUrl, THUMB_MAX_BYTES), 2, 400)
      return { buffer, variant: 'miss-original' }
    }
  }

  /** Drop oldest thumbnails until the directory fits the count and byte budget. */
  async function pruneThumbs() {
    let names
    try {
      names = await readdir(thumbsDir)
    } catch {
      return
    }
    const files = []
    let totalBytes = 0
    for (const name of names) {
      if (!THUMB_RE.test(name)) continue
      try {
        const info = await stat(join(thumbsDir, name))
        files.push({ name, mtime: info.mtimeMs, size: info.size })
        totalBytes += info.size
      } catch {
        /* raced */
      }
    }
    files.sort((a, b) => a.mtime - b.mtime)
    let index = 0
    while (index < files.length && (files.length - index > THUMB_MAX_FILES || totalBytes > THUMB_MAX_TOTAL_BYTES)) {
      const entry = files[index]
      index += 1
      try {
        await rm(join(thumbsDir, entry.name), { force: true })
        totalBytes -= entry.size
      } catch {
        /* raced */
      }
    }
  }

  /** Kick a prune at most once per minute; it never blocks the response. */
  function pruneThumbsSoon() {
    const now = Date.now()
    if (thumbPruneRunning || now - thumbPruneAt < THUMB_PRUNE_INTERVAL) return
    thumbPruneAt = now
    thumbPruneRunning = true
    pruneThumbs()
      .catch(() => {})
      .finally(() => {
        thumbPruneRunning = false
      })
  }

  /* ---------------------------------------------------------------------- */
  /* Asset store                                                            */
  /* ---------------------------------------------------------------------- */

  async function pruneAssets(keepFile) {
    let entries
    try {
      entries = await readdir(assetsDir)
    } catch {
      return
    }
    const files = entries.filter((entry) => ASSET_RE.test(entry))
    if (files.length <= MAX_ASSETS) return
    const stats = []
    for (const file of files) {
      try {
        stats.push({ file, mtime: (await stat(join(assetsDir, file))).mtimeMs })
      } catch {
        /* raced */
      }
    }
    stats.sort((a, b) => b.mtime - a.mtime)
    for (const { file } of stats.slice(MAX_ASSETS)) {
      if (file === keepFile) continue
      try {
        await rm(join(assetsDir, file), { force: true })
      } catch {
        /* raced */
      }
    }
  }

  async function saveAsset(buffer, extension) {
    const hash = createHash('sha1').update(buffer).digest('hex')
    const file = `${hash}.${extension}`
    await mkdir(assetsDir, { recursive: true })
    await writeFile(join(assetsDir, file), buffer)
    await pruneAssets(file)
    return { file, asset: `${PREFIX}/asset/${file}`, bytes: buffer.length }
  }

  /* ---------------------------------------------------------------------- */
  /* Recent-wallpaper history                                               */
  /* ---------------------------------------------------------------------- */

  /** Accept one history row, dropping anything that is not a served asset. */
  function normalizeHistoryEntry(input) {
    const raw = input && typeof input === 'object' ? input : {}
    const asset = clipString(raw.asset, 300)
    const file = asset.startsWith(`${PREFIX}/asset/`) ? asset.slice(`${PREFIX}/asset/`.length) : ''
    if (!ASSET_RE.test(file)) return null
    return {
      asset,
      source: SOURCES.has(raw.source) ? raw.source : 'upload',
      title: clipString(raw.title, 200),
      credit: clipString(raw.credit, 240),
      page: /^https?:\/\//.test(String(raw.page)) ? clipString(raw.page, 500) : '',
      thumb: /^https?:\/\//.test(String(raw.thumb)) ? clipString(raw.thumb, 500) : '',
      usedAt: clipString(raw.usedAt, 40),
    }
  }

  /** Load `history.json` once; a missing or corrupt file means an empty history. */
  async function readHistory() {
    if (historyCache) return historyCache
    const entries = []
    try {
      const parsed = JSON.parse(await readFile(historyPath, 'utf8'))
      const seen = new Set()
      for (const value of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        const entry = normalizeHistoryEntry(value)
        if (!entry || seen.has(entry.asset)) continue
        seen.add(entry.asset)
        entries.push(entry)
        if (entries.length >= MAX_HISTORY) break
      }
    } catch {
      /* no history yet */
    }
    historyCache = { version: 1, entries }
    return historyCache
  }

  /** Publish the in-memory history with TMP+rename, like every other file here. */
  async function writeHistory(entries) {
    historyCache = { version: 1, entries: entries.slice(0, MAX_HISTORY) }
    await mkdir(baseDir, { recursive: true })
    // Unique temp name: two overlapping writes must not truncate each other.
    const tmp = `${historyPath}.${process.pid}.${Date.now().toString(36)}.tmp`
    await writeFile(tmp, JSON.stringify(historyCache, null, 2), 'utf8')
    await rename(tmp, historyPath)
    return historyCache
  }

  /** Drop rows whose asset file vanished; rewrite only when something changed. */
  async function pruneHistory() {
    const history = await readHistory()
    const kept = []
    let changed = false
    for (const entry of history.entries) {
      const file = entry.asset.slice(`${PREFIX}/asset/`.length)
      try {
        await stat(join(assetsDir, file))
        kept.push(entry)
      } catch {
        changed = true
      }
    }
    return changed ? writeHistory(kept) : history
  }

  /** Put the just-applied wallpaper at the front, de-duplicated and capped. */
  async function appendHistory(wallpaper) {
    await pruneHistory()
    const history = await readHistory()
    const entry = normalizeHistoryEntry({ ...wallpaper, usedAt: new Date().toISOString() })
    if (!entry) return history
    const entries = [entry, ...history.entries.filter((item) => item.asset !== entry.asset)]
    return writeHistory(entries)
  }

  /* ---------------------------------------------------------------------- */
  /* Cache statistics and clearing                                          */
  /* ---------------------------------------------------------------------- */

  /** Count and sum the files in one cache directory whose names match. */
  async function countCacheFiles(dir, pattern) {
    let files = 0
    let bytes = 0
    try {
      for (const name of await readdir(dir)) {
        if (!pattern.test(name)) continue
        try {
          bytes += (await stat(join(dir, name))).size
          files += 1
        } catch {
          /* raced */
        }
      }
    } catch {
      /* the directory has not been created yet */
    }
    return { files, bytes }
  }

  /** The current wallpaper's file name, or '' when nothing is applied. */
  async function currentAssetFile() {
    const state = await readState()
    const file = state.wallpaper ? state.wallpaper.asset.slice(`${PREFIX}/asset/`.length) : ''
    return ASSET_RE.test(file) ? file : ''
  }

  /** The full `GET /cache` payload: disk truth plus the current file's fate. */
  async function cacheReport() {
    const assets = await countCacheFiles(assetsDir, ASSET_RE)
    const thumbs = await countCacheFiles(thumbsDir, THUMB_RE)
    const lists = await countCacheFiles(baseDir, LIST_RE)
    let kept = 0
    const current = await currentAssetFile()
    if (current) {
      try {
        await stat(join(assetsDir, current))
        kept = 1
      } catch {
        /* the current wallpaper file is gone */
      }
    }
    const history = await readHistory()
    return { assets: { ...assets, kept }, thumbs, lists, history: { entries: history.entries.length } }
  }

  /** Delete every matching file in one directory, returning the bytes freed. */
  async function removeCacheFiles(dir, pattern, keep = '') {
    let freedBytes = 0
    try {
      for (const name of await readdir(dir)) {
        if (!pattern.test(name) || name === keep) continue
        const file = join(dir, name)
        try {
          const info = await stat(file)
          await rm(file, { force: true })
          freedBytes += info.size
        } catch {
          /* a concurrent request may have removed it first */
        }
      }
    } catch {
      /* nothing to delete */
    }
    return freedBytes
  }

  /* ---------------------------------------------------------------------- */
  /* Routes                                                                 */
  /* ---------------------------------------------------------------------- */

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/state`,
      handler: guard(async (req, res) => {
        if (req.method === 'GET') {
          return sendJson(res, 200, { ok: true, state: await readState() })
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD' } })
        const body = await readBody(req, MAX_STATE_BYTES)
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          throw httpError(400, 'BAD_JSON', 'state body is not JSON')
        }
        const saved = await writeState(parsed?.state ?? parsed)
        return sendJson(res, 200, { ok: true, state: saved })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/bing`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const market = url.searchParams.get('mkt') ?? DEFAULT_STATE.market
        const mkt = MARKETS.has(market) ? market : DEFAULT_STATE.market
        const count = Math.min(Math.max(Number(url.searchParams.get('n')) || 8, 1), 8)
        const page = clampNumber(url.searchParams.get('page'), 0, BING_PAGE_MAX, 0)
        const idx = page * BING_PAGE_SIZE
        const key = `${mkt}:${count}:${page}`
        const cached = bingCache.get(key)
        if (cached && Date.now() - cached.at < BING_TTL) {
          return sendJson(res, 200, {
            ok: true,
            page,
            hasMore: page < BING_PAGE_MAX,
            items: cached.items,
            stale: false,
          })
        }
        // Page 2 only widens the pool, so anything page 1 already showed is dropped.
        const seen = page > 0 ? await bingPageZeroIds(mkt) : null
        try {
          const payload = await fetchJson(bingRequestUrl(mkt, count, idx))
          let items = parseBing(payload)
          if (seen && seen.size > 0) items = items.filter((item) => !seen.has(item.id))
          bingCache.set(key, { at: Date.now(), items })
          mkdir(baseDir, { recursive: true })
            .then(() => writeFile(join(baseDir, `bing-${mkt}-${idx}.json`), JSON.stringify(items), 'utf8'))
            .catch(() => {})
          return sendJson(res, 200, {
            ok: true,
            page,
            hasMore: page < BING_PAGE_MAX,
            items,
            stale: false,
          })
        } catch (error) {
          const disk = (await readBingDisk(mkt, idx)) ?? []
          const items = seen && seen.size > 0 ? disk.filter((item) => !seen.has(String(item?.id))) : disk
          if (items.length > 0) {
            return sendJson(res, 200, {
              ok: true,
              page,
              hasMore: page < BING_PAGE_MAX,
              items,
              stale: true,
              error: String(error?.message ?? error),
            })
          }
          return sendJson(res, 200, {
            ok: false,
            page,
            hasMore: false,
            items: [],
            stale: true,
            error: String(error?.message ?? error),
          })
        }
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/art`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const source = url.searchParams.get('source') === 'cleveland' ? 'cleveland' : 'wikimedia'
        const query = clipString(url.searchParams.get('q') ?? '', 120).trim()
        if (!query) throw httpError(400, 'MISSING_QUERY', 'q is required')
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), ART_LIMIT_MAX)
        const page = clampNumber(url.searchParams.get('page'), 0, ART_PAGE_MAX, 0)
        const offset = page * limit
        const key = `${source}|${query}|${limit}|${page}`
        const cached = artCache.get(key)
        if (cached && Date.now() - cached.at < ART_TTL) {
          return sendJson(res, 200, {
            ok: true,
            source,
            page,
            limit,
            hasMore: cached.hasMore === true,
            total: Number(cached.total) || 0,
            items: cached.items,
            stale: false,
          })
        }
        try {
          const payload =
            source === 'cleveland'
              ? await fetchJson(clevelandRequestUrl(query, limit, offset))
              : await fetchJson(wikimediaRequestUrl(query, limit, offset), 25_000)
          const items = source === 'cleveland' ? parseCleveland(payload) : parseWikimedia(payload)
          const paging = paginationOf(source, payload, { limit, offset })
          // The last page the API accepts must not advertise another one, or the
          // client would request `page + 1`, get clamped back here and loop.
          const hasMore = paging.hasMore && page < ART_PAGE_MAX
          const total = paging.total
          const entry = { at: Date.now(), items, hasMore, total }
          artCache.set(key, entry)
          rememberArt(key, entry).catch(() => {})
          return sendJson(res, 200, {
            ok: true,
            source,
            page,
            limit,
            hasMore,
            total,
            items,
            stale: false,
          })
        } catch (error) {
          const message = String(error?.message ?? error)
          // A failed refresh still beats a blank gallery: replay the same page from disk.
          const disk = await loadArtDisk()
          const previous = disk.entries[key]
          if (Array.isArray(previous?.items) && previous.items.length > 0) {
            return sendJson(res, 200, {
              ok: true,
              source,
              page,
              limit,
              hasMore: previous.hasMore === true,
              total: Number(previous.total) || 0,
              items: previous.items,
              stale: true,
              error: message,
            })
          }
          if (source === 'wikimedia') {
            const items = FALLBACK_ART.filter((item) => {
              const haystack = `${item.title} ${item.credit}`.toLowerCase()
              return query.toLowerCase().split(/\s+/).some((word) => word.length > 2 && haystack.includes(word))
            })
            return sendJson(res, 200, {
              ok: false,
              source,
              page,
              limit,
              hasMore: false,
              total: 0,
              items: items.length > 0 ? items : FALLBACK_ART.slice(0, 1),
              stale: true,
              error: message,
            })
          }
          return sendJson(res, 200, {
            ok: false,
            source,
            page,
            limit,
            hasMore: false,
            total: 0,
            items: [],
            stale: true,
            error: message,
          })
        }
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/pin`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'POST')) return
        const body = await readBody(req, MAX_JSON_BYTES)
        let request
        try {
          request = JSON.parse(body.toString('utf8'))
        } catch {
          throw httpError(400, 'BAD_JSON', 'pin body is not JSON')
        }
        const candidates = [request?.url, ...(Array.isArray(request?.fallbacks) ? request.fallbacks : [])]
          .filter((value) => typeof value === 'string' && value.length > 0)
          .slice(0, 4)
        if (candidates.length === 0) throw httpError(400, 'MISSING_URL', 'url is required')
        let lastError = null
        for (const candidate of candidates) {
          try {
            const { buffer, contentType } = await withRetry(() => fetchRemoteImage(candidate), 2, 800)
            const extension = detectExtension(contentType, buffer)
            if (!extension) throw httpError(502, 'UNSUPPORTED_TYPE', `unsupported image type ${contentType}`)
            const saved = await saveAsset(buffer, extension)
            return sendJson(res, 200, {
              ok: true,
              asset: saved.asset,
              bytes: saved.bytes,
              source: SOURCES.has(request?.source) ? request.source : 'upload',
            })
          } catch (error) {
            lastError = error
          }
        }
        throw lastError ?? httpError(502, 'PIN_FAILED', 'no candidate could be downloaded')
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/upload`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'POST')) return
        const rawType = String(req.headers['content-type'] || '').toLowerCase()
        if (!/^image\/(jpeg|jpg|png|webp)/.test(rawType)) {
          throw httpError(415, 'UNSUPPORTED_TYPE', `content-type ${rawType || 'unknown'}`)
        }
        const buffer = await readBody(req, MAX_UPLOAD_BYTES)
        const extension = detectExtension(rawType, buffer)
        if (!extension) throw httpError(415, 'UNSUPPORTED_TYPE', 'body is not a JPEG/PNG/WebP image')
        const saved = await saveAsset(buffer, extension)
        return sendJson(res, 200, { ok: true, asset: saved.asset, bytes: saved.bytes, source: 'upload' })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      // No trailing slash: the server matches `path === prefix || path.startsWith(prefix + '/')`.
      path: `${PREFIX}/asset`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'GET')) return
        const name = decodeURIComponent(String(req.url ?? '').slice(`${PREFIX}/asset/`.length).split('?')[0])
        if (!ASSET_RE.test(name)) throw httpError(404, 'NOT_FOUND', 'unknown asset')
        let buffer
        try {
          buffer = await readFile(join(assetsDir, name))
        } catch {
          throw httpError(404, 'NOT_FOUND', 'asset missing')
        }
        res.writeHead(200, {
          'content-type': contentTypeFor(name.slice(name.lastIndexOf('.') + 1)),
          'content-length': buffer.length,
          'cache-control': 'public, max-age=604800, immutable',
          'x-content-type-options': 'nosniff',
        })
        res.end(buffer)
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/proxy`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const target = url.searchParams.get('u')
        if (!target) throw httpError(400, 'MISSING_URL', 'u is required')
        // Wikimedia only serves its standard widths and answers 400 for anything
        // else, so the requested width snaps up to a step it accepts (500 for the
        // tiles). Other hosts have fixed thumb sizes and stay byte-identical,
        // which is why the allowlist check runs on the final URL.
        const width = clampNumber(url.searchParams.get('w'), THUMB_WIDTH_MIN, THUMB_WIDTH_MAX, THUMB_WIDTH)
        const finalUrl = thumbUrl(target, width)
        if (!isAllowedRemote(finalUrl)) {
          throw httpError(400, 'URL_NOT_ALLOWED', `not allowed: ${finalUrl}`)
        }
        const hash = createHash('sha1').update(finalUrl).digest('hex')
        const file = join(thumbsDir, `${hash}.img`)
        const saved = await readThumb(file)
        if (saved && saved.fresh) {
          sendThumb(res, saved.buffer, 'hit')
          return
        }
        let upstream
        try {
          upstream = await fetchThumb(finalUrl, finalUrl === target ? null : target)
        } catch (error) {
          // An expired copy still beats a broken tile on a flaky link.
          if (saved) {
            sendThumb(res, saved.buffer, 'stale', 3600)
            return
          }
          throw error
        }
        try {
          await mkdir(thumbsDir, { recursive: true })
          // Unique temp names: two concurrent requests for one thumbnail must not
          // truncate each other's bytes before the rename publishes them.
          const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
          const tmp = join(thumbsDir, `${hash}.${process.pid}.${suffix}.tmp`)
          await writeFile(tmp, upstream.buffer)
          await rename(tmp, file)
        } catch {
          /* the response still succeeds; the next request is just another miss */
        }
        pruneThumbsSoon()
        sendThumb(res, upstream.buffer, upstream.variant)
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/history`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'GET')) return
        // Read-time pruning keeps the promise that every returned row is servable.
        const history = await pruneHistory()
        const state = await readState()
        return sendJson(res, 200, {
          ok: true,
          current: state.wallpaper?.asset ?? null,
          entries: history.entries,
        })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/cache`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'GET')) return
        return sendJson(res, 200, { ok: true, ...(await cacheReport()) })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/cache/clear`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'POST')) return
        const body = await readBody(req, MAX_JSON_BYTES)
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          throw httpError(400, 'BAD_JSON', 'cache body is not JSON')
        }
        const what = String(parsed?.what ?? '')
        if (!CACHE_WHAT.has(what)) {
          throw httpError(400, 'BAD_WHAT', 'what must be one of thumbs|lists|assets|all')
        }
        let freedBytes = 0
        if (what === 'thumbs' || what === 'all') {
          freedBytes += await removeCacheFiles(thumbsDir, THUMB_RE)
          thumbPruneAt = 0
        }
        if (what === 'lists' || what === 'all') {
          freedBytes += await removeCacheFiles(baseDir, LIST_RE)
          // Memory first: a debounced save would otherwise recreate art-cache.json.
          bingCache.clear()
          artCache.clear()
          artDisk = null
          artDiskLoading = null
          if (artSaveTimer) {
            clearTimeout(artSaveTimer)
            artSaveTimer = null
          }
        }
        if (what === 'assets' || what === 'all') {
          freedBytes += await removeCacheFiles(assetsDir, ASSET_RE, await currentAssetFile())
        }
        // Prune after every clear: a row whose file vanished while the request
        // was in flight must not survive into the next read.
        await pruneHistory()
        return sendJson(res, 200, { ok: true, what, freedBytes, cache: await cacheReport() })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/selfcheck`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'POST')) return
        const body = await readBody(req, MAX_JSON_BYTES)
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          throw httpError(400, 'BAD_JSON', 'self-check body is not JSON')
        }
        await mkdir(baseDir, { recursive: true })
        await writeFile(
          join(baseDir, 'selfcheck.json'),
          JSON.stringify({ receivedAt: new Date().toISOString(), report: parsed }, null, 2),
          'utf8',
        )
        sendJson(res, 200, { ok: true })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/health`,
      handler: guard(async (req, res) => {
        if (!methodIs(req, res, 'GET')) return
        let assets = 0
        try {
          assets = (await readdir(assetsDir)).filter((entry) => ASSET_RE.test(entry)).length
        } catch {
          assets = 0
        }
        let thumbs = 0
        let thumbsBytes = 0
        try {
          const names = (await readdir(thumbsDir)).filter((entry) => THUMB_RE.test(entry))
          thumbs = names.length
          for (const name of names) {
            try {
              thumbsBytes += (await stat(join(thumbsDir, name))).size
            } catch {
              /* raced */
            }
          }
        } catch {
          /* no thumbnails yet */
        }
        const artDiskNow = await loadArtDisk()
        const state = await readState()
        sendJson(res, 200, {
          ok: true,
          version: 1,
          baseDir,
          assets,
          thumbs,
          thumbsBytes,
          artEntries: Object.keys(artDiskNow.entries).length,
          enabled: state.enabled,
          hasWallpaper: Boolean(state.wallpaper),
          upstream: ['bing', 'wikimedia', 'cleveland'],
        })
      }),
    }),
  )
}
