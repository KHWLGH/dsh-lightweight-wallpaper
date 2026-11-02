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
const fakeCtx = {
  effect(callback) {
    const dispose = callback()
    effects.push(dispose)
    return dispose
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
    overrideTokens(source, tokens) {
      tokenLayers.push({ source, tokens })
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
assert.equal(fakeElement.style.getPropertyValue('--lww-scrim-rgb'), '255,255,255')
// Light scrim: the slider value only, 62%.
assert.equal(fakeElement.style.getPropertyValue('--lww-floor'), 'rgba(255,255,255,0.620)')
assert.ok(fakeElement.attrs.has('data-lww-contrast'), 'light-mode text contrast must be on by default')

const cssText = appended.map((element) => element.textContent).join('\n')
for (const needle of [
  'data-lww-glass',
  'data-lww-contrast',
  '_composerSeat',
  '_composerHero',
  '_newSession',
  '--lww-panel-a',
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

console.log('PASS  __ModuleLoader__ envelope, id, inject and apply')
console.log('PASS  one settings.section registration with a localizable label')
console.log('PASS  zh + en locale dictionaries registered')
console.log('PASS  one transparent-token layer once a wallpaper exists')
console.log('PASS  glass + contrast attributes land on the root with no hidden boost')
console.log('PASS  stylesheet carries composer-card, new-session and contrast rules')
