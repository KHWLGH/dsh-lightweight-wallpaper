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
])

export const BING_MARKETS = ['zh-CN', 'en-US', 'ja-JP', 'en-GB']
export const ART_SOURCES = ['wikimedia', 'cleveland']

const BING_ORIGIN = 'https://www.bing.com'

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

export function bingRequestUrl(market = 'zh-CN', count = 8) {
  const mkt = BING_MARKETS.includes(market) ? market : 'zh-CN'
  const n = Math.min(Math.max(Number(count) || 8, 1), 8)
  return `${BING_ORIGIN}/HPImageArchive.aspx?format=js&idx=0&n=${n}&mkt=${mkt}`
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

export function wikimediaRequestUrl(query, limit = 24) {
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
  return `https://commons.wikimedia.org/w/api.php?${params.toString()}`
}

/** Swap the thumbnail width in a Commons thumb URL, keeping every other part. */
export function resizeWikimediaThumb(thumb, width) {
  if (typeof thumb !== 'string') return null
  return thumb.replace(/\/(\d+)px-/, `/${width}px-`)
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
