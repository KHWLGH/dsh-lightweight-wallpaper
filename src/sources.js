/**
 * Source adapters for the lightweight wallpaper plugin.
 *
 * Pure functions only: URL builders on one side, upstream JSON → normalized
 * item on the other. The Host half and tools/probe-sources.mjs both import this
 * module, so nothing here may touch the filesystem, the network or Cordis.
 */

export const UA =
  'dsh-lightweight-wallpaper/0.1 (+https://github.com/deepseek-harness) DeepSeek-Harness-Wallpaper'

/** Remote hosts the Host half may proxy or download from. */
export const ALLOWED_HOSTS = new Set([
  'www.bing.com',
  'bing.com',
  'upload.wikimedia.org',
  'thumb.wikimedia.org',
  'commons.wikimedia.org',
  'openaccess-api.clevelandart.org',
  'openaccess-cdn.clevelandart.org',
  '10wallpaper.com',
  'www.10wallpaper.com',
])

export const BING_MARKETS = ['zh-CN', 'en-US', 'ja-JP', 'en-GB']
export const ART_SOURCES = ['wikimedia', 'cleveland', 'tenwallpaper']

/**
 * 10wallpaper has fixed upstream page sizes: list/search pages carry 12 cells
 * and category pages 20. `ART_LIMIT_MAX` (Host) only applies to the two museum
 * APIs, which take an explicit `limit`.
 */
export const TENWALLPAPER_PAGE_SIZE = 12
export const TENWALLPAPER_CATEGORY_PAGE_SIZE = 20

/**
 * Category pages that are safe to surface as chips. The site also ships
 * `People`, `Plants`, `Moive` (sic), `Sports`, … — the global list mixes all of
 * them, but the picker only offers the neutral ones; anything else stays one
 * search away and is never presented as a default feed.
 */
export const TENWALLPAPER_CATEGORIES = [
  'Landscape',
  'Game',
  'City',
  'Space',
  'Animal',
  'Design',
  'Photography',
]

/** 10wallpaper serves 22 fixed variants by path; the plugin uses the 4K one. */
export const TENWALLPAPER_FULL_VARIANT = '3840x2160'

const BING_ORIGIN = 'https://www.bing.com'
const TENWALLPAPER_ORIGIN = 'https://10wallpaper.com'

/* ------------------------------------------------------------------------ */
/* Small text helpers                                                       */
/* ------------------------------------------------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

/** Remove markup from a Commons extmetadata field and collapse whitespace. */
export function stripHtml(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([a-zA-Z#0-9]+);/g, (match, name) => ENTITIES[name] ?? match)
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(text, max) {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/* ------------------------------------------------------------------------ */
/* Bing daily wallpaper                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Bing HPImageArchive request URL.
 * `idx` is the wallpaper-day offset (0 = today); the Host half pages by eight
 * entries, so page N reads `idx = N * 8`, clamped to Bing's 0..8 window.
 */
export function bingRequestUrl(market = 'zh-CN', count = 8, idx = 0) {
  const mkt = BING_MARKETS.includes(market) ? market : 'zh-CN'
  const n = Math.min(Math.max(Number(count) || 8, 1), 8)
  const start = Math.min(Math.max(Math.round(Number(idx) || 0), 0), 8)
  return `${BING_ORIGIN}/HPImageArchive.aspx?format=js&idx=${start}&n=${n}&mkt=${mkt}`
}

function bingSized(urlbase, size) {
  return `${BING_ORIGIN}${urlbase}_${size}.jpg`
}

/**
 * Normalize the Bing HPImageArchive payload.
 * `_UHD.jpg` is a true 3840x2160; `_400x240.jpg` keeps a grid cheap.
 */
export function parseBing(payload) {
  const images = Array.isArray(payload?.images) ? payload.images : []
  const items = []
  for (const image of images) {
    const base = typeof image?.urlbase === 'string' ? image.urlbase : null
    if (!base) continue
    const copyright = clip(stripHtml(image.copyright), 220)
    items.push({
      id: String(image.hsh || image.startdate || base),
      source: 'bing',
      title: clip(stripHtml(image.title) || copyright, 160),
      credit: copyright,
      license: 'Bing wallpaper (personal wallpaper use)',
      page: typeof image.copyrightlink === 'string' ? image.copyrightlink : BING_ORIGIN,
      date: String(image.startdate || ''),
      thumb: bingSized(base, '400x240'),
      full: bingSized(base, 'UHD'),
      fallbacks: [bingSized(base, '1920x1080'), bingSized(base, '1366x768')],
      width: 3840,
      height: 2160,
    })
  }
  return items
}

/* ------------------------------------------------------------------------ */
/* Wikimedia Commons art                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Commons search request URL. Later pages carry the `gsroffset` cursor the API
 * returned with the previous answer; page one intentionally sends none.
 */
export function wikimediaRequestUrl(query, limit = 24, offset = 0) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: String(Math.min(Math.max(Number(limit) || 24, 1), 40)),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: '960',
  })
  // Only later pages need the cursor; page one must stay request-identical.
  const skip = Math.max(Math.round(Number(offset) || 0), 0)
  if (skip > 0) params.set('gsroffset', String(skip))
  return `https://commons.wikimedia.org/w/api.php?${params.toString()}`
}

/** Swap the thumbnail width in a Commons thumb URL, keeping every other part. */
export function resizeWikimediaThumb(thumb, width) {
  if (typeof thumb !== 'string') return null
  return thumb.replace(/\/(\d+)px-/, `/${width}px-`)
}

/** Hosts whose thumbnail URLs end in a `/NNNpx-<name>` segment we can rewrite. */
const THUMB_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org', 'commons.wikimedia.org'])

/**
 * Widths Wikimedia production actually serves. Direct requests (hotlinking) for
 * any other width now answer 400 — "Use thumbnail sizes listed on
 * https://w.wiki/GHai" — so every rewrite has to land on one of these steps.
 */
export const WIKIMEDIA_THUMB_STEPS = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840]

/** Smallest standard Wikimedia width at or above `width`. */
export function standardThumbWidth(width = 500) {
  const wanted = Math.max(Math.round(Number(width) || 500), WIKIMEDIA_THUMB_STEPS[0])
  return WIKIMEDIA_THUMB_STEPS.find((step) => step >= wanted) ?? WIKIMEDIA_THUMB_STEPS.at(-1)
}

/**
 * Normalize a thumbnail request. Only Wikimedia hosts embed the width in the
 * path, and only their standard steps are accepted, so the value snaps up to
 * the closest step (the Client asks for 480 and gets 500). Every other
 * allowlisted URL is returned byte-identical, because their thumb sizes are
 * fixed by the source.
 */
export function thumbUrl(url, width = 500) {
  if (typeof url !== 'string' || url.length === 0) return url
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return url
  }
  if (!THUMB_HOSTS.has(host)) return url
  return resizeWikimediaThumb(url, standardThumbWidth(width)) || url
}

function commonsFileUrl(title) {
  const name = String(title || '').replace(/^File:/, '')
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name.replace(/ /g, '_'))}`
}

export function parseWikimedia(payload) {
  const pages = payload?.query?.pages
  const list = Array.isArray(pages) ? pages : Object.values(pages ?? {})
  const items = []
  for (const page of list) {
    const info = page?.imageinfo?.[0]
    if (!info) continue
    const mime = String(info.mime || '')
    if (mime !== 'image/jpeg' && mime !== 'image/png') continue
    const width = Number(info.width) || 0
    const height = Number(info.height) || 0
    if (width < 1200 || height < 800) continue
    const thumb = typeof info.thumburl === 'string' ? info.thumburl : info.url
    if (!thumb) continue
    const meta = info.extmetadata || {}
    const artist = clip(stripHtml(meta.Artist?.value), 120)
    const license = clip(stripHtml(meta.LicenseShortName?.value), 60)
    const name = String(page.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')
    items.push({
      id: String(page.pageid ?? page.title),
      source: 'wikimedia',
      title: clip(name.replace(/_/g, ' '), 160),
      credit: artist || 'Wikimedia Commons',
      license: license || 'Public domain',
      page: commonsFileUrl(page.title),
      thumb,
      full: resizeWikimediaThumb(thumb, 1920) || thumb,
      fallbacks: [resizeWikimediaThumb(thumb, 1280), resizeWikimediaThumb(thumb, 960)].filter(Boolean),
      width,
      height,
    })
  }
  // Commons relevance picks up sketches and small derivatives; the famous
  // Google-Art-Project scans are the largest files, so rank by pixel area.
  items.sort((a, b) => b.width * b.height - a.width * a.height)
  return items
}

/* ------------------------------------------------------------------------ */
/* Cleveland Museum of Art open access                                      */
/* ------------------------------------------------------------------------ */

export function clevelandRequestUrl(query, limit = 24, skip = 0) {
  const params = new URLSearchParams({
    q: query,
    cc0: '1',
    has_image: '1',
    limit: String(Math.min(Math.max(Number(limit) || 24, 1), 40)),
    skip: String(Math.max(Number(skip) || 0, 0)),
  })
  return `https://openaccess-api.clevelandart.org/api/artworks?${params.toString()}`
}

export function parseCleveland(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : []
  const items = []
  for (const work of data) {
    if (String(work?.share_license_status || '').toUpperCase() !== 'CC0') continue
    const images = work?.images || {}
    const full = images.print?.url || images.full?.url || images.web?.url
    const thumb = images.web?.url || images.print?.url
    if (!full || !thumb) continue
    const creator =
      stripHtml(work.creators?.[0]?.description) || stripHtml(work.culture?.[0]) || 'Cleveland Museum of Art'
    items.push({
      id: String(work.id ?? work.accession_number),
      source: 'cleveland',
      title: clip(stripHtml(work.title), 160) || 'Untitled',
      credit: clip(creator, 120),
      license: 'CC0',
      page: `https://www.clevelandart.org/art/${encodeURIComponent(String(work.id ?? ''))}`,
      thumb,
      full,
      fallbacks: [images.web?.url].filter(Boolean),
      width: Number(images.print?.width) || Number(images.web?.width) || 0,
      height: Number(images.print?.height) || Number(images.web?.height) || 0,
    })
  }
  return items
}

/* ------------------------------------------------------------------------ */
/* 10wallpaper                                                              */
/* ------------------------------------------------------------------------ */

function tenwallpaperCategory(cat) {
  return TENWALLPAPER_CATEGORIES.includes(String(cat ?? '')) ? String(cat) : ''
}

/** Escape a search term the way the site's URL routing expects (spaces → _). */
function tenwallpaperSearchSlug(query) {
  return encodeURIComponent(String(query).trim().replace(/\s+/g, '_'))
}

/**
 * 10wallpaper has no API: list, category and search pages are plain HTML. The
 * first page has no `/page/1` suffix; page N (0-based) is upstream page N+1.
 */
export function tenwallpaperRequestUrl(options = {}) {
  const page = Math.max(Math.round(Number(options.page) || 0), 0)
  const query = String(options.q ?? '').trim()
  const category = tenwallpaperCategory(options.cat)
  if (query) {
    return page > 0
      ? `${TENWALLPAPER_ORIGIN}/search/${tenwallpaperSearchSlug(query)}/page/${page + 1}`
      : `${TENWALLPAPER_ORIGIN}/search/${tenwallpaperSearchSlug(query)}/`
  }
  if (category) {
    return page > 0
      ? `${TENWALLPAPER_ORIGIN}/${category}_wallpaper/page/${page + 1}`
      : `${TENWALLPAPER_ORIGIN}/${category}_wallpaper.html`
  }
  return page > 0
    ? `${TENWALLPAPER_ORIGIN}/List_wallpapers/page/${page + 1}`
    : `${TENWALLPAPER_ORIGIN}/List_wallpapers.html`
}

/**
 * Rewrite the medium thumbnail path into one of the 22 fixed resolution
 * variants the site keeps side by side (e.g. 3840x2160). No API: the variant
 * is literally a replacement of two path segments.
 */
export function tenwallpaperVariantUrl(mediumPath, variant = TENWALLPAPER_FULL_VARIANT) {
  const path = String(mediumPath ?? '')
  if (!path) return ''
  return `${TENWALLPAPER_ORIGIN}${path
    .replace('/wallpaper/medium/', `/wallpaper/${variant}/`)
    .replace(/_medium\.jpg$/, `_${variant}.jpg`)}`
}

/**
 * Parse a list/category/search wall. Every cell is
 * `<a href="/view/<Slug>.html"><img src="/wallpaper/medium/<YYMM>/<Slug>_medium.jpg" …>`.
 * The human title sits in `alt` on list/search pages but in `title` on category
 * pages, and it is followed by a view counter; the slug is a stable fallback.
 */
export function parseTenwallpaper(html) {
  const items = []
  const source = String(html ?? '')
  const pattern =
    /<a href="(\/view\/[^"]+)\.html"[^>]*>\s*<img src="(\/wallpaper\/medium\/(\d{4})\/[^"]+?_medium\.jpg)"[^>]*?(?:alt|title)="([^"]*)"/g
  for (const match of source.matchAll(pattern)) {
    const [, viewPath, mediumPath, , rawAlt] = match
    const slug = viewPath.split('/').pop() || ''
    if (!slug || !mediumPath) continue
    const title = clip(stripHtml(rawAlt).replace(/\s*Views:\s*\d+\s*$/i, ''), 160)
    items.push({
      id: slug,
      source: 'tenwallpaper',
      title: title || slug.replace(/_/g, ' '),
      credit: '10wallpaper.com',
      license: '© 原作者 · 仅个人使用',
      page: `${TENWALLPAPER_ORIGIN}${viewPath}.html`,
      thumb: `${TENWALLPAPER_ORIGIN}${mediumPath}`,
      full: tenwallpaperVariantUrl(mediumPath),
      fallbacks: ['2560x1440', '1920x1080', '1366x768'].map((variant) =>
        tenwallpaperVariantUrl(mediumPath, variant),
      ),
      width: 3840,
      height: 2160,
    })
  }
  return items
}

/** Highest page number linked on the wall (site reports it in the pager). */
export function tenwallpaperLastPage(html) {
  let last = 0
  for (const match of String(html ?? '').matchAll(
    /\/(?:List_wallpapers|search\/[^"/]+|[A-Za-z]+_wallpaper)\/page\/(\d+)"/g,
  )) {
    const page = Number(match[1]) || 0
    if (page > last) last = page
  }
  return last
}

/** Derive hasMore/total from the pager; the site has no total field of its own. */
export function tenwallpaperPagination(html, pageSize, page) {
  const lastPage = tenwallpaperLastPage(html)
  const size = Math.max(Number(pageSize) || 0, 1)
  // On the very last page the pager no longer links its own number, so the
  // current page is the best lower bound we have for the total.
  return {
    lastPage,
    hasMore: lastPage > 0 ? page + 1 < lastPage : false,
    total: lastPage > 0 ? Math.max(lastPage, page + 1) * size : 0,
  }
}

/* ------------------------------------------------------------------------ */
/* Paging                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Report whether a source returned more pages and, when it knows, how many
 * items exist in total. Commons only exposes an opaque `continue` cursor, so
 * it never reports a total; Cleveland publishes `info.total`.
 */
export function paginationOf(source, payload, options = {}) {
  const limit = Math.max(Number(options.limit) || 0, 0)
  const offset = Math.max(Number(options.offset) || 0, 0)
  if (source === 'wikimedia') {
    return { hasMore: Boolean(payload?.continue?.gsroffset), total: 0 }
  }
  if (source === 'cleveland') {
    const total = Number(payload?.info?.total) || 0
    const hasMore = total > 0 ? offset + limit < total : (payload?.data?.length ?? 0) >= limit
    return { hasMore, total }
  }
  return { hasMore: false, total: 0 }
}

/* ------------------------------------------------------------------------ */
/* Built-in fallback (used only when the Commons API is unreachable)        */
/* ------------------------------------------------------------------------ */

const STARRY_NIGHT_BASE =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg'

export const FALLBACK_ART = [
  {
    id: 'fallback-starry-night',
    source: 'wikimedia',
    title: 'The Starry Night — Vincent van Gogh',
    credit: 'Vincent van Gogh',
    license: 'Public domain',
    page: 'https://commons.wikimedia.org/wiki/File:Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg',
    thumb: `${STARRY_NIGHT_BASE}/960px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg`,
    full: `${STARRY_NIGHT_BASE}/1920px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg`,
    fallbacks: [`${STARRY_NIGHT_BASE}/1280px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg`],
    width: 44567,
    height: 35291,
  },
]

/* ------------------------------------------------------------------------ */
/* Allowlist                                                                */
/* ------------------------------------------------------------------------ */

/** True when the Host half may fetch this URL: HTTPS, allowlisted host, no credentials. */
export function isAllowedRemote(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  return ALLOWED_HOSTS.has(url.hostname.toLowerCase())
}
