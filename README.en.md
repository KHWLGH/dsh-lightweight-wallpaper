[简体中文](https://github.com/KHWLGH/dsh-lightweight-wallpaper/blob/main/README.md) | English | [Changelog](https://github.com/KHWLGH/dsh-lightweight-wallpaper/blob/main/CHANGELOG.md)

<div align="center">

<img src="https://raw.githubusercontent.com/KHWLGH/dsh-lightweight-wallpaper/main/icon.svg" width="96" alt="Lightweight Wallpaper" />

# dsh-lightweight-wallpaper

**A lightweight wallpaper and font plugin for DeepSeek Harness: five wallpaper sources, full-window coverage, cards and dialogs stay solid, and glass only on two surfaces; interface, code and terminal fonts can be picked from installed system fonts. Zero runtime dependencies, no build step, no bundled images or fonts.**

[![npm version](https://img.shields.io/npm/v/dsh-lightweight-wallpaper?style=flat-square&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/dsh-lightweight-wallpaper)
[![npm downloads](https://img.shields.io/npm/dm/dsh-lightweight-wallpaper?style=flat-square&label=downloads&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-lightweight-wallpaper)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/KHWLGH/dsh-lightweight-wallpaper/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/KHWLGH/dsh-lightweight-wallpaper?style=flat-square)](https://github.com/KHWLGH/dsh-lightweight-wallpaper/stargazers)
[![last commit](https://img.shields.io/github/last-commit/KHWLGH/dsh-lightweight-wallpaper?style=flat-square)](https://github.com/KHWLGH/dsh-lightweight-wallpaper/commits/main)
[![issues](https://img.shields.io/github/issues/KHWLGH/dsh-lightweight-wallpaper?style=flat-square)](https://github.com/KHWLGH/dsh-lightweight-wallpaper/issues)

![DSH plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE?style=flat-square)
![runtime dependencies](https://img.shields.io/badge/runtime_deps-0-brightgreen?style=flat-square)
![build](https://img.shields.io/badge/build-none-brightgreen?style=flat-square)
![JavaScript](https://img.shields.io/badge/JavaScript-ES_Modules-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

</div>

## Preview

| Light theme | Dark theme |
| :---: | :---: |
| ![Light theme](https://raw.githubusercontent.com/KHWLGH/dsh-lightweight-wallpaper/main/screenshots/lightmode.png) | ![Dark theme](https://raw.githubusercontent.com/KHWLGH/dsh-lightweight-wallpaper/main/screenshots/darkmode.png) |
| Claude Monet, *Impression, Sunrise*, 1872 | Vincent van Gogh, *The Starry Night*, 1889 |

## About

The plugin paints a wallpaper on the bottom layer of the Harness window: the canvas and sidebar let it show through, while cards, dialogs and code blocks stay solid so text remains readable. Only the composer card and the sidebar New session button get an extra glass layer. The Fonts group in the settings page also picks the interface, code and terminal fonts from installed system fonts; the code font drives both code blocks and the sidebar file preview/editor, and the terminal font drives the sidebar terminal.

Five sources feed the wallpaper: Bing daily, public-domain paintings from Wikimedia Commons, CC0 works from the Cleveland Museum of Art, 10wallpaper, and local uploads. Every upstream request is made by the host on the plugin's behalf and cached locally — the browser never talks to third-party APIs directly, and the last successful result is replayed when the network or the upstream fails.

Wallpaper settings, images and caches all live under `$DSH_HOME/lightweight-wallpaper/`, so they survive port changes and browser switches. Font choices are written to DSH's `ui-theme` settings and persisted by the official settings API.

## Features

### Wallpaper sources

- **Bing daily**: the last 16 days, with `zh-CN` / `en-US` / `ja-JP` / `en-GB` regions; 8 images per page, 2 pages.
- **Wikimedia Commons**: public-domain and freely licensed paintings; search for an artist, work or movement, or use one of the 8 presets.
- **Cleveland Museum of Art**: only items whose `share_license_status` is `CC0`; the pager shows the total count.
- **10wallpaper** (Wallpaper sites tab): list/search 12 per page, categories 20 per page; Landscape / Game / City / Space / Animal / Design chips plus keyword search; downloads 3840×2160 with 2560/1920/1366 fallbacks.
- **Upload**: JPEG / PNG / WebP; files over 6MB are downscaled to a 2560px longest edge in the browser before upload.

### Display and readability

- **Full-window wallpaper + four global controls**: the wallpaper covers the bottom layer; fill mode (cover / contain), window scrim, dim and wallpaper blur are all adjustable, and the sliders preview live.
- **Glass on two surfaces only**: the composer card and the sidebar New session button share one opacity and one blur; turning the master switch off makes them solid again.
- **A fullscreen right sidebar no longer leaks the transcript**: while a document, terminal or file tree covers the window, the page behind the panel goes back to the wallpaper and the conversation column (transcript, composer, status line) steps aside; it returns at once when the panel goes back to its docked presentation, and after the panel's slide when the panel closes.
- **Readable popovers**: while a wallpaper is active, the composer "+" menu, the model picker and other popovers turn near-solid with a background blur, so small text no longer drowns in the artwork.
- **Light-mode contrast boost**: secondary greys outside the glass step darker (`label-secondary` 700→800, `label-tertiary` 600→750, `label-caption` 400→700); the dark theme and the wallpaper-off state are untouched.
- **Theme sync**: the scrim colour follows the system light/dark theme (including "follow system") and never stays on the previous palette after a switch.

### Fonts

- **Interface / code / terminal fonts**: the Fonts group in the settings page picks each one; the list comes from the machine through Chromium's Local Font Access API, with a common-fonts fallback when access is denied or unavailable, and any family name can also be typed in.
- **Searchable, scrollable list**: the menu supports search and scrolling, marks the current font, and previews each candidate with its own `Aa Aa` sample; scrolling the list never closes it.
- **Synced with the official settings**: choices are written to DSH's `ui-theme` `textFontFamily` / `codeFontFamily` / `terminalFontFamily`, the same values behind Settings → General → More font settings; they survive restarts.
- **The code editor follows too**: Markdown code blocks use the official `--ds-font-family-code`; the plugin also maps the legacy `--dsw-font` / `--dsw-font-mono` names to the live stacks, so the sidebar file preview/editor no longer stays on the default monospace font.
- **Terminal font**: it uses the official `terminalFontFamily` / `--dsh-font-family-terminal` and applies to the sidebar terminal; the `$ dsh --version` preview is rendered with the selected terminal font.
- **Back to default**: System default (or Reset) clears all three lists and restores the built-in Harness stacks; an empty list writes no override.
- **Local names only**: the plugin reads font names, never uploads font files and bundles no fonts.

### Browsing and local wallpapers

- **Paged browsing**: 24 images per museum art page, while 10wallpaper uses 12 for lists/search and 20 for categories. Wikimedia Commons pages continuously, Cleveland shows the total count, and Bing daily has 2 pages. Changing the source, the preset or the query returns to page 1.
- **Wallpaper sites tab**: separate from Museum art and currently fronted by 10wallpaper, with category chips and keyword search.
- **8 art presets**: Van Gogh, Monet, Impressionism, Chinese landscape, Ukiyo-e, Renaissance, Vermeer and Klimt on a single row; any artist, work or movement can also be typed in directly.
- **Local wallpapers** (the default tab): the list is the on-disk library — downloads and uploads alike — capped at 20 entries, ordered by recent use, and a click switches straight back. Rows whose file is gone (deleted by hand, pushed out or cache-cleared) are dropped on the next read, and images already on disk without a row are added back automatically.

### Cache and persistence

- **Local cache**: applied images are stored under `assets/` and still display offline; when the upstream fails, the last successful list is replayed and *The Starry Night* remains as the built-in fallback row.
- **Thumbnail cache**: list thumbnails land in `thumbs/`, so the second visit and every restart paint instantly; grid tiles ask for 500px and fall back to the original list URL when that width is refused.
- **Cache management**: shows entry counts and disk usage for local wallpapers, thumbnails and list snapshots, clears them separately, or clears everything (the button becomes "Confirm clear" once, executes on the second click, and cancels when you click elsewhere). Clearing always keeps the current wallpaper and every setting.
- **Rotate daily**: when on, each Harness launch pins that day's Bing image and caches it locally.
- **Settings persist in the host**: port changes and browser switches lose nothing.

## Installation

The plugin is an npm bundle: once it is installed into a DSH profile, its configuration layer and client components come online together. The first install or enable needs one full Harness restart; after that, code changes reload without a restart — see Development.

`--profile desktop` is the desktop app; the Web / CLI editions usually use `web`. Without a global `dsh` command, run `npx @deepseek-ai/dsh` instead, for example:

```bash
npx @deepseek-ai/dsh plugin --profile desktop add dsh-lightweight-wallpaper
```

### From the command line

Pick any of the three sources; the result is the same — only where the package comes from and whether it needs a build approval differ.

#### npm package (recommended)

```bash
dsh plugin --profile desktop add dsh-lightweight-wallpaper
```

Pin a version or upgrade:

```bash
dsh plugin --profile desktop add dsh-lightweight-wallpaper@0.1.2    # pin
dsh plugin --profile desktop add dsh-lightweight-wallpaper@latest   # upgrade
```

What the registry ships is already runnable source (plain ESM, zero runtime dependencies, no build step) with no install-time scripts, so pnpm never blocks it and **no `allowBuilds` approval is needed**.

#### GitHub source

```bash
dsh plugin --profile desktop add github:KHWLGH/dsh-lightweight-wallpaper
dsh plugin --profile desktop add github:KHWLGH/dsh-lightweight-wallpaper#<commit>   # pin
```

A Git install fetches the source tree rather than a built artifact, which normally means a `prepare` build plus a pnpm approval; this plugin has neither a build step nor a `prepare` script, so both are skipped. The trade-off is that npm does not resolve its versions — re-run `add` to update.

#### Local directory or tarball

```bash
dsh plugin --profile desktop add "<absolute path to this directory>"   # while editing code
npm pack                                                              # offline / intranet: pack first
dsh plugin --profile desktop add ./dsh-lightweight-wallpaper-0.1.2.tgz
```

A tarball is a prebuilt archive, so it needs no build approval either; check the sha256 first when the file came from an unofficial channel.

### Plugin Manager (graphical)

When only the desktop app is at hand and you would rather not open a terminal: **Plugins** in the sidebar → **Add plugin** in the top right → paste the npm package name `dsh-lightweight-wallpaper`, the repository URL `https://github.com/KHWLGH/dsh-lightweight-wallpaper`, or an absolute local path → **Install**, then **Enable now** if it offers it. It resolves the source and version behind that spec and shows them before installing.

### Remove and upgrade

Removal is the same whatever the source:

```bash
dsh plugin --profile desktop remove dsh-lightweight-wallpaper
```

| Source | Upgrade |
|---|---|
| npm package | `dsh plugin --profile desktop add dsh-lightweight-wallpaper@latest` |
| GitHub source | `add` again (latest commit on the default branch), or remove and add a pinned commit |
| Local / tarball | remove, then `add` the new path |

## Usage

Settings → **Wallpaper & fonts**. The page has four groups:

- **Wallpaper**: master switch, current wallpaper, choose a wallpaper (local / Bing daily / museum art / wallpaper sites / upload).
- **Display**: display controls (with Self-check and Reset to recommended at the bottom), glass, rotate daily.
- **Fonts**: interface font, code font and terminal font, from the system list; System default restores the built-in stacks.
- **Data**: cache usage and clearing.

Every control saves automatically; clicking any thumbnail applies it.

## Defaults

| Setting | Default | Notes |
|---|---|---|
| Fill mode | Cover | Contain is also available |
| Window scrim | 62% | Base scrim over the whole window; lower values reveal more wallpaper (30–100%) |
| Dim | 18% | A dark layer over the wallpaper that protects body-text contrast |
| Wallpaper blur | 0 | 0–24px |
| Glass | On | Composer card + New session button |
| Glass opacity | 55% | 0–100%, shared by both surfaces; 0% is fully transparent |
| Glass blur | 24px | 0–40px, shared by both surfaces |
| Interface font | System default | Follows the built-in Harness stack; any installed family can be chosen |
| Code font | System default | Code blocks, inline code and the file preview/editor |
| Terminal font | System default | The sidebar terminal |
| Light-mode contrast boost | On | Secondary greys step to the 800 / 750 / 700 scale |

## Data and cache

Everything lives under `$DSH_HOME/lightweight-wallpaper/`:

```text
├── state.json            current wallpaper and settings
├── history.json          local wallpaper list (up to 20, downloads and uploads)
├── assets/<sha1>.<ext>   applied images (up to 20, deduplicated by content hash)
├── thumbs/<sha1>.img     list thumbnails (7-day TTL, at most 240 files / 48MB)
├── art-cache.json        last successful art lists (by source, query and page, up to 16 entries)
├── bing-<mkt>-<idx>.json last successful Bing list (fallback when the API fails)
└── selfcheck.json        the latest self-check report (from Self-check, or written on boot)
```

The browser `localStorage` only keeps a first-paint snapshot; it is never the source of truth. List caches are served directly for 30 minutes; after that the host asks the upstream again, and replays the previous successful result (flagged as stale) when that request fails.

Font choices are not stored in `state.json`: the official `ui-theme` settings (`textFontFamily` / `codeFontFamily` / `terminalFontFamily`) hold them, which is the same value as Settings → General → More font settings. Uninstalling the plugin leaves the font settings in place.

## Sources and licenses

| Source | Endpoint | License | Notes |
|---|---|---|---|
| Bing daily | `HPImageArchive.aspx` | Microsoft limits it to wallpaper use | No download or export button |
| Wikimedia Commons | `commons.wikimedia.org/w/api.php` | Public domain / CC, per item | JPEG / PNG only, at least 1200 × 800; uses the 500 / 960 / 1280 / 1920 thumbnails, never the original |
| Cleveland | `openaccess-api.clevelandart.org` | **CC0** | Only items with `share_license_status = CC0` |
| 10wallpaper | in-site HTML (no API) | Copyright remains with the original authors, not verified per item | Images are collected from the internet; personal use only, no commercial use; downloads 3840×2160 |

Thumbnails show the author and the license; after applying, the source and copyright stay at the top of the settings page.

## Self-check and troubleshooting

Settings → Wallpaper & fonts → **Self-check** at the bottom of Display writes the computed styles of the wallpaper layer, the scrim layer and the official containers (frame, sidebar, content column, input area, New session button), the composer glass `::before` layer, the font variables, the glass and contrast state, theme consistency, the list of opaque surfaces and the element stacks under the mouse into `selfcheck.json`; the page also writes one automatically on every boot. When the wallpaper is invisible, a white edge appears, the glass does nothing or the code font does not follow, check these first:

- `--dsw-alias-bg-base` and `--dsw-specific-sidebar-fill` should be `rgba(0,0,0,0)`; `html::after` is the only base scrim and `html::before` points its `background-image` at the local asset.
- `scheme.paint`, `scheme.service` and `scheme.colorScheme` should match `scheme.bodyDark`; with a wallpaper active, `scrim.matches` and `glassTint.matches` should be `true`.
- In the light theme with the contrast switch on, `glassVariables` should report `#353638` / `#43454a` / `#61666b` for `labelSecondary` / `labelTertiary` / `labelCaption`, and `menuSurfaceFill` should be `#f8f9faf0` (light) or `#33343af0` (dark).
- With glass on, `composerCard.card.backdropFilter` should be `none`, `composerCard.isolation` should be `isolate`, and `composerCard.layer.backdropFilter` should contain `blur` with `zIndex` `-1` and the card's `borderRadius`; `attributes.lwwBlur` should be `false` when the wallpaper blur is 0.
- `fonts.writeSupported` should be `true`; `fonts.text` / `fonts.code` / `fonts.terminal` are the official family lists, while `fonts.legacyUi` / `fonts.legacyMono` should resolve to the current interface and code stacks (including the `sans-serif` / `ui-monospace` fallbacks).
- `navIcon.matched` and `navIcon.decorated` being `true` means the navigation icon decoration applied; any unexpected entry in `opaqueSurfaces` is where a white block comes from.
- When `rightPanel.presentation` is `fullscreen` and `rightPanel.open` is `true`, `rightPanel.centerColVisibility` (and `elements.centerCol.visibility`) should be `hidden` — that is the test for "the conversation shows through a fullscreen right panel"; they should be `visible` in the `push` presentation or with the panel closed.

## Known limitations

### Window and shell

- The native Windows title bar (about 40px) is drawn by the Electron shell; page CSS cannot cover it, so it stays solid.
- The settings panel is fixed at 800px wide (a ~564px content column), so the plugin page uses a single-column layout.
- A few official controls with hard-coded colours do not let the wallpaper through; the settings dialog itself stays solid (on purpose).

### Style dependencies and readability trade-offs

- The glass depends on the official CSS-module class suffixes (`_composerSeat`, `_card`, `_newSession`, and so on); after a major DSH version changes them, update the selectors using the self-check report.
- The fullscreen-right-panel rule depends on the official `data-sidebar-right-panel` / `data-sidebar-right-open` attributes and the `_centerCol` / `_frame` class suffixes; after a DSH rename the rule stops matching and only restores the bleed-through — it never hides unrelated content — so update the selectors from the self-check report.
- The composer glass material sits on `_card::before`, while the card itself stays transparent; this keeps the send button's hover repaint from re-rasterizing the backdrop-filter. If the official card ever gains its own `::before`, the selector needs adjusting.
- When `backdrop-filter` is disabled, the glass keeps its tint but loses the background blur; readability is unaffected.
- Font enumeration depends on the browser's Local Font Access API; when access is denied, the browser lacks it or DSH disables it, only the built-in common list and manual family names are available.
- The code font reaches official components through `--ds-font-family-code` and the legacy `--dsw-font` / `--dsw-font-mono` mapping; the terminal font uses `--dsh-font-family-terminal`. If an official component switches to an inline `font-family`, it needs a follow-up.
- The light-mode contrast boost also darkens secondary greys inside popovers and cards, because the official tokens are global; turn the switch off if that is not what you want.

### Upstream APIs and upload formats

- Uploads accept JPEG / PNG / WebP only; files over 6MB are downscaled to a 2560px longest edge in the browser first.
- Wikimedia Commons occasionally answers 429 or times out; the list then shows the last successful result, and very deep pages drift slightly with the upstream index.
- 10wallpaper relies on in-site HTML, so a redesign can break its parser; its copyright belongs to the original authors and is not verified per item.
- Wikimedia Commons only accepts its standard thumbnail widths (20 / 40 / 60 / 120 / 250 / 330 / 500 / 960 / 1280 / 1920 / 3840) and answers `400` for anything else; the plugin snaps grid tiles to the nearest step (480 → 500px) and falls back to the original URL if that still fails.

## Development (no restart)

Code changes do not need a Harness restart:

| Change | How it applies |
| --- | --- |
| `src/client.js` | Official Client HMR: about a second after saving, the bundle reloads inside the page (`/plugins/events` SSE compares file mtime and size every 500ms), with the settings page left open |
| `src/impl.js`, `src/sources.js` | The host entry `src/index.js` is a stable shim: it compares these two files every 800ms and, when they change, `import('./impl.js?rev=…')` starts a new generation and disposes the old one — the new code takes over in about a second |
| `src/index.js` (the shim itself), `package.json`, the meta in `locale/*.json`, `cordis.patch.yml` | Registration layer — still needs one restart |

```bash
npm run dev     # = node tools/dev.mjs: node --check plus the matching test on save; fix red first
npm run check   # run host-smoke + client-contract by hand
```

`src/impl.js` imports `sources.js` with the same `?rev=`, so editing `sources.js` hot-reloads too; when a host reload fails, the previous generation keeps serving and only a warning is logged.

User-visible changes go to the top of [`CHANGELOG.md`](CHANGELOG.md); the version number follows `package.json`.

## Verification

```bash
node --check src/index.js && node --check src/impl.js && node --check src/client.js
node tools/host-smoke.mjs        # 42 checks: host routes / cache / history (20 + backfill) / thumbnails / 10wallpaper parser / entry shim and reload lifecycle
node tools/client-contract.mjs   # 15 checks: module envelope, registration contract, presets and pager, fonts and glass layer, cards and layout, local list
node tools/probe-sources.mjs     # upstream connectivity probe (network required)
node tools/dev.mjs               # dev loop: syntax gate on save plus the matching test
```

## Implementation

- **A single base scrim**: every official container token (`--dsw-alias-bg-base`, `--dsw-specific-sidebar-fill`) is set transparent, and the plugin paints both the wallpaper and the scrim itself.
- **The fullscreen right panel stands the conversation aside**: the official panel has no surface of its own and uses `--dsw-alias-bg-base` as the page; that token is transparent here, so while the panel is open in the fullscreen presentation `:has([data-sidebar-right-panel="fullscreen"][data-sidebar-right-open])` sets `visibility:hidden` on `_centerCol` (no layout change, no unmount, and the wallpaper becomes the page behind the panel). It comes back at once when the panel returns to the docked presentation (`[data-sidebar-right-panel="push"]`) and after the `--ds-transition-duration-slow` slide when the panel closes; reduced motion skips that wait. Shells where the fullscreen panel spans the whole frame also get `_sidebarCol`, while an open drawer paints above the panel and is left alone.
- **Glass on exactly two surfaces**: the composer card's `_card::before` glass layer and `[class*="_newSession"]`; the card itself stays transparent and isolated, so the send button's hover repaint does not re-rasterize the backdrop-filter, and global tokens such as `--dsw-specific-input-major` are left alone.
- **Fonts are written through the official settings**: `ctx.theme.setFontFamily` updates `ui-theme` for the interface, code and terminal roles; the legacy `--dsw-font` / `--dsw-font-mono` names map to the official variables so the editor and code blocks share one code font, while the terminal follows `--dsh-font-family-terminal`.
- **Theme colours come from the service snapshot**: the scrim colour `--lww-floor` comes from the `theme/change` payload (falling back to `ctx.theme.getTheme()`); the glass tint `--lww-scrim-rgb` is decided by CSS from `body[data-ds-dark-theme]`, with a `MutationObserver` as a safety net.
- **Contrast uses the official scale variables**: in the light theme `label-secondary` 700 → 800, `label-tertiary` 600 → 750 and `label-caption` 400 → 700, and the switch can turn it all off.

The host and the browser talk over a same-origin API under `/api/lightweight-wallpaper`:

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/state` | Read or write the current wallpaper and settings |
| GET | `/bing?mkt&n&page` | Bing daily list (paged by region) |
| GET | `/art?source&q&cat&limit&page` | Paged museum search (Wikimedia / Cleveland) or 10wallpaper's gallery |
| POST | `/pin` | Download and cache one image |
| POST | `/upload` | Upload raw image bytes |
| GET | `/asset/<sha1>.<ext>` | Serve a cached local image |
| GET | `/proxy?u&w` | Same-origin image proxy that snaps thumbnail widths to the official steps |
| GET | `/history` | Local wallpaper list |
| GET | `/cache` and POST `/cache/clear` | Cache statistics and clearing |
| GET | `/health` | Cache health check |

Non-GET requests must carry an `x-dsh-plugin: lightweight-wallpaper` header: a cross-site form cannot set it, and the server answers no CORS preflight.

## Project layout

```text
src/index.js     host entry shim: keeps the registration layer stable, watches the two files below and hot-reloads the host half
src/impl.js      host: same-origin routes, paging parameters, history, cache stats and clearing, upstream / list / thumbnail caches, image proxy, state persistence
src/sources.js   pure functions: URL builders for every upstream source (with paging), paging metadata, thumbnail widths, response normalization
src/client.js    client: wallpaper layer + window scrim + glass, system font pickers, the settings page (local wallpapers / fonts / cache manager) and the self-check
tools/           smoke tests, contract checks, a connectivity probe and the dev loop (development only, not part of the running plugin)
```

## License

MIT. Wallpapers remain the property of their sources; this plugin only displays and caches them locally.
