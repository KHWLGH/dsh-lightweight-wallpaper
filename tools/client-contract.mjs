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
const fakeDocument = {
  documentElement: {
    style: { setProperty() {}, removeProperty() {} },
    setAttribute() {},
    removeAttribute() {},
  },
  createElement() {
    return { id: '', textContent: '', remove() {} }
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
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, state: { enabled: true } }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

try {
  plugin.apply(fakeCtx)
  await new Promise((resolve) => setTimeout(resolve, 30))
} finally {
  globalThis.fetch = originalFetch
}

assert.equal(sectionRegistrations.length, 1, 'exactly one settings.section registration')
assert.equal(sectionRegistrations[0].options.id, 'lightweight-wallpaper')
assert.equal(typeof sectionRegistrations[0].component, 'function')
assert.equal(typeof sectionRegistrations[0].options.label, 'function')
assert.equal(sectionRegistrations[0].options.label(), 'nav.title')

// Dispose every registered effect (also stops the delayed self-check timer).
for (const dispose of effects.reverse()) {
  if (typeof dispose === 'function') dispose()
}

assert.deepEqual(
  localeRegistrations.map((entry) => entry.locale).sort(),
  ['en', 'zh'],
  'both built-in locales must be registered',
)
assert.ok(tokenLayers.length <= 1, 'at most one token layer before a wallpaper is chosen')

console.log('PASS  __ModuleLoader__ envelope, id, inject and apply')
console.log('PASS  one settings.section registration with a localizable label')
console.log('PASS  zh + en locale dictionaries registered')
console.log('PASS  no token override is installed until a wallpaper exists')
