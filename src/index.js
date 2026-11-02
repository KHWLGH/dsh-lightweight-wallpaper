/**
 * dsh-lightweight-wallpaper — Host half.
 *
 * Owns the small same-origin API the Client half talks to, so the browser never
 * calls Bing, Wikimedia or Cleveland directly (CORS, CSP, hotlink rules and
 * offline caching all live here):
 *
 *   GET  /api/lightweight-wallpaper/state
 *   POST /api/lightweight-wallpaper/state            { state }
 *   GET  /api/lightweight-wallpaper/bing?mkt&n
 *   GET  /api/lightweight-wallpaper/art?source&q&limit
 *   POST /api/lightweight-wallpaper/pin              { url, fallbacks, ... }
 *   POST /api/lightweight-wallpaper/upload           raw image bytes
 *   GET  /api/lightweight-wallpaper/asset/<sha1>.<ext>
 *   GET  /api/lightweight-wallpaper/proxy?u=<url>
 *   GET  /api/lightweight-wallpaper/health
 *
 * Non-GET routes require `x-dsh-plugin: lightweight-wallpaper` (a cross-site
 * form cannot set it, and this server answers no CORS preflight).
 *
 * State and downloaded images live under `$DSH_HOME/lightweight-wallpaper/`,
 * not under the browser origin, because the desktop shell's listening port
 * changes between launches and localStorage is origin-scoped.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  FALLBACK_ART,
  UA,
  bingRequestUrl,
  clevelandRequestUrl,
  isAllowedRemote,
  parseBing,
  parseCleveland,
  parseWikimedia,
  wikimediaRequestUrl,
} from './sources.js'

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
const BING_TTL = 30 * 60 * 1000
const ART_TTL = 10 * 60 * 1000
const FETCH_TIMEOUT = 20_000

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
  const statePath = join(baseDir, 'state.json')

  /** @type {ReturnType<typeof normalizeState> | null} */
  let stateCache = null
  const bingCache = new Map()
  const artCache = new Map()

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
    stateCache = normalizeState(next)
    await mkdir(baseDir, { recursive: true })
    const tmp = `${statePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(stateCache, null, 2), 'utf8')
    await rename(tmp, statePath)
    return stateCache
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

  /** Fetch with a per-hop allowlist check, bounded redirects and an image-only answer. */
  async function fetchRemoteImage(startUrl) {
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
      if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
        throw httpError(413, 'IMAGE_TOO_LARGE', `image is ${length} bytes`)
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > MAX_DOWNLOAD_BYTES) {
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
        const key = `${mkt}:${count}`
        const cached = bingCache.get(key)
        if (cached && Date.now() - cached.at < BING_TTL) {
          return sendJson(res, 200, { ok: true, items: cached.items, stale: false })
        }
        try {
          const items = parseBing(await fetchJson(bingRequestUrl(mkt, count)))
          bingCache.set(key, { at: Date.now(), items })
          writeFile(join(baseDir, `bing-${mkt}.json`), JSON.stringify(items), 'utf8').catch(() => {})
          return sendJson(res, 200, { ok: true, items, stale: false })
        } catch (error) {
          try {
            const items = JSON.parse(await readFile(join(baseDir, `bing-${mkt}.json`), 'utf8'))
            if (Array.isArray(items) && items.length > 0) {
              bingCache.set(key, { at: Date.now(), items })
              return sendJson(res, 200, { ok: true, items, stale: true, error: String(error?.message ?? error) })
            }
          } catch {
            /* no disk cache */
          }
          return sendJson(res, 200, {
            ok: false,
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
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), 32)
        const key = `${source}|${query}|${limit}`
        const cached = artCache.get(key)
        if (cached && Date.now() - cached.at < ART_TTL) {
          return sendJson(res, 200, { ok: true, source, items: cached.items, stale: false })
        }
        try {
          const payload =
            source === 'cleveland'
              ? await fetchJson(clevelandRequestUrl(query, limit))
              : await fetchJson(wikimediaRequestUrl(query, limit), 25_000)
          const items = source === 'cleveland' ? parseCleveland(payload) : parseWikimedia(payload)
          artCache.set(key, { at: Date.now(), items })
          return sendJson(res, 200, { ok: true, source, items, stale: false })
        } catch (error) {
          const message = String(error?.message ?? error)
          if (source === 'wikimedia') {
            const items = FALLBACK_ART.filter((item) => {
              const haystack = `${item.title} ${item.credit}`.toLowerCase()
              return query.toLowerCase().split(/\s+/).some((word) => word.length > 2 && haystack.includes(word))
            })
            return sendJson(res, 200, {
              ok: false,
              source,
              items: items.length > 0 ? items : FALLBACK_ART.slice(0, 1),
              stale: true,
              error: message,
            })
          }
          return sendJson(res, 200, { ok: false, source, items: [], stale: true, error: message })
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
        const { buffer, contentType } = await withRetry(() => fetchRemoteImage(target), 2, 500)
        res.writeHead(200, {
          'content-type': contentType,
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
        const state = await readState()
        sendJson(res, 200, {
          ok: true,
          version: 1,
          baseDir,
          assets,
          enabled: state.enabled,
          hasWallpaper: Boolean(state.wallpaper),
          upstream: ['bing', 'wikimedia', 'cleveland'],
        })
      }),
    }),
  )
}
