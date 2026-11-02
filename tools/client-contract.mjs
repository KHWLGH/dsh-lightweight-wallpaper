/**
 * Client-bundle contract check — no browser, no React renderer.
 *
 *   node tools/client-contract.mjs
 *
 * Verifies the `__ModuleLoader__` envelope the Harness browser graph expects:
 * the module id equals the package name, the factory returns `inject` and
 * `apply`, and applying it registers exactly one `settings.section` entry plus
 * the locale dictionaries and stylesheet, all with working disposers.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const code = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

const ReactStub = {
  createElement: () => ({}),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

let loaded = null
const fakeWindow = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}
const fakeModule = { exports: {} }
const appended = []
const fakeElement = {
  style: {
    props: {},
    setProperty(name, value) {
      this.props[name] = value
    },
    removeProperty(name) {
      delete this.props[name]
    },
    getPropertyValue(name) {
      return this.props[name] ?? ''
    },
  },
  attrs: new Set(),
  setAttribute(name) {
    this.attrs.add(name)
  },
  removeAttribute(name) {
    this.attrs.delete(name)
  },
  hasAttribute(name) {
    return this.attrs.has(name)
  },
}
const fakeDocument = {
  documentElement: fakeElement,
  createElement() {
    const element = { id: '', textContent: '', remove() {} }
    appended.push(element)
    return element
  },
  head: { appendChild() {}, removeChild() {} },
}
const fakeLocalStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const requireStub = (name) => {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require(${name})`)
}

const evaluate = new Function('window', 'module', 'exports', 'require', 'document', 'localStorage', code)
evaluate(fakeWindow, fakeModule, fakeModule.exports, requireStub, fakeDocument, fakeLocalStorage)

assert.ok(loaded, '__ModuleLoader__.load was not called')
assert.equal(loaded.id, 'dsh-lightweight-wallpaper', 'module id must equal the package name')
assert.equal(typeof loaded.factory, 'function')

const plugin = loaded.factory(requireStub)
assert.ok(Array.isArray(plugin.inject), 'inject must be an array')
for (const service of ['slots', 'theme', 'locale']) {
  assert.ok(plugin.inject.includes(service), `inject must include ${service}`)
}
assert.equal(typeof plugin.apply, 'function')

/* Minimal Cordis-ish context to observe what apply() registers. */
const effects = []
const sectionRegistrations = []
const localeRegistrations = []
const tokenLayers = []
const eventListeners = []
let themeScheme = 'light'
const fakeCtx = {
  effect(callback) {
    const dispose = callback()
    effects.push(dispose)
    return dispose
  },
  on(name, listener) {
    eventListeners.push({ name, listener })
    return () => {}
  },
  slots: {
    inject(ownerKey, callback) {
      assert.equal(ownerKey, 'settings.section')
      effects.push(callback())
      return () => {}
    },
    register(options, component) {
      sectionRegistrations.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register(namespace, locale, dict) {
      localeRegistrations.push({ namespace, locale, dict })
      return () => {}
    },
    bind() {
      return (key) => key
    },
    subscribe() {
      return () => {}
    },
  },
  theme: {
    getTheme() {
      return { active: { colorScheme: themeScheme } }
    },
    overrideTokens(source, tokens) {
      tokenLayers.push({ source, tokens })
      // cordis `emit` is synchronous, so a layer publish re-enters the
      // theme/change listener before overrideTokens returns. That must not
      // stack a second layer.
      for (const entry of eventListeners) {
        if (entry.name === 'theme/change') entry.listener({ active: { colorScheme: 'light' } })
      }
      return () => {}
    },
  },
}

const originalFetch = globalThis.fetch
const sampleState = {
  enabled: true,
  fit: 'cover',
  dim: 18,
  blur: 0,
  opacity: 62,
  panelEnabled: true,
  panelAlpha: 55,
  panelBlur: 24,
  wallpaper: {
    asset: '/api/lightweight-wallpaper/asset/0123456789abcdef0123456789abcdef01234567.jpg',
    source: 'bing',
    title: 'Sample',
    credit: '',
    page: '',
    addedAt: '2026-01-01T00:00:00.000Z',
  },
}
globalThis.fetch = async () =>
  new Response(JSON.stringify({ ok: true, state: sampleState }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

try {
  plugin.apply(fakeCtx)
  await new Promise((resolve) => setTimeout(resolve, 30))
} finally {
  globalThis.fetch = originalFetch
}

/* Glass surfaces: one material on the root, applied by data attributes only. */
assert.ok(fakeElement.attrs.has('data-lww-active'), 'wallpaper must activate the paint layer')
assert.ok(fakeElement.attrs.has('data-lww-glass'), 'glass must be enabled by default')
// Light theme (no document.body) does not boost anything: 55% stays 55%.
assert.equal(fakeElement.style.getPropertyValue('--lww-panel-a'), '0.550')
assert.equal(fakeElement.style.getPropertyValue('--lww-panel-b'), '24px')
// The glass tint is a stylesheet value keyed on the palette attribute; writing
// it from script is what made a theme switch occasionally paint the old one.
assert.equal(
  fakeElement.style.getPropertyValue('--lww-scrim-rgb'),
  '',
  'glass tint must come from CSS, never from an inline variable',
)
// Light scrim: the slider value only, 62%.
assert.equal(fakeElement.style.getPropertyValue('--lww-floor'), 'rgba(255,255,255,0.620)')
assert.ok(fakeElement.attrs.has('data-lww-contrast'), 'light-mode text contrast must be on by default')

/*
 * Theme switching must not depend on the palette attribute on body: this fake
 * document has no body at all, so a DOM read would leave the scrim white. The
 * snapshot handed to `theme/change` is the only thing that may decide.
 */
const themeChange = eventListeners.find((entry) => entry.name === 'theme/change')
assert.ok(themeChange, 'the plugin must subscribe to theme/change')
themeChange.listener({ active: { colorScheme: 'dark' } })
assert.equal(
  fakeElement.style.getPropertyValue('--lww-floor'),
  'rgba(21,21,23,0.620)',
  'a dark snapshot must repaint the scrim dark without reading the DOM',
)
themeChange.listener({ active: { colorScheme: 'light' } })
assert.equal(fakeElement.style.getPropertyValue('--lww-floor'), 'rgba(255,255,255,0.620)')

// Second source: a change without a usable payload falls back to getTheme().
themeScheme = 'dark'
themeChange.listener(undefined)
assert.equal(
  fakeElement.style.getPropertyValue('--lww-floor'),
  'rgba(21,21,23,0.620)',
  'theme.getTheme() must be the second source',
)

// Third source: no payload and no service value — the palette attribute decides.
themeScheme = ''
fakeCtx.theme.getTheme = () => ({})
fakeDocument.body = { hasAttribute: (name) => name === 'data-ds-dark-theme' }
themeChange.listener(undefined)
assert.equal(fakeElement.style.getPropertyValue('--lww-floor'), 'rgba(21,21,23,0.620)')

// Healthy again: nothing may stay stuck on the dark scrim.
fakeDocument.body = undefined
themeScheme = 'light'
fakeCtx.theme.getTheme = () => ({ active: { colorScheme: themeScheme } })
themeChange.listener(undefined)
assert.equal(fakeElement.style.getPropertyValue('--lww-floor'), 'rgba(255,255,255,0.620)')

const cssText = appended.map((element) => element.textContent).join('\n')
for (const needle of [
  'data-lww-glass',
  'data-lww-contrast',
  '_composerSeat',
  '_composerHero',
  '_newSession',
  '--lww-panel-a',
  '--lww-scrim-rgb:255,255,255',
  '--lww-scrim-rgb:21,21,23',
  '--dsw-alias-label-secondary',
  '--dsw-menu-surface-fill',
  'data-menu-material',
]) {
  assert.ok(cssText.includes(needle), `stylesheet must carry ${needle}`)
}
assert.ok(!cssText.includes('--dsw-specific-input-major:transparent'), 'no global composer token override')
assert.ok(!cssText.includes('[class*="_bottomRow"]{\n        background-color:rgba'), 'the full-width bottom row must not be painted')
assert.ok(
  fakeWindow.__dshLightweightWallpaper && typeof fakeWindow.__dshLightweightWallpaper.check === 'function',
  'self-check hook must be exposed on window',
)

assert.equal(sectionRegistrations.length, 1, 'exactly one settings.section registration')
assert.equal(sectionRegistrations[0].options.id, 'lightweight-wallpaper')
assert.equal(typeof sectionRegistrations[0].component, 'function')
assert.equal(typeof sectionRegistrations[0].options.label, 'function')
assert.equal(sectionRegistrations[0].options.label(), 'nav.title')

// Dispose every registered effect (also stops the delayed self-check timer).
for (const dispose of effects.reverse()) {
  if (typeof dispose === 'function') dispose()
}

assert.equal(fakeElement.attrs.has('data-lww-active'), false, 'dispose must release the paint layer')
assert.equal(fakeElement.attrs.has('data-lww-glass'), false, 'dispose must release the glass layer')
assert.equal(fakeElement.attrs.has('data-lww-contrast'), false, 'dispose must release the contrast layer')

assert.deepEqual(
  localeRegistrations.map((entry) => entry.locale).sort(),
  ['en', 'zh'],
  'both built-in locales must be registered',
)
for (const registration of localeRegistrations) {
  for (const key of ['panel.title', 'panel.alpha', 'panel.blur', 'panel.off', 'contrast.title', 'contrast.hint']) {
    assert.ok(registration.dict[key], `${registration.locale} dictionary is missing ${key}`)
  }
}
assert.equal(tokenLayers.length, 1, 'a wallpaper installs exactly one token layer')
assert.deepEqual(Object.keys(tokenLayers[0].tokens).sort(), [
  '--dsw-alias-bg-base',
  '--dsw-specific-sidebar-fill',
])

/*
 * Pagination + preset contract: the client half owns the art presets, the pager
 * strings live in both dictionaries, the shared pager row has its own stylesheet
 * rules and every tile asks the host proxy for a small thumbnail (the Host snaps
 * the requested width to one Wikimedia actually serves).
 */
const presetBlock = /const PRESETS = \[([\s\S]*?)\n    \]/.exec(code)
assert.ok(presetBlock, 'PRESETS must be declared in the client bundle')
const presetIds = [...presetBlock[1].matchAll(/\bid: '([^']+)'/g)].map((match) => match[1])
assert.equal(presetIds.length, 8, `expected exactly 8 art presets, found ${presetIds.length}`)
assert.deepEqual(
  presetIds,
  ['vanGogh', 'monet', 'impressionism', 'landscape', 'ukiyoe', 'renaissance', 'vermeer', 'klimt'],
  'the eight art presets',
)
for (const registration of localeRegistrations) {
  for (const id of presetIds) {
    assert.ok(registration.dict[`preset.${id}`], `${registration.locale} dictionary is missing preset.${id}`)
  }
  for (const gone of ['hokusai', 'turner', 'preraph', 'russian', 'stilllife', 'artnouveau']) {
    assert.equal(
      registration.dict[`preset.${gone}`],
      undefined,
      `${registration.locale} must not ship the removed preset.${gone}`,
    )
  }
  for (const key of ['pager.prev', 'pager.next', 'pager.page', 'pager.total', 'pager.end']) {
    assert.ok(registration.dict[key], `${registration.locale} dictionary is missing ${key}`)
  }
}
assert.ok(cssText.includes('.lww-pager'), 'stylesheet must carry the pager row')
assert.ok(cssText.includes('.lww-pager-info'), 'stylesheet must carry the pager info line')
assert.ok(
  code.includes('.lww-chips{display:flex;flex-wrap:nowrap'),
  'the preset row must never wrap: eight chips stay on one line',
)
assert.ok(
  code.includes('flex:none;white-space:nowrap'),
  'preset chips keep their intrinsic width inside the scrolling row',
)
assert.ok(
  code.includes('/proxy?u=${encodeURIComponent(item.thumb)}&w=480'),
  'tiles must ask the proxy for a small thumbnail (the Host snaps 480 to Wikimedia’s 500px step)',
)

/*
 * Recent list + cache manager: both dictionaries carry the new strings, the
 * bundle talks to the two new Host endpoints, the recent grid has its own
 * stylesheet rules and a thumbnail purge bumps the epoch that every proxied
 * thumbnail URL carries. A history entry is never "missing" — the Host only
 * returns files that still exist on disk — so that state must not exist.
 */
for (const registration of localeRegistrations) {
  for (const key of [
    'history.title',
    'history.hint',
    'history.empty',
    'history.current',
    'cache.title',
    'cache.hint',
    'cache.assets',
    'cache.thumbs',
    'cache.lists',
    'cache.clear',
    'cache.clearAssets',
    'cache.clearAll',
    'cache.confirm',
    'cache.freed',
    'cache.never',
  ]) {
    assert.ok(registration.dict[key], `${registration.locale} dictionary is missing ${key}`)
  }
  assert.equal(
    registration.dict['history.missing'],
    undefined,
    'a history entry never goes missing: the Host only returns existing files',
  )
  assert.equal(
    registration.dict['cache.confirm'],
    registration.locale === 'zh' ? '确认清理' : 'Confirm clear',
    `${registration.locale} clear-all confirmation is a plain two-step label`,
  )
}
assert.ok(!code.includes('confirmTimer'), 'no countdown timer around the clear-all button')
assert.ok(!code.includes('（3 秒）') && !code.includes('(3 s)'), 'the countdown copy is gone')
assert.ok(
  code.includes('onBlur: () => setConfirming(false)'),
  'the armed clear-all label disarms when focus leaves the button',
)
for (const endpoint of ['/history', '/cache', '/cache/clear']) {
  assert.ok(
    code.includes(`'${endpoint}'`) || code.includes(`\`${endpoint}`),
    `the client must call the ${endpoint} Host endpoint`,
  )
}
assert.ok(code.includes('.lww-history-grid'), 'stylesheet must carry the recent-wallpaper grid')
for (const rule of ['.lww-history-item.is-current', '.lww-cache-row', '.lww-badge']) {
  assert.ok(code.includes(rule), `stylesheet must carry ${rule}`)
}
assert.ok(code.includes('&v=${thumbEpoch}'), 'proxied thumbnails must carry the thumbnail epoch')
assert.ok(code.includes("thumb: item.thumb || ''"), 'pin and auto-rotate must carry the remote thumb')
assert.ok(code.includes('function formatBytes'), 'cache sizes must be formatted by formatBytes')
assert.ok(!code.includes('history.missing'), 'there is no history.missing state in the client')

/*
 * Merged picker: recently used is the first AND default tab, the three upstream
 * sources follow behind a hairline, the standalone history card is gone, and the
 * picker never auto-jumps away from the history tab.
 */
const tabKeys = [
  "['history', props.t('history.title')]",
  "['bing', props.t('source.bing')]",
  "['art', props.t('source.art')]",
  "['custom', props.t('source.custom')]",
]
const tabPositions = tabKeys.map((needle) => code.indexOf(needle))
assert.ok(
  tabPositions.every((position) => position >= 0),
  'SourceTabs must declare history + the three sources',
)
assert.deepEqual(
  [...tabPositions].sort((a, b) => a - b),
  tabPositions,
  'recently used must be the first tab, the sources follow it',
)
assert.ok(code.includes("useState('history')"), 'the picker opens on the recently-used tab')
assert.ok(code.includes("id === 'bing'"), 'the sources must be separated from the history tab')
assert.ok(cssText.includes('.lww-tab-sep'), 'stylesheet must carry the tab separator')
assert.ok(!code.includes('HistoryCard'), 'the standalone history card must be gone')
assert.ok(!code.includes('onEmpty'), 'the picker must not fall back to a source tab when history is empty')
for (const registration of localeRegistrations) {
  const expected = registration.locale === 'zh' ? '选择壁纸' : 'Choose a wallpaper'
  assert.equal(registration.dict['source.title'], expected, `${registration.locale} picker card title`)
}

/*
 * Settings nav icon + page layout. The shell has no icon seat for third-party
 * sections (they fall back to the gear), so the Client marks its own nav row by
 * localized label and paints the glyph through CSS; the page groups its cards
 * and aligns its controls with shared classes instead of inline margins.
 */
for (const registration of localeRegistrations) {
  for (const key of ['group.wallpaper', 'group.display', 'group.data']) {
    assert.ok(registration.dict[key], `${registration.locale} dictionary is missing ${key}`)
  }
}
for (const needle of [
  'data-lww-nav',
  'data-shortcut-modal="settings"',
  '_navCell',
  '_navLabel',
  'decorateSettingsNav',
  'installSettingsNav',
  'nav: { decorate: decorateSettingsNav, probe: probeSettingsNav }',
  'navIcon: probeSettingsNav()',
]) {
  assert.ok(code.includes(needle), `client must carry ${needle} for the settings nav icon`)
}
for (const rule of [
  '[data-lww-nav]>svg',
  'mask-image',
  'data:image/svg+xml',
  '.lww-group',
  '.lww-card-actions',
  '.lww-preview',
  'tabular-nums',
  'minmax(112px,1fr)',
]) {
  assert.ok(cssText.includes(rule), `stylesheet must carry ${rule}`)
}
assert.ok(!/style: \{ marginTop/.test(code), 'layout gaps must come from classes, not inline margins')

/*
 * Cache buttons share one column width, and a wallpaper without a remote thumb
 * (uploads) must never be sent through the proxy: its asset path is local and
 * the proxy only accepts absolute https URLs, so that used to break the tile.
 */
assert.ok(
  cssText.includes('.lww-cache-row .lww-btn{min-width:132px'),
  'all three cache buttons must share one width',
)
assert.ok(!code.includes(':first-child .lww-btn'), 'no per-row cache button width override')
assert.ok(code.includes("'cache.clearAssets': 'Clear old'"), 'the english clear label must stay short')
assert.ok(
  code.includes('/^https?:\\/\\//i.test(entry.thumb)'),
  'history thumbnails must only proxy absolute https thumbs',
)
assert.ok(
  code.includes("return entry && typeof entry.asset === 'string' ? entry.asset : ''"),
  'an entry without a remote thumb must fall back to the stored asset',
)
assert.ok(!code.includes('proxy?u=${encodeURIComponent(source)}'), 'no local asset path must reach the proxy')
assert.ok(code.includes('lww-history-thumb-empty'), 'a tile without any image gets a quiet placeholder')

/*
 * Local library: the first picker tab is every wallpaper stored on this machine
 * — downloaded and uploaded alike — capped at the asset cap (20), and the nav
 * glyph now uses the official 16px box so its label lines up with every other
 * row (the shell renders built-in glyphs with `size: 16`).
 */
for (const registration of localeRegistrations) {
  const zh = registration.locale === 'zh'
  assert.equal(registration.dict['history.title'], zh ? '本地壁纸' : 'Local wallpapers', `${registration.locale} local list title`)
  assert.equal(registration.dict['cache.assets'], zh ? '本地壁纸' : 'Local wallpapers', `${registration.locale} cache row title`)
  assert.equal(registration.dict['source.custom'], zh ? '上传' : 'Upload', `${registration.locale} upload tab`)
  assert.ok(registration.dict['source.name.local'], `${registration.locale} local source name`)
}
assert.ok(code.includes('const HISTORY_LIMIT = 20'), 'the local list shows twenty wallpapers')
assert.ok(
  code.includes('[data-lww-nav]::before{content:"";flex:none;width:16px;height:16px'),
  'the masked glyph must use the official 16x16 box',
)
assert.ok(
  !code.includes('[data-lww-nav]::before{content:"";flex:none;width:20px;height:20px'),
  'the oversized 20px glyph box is gone',
)
assert.ok(code.includes("stroke-width='1.9'"), 'the glyph stroke matches the official icon weight')
assert.ok(code.includes('navLabelOffset'), 'the self-check measures the label offset for alignment')

console.log('PASS  __ModuleLoader__ envelope, id, inject and apply')
console.log('PASS  one settings.section registration with a localizable label')
console.log('PASS  zh + en locale dictionaries registered')
console.log('PASS  one transparent-token layer once a wallpaper exists')
console.log('PASS  glass + contrast attributes land on the root with no hidden boost')
console.log('PASS  glass tint comes from the stylesheet, not from an inline variable')
console.log('PASS  a dark snapshot repaints the scrim: payload → getTheme() → attribute')
console.log('PASS  stylesheet carries composer-card, new-session and contrast rules')
console.log('PASS  art presets, pager strings and small-thumbnail proxy requests')
console.log('PASS  recent-list + cache manager: i18n, endpoints, epoch and history grid')
console.log('PASS  merged picker: recently-used first tab, sources behind a separator')
console.log('PASS  settings nav icon decoration + grouped, aligned layout classes')
console.log('PASS  local library (20, uploads included) + 16px nav glyph geometry')
