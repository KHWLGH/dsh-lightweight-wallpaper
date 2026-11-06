/**
 * dsh-lightweight-wallpaper — Client half.
 *
 * One `settings.section` page plus a paint-only visual layer:
 *   - the wallpaper is painted by `html::before` (fixed, z-index:-1) so it sits
 *     behind the app frame without touching any official DOM node;
 *   - punch-through is expressed through the official theme service
 *     (`ctx.theme.overrideTokens`): the official base/sidebar tokens become
 *     transparent and one theme-aware scrim (`html::after`) is the only mask;
 *   - cards and settings surfaces keep their opaque layer tokens for readable
 *     text, which is what keeps this plugin small.
 *
 * No browser network calls to upstreams: everything goes through the Host half.
 */
window.__ModuleLoader__.load({
  id: 'dsh-lightweight-wallpaper',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PREFIX = '/api/lightweight-wallpaper'
    const PLUGIN_ID = 'lightweight-wallpaper'
    const PLUGIN_HEADER = 'x-dsh-plugin'
    const NS = 'lightweight-wallpaper'
    const PAINT_CACHE = 'dsh-lightweight-wallpaper.paint.v1'

    const DEFAULT_STATE = {
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
    }

    /** Same numbers as the Host default, exposed for the one-click reset. */
    const EFFECT_DEFAULTS = {
      fit: 'cover',
      dim: 18,
      blur: 0,
      opacity: 62,
      panelEnabled: true,
      panelAlpha: 55,
      panelBlur: 24,
      contrastEnabled: true,
    }

    function clampInt(value, min, max, fallback) {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(Math.max(Math.round(number), min), max)
    }

    /** Percent slider (0–100) to a CSS alpha with a stable three-decimal form. */
    function alphaValue(percent) {
      const value = (Number(percent) || 0) / 100
      return Math.min(1, Math.max(0, value)).toFixed(3)
    }

    /** Human cache size: integer bytes, then one decimal for KB and MB. */
    function formatBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes < 1024) return `${Math.round(bytes)} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /* ------------------------------------------------------------------ */
    /* Font families                                                      */
    /* ------------------------------------------------------------------ */

    /** CSS generic families stay unquoted in a font-family list. */
    const GENERIC_FONTS = new Set([
      'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
      'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math',
      'fangsong', '-apple-system', 'blinkmacsystemfont',
    ])

    /** Fallback rows when the Local Font Access API is unavailable or denied. */
    const COMMON_UI_FONTS = [
      'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB',
      'Noto Sans CJK SC', 'Source Han Sans SC', 'SimSun', 'SimHei',
      'DengXian', 'Segoe UI Variable', 'Helvetica Neue', 'Arial',
      'Inter', 'Roboto',
    ]
    const COMMON_CODE_FONTS = [
      'Cascadia Code', 'Consolas', 'JetBrains Mono', 'Fira Code',
      'Source Code Pro', 'SF Mono', 'Menlo', 'Courier New',
      'Sarasa Mono SC', 'LXGW WenKai Mono', 'Maple Mono', 'IBM Plex Mono',
      'Microsoft YaHei', 'PingFang SC',
    ]

    /** One session cache; a denied prompt is not repeated on every open. */
    let fontListCache = null
    let fontListPromise = null

    function cleanFontName(value) {
      return String(value || '')
        .replace(/["'\\<>\u0000-\u001f\u007f]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
    }

    function cssFontName(name) {
      const clean = cleanFontName(name)
      if (!clean) return ''
      return GENERIC_FONTS.has(clean.toLowerCase()) ? clean : `"${clean}"`
    }

    /** A custom entry may be a comma-separated list; preview it as CSS too. */
    function cssFontList(value) {
      return String(value || '')
        .split(',')
        .map(cleanFontName)
        .filter(Boolean)
        .map(cssFontName)
        .join(', ')
    }

    /** First family of a normalized list, for the trigger label. */
    function fontLabel(value, fallback) {
      const names = String(value || '')
        .split(',')
        .map(cleanFontName)
        .filter(Boolean)
      return names.length ? names[0] : fallback
    }

    function firstFontName(value) {
      return fontLabel(value, '').toLowerCase()
    }

    /** Dedupe, keeping the current family first so it is always visible. */
    function mergeFonts(fonts, current) {
      const out = []
      const seen = new Set()
      const add = (name) => {
        const clean = cleanFontName(name)
        if (!clean) return
        const key = clean.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        out.push(clean)
      }
      for (const name of String(current || '').split(',')) add(name)
      for (const font of Array.isArray(fonts) ? fonts : []) add(font)
      return out
    }

    function commonFonts() {
      return mergeFonts([...COMMON_UI_FONTS, ...COMMON_CODE_FONTS]).sort((a, b) => a.localeCompare(b))
    }

    function resetFontListCache() {
      fontListCache = null
      fontListPromise = null
    }

    /**
     * Read the machine's font families through Chromium's Local Font Access
     * API. Called from a click so the permission prompt has a user gesture.
     * A timeout keeps a silently blocked prompt from wedging the picker; any
     * failure falls back to the common list and the custom-name entry.
     */
    async function fetchSystemFonts() {
      if (fontListCache) return fontListCache
      if (fontListPromise) return fontListPromise
      fontListPromise = (async () => {
        let names = []
        let error = ''
        let apiFailed = null
        try {
          if (typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function') {
            let timer = 0
            const timeout = new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), 8000)
            })
            const api = Promise.resolve()
              .then(() => window.queryLocalFonts())
              .catch((err) => {
                apiFailed = err
                return null
              })
            let fonts = null
            try {
              fonts = await Promise.race([api, timeout])
            } finally {
              clearTimeout(timer)
            }
            if (apiFailed) throw apiFailed
            if (Array.isArray(fonts) && fonts.length) {
              names = fonts.map((font) => (font && font.family ? font.family : '')).filter(Boolean)
            } else if (fonts === null) {
              error = 'timeout'
            } else {
              error = 'empty'
            }
          } else {
            error = 'unavailable'
          }
        } catch (err) {
          error = 'denied'
          console.warn('[lightweight-wallpaper] could not read system fonts', err)
        }
        const source = names.length ? 'system' : 'fallback'
        fontListCache = {
          fonts: names.length
            ? mergeFonts(names).sort((a, b) => a.localeCompare(b))
            : commonFonts(),
          source,
          error,
        }
        fontListPromise = null
        return fontListCache
      })()
      return fontListPromise
    }

    /** Language tag used for the relative timestamps of the recent list. */
    function localeTag() {
      try {
        const lang = document.documentElement && document.documentElement.lang
        if (lang) return lang
      } catch {
        /* non-browser context */
      }
      try {
        if (typeof navigator !== 'undefined' && navigator && navigator.language) return navigator.language
      } catch {
        /* no navigator */
      }
      return 'en'
    }

    /**
     * "3 minutes ago" / "3 分钟前" for one history entry. Intl ships with the
     * browser; without it the absolute date is still a usable fallback.
     */
    function relativeTime(value) {
      const stamp = Date.parse(value)
      if (!Number.isFinite(stamp)) return ''
      const delta = stamp - Date.now()
      const steps = [
        ['year', 365 * 24 * 60 * 60 * 1000],
        ['month', 30 * 24 * 60 * 60 * 1000],
        ['day', 24 * 60 * 60 * 1000],
        ['hour', 60 * 60 * 1000],
        ['minute', 60 * 1000],
      ]
      try {
        const formatter = new Intl.RelativeTimeFormat(localeTag(), { numeric: 'auto' })
        for (const [unit, size] of steps) {
          if (Math.abs(delta) >= size) return formatter.format(Math.round(delta / size), unit)
        }
        return formatter.format(0, 'second')
      } catch {
        return new Date(stamp).toLocaleDateString()
      }
    }

    /**
     * Colour scheme carried by one theme snapshot. `ThemeSnapshot.active`
     * always resolves `system` upstream, so this is the scheme that is really
     * on screen.
     */
    function schemeOf(snapshot) {
      const value = snapshot && snapshot.active && snapshot.active.colorScheme
      return value === 'dark' || value === 'light' ? value : ''
    }

    /**
     * Scheme the paint must use. The theme service owns it — the change
     * payload first, then `getTheme()` — because the `data-ds-dark-theme`
     * attribute on body is written by another plugin's presenter: reading it
     * makes every repaint depend on listener order and leaves the scrim one
     * theme behind on the switch. The attribute stays a last resort only.
     */
    function resolvedScheme(theme, snapshot) {
      const fromEvent = schemeOf(snapshot)
      if (fromEvent) return fromEvent
      try {
        const service = theme && typeof theme.getTheme === 'function' ? theme.getTheme() : null
        const fromService = schemeOf(service)
        if (fromService) return fromService
      } catch {
        /* service unavailable — fall through to the palette attribute */
      }
      return document.body && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
    }

    /** Merge a cached or host payload onto the defaults without losing new fields. */
    function hydrateState(raw) {
      const next = { ...DEFAULT_STATE, ...(raw && typeof raw === 'object' ? raw : {}) }
      next.panelEnabled = next.panelEnabled !== false
      next.panelAlpha = clampInt(next.panelAlpha, 0, 100, DEFAULT_STATE.panelAlpha)
      next.panelBlur = clampInt(next.panelBlur, 0, 40, DEFAULT_STATE.panelBlur)
      next.contrastEnabled = next.contrastEnabled !== false
      return next
    }

    const MARKETS = [
      ['zh-CN', '中文'],
      ['en-US', 'English (US)'],
      ['ja-JP', '日本語'],
      ['en-GB', 'English (UK)'],
    ]

    /**
     * Art search presets. Kept to eight: a painter or a movement each, so the
     * chip row stays short while every entry still runs on both sources.
     */
    const PRESETS = [
      { id: 'vanGogh', label: 'preset.vanGogh', query: 'Vincent van Gogh paintings' },
      { id: 'monet', label: 'preset.monet', query: 'Claude Monet paintings' },
      { id: 'impressionism', label: 'preset.impressionism', query: 'Impressionism painting' },
      { id: 'landscape', label: 'preset.landscape', query: 'Chinese landscape painting' },
      { id: 'ukiyoe', label: 'preset.ukiyoe', query: 'Ukiyo-e woodblock print' },
      { id: 'renaissance', label: 'preset.renaissance', query: 'Renaissance painting' },
      { id: 'vermeer', label: 'preset.vermeer', query: 'Johannes Vermeer painting' },
      { id: 'klimt', label: 'preset.klimt', query: 'Gustav Klimt painting' },
    ]

    /**
     * 10wallpaper's chip row: one entry per fixed category page. `cat` is the
     * upstream URL slug; an empty value means the global newest list.
     */
    const TENWALLPAPER_PRESETS = [
      { id: 'tenwallpaper-landscape', label: 'site.tenwallpaper.landscape', cat: 'Landscape' },
      { id: 'tenwallpaper-latest', label: 'site.tenwallpaper.latest', cat: '' },
      { id: 'tenwallpaper-game', label: 'site.tenwallpaper.game', cat: 'Game' },
      { id: 'tenwallpaper-city', label: 'site.tenwallpaper.city', cat: 'City' },
      { id: 'tenwallpaper-space', label: 'site.tenwallpaper.space', cat: 'Space' },
      { id: 'tenwallpaper-animal', label: 'site.tenwallpaper.animal', cat: 'Animal' },
      { id: 'tenwallpaper-design', label: 'site.tenwallpaper.design', cat: 'Design' },
    ]

    const DICTS = {
      zh: {
        'nav.title': '壁纸与字体',
        'page.title': '壁纸、字体与背景',
        'enable': '启用壁纸',
        'group.wallpaper': '壁纸',
        'group.display': '显示',
        'group.data': '数据',
        'group.fonts': '字体',
        'font.title': '界面、代码与终端字体',
        'font.ui': '界面字体',
        'font.code': '代码字体',
        'font.terminal': '终端字体',
        'font.default': '系统默认',
        'font.reset': '恢复默认',
        'font.preview': '预览',
        'font.previewUi': '界面字体预览 Aa 字体',
        'font.previewCode': 'const code = 1',
        'font.previewTerminal': '$ dsh --version',
        'font.sample': 'Aa 永',
        'font.systemSource': '系统字体',
        'font.fallbackSource': '常见字体',
        'font.noMatch': '没有匹配的字体，按 Enter 使用输入值。',
        'font.clearSearch': '清除搜索',
        'font.search': '搜索字体…',
        'font.loading': '正在读取系统字体…',
        'font.fallback': '当前环境无法列出系统字体：可从常见字体中选择，或直接输入字体名。',
        'font.denied': '没有获得字体访问权限：可从常见字体中选择，或直接输入字体名。',
        'font.custom': '使用「{name}」',
        'font.current': '当前',
        'font.unavailable': '当前 DSH 版本不支持从插件写入字体，请在 设置 → 通用 → 更多字体设置 中修改。',
        'font.note': '字体列表来自本机，不会上传；选择写入 DSH 的 ui-theme 设置，与「设置 → 通用 → 更多字体设置」同步。',
        'font.loadFailed': '读取系统字体失败：{message}',
        'font.retry': '重新读取',
        'font.bothDefault': '界面、代码和终端字体已恢复默认。',
        'source.title': '选择壁纸',
        'source.bing': '必应每日',
        'source.art': '艺术馆藏',
        'source.sites': '壁纸站',
        'source.custom': '上传',
        'bing.market': '地区',
        'bing.refresh': '刷新',
        'bing.note': '必应每日图提供最近 16 天，每页 8 张，最多 2 页；图片仅限个人壁纸用途。',
        'art.wikimedia': '维基共享（公共领域）',
        'art.cleveland': '克利夫兰（CC0）',
        'art.search': '搜索画家、作品或流派…',
        'art.searchBtn': '搜索',
        'site.search': '搜索 10wallpaper 关键词…',
        'site.note.tenwallpaper': '10wallpaper 的图片收集自互联网，版权归原作者；仅供个人使用，请勿商用。默认取 4K（3840×2160）。',
        'site.tenwallpaper.latest': '最新',
        'site.tenwallpaper.landscape': '风景',
        'site.tenwallpaper.game': '游戏',
        'site.tenwallpaper.city': '城市',
        'site.tenwallpaper.space': '太空',
        'site.tenwallpaper.animal': '动物',
        'site.tenwallpaper.design': '设计',
        'custom.pick': '选择图片',
        'custom.hint': '支持 JPEG / PNG / WebP，超过 6MB 会先压到最长边 2560 再上传。',
        'custom.current': '当前自定义图片',
        'effect.title': '显示效果',
        'effect.fit': '填充方式',
        'effect.fit.cover': '铺满',
        'effect.fit.contain': '适应',
        'effect.dim': '压暗',
        'effect.blur': '壁纸模糊',
        'effect.opacity': '整窗遮罩',
        'effect.reset': '恢复推荐值',
        'effect.selfcheck': '自检',
        'panel.title': '毛玻璃与透明',
        'panel.desc': '只给输入框卡片和侧栏「新会话」按钮上毛玻璃；顶部、底部状态栏与两侧都不覆盖。',
        'panel.enable': '启用毛玻璃',
        'panel.alpha': '毛玻璃透明度',
        'panel.blur': '毛玻璃模糊',
        'panel.off': '毛玻璃已关闭：输入框与「新会话」按钮恢复实心。',
        'contrast.title': '浅色模式增强文字对比',
        'contrast.hint': '没有毛玻璃的地方（正文、侧栏、底部状态栏）把次要灰字加深一档，浅色主题下更清楚；深色主题不受影响。',
        'auto.title': '每日自动更换',
        'auto.desc': '开启后，每次打开 Harness 会取当天的必应每日图并缓存到本地。',
        'current.title': '当前壁纸',
        'current.none': '还没有选择壁纸',
        'current.by': '作者 / 版权',
        'current.source': '来源',
        'source.name.bing': '必应每日',
        'source.name.wikimedia': '维基共享',
        'source.name.cleveland': '克利夫兰',
        'source.name.tenwallpaper': '10wallpaper',
        'source.name.upload': '本地上传',
        'source.name.local': '本地',
        'loading': '加载中…',
        'retry': '重试',
        'empty': '这一页暂时没有可用的图片。',
        'stale': '上游临时不可用，显示的是上次成功的结果。',
        'offline': '宿主接口暂不可用，当前用的是本机缓存。',
        'preset.vanGogh': '梵高',
        'preset.monet': '莫奈',
        'preset.impressionism': '印象派',
        'preset.landscape': '中国山水',
        'preset.ukiyoe': '浮世绘',
        'preset.renaissance': '文艺复兴',
        'preset.vermeer': '维米尔',
        'preset.klimt': '克林姆特',
        'pager.prev': '上一页',
        'pager.next': '下一页',
        'pager.page': '第 {n} 页',
        'pager.total': '共 {n} 张',
        'pager.end': '没有更多了',
        'error.pick': '应用这张图失败',
        'error.upload': '上传失败',
        'busy.pin': '正在下载并缓存…',
        'busy.upload': '正在处理图片…',
        'history.title': '本地壁纸',
        'history.hint': '已下载和上传的壁纸都在本地（最多 20 张），按最近使用排序；点一下直接切回，当前这张会高亮。',
        'history.empty': '本地还没有壁纸。',
        'history.current': '当前',
        'cache.title': '缓存',
        'cache.hint': '本地壁纸、缩略图和列表快照都存在磁盘上；清理不会删除当前壁纸。',
        'cache.assets': '本地壁纸',
        'cache.thumbs': '缩略图缓存',
        'cache.lists': '列表缓存',
        'cache.clear': '清理',
        'cache.clearAssets': '清理旧壁纸',
        'cache.clearAll': '全部清理',
        'cache.confirm': '确认清理',
        'cache.freed': '已释放 {size}',
        'cache.never': '暂无缓存',
      },
      en: {
        'nav.title': 'Wallpaper & fonts',
        'page.title': 'Wallpaper, fonts & background',
        'enable': 'Enable wallpaper',
        'group.wallpaper': 'Wallpaper',
        'group.display': 'Display',
        'group.data': 'Data',
        'group.fonts': 'Fonts',
        'font.title': 'Interface, code & terminal fonts',
        'font.ui': 'Interface font',
        'font.code': 'Code font',
        'font.terminal': 'Terminal font',
        'font.default': 'System default',
        'font.reset': 'Reset',
        'font.preview': 'Preview',
        'font.previewUi': 'Interface font preview Aa',
        'font.previewCode': 'const code = 1',
        'font.previewTerminal': '$ dsh --version',
        'font.sample': 'Aa Aa',
        'font.systemSource': 'System fonts',
        'font.fallbackSource': 'Common fonts',
        'font.noMatch': 'No matching font — press Enter to use the typed name.',
        'font.clearSearch': 'Clear search',
        'font.search': 'Search fonts…',
        'font.loading': 'Reading system fonts…',
        'font.fallback': 'This environment cannot list system fonts. Pick a common font below or type a family name.',
        'font.denied': 'Font access was not granted. Pick a common font below or type a family name.',
        'font.custom': 'Use “{name}”',
        'font.current': 'Current',
        'font.unavailable': 'This DSH version does not expose font writes to plugins. Use Settings → General → More font settings instead.',
        'font.note': 'The font list stays on this machine and is never uploaded; choices are written to DSH’s ui-theme settings, in sync with Settings → General → More font settings.',
        'font.loadFailed': 'Could not read system fonts: {message}',
        'font.retry': 'Reload',
        'font.bothDefault': 'Interface, code and terminal fonts are back to defaults.',
        'source.title': 'Choose a wallpaper',
        'source.bing': 'Bing daily',
        'source.art': 'Museum art',
        'source.sites': 'Wallpaper sites',
        'source.custom': 'Upload',
        'bing.market': 'Region',
        'bing.refresh': 'Refresh',
        'bing.note': 'Bing serves the last 16 days, 8 images per page, up to 2 pages. Images are for personal wallpaper use only.',
        'art.wikimedia': 'Wikimedia Commons (public domain)',
        'art.cleveland': 'Cleveland Museum (CC0)',
        'art.search': 'Search an artist, work or movement…',
        'art.searchBtn': 'Search',
        'site.search': 'Search 10wallpaper…',
        'site.note.tenwallpaper': '10wallpaper collects images from the internet; copyright remains with the original authors. Personal use only, no commercial use. Default download is 4K (3840×2160).',
        'site.tenwallpaper.latest': 'Newest',
        'site.tenwallpaper.landscape': 'Landscape',
        'site.tenwallpaper.game': 'Game',
        'site.tenwallpaper.city': 'City',
        'site.tenwallpaper.space': 'Space',
        'site.tenwallpaper.animal': 'Animal',
        'site.tenwallpaper.design': 'Design',
        'custom.pick': 'Choose image',
        'custom.hint': 'JPEG / PNG / WebP. Files over 6MB are downscaled to 2560px before upload.',
        'custom.current': 'Current custom image',
        'effect.title': 'Display',
        'effect.fit': 'Fill mode',
        'effect.fit.cover': 'Cover',
        'effect.fit.contain': 'Contain',
        'effect.dim': 'Dim',
        'effect.blur': 'Wallpaper blur',
        'effect.opacity': 'Window scrim',
        'effect.reset': 'Reset to recommended',
        'effect.selfcheck': 'Self-check',
        'panel.title': 'Glass & transparency',
        'panel.desc': 'Only the composer card and the sidebar New session button get the glass; the header, the bottom status bar and both sides stay untouched.',
        'panel.enable': 'Enable glass',
        'panel.alpha': 'Glass opacity',
        'panel.blur': 'Glass blur',
        'panel.off': 'Glass is off: the composer and the New session button are solid again.',
        'contrast.title': 'Boost text contrast in light mode',
        'contrast.hint': 'Where there is no glass (transcript, sidebar, bottom status bar) the secondary greys step one shade darker so they read better in the light theme; the dark theme is untouched.',
        'auto.title': 'Rotate daily',
        'auto.desc': 'When on, each Harness launch pins that day’s Bing image and caches it locally.',
        'current.title': 'Current wallpaper',
        'current.none': 'No wallpaper selected yet',
        'current.by': 'Credit',
        'current.source': 'Source',
        'source.name.bing': 'Bing daily',
        'source.name.wikimedia': 'Wikimedia Commons',
        'source.name.cleveland': 'Cleveland Museum',
        'source.name.tenwallpaper': '10wallpaper',
        'source.name.upload': 'Upload',
        'source.name.local': 'Local',
        'loading': 'Loading…',
        'retry': 'Retry',
        'empty': 'No images are available on this page right now.',
        'stale': 'The upstream source is temporarily unavailable; showing the last successful result.',
        'offline': 'The host API is unavailable; using the local cache.',
        'preset.vanGogh': 'Van Gogh',
        'preset.monet': 'Monet',
        'preset.impressionism': 'Impressionism',
        'preset.landscape': 'Chinese landscape',
        'preset.ukiyoe': 'Ukiyo-e',
        'preset.renaissance': 'Renaissance',
        'preset.vermeer': 'Vermeer',
        'preset.klimt': 'Klimt',
        'pager.prev': 'Previous',
        'pager.next': 'Next',
        'pager.page': 'Page {n}',
        'pager.total': '{n} in total',
        'pager.end': 'No more results',
        'error.pick': 'Could not apply that image',
        'error.upload': 'Upload failed',
        'busy.pin': 'Downloading and caching…',
        'busy.upload': 'Processing image…',
        'history.title': 'Local wallpapers',
        'history.hint': 'Downloaded and uploaded wallpapers live on this machine (up to 20), newest first — click a tile to switch straight back. The current one is highlighted.',
        'history.empty': 'No local wallpapers yet.',
        'history.current': 'Current',
        'cache.title': 'Cache',
        'cache.hint': 'Local wallpapers, thumbnails and list snapshots are cached locally. Clearing never removes the current wallpaper.',
        'cache.assets': 'Local wallpapers',
        'cache.thumbs': 'Thumbnail cache',
        'cache.lists': 'List cache',
        'cache.clear': 'Clear',
        'cache.clearAssets': 'Clear old',
        'cache.clearAll': 'Clear everything',
        'cache.confirm': 'Confirm clear',
        'cache.freed': 'Freed {size}',
        'cache.never': 'Nothing cached',
      },
    }

    const CSS = `
      /* Official components still read the legacy --dsw-font / --dsw-font-mono
         names; the file-preview code body is one of them. Point both at the
         live text/code stacks so the font picker and the official font fields
         reach every code surface. Not gated on data-lww-active: fonts keep
         working when the wallpaper is off. */
      html body{
        --dsw-font:var(--dsw-font-family),sans-serif;
        --dsw-font-mono:var(--ds-font-family-code),ui-monospace,SFMono-Regular,Menlo,monospace}
      html[data-lww-active]::before{content:"";position:fixed;inset:-3rem;z-index:-1;pointer-events:none;
        background-image:linear-gradient(rgba(0,0,0,var(--lww-dim,0)),rgba(0,0,0,var(--lww-dim,0))),
          var(--lww-image,none);
        background-position:center;background-size:var(--lww-fit,cover);background-repeat:no-repeat}
      /* A full-screen blur(0px) still creates a filter/compositing layer; only
         pay for it when the slider is actually above zero. */
      html[data-lww-active][data-lww-blur]::before{filter:blur(var(--lww-blur,0px))}
      html[data-lww-active]::after{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
        background-color:var(--lww-floor,transparent)}
      html[data-lww-active] body{background-color:transparent!important}
      html[data-lww-active]{--dsh-windows-content-radius:0px}
      /* Every official large surface repaints the same tokens; stacked alpha
         fills both hide the wallpaper and create lighter seams (white edges on
         the sidebar and the composer). Force them transparent and keep exactly
         one base scrim: html::after. */
      html[data-lww-active] [class*="_frame"],
      html[data-lww-active] [class*="_frame"]::before,
      html[data-lww-active] [class*="_sidebarCol"],
      html[data-lww-active] [class*="_centerCol"],
      html[data-lww-active] [class*="_rightbarCol"],
      html[data-lww-active] [class*="_bottomRow"],
      html[data-lww-active] [class*="_quietBars"],
      html[data-lww-active] [class*="_root"][data-phase],
      html[data-lww-active] [class*="_embeddedBody"],
      html[data-lww-active] [class*="_composerSeat"]{
        background-color:transparent!important;background-image:none!important;
        border-radius:0!important;border-left:none!important;border-right:none!important}

      /* ==================================================================
         Fullscreen right Sidebar. DSH gives the panel the page colour
         (--dsw-alias-bg-base on its docked tab host) and keeps the wide-screen
         conversation column mounted underneath, so an opaque page hides the
         transcript, the composer and the status line by itself. We made that
         page transparent, so a fullscreen document, terminal or file tree
         became a window onto the conversation behind it. While that panel
         covers the frame the conversation column steps aside and the wallpaper
         is the page the panel was always transparent against. Leaving
         fullscreen keeps the panel open beside the conversation, so the column
         comes back at once; a closed panel comes back after its slide.
         ================================================================== */
      html[data-lww-active] [class*="_centerCol"]{
        transition:visibility 0s linear var(--ds-transition-duration-slow,.3s)}
      html[data-lww-active] [class*="_frame"]:has([data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]) [class*="_centerCol"]{
        visibility:hidden;transition-delay:0s}
      html[data-lww-active] [class*="_frame"]:has([data-sidebar-right-panel="push"][data-sidebar-right-open]) [class*="_centerCol"]{
        visibility:visible;transition-delay:0s}
      /* Only the Windows shell insets the fullscreen panel to the right of the
         docked sidebar. Everywhere else the panel spans the whole frame, so the
         sidebar needs the same treatment; an open drawer paints above the panel
         and is left alone. */
      html[data-lww-active]:not([data-windows-titlebar]) [class*="_frame"]:not([data-sidebar-drawer]):has([data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]) [class*="_sidebarCol"]{
        visibility:hidden}
      @media (prefers-reduced-motion:reduce){
        html[data-lww-active] [class*="_centerCol"]{transition:none}
      }

      /* Glass tint belongs to the palette attribute, not to a script: the
         composer card is a descendant of body, so it inherits the value and a
         theme switch repaints it even if no JavaScript runs at all. The
         rgba() rules below keep a light fallback for the window before the
         attribute exists. */
      html[data-lww-active] body{--lww-scrim-rgb:255,255,255}
      html[data-lww-active] body[data-ds-dark-theme]{--lww-scrim-rgb:21,21,23}

      /* ==================================================================
         Composer glass. ONE shared material (--lww-panel-a / --lww-panel-b)
         on ONE surface: the input card itself. The dock around it, the
         conversation header, the full-width bottom row and the sidebars are
         deliberately left alone, so no tint reaches the left/right sides.
         The material lives on a pseudo-element rather than the card: the
         card's send button has a background-color hover transition, and a
         backdrop-filter on the card itself makes Chromium re-rasterize the
         whole glass layer on that repaint (a visible flash). A dedicated
         negative-z layer inside an isolated stacking context is stable and
         still accepts the panel's border-radius. Selectors match the official
         CSS-module class suffixes (<hash>_localName); a build hash change
         keeps them working.
         ================================================================== */
      html[data-lww-glass] [class*="_composerSeat"] [class*="_card"],
      html[data-lww-glass] [class*="_composerHero"] [class*="_card"]{
        position:relative;isolation:isolate;
        background-color:transparent!important;
        -webkit-backdrop-filter:none!important;
        backdrop-filter:none!important}
      html[data-lww-glass] [class*="_composerSeat"] [class*="_card"]::before,
      html[data-lww-glass] [class*="_composerHero"] [class*="_card"]::before{
        content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;
        border-radius:inherit;
        background-color:rgba(var(--lww-scrim-rgb,255,255,255),var(--lww-panel-a,0));
        -webkit-backdrop-filter:blur(var(--lww-panel-b,0px)) saturate(1.06);
        backdrop-filter:blur(var(--lww-panel-b,0px)) saturate(1.06);
        transform:translateZ(0)}
      /* New session button: the same adjustable material (it is NOT hard-wired
         to transparent; 0% opacity makes it fully see-through). The :not()
         list skips its own label/content/shortcut/mask children. */
      html[data-lww-glass] [class*="_newSession"]:not([class*="Label"],[class*="Content"],[class*="Shortcut"],[class*="Mask"]){
        background-color:rgba(var(--lww-scrim-rgb,255,255,255),var(--lww-panel-a,0))!important;
        -webkit-backdrop-filter:blur(var(--lww-panel-b,0px)) saturate(1.06);
        backdrop-filter:blur(var(--lww-panel-b,0px)) saturate(1.06)}

      /* ==================================================================
         Light-mode text contrast. Where there is no glass the official light
         greys sit close to a veiled photo, so the three readable grey tiers
         each step two shades darker (secondary 700→800, tertiary 600→750,
         caption 400→700) — only while a wallpaper is active and the theme is
         light. Primary, dark theme and the no-wallpaper state are untouched.
         ================================================================== */
      html[data-lww-active][data-lww-contrast] body:not([data-ds-dark-theme]){
        --dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-800);
        --dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-750);
        --dsw-alias-label-caption:var(--dsw-static-neutral-bluish-700)}

      /* ==================================================================
         Popover / menu surfaces. The composer "+" menu, the model picker and
         every other MenuSurface read --dsw-menu-surface-fill, which the theme
         ships at 58% (light) / 45% (dark) alpha for an opaque page. Over a
         wallpaper that thin veil leaves 13px menu text muddy, so while a
         wallpaper is active the material turns near-opaque and the surface
         gets a real backdrop blur. Without a wallpaper nothing changes.
         ================================================================== */
      html[data-lww-active] body:not([data-ds-dark-theme]){
        --dsw-menu-surface-fill:#f8f9faf0;
        --dsw-menu-backdrop-filter:blur(28px) saturate(1.4)}
      html[data-lww-active] body[data-ds-dark-theme]{
        --dsw-menu-surface-fill:#33343af0;
        --dsw-menu-backdrop-filter:blur(28px) saturate(1.4)}
      html[data-lww-active] [data-menu-material]{
        -webkit-backdrop-filter:blur(28px) saturate(1.4);
        backdrop-filter:blur(28px) saturate(1.4)}

      /* ==================================================================
         Settings page. The settings panel is 800px wide with a 188px nav and
         24px of content padding, so the content column is ~564px: one column
         of compact cards is the layout that fits without clipping.
         ================================================================== */

      /* ==================================================================
         Settings nav icon. The shell falls back to the gear for section ids
         it does not know, and current shells wrap that fallback in a _navIcon
         span; older shells put the <svg> straight in the row. The Client half
         marks our row with data-lww-nav, hides whichever shell glyph is there
         and paints its own, so the colour still comes from the row text
         (light/dark, hover and the active row all follow). The box is 16x16
         because the shell renders every built-in glyph with size: 16 — anything
         larger also pushes the label right, so the row no longer lines up with
         the others. If the official rows change, decorateSettingsNav matches
         nothing and the shell's default glyph stays — nothing breaks.
         ================================================================== */
      [data-lww-nav]{
        --lww-nav-icon:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3.25' y='5.25' width='17.5' height='13.5' rx='2.4' fill='none' stroke='black' stroke-width='1.9'/%3E%3Ccircle cx='8.6' cy='9.6' r='1.45' fill='black'/%3E%3Cpath d='M3.4 17.6 9.1 12l3 3.1 2.6-2.5 6.2 5z' fill='black'/%3E%3C/svg%3E")}
      @supports ((mask-image:linear-gradient(black,black)) or (-webkit-mask-image:linear-gradient(black,black))){
        [data-lww-nav]>svg,
        [data-lww-nav] [class*="_navIcon"]{display:none!important}
        [data-lww-nav]::before{content:"";flex:none;width:16px;height:16px;
          background-color:currentColor;
          -webkit-mask:var(--lww-nav-icon) center/contain no-repeat;
          mask:var(--lww-nav-icon) center/contain no-repeat}
      }

      .lww-page{width:100%;max-width:100%;box-sizing:border-box;padding:2px 0 32px;
        color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
      .lww-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 14px}
      .lww-head-body{min-width:0}
      .lww-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
      .lww-enable{display:flex;align-items:center;gap:8px;flex:none}
      .lww-group{margin:18px 2px 8px;font-size:11.5px;font-weight:600;letter-spacing:.04em;
        color:var(--dsw-alias-label-secondary)}
      .lww-group:first-of-type{margin-top:2px}
      .lww-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;
        padding:14px 16px;margin-bottom:14px;background:var(--dsw-alias-bg-layer-1)}
      body[data-ds-dark-theme] .lww-card{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1))}
      .lww-card:last-child{margin-bottom:0}
      .lww-card-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
        flex-wrap:wrap;margin-bottom:12px}
      .lww-card-head-main{flex:1 1 220px;min-width:0}
      .lww-card-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;
        flex-wrap:wrap;margin-top:12px}
      .lww-card-title{font-size:14px;font-weight:600;line-height:20px}
      .lww-card-sub{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .lww-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .lww-switch{position:relative;width:38px;height:22px;border-radius:11px;border:none;flex:none;padding:0;
        cursor:pointer;transition:background .15s;
        background:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}
      .lww-switch[aria-checked="true"]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary))}
      .lww-switch>span{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
        background:var(--dsw-alias-bg-layer-2);box-shadow:0 1px 2px rgba(0,0,0,.28);
        transition:transform .15s}
      .lww-switch[aria-checked="true"]>span{transform:translateX(16px)}
      .lww-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
      .lww-tabs{display:inline-flex;gap:2px;padding:2px;border-radius:9px;margin-bottom:12px;
        background:var(--dsw-alias-bg-layer-2)}
      .lww-tab{border:none;background:none;padding:5px 12px;border-radius:7px;font:inherit;font-size:12.5px;
        color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .12s,background .12s}
      .lww-tab:hover{color:var(--dsw-alias-label-primary)}
      .lww-tab.is-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);
        box-shadow:0 1px 2px rgba(0,0,0,.1)}
      /* Recently used is a shortcut, not a source: keep the two groups apart. */
      .lww-tab-sep{width:1px;height:16px;margin:2px 4px;flex:none;align-self:center;
        background:var(--dsw-alias-border-l2)}
      .lww-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
      .lww-tile{position:relative;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:0;
        overflow:hidden;cursor:pointer;text-align:left;color:inherit;font:inherit;aspect-ratio:16/10;
        background:var(--dsw-alias-bg-layer-2);transition:transform .12s,border-color .12s}
      .lww-tile:hover:not(:disabled){transform:translateY(-1px)}
      .lww-tile:disabled{cursor:default;opacity:.7}
      .lww-tile img{width:100%;height:100%;object-fit:cover;display:block}
      .lww-tile.is-active{border-color:transparent;outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .lww-tile-meta{position:absolute;inset:auto 0 0 0;padding:16px 8px 6px;pointer-events:none;
        background:linear-gradient(transparent,rgba(0,0,0,.76));color:#fff;font-size:11px;line-height:1.35;
        display:flex;flex-direction:column;gap:2px}
      .lww-tile-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-tile-credit{opacity:.82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* The presets stay on ONE line: they never wrap, and if a locale makes
         them wider than the ~532px content column the row scrolls sideways
         (a thin scrollbar marks it) instead of pushing the grid down. */
      .lww-chips{display:flex;flex-wrap:nowrap;gap:6px;margin-bottom:10px;
        overflow-x:auto;padding-bottom:2px;scrollbar-width:thin;
        overscroll-behavior-x:contain}
      .lww-chips::-webkit-scrollbar{height:4px}
      .lww-chips::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px}
      .lww-chips::-webkit-scrollbar-track{background:transparent}
      .lww-chip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
        border-radius:999px;padding:3px 10px;font:inherit;font-size:11.5px;cursor:pointer;
        flex:none;white-space:nowrap;
        color:var(--dsw-alias-label-secondary);transition:color .12s,border-color .12s}
      .lww-chip:hover{color:var(--dsw-alias-label-primary)}
      .lww-chip.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);
        background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
      .lww-row{display:grid;grid-template-columns:104px minmax(0,1fr) 56px 22px;
        align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .lww-row:last-child{border-bottom:none}
      .lww-row-split{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .lww-row-main{min-width:0}
      .lww-row-label{font-size:12.5px}
      .lww-row-hint{margin-top:1px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
      .lww-unit{font-size:11.5px;color:var(--dsw-alias-label-secondary);text-align:right}
      .lww-preview{margin-top:12px;max-width:100%;max-height:220px;border-radius:10px;display:block}
      .lww-range{-webkit-appearance:none;appearance:none;width:100%;min-width:0;height:16px;
        background:transparent;cursor:pointer;padding:0;margin:0}
      .lww-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;
        background:var(--dsw-alias-border-l2)}
      .lww-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;
        margin-top:-5px;border-radius:50%;background:var(--dsw-alias-label-primary);
        border:2px solid var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,.28)}
      .lww-range:focus-visible{outline:none}
      .lww-range:focus-visible::-webkit-slider-thumb{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
      .lww-range:disabled{opacity:.55;cursor:default}
      .lww-num{width:56px;height:26px;box-sizing:border-box;border-radius:7px;
        border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
        color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 6px;
        text-align:right;font-variant-numeric:tabular-nums}
      .lww-select{height:28px;box-sizing:border-box;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);
        background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
        font:inherit;font-size:12px;padding:0 8px}
      .lww-input{height:28px;flex:1;min-width:0;box-sizing:border-box;border-radius:7px;
        border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
        color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 9px}
      .lww-input::placeholder{color:var(--dsw-alias-label-secondary)}
      .lww-btn{height:28px;box-sizing:border-box;padding:0 11px;border-radius:8px;cursor:pointer;
        border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
        color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;
        transition:background .12s,border-color .12s,color .12s}
      .lww-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .lww-btn:disabled{opacity:.5;cursor:default}
      .lww-btn.is-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));
        border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}
      .lww-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
      .lww-btn:focus-visible,.lww-chip:focus-visible,.lww-tab:focus-visible,.lww-tile:focus-visible,
      .lww-input:focus-visible,.lww-select:focus-visible,.lww-num:focus-visible{
        outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .lww-note{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
      .lww-error{margin-top:8px;padding:7px 10px;border-radius:8px;font-size:12px;
        border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);
        background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);
        color:var(--dsw-alias-state-error-primary)}
      .lww-empty{padding:22px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
      .lww-gap{margin-top:10px}
      .lww-gap-sm{margin-top:8px}
      .lww-gap-b{margin-bottom:10px}
      /* Pager: prev / centred page label / next, with the end note on its own line. */
      .lww-pager{display:flex;align-items:center;gap:8px;margin-top:12px}
      .lww-pager-info{flex:1;min-width:0;text-align:center;font-size:12px;
        color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
      .lww-pager-end{margin-top:6px;text-align:center;font-size:12px;
        color:var(--dsw-alias-label-secondary)}
      .lww-current{display:flex;align-items:center;gap:12px}
      .lww-current-thumb{width:104px;height:64px;border-radius:9px;object-fit:cover;flex:none;
        background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
      .lww-current-body{min-width:0}
      .lww-current-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* Recent wallpapers: four mini tiles per row. The content column is only
         ~564px, so titles and timestamps ellipsize instead of stretching it. */
      .lww-history-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px}
      .lww-history-item{position:relative;display:flex;flex-direction:column;gap:6px;min-width:0;
        box-sizing:border-box;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
        text-align:left;color:inherit;font:inherit;cursor:pointer;background:var(--dsw-alias-bg-layer-2);
        transition:transform .12s,border-color .12s}
      .lww-history-item:hover{transform:translateY(-1px)}
      .lww-history-item.is-current{border-color:var(--dsw-alias-brand-primary);
        box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
      .lww-history-thumb{width:100%;aspect-ratio:16/10;object-fit:cover;display:block;border-radius:7px;
        background:var(--dsw-alias-bg-layer-1)}
      /* No usable image source: a quiet block instead of the browser's broken icon. */
      .lww-history-thumb-empty{background:linear-gradient(135deg,
        var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-2));
        display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);
        font-size:16px;line-height:1}
      .lww-history-body{min-width:0;display:flex;flex-direction:column;gap:1px}
      .lww-history-title{font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-history-meta{font-size:11px;line-height:1.35;color:var(--dsw-alias-label-secondary);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-badge{position:absolute;top:12px;left:12px;padding:1px 6px;border-radius:999px;
        font-size:10.5px;line-height:15px;font-weight:600;pointer-events:none;
        color:var(--dsw-alias-label-primary-foreground,#fff);
        background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary))}
      /* Cache manager: text column, right-aligned numbers, then the button. The
         button column is one fixed width for every row, so all three buttons
         align on both edges (the labels differ in length). */
      .lww-cache-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;
        align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .lww-cache-row:last-child{border-bottom:none}
      .lww-cache-main{min-width:0}
      .lww-cache-size{font-size:12px;color:var(--dsw-alias-label-secondary);text-align:right;
        min-width:92px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
      .lww-cache-row .lww-btn{min-width:132px;justify-content:center}
      .lww-fade{opacity:.72}

      /* ==================================================================
         Font card. The trigger opens a fixed, portalled list so the settings
         column's overflow cannot clip it. The list rows preview themselves.
         ================================================================== */
      .lww-font-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}
      @media (max-width:680px){.lww-font-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media (max-width:460px){.lww-font-grid{grid-template-columns:minmax(0,1fr)}}
      .lww-font-field{display:flex;flex-direction:column;gap:5px;min-width:0}
      .lww-font-label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
      .lww-font-trigger{display:flex;align-items:center;gap:8px;height:32px;width:100%;min-width:0;
        border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
        background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
        padding:0 9px;font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
      .lww-font-trigger:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
      .lww-font-trigger:disabled{opacity:.55;cursor:default}
      .lww-font-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-font-value.is-default{color:var(--dsw-alias-label-tertiary)}
      .lww-font-caret{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1}
      .lww-font-preview{margin-top:12px;padding:9px 11px;border-radius:9px;
        background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
        display:flex;flex-direction:column;gap:4px;min-width:0}
      .lww-font-preview-line{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:12px;
        color:var(--dsw-alias-label-secondary)}
      .lww-font-preview-label{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
      .lww-font-preview-ui{font-family:var(--dsw-font-family);font-size:13px;
        color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-font-preview-code{font-family:var(--ds-font-family-code);font-size:12px;
        color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-font-preview-terminal{font-family:var(--dsh-font-family-terminal,var(--ds-font-family-code));
        font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;
        white-space:nowrap}
      .lww-font-note{margin-top:9px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
      .lww-font-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
      .lww-font-actions .lww-font-note{margin-top:0;flex:1;min-width:180px}
      .lww-font-pop{position:fixed;inset:auto;margin:0;z-index:2147483000;box-sizing:border-box;
        border:1px solid var(--dsw-alias-border-l2);border-radius:12px;
        background:var(--dsw-alias-bg-layer-1);
        box-shadow:0 10px 30px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);
        padding:0;display:flex;flex-direction:column;overflow:hidden}
      @supports selector(:popover-open){
        .lww-font-pop[popover]:not(:popover-open){display:none}
      }
      .lww-font-pop::backdrop{background:transparent;pointer-events:none}
      .lww-font-pop-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-font-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
        padding:11px 12px 7px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
      .lww-font-pop-source{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
      .lww-font-search{position:relative;display:flex;align-items:center;margin:0 8px 7px}
      .lww-font-search-icon{position:absolute;left:9px;top:50%;transform:translateY(-50%);
        pointer-events:none;width:13px;height:13px;display:block;
        color:var(--dsw-alias-label-tertiary)}
      .lww-font-search .lww-input{height:32px;flex:1;padding-left:28px;padding-right:26px;
        background:var(--dsw-alias-bg-layer-2);border-radius:8px}
      .lww-font-search-clear{position:absolute;right:3px;width:24px;height:24px;border:none;
        background:none;border-radius:6px;color:var(--dsw-alias-label-tertiary);font-size:15px;
        line-height:1;cursor:pointer;display:grid;place-items:center;padding:0}
      .lww-font-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover);
        color:var(--dsw-alias-label-primary)}
      .lww-font-list{overflow:auto;min-height:0;display:flex;flex-direction:column;gap:1px;
        padding:0 6px 6px;scrollbar-width:thin;overscroll-behavior:contain}
      .lww-font-list::-webkit-scrollbar{width:6px}
      .lww-font-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px}
      .lww-font-list::-webkit-scrollbar-track{background:transparent}
      .lww-font-option{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;
        border:none;background:none;border-radius:8px;padding:6px 8px;
        color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;
        cursor:pointer;min-height:32px}
      .lww-font-option:hover,.lww-font-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover);
        outline:none}
      .lww-font-option.is-current{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent)}
      .lww-font-option-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-font-option-sample{flex:none;max-width:92px;overflow:hidden;text-overflow:ellipsis;
        white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary);opacity:.9}
      .lww-font-option-mark{flex:none;width:14px;text-align:center;font-size:11px;
        color:var(--dsw-alias-brand-primary)}
      .lww-font-option.is-default .lww-font-option-name{color:var(--dsw-alias-label-secondary)}
      .lww-font-pop-foot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;
        border-top:1px solid var(--dsw-alias-border-l1);padding:7px 12px;font-size:11px;
        color:var(--dsw-alias-label-tertiary)}
      .lww-font-pop-note{flex:none;padding:0 12px 7px;font-size:11px;line-height:1.45;
        color:var(--dsw-alias-label-tertiary)}
      .lww-font-empty,.lww-font-loading{padding:14px 8px;font-size:12px;
        color:var(--dsw-alias-label-secondary);text-align:center}
    `

    /* ------------------------------------------------------------------ */
    /* Store                                                              */
    /* ------------------------------------------------------------------ */

    let state = hydrateState(DEFAULT_STATE)
    let ready = false
    let errorText = ''
    let busy = ''
    const listeners = new Set()
    let visualApply = () => {}
    /** Scheme the last paint used; reported by the self-check. */
    let paintScheme = 'light'
    /** The theme service, kept for the self-check's independent read. */
    let themeRef = null
    let saveTimer = null
    let paintTimer = null
    let saveChain = Promise.resolve()
    /** Bumped after a thumbnail purge so every proxied thumbnail URL changes. */
    let thumbEpoch = 0
    /** Recent-list subscribers: purging wallpapers drops files out of history. */
    const historyListeners = new Set()

    function snapshot() {
      return { state, ready, errorText, busy }
    }

    function emit() {
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          console.error('[lightweight-wallpaper] listener failed', error)
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function subscribeHistory(listener) {
      historyListeners.add(listener)
      return () => historyListeners.delete(listener)
    }

    /** The cache card asks the recent list to reload after `assets`/`all`. */
    function notifyHistory() {
      for (const listener of historyListeners) {
        try {
          listener()
        } catch (error) {
          console.error('[lightweight-wallpaper] history listener failed', error)
        }
      }
    }

    function paintCache() {
      try {
        localStorage.setItem(PAINT_CACHE, JSON.stringify(state))
      } catch {
        /* private mode / quota — the host state is the source of truth */
      }
    }

    function readPaintCache() {
      try {
        const raw = localStorage.getItem(PAINT_CACHE)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? hydrateState(parsed) : null
      } catch {
        return null
      }
    }

    function setError(message) {
      errorText = message ? String(message) : ''
      emit()
    }

    function setBusy(value) {
      busy = value
      emit()
    }

    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = null
        saveChain = saveChain.then(() => saveState()).catch(() => {})
      }, 250)
    }

    function schedulePaint() {
      if (paintTimer) return
      paintTimer = setTimeout(() => {
        paintTimer = null
        paintCache()
      }, 200)
    }

    function setState(patch, options = {}) {
      state = { ...state, ...patch }
      visualApply(state)
      schedulePaint()
      emit()
      if (options.persist !== false) scheduleSave()
    }

    /* ------------------------------------------------------------------ */
    /* API                                                               */
    /* ------------------------------------------------------------------ */

    async function api(path, init) {
      const headers = { [PLUGIN_HEADER]: PLUGIN_ID }
      if (init && init.body) headers['content-type'] = 'application/json'
      const response = await fetch(`${PREFIX}${path}`, {
        ...init,
        headers: { ...headers, ...(init && init.headers ? init.headers : {}) },
        credentials: 'same-origin',
      })
      const text = await response.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      if (!response.ok) {
        throw new Error((data && data.error && data.error.message) || `HTTP ${response.status}`)
      }
      return data
    }

    async function saveState() {
      try {
        await api('/state', { method: 'POST', body: JSON.stringify({ state }) })
        if (errorText) setError('')
      } catch (error) {
        setError(String(error && error.message ? error.message : error))
      }
    }

    async function loadState() {
      try {
        const data = await api('/state', { method: 'GET' })
        if (data && data.state) {
          state = hydrateState(data.state)
          paintCache()
        }
        if (errorText) setError('')
      } catch (error) {
        setError(`${error && error.message ? error.message : error}`)
      } finally {
        ready = true
        visualApply(state)
        emit()
      }
    }

    /* ------------------------------------------------------------------ */
    /* Visual layer                                                       */
    /* ------------------------------------------------------------------ */

    function createVisual(theme) {
      let disposeTokenLayer = null
      /* `overrideTokens` publishes `theme/change` synchronously, which re-enters
         applyVisual; the slot is reserved before the call so the nested paint
         cannot stack an endless run of layers. */
      let tokenLayerRequested = false
      const root = document.documentElement

      function clearTokens() {
        if (disposeTokenLayer) {
          disposeTokenLayer()
          disposeTokenLayer = null
        }
      }

      /** Scrim colour for one scheme; the alpha still comes from the slider. */
      function floorColor(alpha, scheme) {
        return scheme === 'dark' ? `rgba(21,21,23,${alpha})` : `rgba(255,255,255,${alpha})`
      }

      function clearGlass() {
        root.removeAttribute('data-lww-glass')
        root.removeAttribute('data-lww-contrast')
        root.style.removeProperty('--lww-panel-a')
        root.style.removeProperty('--lww-panel-b')
        /* The tint is a stylesheet value now; drop any inline leftover. */
        root.style.removeProperty('--lww-scrim-rgb')
      }

      return function applyVisual(next, snapshot) {
        try {
          const scheme = resolvedScheme(theme, snapshot)
          paintScheme = scheme
          const wallpaper = next && next.enabled ? next.wallpaper : null
          if (!wallpaper || !wallpaper.asset) {
            root.removeAttribute('data-lww-active')
            root.removeAttribute('data-lww-blur')
            root.style.removeProperty('--lww-image')
            root.style.removeProperty('--lww-fit')
            root.style.removeProperty('--lww-blur')
            root.style.removeProperty('--lww-dim')
            root.style.removeProperty('--lww-floor')
            clearGlass()
            clearTokens()
            return
          }
          root.setAttribute('data-lww-active', '')
          root.style.setProperty('--lww-image', `url("${wallpaper.asset}")`)
          root.style.setProperty('--lww-fit', next.fit === 'contain' ? 'contain' : 'cover')
          const blur = clampInt(next.blur, 0, 24, 0)
          root.style.setProperty('--lww-blur', `${blur}px`)
          if (blur > 0) root.setAttribute('data-lww-blur', '')
          else root.removeAttribute('data-lww-blur')
          root.style.setProperty('--lww-dim', String(((Number(next.dim) || 0) / 100).toFixed(3)))
          root.style.setProperty('--lww-floor', floorColor(alphaValue(next.opacity), scheme))
          if (next.contrastEnabled === false) root.removeAttribute('data-lww-contrast')
          else root.setAttribute('data-lww-contrast', '')
          if (next.panelEnabled === false) {
            clearGlass()
          } else {
            root.setAttribute('data-lww-glass', '')
            root.style.setProperty('--lww-panel-a', alphaValue(next.panelAlpha))
            root.style.setProperty('--lww-panel-b', `${clampInt(next.panelBlur, 0, 40, 0)}px`)
          }
          if (!disposeTokenLayer && !tokenLayerRequested) {
            tokenLayerRequested = true
            try {
              disposeTokenLayer = theme.overrideTokens(PLUGIN_ID, {
                '--dsw-alias-bg-base': { light: 'rgba(0,0,0,0)', dark: 'rgba(0,0,0,0)' },
                '--dsw-specific-sidebar-fill': { light: 'rgba(0,0,0,0)', dark: 'rgba(0,0,0,0)' },
              })
            } finally {
              tokenLayerRequested = false
            }
          }
        } catch (error) {
          console.error('[lightweight-wallpaper] could not apply the wallpaper', error)
        }
      }
    }

    /* ------------------------------------------------------------------ */
    /* Actions                                                            */
    /* ------------------------------------------------------------------ */

    function todayKey() {
      const date = new Date()
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }

    async function pinItem(item) {
      setBusy('pin')
      setError('')
      try {
        if (!item.full) throw new Error('no downloadable image for this item')
        const result = await api('/pin', {
          method: 'POST',
          body: JSON.stringify({
            url: item.full,
            fallbacks: Array.isArray(item.fallbacks) ? item.fallbacks : [],
            source: item.source,
            title: item.title,
            credit: item.credit,
            page: item.page,
          }),
        })
        setState({
          wallpaper: {
            asset: result.asset,
            source: result.source || item.source,
            title: item.title || '',
            credit: item.credit || '',
            page: item.page || '',
            /** Remote small image; the client never downloads it directly. */
            thumb: item.thumb || '',
            addedAt: new Date().toISOString(),
          },
        })
      } catch (error) {
        setError(String(error && error.message ? error.message : error))
        throw error
      } finally {
        setBusy('')
      }
    }

    async function uploadBlob(blob) {
      const response = await fetch(`${PREFIX}/upload`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': blob.type || 'image/jpeg', [PLUGIN_HEADER]: PLUGIN_ID },
        body: blob,
      })
      const text = await response.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      if (!response.ok) {
        throw new Error((data && data.error && data.error.message) || `HTTP ${response.status}`)
      }
      return data
    }

    async function shrink(file) {
      const smallEnough = file.size <= 6 * 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(file.type)
      if (smallEnough) return file
      const maxEdge = 2560
      let source = null
      let width = 0
      let height = 0
      try {
        source = await createImageBitmap(file)
        width = source.width
        height = source.height
      } catch {
        source = null
      }
      if (!source) {
        const objectUrl = URL.createObjectURL(file)
        try {
          const image = await new Promise((resolveImage, rejectImage) => {
            const img = new Image()
            img.onload = () => resolveImage(img)
            img.onerror = () => rejectImage(new Error('image decode failed'))
            img.src = objectUrl
          })
          source = image
          width = image.naturalWidth
          height = image.naturalHeight
          const scale = Math.min(1, maxEdge / Math.max(width, height))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(width * scale))
          canvas.height = Math.max(1, Math.round(height * scale))
          canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
          source.close?.()
          const blob = await new Promise((resolveBlob) => canvas.toBlob(resolveBlob, 'image/jpeg', 0.9))
          if (!blob) throw new Error('could not encode the image')
          return blob
        } finally {
          URL.revokeObjectURL(objectUrl)
        }
      }
      const scale = Math.min(1, maxEdge / Math.max(width, height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
      source.close?.()
      const blob = await new Promise((resolveBlob) => canvas.toBlob(resolveBlob, 'image/jpeg', 0.9))
      if (!blob) throw new Error('could not encode the image')
      return blob
    }

    async function applyUpload(file) {
      setBusy('upload')
      setError('')
      try {
        const blob = await shrink(file)
        const result = await uploadBlob(blob)
        setState({
          wallpaper: {
            asset: result.asset,
            source: 'upload',
            title: file.name || 'Custom image',
            credit: file.name || '',
            page: '',
            addedAt: new Date().toISOString(),
          },
        })
      } catch (error) {
        setError(String(error && error.message ? error.message : error))
        throw error
      } finally {
        setBusy('')
      }
    }

    async function autoRotate() {
      if (!state.enabled || !state.autoBing) return
      if (state.autoBingDate === todayKey()) return
      try {
        const data = await api(`/bing?mkt=${encodeURIComponent(state.market)}&n=1`)
        const item = data && data.items && data.items[0]
        if (!item) return
        const result = await api('/pin', {
          method: 'POST',
          body: JSON.stringify({
            url: item.full,
            fallbacks: item.fallbacks || [],
            source: 'bing',
            title: item.title,
            credit: item.credit,
            page: item.page,
          }),
        })
        setState({
          autoBingDate: todayKey(),
          wallpaper: {
            asset: result.asset,
            source: 'bing',
            title: item.title || '',
            credit: item.credit || '',
            page: item.page || '',
            thumb: item.thumb || '',
            addedAt: new Date().toISOString(),
          },
        })
      } catch (error) {
        console.warn('[lightweight-wallpaper] daily rotation failed', error)
      }
    }

    /* ------------------------------------------------------------------ */
    /* Components                                                         */
    /* ------------------------------------------------------------------ */

    function useStore() {
      const [value, setValue] = useState(snapshot)
      useEffect(() => subscribe(() => setValue(snapshot())), [])
      return value
    }

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'lww-switch',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          disabled: props.disabled,
          onClick: () => props.onChange(!props.checked),
        },
        h('span'),
      )
    }

    function Slider(props) {
      const { label, hint, value, min, max, step, unit, disabled, onChange } = props
      return h(
        'div',
        { className: 'lww-row' },
        h(
          'div',
          { className: 'lww-row-main' },
          h('div', { className: 'lww-row-label' }, label),
          hint ? h('div', { className: 'lww-row-hint' }, hint) : null,
        ),
        h('input', {
          className: 'lww-range',
          type: 'range',
          min,
          max,
          step,
          value,
          disabled,
          'aria-label': label,
          onChange: (event) => onChange(Number(event.target.value)),
        }),
        h('input', {
          className: 'lww-num',
          type: 'number',
          min,
          max,
          step,
          value,
          disabled,
          'aria-label': label,
          onChange: (event) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)))
          },
        }),
        h('span', { className: 'lww-unit' }, unit),
      )
    }

    /**
     * Grid thumbnails go through the Host proxy so they land in its disk cache.
     * 480 is only the request: the Host snaps it up to 500px, one of the widths
     * Wikimedia actually serves (direct requests for any other width get 400).
     * `v` is the thumbnail epoch: a purge bumps it and every tile refetches.
     */
    function tileImage(item) {
      return `${PREFIX}/proxy?u=${encodeURIComponent(item.thumb)}&w=480&v=${thumbEpoch}`
    }

    /**
     * Recent-list thumbnails. A remote thumb (absolute https URL) goes through
     * the Host proxy, which caches the 330px rendition. Uploads have no remote
     * thumb — the proxy only accepts absolute https URLs, so a local asset path
     * there answers 400 — and read the stored asset directly instead: /asset is
     * same-origin and cached as immutable.
     */
    function historyImage(entry) {
      const remote =
        entry && typeof entry.thumb === 'string' && /^https?:\/\//i.test(entry.thumb) ? entry.thumb : ''
      if (remote) return `${PREFIX}/proxy?u=${encodeURIComponent(remote)}&w=330&v=${thumbEpoch}`
      return entry && typeof entry.asset === 'string' ? entry.asset : ''
    }

    /* ------------------------------------------------------------------ */
    /* Settings nav icon                                                  */
    /* ------------------------------------------------------------------ */

    const NAV_MARK = 'data-lww-nav'

    /** Our settings-section label in the active locale (nav.title). */
    function navLabel() {
      try {
        return translateRef ? String(translateRef('nav.title') || '').trim() : ''
      } catch {
        return ''
      }
    }

    /** Nav rows of the settings dialog; empty while the panel is closed. */
    function settingsNavRows() {
      try {
        if (typeof document.querySelectorAll !== 'function') return []
        return Array.from(document.querySelectorAll('[data-shortcut-modal="settings"] [class*="_navCell"]'))
      } catch {
        return []
      }
    }

    /**
     * The official nav carries no section id on its rows and its icon map is
     * keyed by the shipped ids only, so a third-party section always gets the
     * gear of "general settings". Our row is found by its localized label and
     * marked; the glyph itself is painted by CSS on the mark.
     */
    function decorateSettingsNav() {
      const label = navLabel()
      if (!label) return false
      let matched = false
      for (const row of settingsNavRows()) {
        const text = row.querySelector('[class*="_navLabel"]')
        const ours = Boolean(text) && String(text.textContent || '').trim() === label
        if (ours) {
          if (!row.hasAttribute(NAV_MARK)) row.setAttribute(NAV_MARK, '')
          matched = true
        } else if (row.hasAttribute(NAV_MARK)) {
          row.removeAttribute(NAV_MARK)
        }
      }
      return matched
    }

    /**
     * Horizontal offset of a row's label from the row's own left edge. The
     * official glyph is 16x16 plus an 8px gap, so every built-in row lands on
     * the same value; our decorated row must match it exactly, and that is what
     * the self-check compares.
     */
    function navLabelOffset(row) {
      try {
        const label = row && row.querySelector('[class*="_navLabel"]')
        if (!label || typeof row.getBoundingClientRect !== 'function') return null
        const box = row.getBoundingClientRect()
        const text = label.getBoundingClientRect()
        if (!box || !text || !box.width) return null
        return Math.round((text.left - box.left) * 10) / 10
      } catch {
        return null
      }
    }

    /** Self-check view: is a row with our label present, marked and aligned? */
    function probeSettingsNav() {
      const label = navLabel()
      let matched = false
      let decorated = false
      let ours = null
      for (const row of settingsNavRows()) {
        const text = row.querySelector('[class*="_navLabel"]')
        if (!text || String(text.textContent || '').trim() !== label) continue
        matched = true
        if (row.hasAttribute(NAV_MARK)) decorated = true
        ours = navLabelOffset(row)
      }
      /* Any built-in row works as the reference: they all use the official 16px
         glyph box, so an equal offset proves our masked glyph matches. */
      let reference = null
      for (const row of settingsNavRows()) {
        const text = row.querySelector('[class*="_navLabel"]')
        if (!text || String(text.textContent || '').trim() === label) continue
        const offset = navLabelOffset(row)
        if (offset === null) continue
        reference = offset
        break
      }
      return { label, matched, decorated, geometry: { ours, reference } }
    }

    /**
     * Keep the mark alive: the panel is portalled on open and unmounted on
     * close, and the label text follows the locale. The observer watches only
     * body childList (one node per open/close) and merges runs into a frame.
     */
    function installSettingsNav() {
      let frame = 0
      let disposed = false
      const isFrame = typeof requestAnimationFrame === 'function'
      const schedule = () => {
        if (frame || disposed) return
        if (isFrame) {
          frame = requestAnimationFrame(() => {
            frame = 0
            if (!disposed) decorateSettingsNav()
          })
        } else {
          frame = setTimeout(() => {
            frame = 0
            if (!disposed) decorateSettingsNav()
          }, 16)
        }
      }
      decorateSettingsNav()
      let observer = null
      try {
        if (typeof MutationObserver === 'function' && document.body) {
          observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true })
        }
      } catch {
        observer = null
      }
      return () => {
        disposed = true
        try {
          if (frame) {
            if (isFrame) cancelAnimationFrame(frame)
            else clearTimeout(frame)
          }
        } catch {
          /* the frame is already gone */
        }
        if (observer) observer.disconnect()
        for (const row of settingsNavRows()) row.removeAttribute(NAV_MARK)
      }
    }

    /* ------------------------------------------------------------------ */
    /* Self-check (written to $DSH_HOME/lightweight-wallpaper/selfcheck.json) */
    /* ------------------------------------------------------------------ */

    function describeElement(element) {
      if (!element) return null
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        tag: element.tagName,
        cls: String(element.className || '').slice(0, 120),
        id: element.id || '',
        bg: style.backgroundColor,
        bgImage: String(style.backgroundImage || '').slice(0, 140),
        backdropFilter: String(style.backdropFilter || '').slice(0, 80),
        opacity: style.opacity,
        visibility: style.visibility,
        position: style.position,
        zIndex: style.zIndex,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      }
    }

    function describePseudo(element, which) {
      if (!element) return null
      const style = getComputedStyle(element, which)
      return {
        content: style.content,
        bg: style.backgroundColor,
        bgImage: String(style.backgroundImage || '').slice(0, 160),
        position: style.position,
        zIndex: style.zIndex,
        inset: [style.top, style.right, style.bottom, style.left].join(' '),
        filter: style.filter,
        display: style.display,
      }
    }

    /** Glass surfaces, kept in one place: a miss shows up as matched:false. */
    const GLASS_PROBES = [
      [
        'newSession',
        '[class*="_newSession"]:not([class*="Label"],[class*="Content"],[class*="Shortcut"],[class*="Mask"])',
      ],
    ]

    function probeGlass(selector) {
      let element = null
      try {
        element = document.querySelector(selector)
      } catch {
        element = null
      }
      if (!element) return { selector, matched: false }
      const style = getComputedStyle(element)
      return {
        selector,
        matched: true,
        element: describeElement(element),
        inputsMajor: style.getPropertyValue('--dsw-specific-input-major').trim(),
      }
    }

    function probeComposerCard() {
      const host =
        document.querySelector('[class*="_composerHero"]') || document.querySelector('[class*="_composerSeat"]')
      if (!host) return null
      const card = host.querySelector('[class*="_card"]')
      if (!card) return { found: false, host: describeElement(host) }
      const style = getComputedStyle(card)
      const layer = getComputedStyle(card, '::before')
      return {
        found: true,
        card: describeElement(card),
        isolation: style.isolation,
        backdropFilter: String(style.backdropFilter || ''),
        layer: {
          content: layer.content,
          backdropFilter: String(layer.backdropFilter || ''),
          backgroundColor: layer.backgroundColor,
          borderRadius: layer.borderRadius,
          zIndex: layer.zIndex,
        },
      }
    }

    /** Open popovers (composer "+" menu, model picker, …) and their material. */
    function probeMenus() {
      const nodes = document.querySelectorAll('[data-menu-material]')
      const found = []
      for (const element of nodes) {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const material = element.firstElementChild
        found.push({
          cls: String(element.className || '').slice(0, 90),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          surfaceBg: style.backgroundColor,
          materialBg: material ? getComputedStyle(material).backgroundColor : '',
          backdropFilter: String(style.backdropFilter || ''),
        })
        if (found.length >= 4) break
      }
      return found
    }

    /**
     * Any element that still paints an opaque-ish background over the wallpaper
     * is a bug; listing them makes "where is that white block" answerable.
     */
    function probeOpaqueSurfaces() {      const found = []
      const nodes = document.querySelectorAll('body *')
      for (const element of nodes) {
        const rect = element.getBoundingClientRect()
        const area = rect.width * rect.height
        if (area < 20000) continue
        const style = getComputedStyle(element)
        const bg = style.backgroundColor
        const match = /^rgba?\(([^)]+)\)$/.exec(bg)
        if (!match) continue
        const parts = match[1].split(',').map((value) => Number(value.trim()))
        const alpha = parts.length > 3 ? parts[3] : 1
        if (!(alpha > 0.02)) continue
        found.push({
          cls: String(element.className || '').slice(0, 90),
          bg,
          area: Math.round(area),
        })
        if (found.length >= 12) break
      }
      return found
    }

    /** Split a CSS colour into comparable rgb + alpha; null when unparsable. */
    function parseColor(value) {
      const match = /^rgba?\(([^)]+)\)$/.exec(String(value || '').trim())
      if (!match) return null
      const parts = match[1].split(',').map((part) => Number(part.trim()))
      if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null
      const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
      return { rgb: parts.slice(0, 3).join(','), alpha: Math.round(alpha * 1000) / 1000 }
    }

    function sameColor(left, right) {
      const a = parseColor(left)
      const b = parseColor(right)
      return Boolean(a && b && a.rgb === b.rgb && Math.abs(a.alpha - b.alpha) < 0.002)
    }

    function collectSelfCheck() {
      const root = document.documentElement
      const pick = (selector) => document.querySelector(selector)
      /* The right panel's presentation decides whether the conversation column
         is standing aside, so both halves of that rule belong in the report. */
      const rightPanel = pick('[data-sidebar-right-panel]')
      const centerCol = pick('[class*="_centerCol"]')
      const tokenNames = [
        '--dsw-alias-bg-base',
        '--dsw-specific-sidebar-fill',
        '--dsw-alias-bg-layer-1',
        '--dsw-alias-bg-layer-2',
        '--dsw-alias-bg-overlay',
        '--dsw-alias-bg-mask-1',
      ]
      const bodyStyle = document.body ? getComputedStyle(document.body) : null
      const tokens = {}
      for (const name of tokenNames) tokens[name] = bodyStyle ? bodyStyle.getPropertyValue(name).trim() : ''
      const bodyDark = document.body ? document.body.hasAttribute('data-ds-dark-theme') : false
      const wallpaperActive = root.hasAttribute('data-lww-active')
      const glassActive = root.hasAttribute('data-lww-glass')
      const serviceSnapshot = (() => {
        try {
          return themeRef && typeof themeRef.getTheme === 'function' ? themeRef.getTheme() : null
        } catch {
          return null
        }
      })()
      const pseudo = { before: describePseudo(root, '::before'), after: describePseudo(root, '::after') }
      // What the paint should show for the palette that is live right now. A
      // stale scrim shows up as matches:false even if nothing else looks wrong.
      const expectedFloor = `rgba(${bodyDark ? '21,21,23' : '255,255,255'},${alphaValue(state.opacity)})`
      const declaredFloor = root.style.getPropertyValue('--lww-floor').trim()
      const expectedTint = bodyDark ? '21,21,23' : '255,255,255'
      const tint = bodyStyle ? bodyStyle.getPropertyValue('--lww-scrim-rgb').trim() : ''
      const points = [
        [Math.round(innerWidth / 2), Math.round(innerHeight / 2)],
        [Math.round(innerWidth * 0.12), Math.round(innerHeight * 0.5)],
        [Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.12)],
      ].map(([x, y]) => ({
        x,
        y,
        stack: (document.elementsFromPoint(x, y) || []).slice(0, 14).map(describeElement),
      }))
      return {
        at: new Date().toISOString(),
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
        state: {
          enabled: state.enabled,
          fit: state.fit,
          opacity: state.opacity,
          blur: state.blur,
          dim: state.dim,
          panelEnabled: state.panelEnabled !== false,
          panelAlpha: state.panelAlpha,
          panelBlur: state.panelBlur,
          contrastEnabled: state.contrastEnabled !== false,
          asset: state.wallpaper && state.wallpaper.asset,
          source: state.wallpaper && state.wallpaper.source,
        },
        attributes: {
          lwwActive: root.hasAttribute('data-lww-active'),
          lwwGlass: root.hasAttribute('data-lww-glass'),
          lwwContrast: root.hasAttribute('data-lww-contrast'),
          lwwBlur: root.hasAttribute('data-lww-blur'),
          windowsTitlebar: root.hasAttribute('data-windows-titlebar'),
          platform: root.getAttribute('data-platform'),
          dark: document.body ? document.body.hasAttribute('data-ds-dark-theme') : null,
        },
        styleTag: Boolean(document.getElementById('dsh-lightweight-wallpaper-styles')),
        tokens,
        navIcon: probeSettingsNav(),
        rightPanel: {
          presentation: rightPanel ? rightPanel.getAttribute('data-sidebar-right-panel') : null,
          open: rightPanel ? rightPanel.hasAttribute('data-sidebar-right-open') : null,
          opening: rightPanel ? rightPanel.hasAttribute('data-sidebar-right-opening') : null,
          centerColVisibility: centerCol ? getComputedStyle(centerCol).visibility : null,
        },
        scheme: {
          paint: paintScheme,
          service: schemeOf(serviceSnapshot),
          bodyDark,
          colorScheme: root.style.colorScheme || '',
          themeSource: root.getAttribute('data-ds-theme-source') || '',
        },
        scrim: {
          declared: declaredFloor,
          computed: pseudo.after ? pseudo.after.bg : '',
          expected: expectedFloor,
          matches: wallpaperActive ? sameColor(declaredFloor, expectedFloor) : null,
        },
        glassTint: {
          value: tint,
          expected: expectedTint,
          matches: wallpaperActive && glassActive ? tint === expectedTint : null,
        },
        glassVariables: {
          panelAlpha: root.style.getPropertyValue('--lww-panel-a').trim(),
          panelBlur: root.style.getPropertyValue('--lww-panel-b').trim(),
          floor: declaredFloor,
          labelSecondary: bodyStyle ? bodyStyle.getPropertyValue('--dsw-alias-label-secondary').trim() : '',
          labelTertiary: bodyStyle ? bodyStyle.getPropertyValue('--dsw-alias-label-tertiary').trim() : '',
          labelCaption: bodyStyle ? bodyStyle.getPropertyValue('--dsw-alias-label-caption').trim() : '',
          menuSurfaceFill: bodyStyle ? bodyStyle.getPropertyValue('--dsw-menu-surface-fill').trim() : '',
        },
        fonts: {
          writeSupported: Boolean(themeRef && typeof themeRef.setFontFamily === 'function'),
          text: bodyStyle ? bodyStyle.getPropertyValue('--dsh-font-family-text').trim() : '',
          code: bodyStyle ? bodyStyle.getPropertyValue('--dsh-font-family-code').trim() : '',
          terminal: bodyStyle ? bodyStyle.getPropertyValue('--dsh-font-family-terminal').trim() : '',
          ui: bodyStyle ? bodyStyle.getPropertyValue('--dsw-font-family').trim() : '',
          codeEffective: bodyStyle ? bodyStyle.getPropertyValue('--ds-font-family-code').trim() : '',
          legacyUi: bodyStyle ? bodyStyle.getPropertyValue('--dsw-font').trim() : '',
          legacyMono: bodyStyle ? bodyStyle.getPropertyValue('--dsw-font-mono').trim() : '',
        },
        glass: Object.fromEntries(GLASS_PROBES.map(([id, selector]) => [id, probeGlass(selector)])),
        composerCard: probeComposerCard(),
        menus: probeMenus(),
        opaqueSurfaces: probeOpaqueSurfaces(),
        pseudo,
        elements: {
          html: describeElement(root),
          body: describeElement(document.body),
          root: describeElement(document.getElementById('root')),
          frame: describeElement(pick('[class*="_frame"]')),
          centerCol: describeElement(centerCol),
          sidebarCol: describeElement(pick('[class*="_sidebarCol"]')),
          conversationRoot: describeElement(pick('[data-slot="conversation.session"]')),
          rightPanel: describeElement(rightPanel),
        },
        points,
      }
    }

    async function sendSelfCheck(reason) {
      try {
        await fetch(`${PREFIX}/selfcheck`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { [PLUGIN_HEADER]: PLUGIN_ID, 'content-type': 'application/json' },
          body: JSON.stringify({ reason, ...collectSelfCheck() }),
        })
      } catch (error) {
        console.warn('[lightweight-wallpaper] self-check failed', error)
      }
    }

    /** Remote thumbnails occasionally drop on flaky links; retry through the proxy once or twice. */
    function TileImage(props) {
      const [attempt, setAttempt] = useState(0)
      const base = tileImage(props.item)
      const src = attempt === 0 ? base : `${base}&r=${attempt}`
      return h('img', {
        src,
        alt: props.alt || '',
        loading: 'lazy',
        decoding: 'async',
        onError: () => setAttempt((value) => (value < 2 ? value + 1 : value)),
      })
    }

    function Tile(props) {
      const { item, active, disabled, onPick, t } = props
      const meta = [item.date, item.credit, item.license].filter(Boolean).join(' · ')
      return h(
        'button',
        {
          type: 'button',
          className: `lww-tile${active ? ' is-active' : ''}`,
          title: `${item.title}\n${meta}`,
          disabled,
          onClick: () => onPick(item),
        },
        h(TileImage, { item, alt: item.title || '' }),
        h(
          'span',
          { className: 'lww-tile-meta' },
          h('span', { className: 'lww-tile-title' }, item.title || t('source.name.' + item.source)),
          h('span', { className: 'lww-tile-credit' }, meta || t('source.name.' + item.source)),
        ),
      )
    }

    /**
     * One tab row for the whole picker: the local wallpapers come first and are
     * kept apart from the four upstream source groups by a hairline, because a
     * file already on disk is not a source — it is a shortcut back to one.
     */
    function SourceTabs(props) {
      const tabs = [
        ['history', props.t('history.title')],
        ['bing', props.t('source.bing')],
        ['art', props.t('source.art')],
        ['sites', props.t('source.sites')],
        ['custom', props.t('source.custom')],
      ]
      const children = []
      for (const [id, label] of tabs) {
        if (id === 'bing') {
          children.push(h('span', { key: 'separator', className: 'lww-tab-sep', 'aria-hidden': 'true' }))
        }
        children.push(
          h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              'aria-selected': props.value === id ? 'true' : 'false',
              className: `lww-tab${props.value === id ? ' is-active' : ''}`,
              onClick: () => props.onChange(id),
            },
            label,
          ),
        )
      }
      return h('div', { className: 'lww-tabs', role: 'tablist' }, children)
    }

    /**
     * Shared pager row: `‹ previous` · `page N` (+ `· total M` when known) ·
     * `next ›`. Both panels own their page state; this component only renders
     * it and reports the two intents.
     */
    function Pager(props) {
      const { t, page, hasMore, total, loading, items, onPrev, onNext } = props
      const label = t('pager.page').replace('{n}', String(page + 1))
      const totalLabel = total > 0 ? t('pager.total').replace('{n}', String(total)) : ''
      const empty = Array.isArray(items) && items.length === 0
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'lww-pager' },
          h(
            'button',
            {
              type: 'button',
              className: 'lww-btn',
              disabled: loading || page === 0,
              onClick: onPrev,
            },
            `‹ ${t('pager.prev')}`,
          ),
          h('span', { className: 'lww-pager-info' }, totalLabel ? `${label} · ${totalLabel}` : label),
          h(
            'button',
            {
              type: 'button',
              className: 'lww-btn',
              disabled: loading || !hasMore,
              onClick: onNext,
            },
            `${t('pager.next')} ›`,
          ),
        ),
        page > 0 && empty ? h('div', { className: 'lww-pager-end' }, t('pager.end')) : null,
      )
    }

    function BingPanel(props) {
      const { t, state: current, disabled, pin } = props
      const [items, setItems] = useState([])
      const [page, setPage] = useState(0)
      const [hasMore, setHasMore] = useState(false)
      const [loading, setLoading] = useState(true)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const load = useCallback(
        async (market, nextPage = 0) => {
          setLoading(true)
          setError('')
          setNote('')
          try {
            const data = await api(`/bing?mkt=${encodeURIComponent(market)}&n=8&page=${nextPage}`)
            setItems(Array.isArray(data && data.items) ? data.items : [])
            const reportedPage = data && Number(data.page)
            setPage(Number.isFinite(reportedPage) ? reportedPage : nextPage)
            setHasMore(Boolean(data && data.hasMore))
            if (data && data.stale) setNote(t('stale'))
            if (data && data.ok === false) setError(data.error || t('empty'))
          } catch (err) {
            setError(String(err && err.message ? err.message : err))
          } finally {
            setLoading(false)
          }
        },
        [t],
      )
      useEffect(() => {
        load(current.market, 0)
      }, [load, current.market])
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'lww-actions lww-gap-b' },
          h('span', { className: 'lww-card-sub' }, t('bing.market')),
          h(
            'select',
            {
              className: 'lww-select',
              value: current.market,
              onChange: (event) => setState({ market: event.target.value }),
            },
            MARKETS.map(([id, label]) => h('option', { key: id, value: id }, label)),
          ),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', className: 'lww-btn', disabled, onClick: () => load(current.market, 0) }, t('bing.refresh')),
        ),
        loading ? h('div', { className: 'lww-empty' }, t('loading')) : null,
        !loading && items.length === 0 ? h('div', { className: 'lww-empty' }, t('empty')) : null,
        items.length > 0
          ? h(
              'div',
              { className: 'lww-grid' },
              items.map((item) =>
                h(Tile, {
                  key: item.id,
                  item,
                  t,
                  disabled,
                  active: Boolean(current.wallpaper && current.wallpaper.page && current.wallpaper.page === item.page),
                  onPick: pin,
                }),
              ),
            )
          : null,
        h(Pager, {
          t,
          page,
          hasMore,
          total: 0,
          loading,
          items,
          onPrev: () => load(current.market, Math.max(0, page - 1)),
          onNext: () => load(current.market, page + 1),
        }),
        error ? h('div', { className: 'lww-error' }, error) : null,
        note ? h('div', { className: 'lww-note lww-gap-sm' }, note) : null,
        h('div', { className: 'lww-note lww-gap' }, t('bing.note')),
      )
    }

    function ArtPanel(props) {
      const { t, state: current, disabled, pin } = props
      const [source, setSource] = useState('wikimedia')
      const [preset, setPreset] = useState('vanGogh')
      const [query, setQuery] = useState(PRESETS[0].query)
      const [items, setItems] = useState([])
      const [page, setPage] = useState(0)
      const [hasMore, setHasMore] = useState(false)
      const [total, setTotal] = useState(0)
      const [loading, setLoading] = useState(true)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const load = useCallback(
        async (nextSource, nextQuery, nextPage = 0) => {
          if (!nextQuery.trim()) return
          setLoading(true)
          setError('')
          setNote('')
          try {
            const data = await api(
              `/art?source=${encodeURIComponent(nextSource)}&q=${encodeURIComponent(nextQuery)}&limit=24&page=${nextPage}`,
            )
            setItems(Array.isArray(data && data.items) ? data.items : [])
            const reportedPage = data && Number(data.page)
            setPage(Number.isFinite(reportedPage) ? reportedPage : nextPage)
            setHasMore(Boolean(data && data.hasMore))
            const reportedTotal = Number(data && data.total)
            setTotal(Number.isFinite(reportedTotal) && reportedTotal > 0 ? reportedTotal : 0)
            if (data && data.stale) setNote(t('stale'))
            if (data && data.ok === false) setError(data.error || t('empty'))
          } catch (err) {
            setError(String(err && err.message ? err.message : err))
          } finally {
            setLoading(false)
          }
        },
        [t],
      )
      useEffect(() => {
        load('wikimedia', PRESETS[0].query, 0)
      }, [load])
      const choosePreset = (next) => {
        setPreset(next.id)
        setQuery(next.query)
        load(source, next.query, 0)
      }
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'lww-actions lww-gap-b' },
          h(
            'select',
            {
              className: 'lww-select',
              value: source,
              onChange: (event) => {
                const next = event.target.value
                setSource(next)
                load(next, query, 0)
              },
            },
            h('option', { value: 'wikimedia' }, t('art.wikimedia')),
            h('option', { value: 'cleveland' }, t('art.cleveland')),
          ),
          h('input', {
            className: 'lww-input',
            value: query,
            placeholder: t('art.search'),
            'aria-label': t('art.search'),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') load(source, query, 0)
            },
          }),
          h(
            'button',
            { type: 'button', className: 'lww-btn is-primary', disabled, onClick: () => load(source, query, 0) },
            t('art.searchBtn'),
          ),
        ),
        h(
          'div',
          { className: 'lww-chips' },
          PRESETS.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                className: `lww-chip${preset === entry.id ? ' is-active' : ''}`,
                onClick: () => choosePreset(entry),
              },
              t(entry.label),
            ),
          ),
        ),
        loading ? h('div', { className: 'lww-empty' }, t('loading')) : null,
        !loading && items.length === 0 ? h('div', { className: 'lww-empty' }, t('empty')) : null,
        items.length > 0
          ? h(
              'div',
              { className: 'lww-grid' },
              items.map((item) =>
                h(Tile, {
                  key: `${item.source}-${item.id}`,
                  item,
                  t,
                  disabled,
                  active: Boolean(current.wallpaper && current.wallpaper.page && current.wallpaper.page === item.page),
                  onPick: pin,
                }),
              ),
            )
          : null,
        h(Pager, {
          t,
          page,
          hasMore,
          total,
          loading,
          items,
          onPrev: () => load(source, query, Math.max(0, page - 1)),
          onNext: () => load(source, query, page + 1),
        }),
        error ? h('div', { className: 'lww-error' }, error) : null,
        note ? h('div', { className: 'lww-note lww-gap-sm' }, note) : null,
      )
    }

    /**
     * The Wallpaper sites tab currently fronts 10wallpaper: one chip row for
     * its category pages, a keyword search, and the shared Tile/Pager contract.
     */
    function SitesPanel(props) {
      const { t, state: current, disabled, pin } = props
      const [preset, setPreset] = useState(TENWALLPAPER_PRESETS[0].id)
      const [query, setQuery] = useState('')
      const [cat, setCat] = useState(TENWALLPAPER_PRESETS[0].cat)
      const [items, setItems] = useState([])
      const [page, setPage] = useState(0)
      const [hasMore, setHasMore] = useState(false)
      const [total, setTotal] = useState(0)
      const [loading, setLoading] = useState(true)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const load = useCallback(
        async (params, nextPage = 0) => {
          setLoading(true)
          setError('')
          setNote('')
          try {
            const search = new URLSearchParams({ source: 'tenwallpaper', page: String(nextPage) })
            if (params.q) search.set('q', params.q)
            if (params.cat) search.set('cat', params.cat)
            const data = await api(`/art?${search.toString()}`)
            setItems(Array.isArray(data && data.items) ? data.items : [])
            const reportedPage = data && Number(data.page)
            setPage(Number.isFinite(reportedPage) ? reportedPage : nextPage)
            setHasMore(Boolean(data && data.hasMore))
            const reportedTotal = Number(data && data.total)
            setTotal(Number.isFinite(reportedTotal) && reportedTotal > 0 ? reportedTotal : 0)
            if (data && data.stale) setNote(t('stale'))
            if (data && data.ok === false) setError(data.error || t('empty'))
          } catch (err) {
            setError(String(err && err.message ? err.message : err))
          } finally {
            setLoading(false)
          }
        },
        [t],
      )
      useEffect(() => {
        load({ q: '', cat: TENWALLPAPER_PRESETS[0].cat }, 0)
      }, [load])
      const choose = (entry) => {
        const nextCat = entry.cat || ''
        setPreset(entry.id)
        setQuery('')
        setCat(nextCat)
        load({ q: '', cat: nextCat }, 0)
      }
      const submit = () => {
        const nextQuery = query.trim()
        if (!nextQuery) return
        setPreset('')
        setCat('')
        load({ q: nextQuery, cat: '' }, 0)
      }
      const params = { q: query.trim(), cat }
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'lww-actions lww-gap-b' },
          h('input', {
            className: 'lww-input',
            value: query,
            placeholder: t('site.search'),
            'aria-label': t('site.search'),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
            },
          }),
          h(
            'button',
            { type: 'button', className: 'lww-btn is-primary', disabled, onClick: submit },
            t('art.searchBtn'),
          ),
        ),
        h(
          'div',
          { className: 'lww-chips' },
          TENWALLPAPER_PRESETS.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                className: `lww-chip${preset === entry.id ? ' is-active' : ''}`,
                onClick: () => choose(entry),
              },
              t(entry.label),
            ),
          ),
        ),
        loading ? h('div', { className: 'lww-empty' }, t('loading')) : null,
        !loading && items.length === 0 ? h('div', { className: 'lww-empty' }, t('empty')) : null,
        items.length > 0
          ? h(
              'div',
              { className: 'lww-grid' },
              items.map((item) =>
                h(Tile, {
                  key: `${item.source}-${item.id}`,
                  item,
                  t,
                  disabled,
                  active: Boolean(current.wallpaper && current.wallpaper.page && current.wallpaper.page === item.page),
                  onPick: pin,
                }),
              ),
            )
          : null,
        h(Pager, {
          t,
          page,
          hasMore,
          total,
          loading,
          items,
          onPrev: () => load(params, Math.max(0, page - 1)),
          onNext: () => load(params, page + 1),
        }),
        error ? h('div', { className: 'lww-error' }, error) : null,
        note ? h('div', { className: 'lww-note lww-gap-sm' }, note) : null,
        h('div', { className: 'lww-note lww-gap' }, t('site.note.tenwallpaper')),
      )
    }

    function CustomPanel(props) {
      const { t, state: current, disabled } = props
      const inputRef = useRef(null)
      const previewRef = useRef('')
      const [preview, setPreview] = useState('')
      const [error, setError] = useState('')
      const isUpload = current.wallpaper && current.wallpaper.source === 'upload'
      useEffect(
        () => () => {
          if (previewRef.current) URL.revokeObjectURL(previewRef.current)
        },
        [],
      )
      const onFile = async (event) => {
        const file = event.target.files && event.target.files[0]
        if (!file) return
        setError('')
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
          setError(t('custom.hint'))
          return
        }
        try {
          if (previewRef.current) URL.revokeObjectURL(previewRef.current)
          previewRef.current = URL.createObjectURL(file)
          setPreview(previewRef.current)
        } catch {
          setPreview('')
        }
        try {
          await applyUpload(file)
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'lww-actions' },
          h('button', { type: 'button', className: 'lww-btn is-primary', disabled, onClick: () => inputRef.current && inputRef.current.click() }, t('custom.pick')),
          h('input', { ref: inputRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: onFile }),
        ),
        h('div', { className: 'lww-note lww-gap-sm' }, t('custom.hint')),
        preview
          ? h('img', { src: preview, alt: '', className: 'lww-preview' })
          : isUpload
            ? h('img', { src: current.wallpaper.asset, alt: '', className: 'lww-preview' })
            : null,
        error ? h('div', { className: 'lww-error' }, error) : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* Recent wallpapers                                                  */
    /* ------------------------------------------------------------------ */

    const HISTORY_LIMIT = 20

    /**
     * "Recently used" card: the Host's capped history (newest first). The Host
     * only returns entries whose file still exists, so there is no "missing"
     * state to render here — a purge simply shrinks the list.
     */
    /**
     * Body of the local-wallpaper tab: every image kept on this machine, newest
     * first. No card chrome of its own — it renders inside the picker card, and
     * the Host returns exactly the files that still exist (plus a row for each).
     */
    function HistoryPanel(props) {
      const { t, state: current, onApply } = props
      const [entries, setEntries] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const asset = current && current.wallpaper && current.wallpaper.asset ? current.wallpaper.asset : ''
      const load = useCallback(async () => {
        try {
          const data = await api('/history')
          setEntries(Array.isArray(data && data.entries) ? data.entries : [])
          setError('')
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          setLoading(false)
        }
      }, [])
      useEffect(() => {
        load()
      }, [load])
      /*
       * A pin lands on the Host first: state.json is only written after the
       * download finishes, so wait 600ms after the asset flips before asking
       * for the list again — otherwise the new entry (and the current badge)
       * would still be one round behind.
       */
      const seenAsset = useRef(asset)
      useEffect(() => {
        if (seenAsset.current === asset) return undefined
        const timer = setTimeout(() => {
          seenAsset.current = asset
          load()
        }, 600)
        return () => clearTimeout(timer)
      }, [asset, load])
      /* Purging cached wallpapers removes files, so the list is reloaded. */
      useEffect(() => subscribeHistory(load), [load])
      const items = entries.slice(0, HISTORY_LIMIT)
      return h(
        'div',
        null,
        h('div', { className: 'lww-note lww-gap-b' }, t('history.hint')),
        loading ? h('div', { className: 'lww-empty' }, t('loading')) : null,
        !loading && items.length === 0 ? h('div', { className: 'lww-empty' }, t('history.empty')) : null,
        items.length > 0
          ? h(
              'div',
              { className: 'lww-history-grid' },
              items.map((entry) => {
                const isCurrent = Boolean(asset) && entry.asset === asset
                const sourceName = t('source.name.' + entry.source) || entry.source || ''
                const when = relativeTime(entry.usedAt)
                const meta = when ? `${sourceName} · ${when}` : sourceName
                const title = entry.title || sourceName
                const preview = historyImage(entry)
                return h(
                  'button',
                  {
                    key: entry.asset,
                    type: 'button',
                    className: `lww-history-item${isCurrent ? ' is-current' : ''}`,
                    title: `${title}\n${meta}`,
                    onClick: () => onApply(entry),
                  },
                  preview
                    ? h('img', {
                        className: 'lww-history-thumb',
                        src: preview,
                        alt: '',
                        loading: 'lazy',
                        decoding: 'async',
                      })
                    : h('span', { className: 'lww-history-thumb lww-history-thumb-empty', 'aria-hidden': 'true' }, '🖼'),
                  h(
                    'span',
                    { className: 'lww-history-body' },
                    h('span', { className: 'lww-history-title' }, title),
                    h('span', { className: 'lww-history-meta' }, meta),
                  ),
                  isCurrent ? h('span', { className: 'lww-badge' }, t('history.current')) : null,
                )
              }),
            )
          : null,
        error ? h('div', { className: 'lww-error' }, error) : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* Cache manager                                                      */
    /* ------------------------------------------------------------------ */

    const CACHE_ROWS = [
      ['assets', 'cache.assets', 'cache.clearAssets'],
      ['thumbs', 'cache.thumbs', 'cache.clear'],
      ['lists', 'cache.lists', 'cache.clear'],
    ]

    /**
     * Cache card: one row per cache (local wallpapers / thumbnails / list
     * snapshots), each with its own clear button, plus a two-step
     * clear-everything button that stays armed until the second click or until
     * focus leaves it.
     */
    function CacheCard(props) {
      const { t } = props
      const [cache, setCache] = useState(null)
      const [clearing, setClearing] = useState('')
      const [message, setMessage] = useState('')
      const [confirming, setConfirming] = useState(false)
      const load = useCallback(async () => {
        try {
          const data = await api('/cache')
          if (data && data.assets) setCache(data)
        } catch (err) {
          setMessage(String(err && err.message ? err.message : err))
        }
      }, [])
      useEffect(() => {
        load()
      }, [load])
      const clear = async (what) => {
        setConfirming(false)
        setClearing(what)
        setMessage('')
        try {
          const data = await api('/cache/clear', { method: 'POST', body: JSON.stringify({ what }) })
          if (data && data.cache && data.cache.assets) setCache(data.cache)
          const freed = Number(data && data.freedBytes)
          setMessage(t('cache.freed').replace('{size}', formatBytes(freed)))
          if (what === 'thumbs' || what === 'all') {
            /* Thumbnail URLs are cached by the browser: bump the epoch and
               repaint so every tile asks the proxy for a fresh copy. */
            thumbEpoch += 1
            setState({}, { persist: false })
          }
          if (what === 'assets' || what === 'all') notifyHistory()
        } catch (err) {
          setMessage(String(err && err.message ? err.message : err))
        } finally {
          setClearing('')
        }
      }
      /* Two-step, no countdown: the first click arms the label and it stays armed
         until the second click clears or the button loses focus. */
      const armClearAll = () => {
        if (confirming) {
          clear('all')
          return
        }
        setConfirming(true)
      }
      return h(
        'div',
        { className: 'lww-card' },
        h(
          'div',
          { className: 'lww-card-hd' },
          h(
            'div',
            { className: 'lww-card-head-main' },
            h('div', { className: 'lww-card-title' }, t('cache.title')),
            h('div', { className: 'lww-card-sub' }, t('cache.hint')),
          ),
        ),
        h(
          'div',
          { className: 'lww-cache-list' },
          CACHE_ROWS.map(([what, labelKey, clearKey]) => {
            const bucket = (cache && cache[what]) || {}
            const files = Number(bucket.files) || 0
            const bytes = Number(bucket.bytes) || 0
            const detail = files > 0 ? `${files} · ${formatBytes(bytes)}` : t('cache.never')
            return h(
              'div',
              { className: 'lww-cache-row', key: what },
              h(
                'div',
                { className: 'lww-cache-main' },
                h('div', { className: 'lww-row-label' }, t(labelKey)),
                h('div', { className: 'lww-cache-size' }, detail),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'lww-btn',
                  disabled: Boolean(clearing),
                  onClick: () => clear(what),
                },
                clearing === what ? t('loading') : t(clearKey),
              ),
            )
          }),
        ),
        h(
          'div',
          { className: 'lww-card-actions' },
          h(
            'button',
            {
              type: 'button',
              className: `lww-btn${confirming ? ' is-primary' : ''}`,
              disabled: Boolean(clearing),
              onClick: armClearAll,
              onBlur: () => setConfirming(false),
            },
            confirming ? t('cache.confirm') : t('cache.clearAll'),
          ),
        ),
        message ? h('div', { className: 'lww-note lww-gap-sm' }, message) : null,
      )
    }

    function FontPicker(props) {
      const { t, role, label, value, fonts, loading, source, error, onLoad, onPick } = props
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [position, setPosition] = useState(null)
      const triggerRef = useRef(null)
      const panelRef = useRef(null)
      const inputRef = useRef(null)
      const names = useMemo(() => mergeFonts(fonts || [], value), [fonts, value])
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (!needle) return names
        return names.filter((name) => name.toLowerCase().includes(needle))
      }, [names, query])
      const custom = query.trim()
      const customIsNew = Boolean(custom) && !names.some((name) => name.toLowerCase() === custom.toLowerCase())
      const current = firstFontName(value)
      const defaultSampleFamily =
        role === 'terminal'
          ? 'var(--dsh-font-family-terminal,var(--ds-font-family-code))'
          : role === 'code'
            ? 'var(--ds-font-family-code)'
            : 'var(--dsw-font-family)'

      useEffect(() => {
        if (!open) return undefined
        const panel = panelRef.current
        const onToggle = (event) => {
          if (event.newState === 'closed') setOpen(false)
        }
        if (panel) panel.addEventListener('toggle', onToggle)
        if (panel && typeof panel.showPopover === 'function') {
          try {
            panel.showPopover()
          } catch {
            /* already open, or the browser refused the top-layer promotion */
          }
        }
        const onPointerDown = (event) => {
          const target = event.target
          if (panelRef.current && panelRef.current.contains(target)) return
          if (triggerRef.current && triggerRef.current.contains(target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          setOpen(false)
          try {
            triggerRef.current?.focus?.()
          } catch {
            /* detached trigger */
          }
        }
        const onScroll = (event) => {
          const target = event.target
          if (
            panelRef.current &&
            typeof Node !== 'undefined' &&
            target instanceof Node &&
            panelRef.current.contains(target)
          ) {
            return
          }
          setOpen(false)
        }
        const onResize = () => setOpen(false)
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onResize)
        const timer = setTimeout(() => {
          try {
            inputRef.current?.focus?.()
          } catch {
            /* detached input */
          }
        }, 0)
        return () => {
          clearTimeout(timer)
          if (panel) panel.removeEventListener('toggle', onToggle)
          if (panel && typeof panel.hidePopover === 'function') {
            try {
              panel.hidePopover()
            } catch {
              /* already closed or detached */
            }
          }
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
        }
      }, [open])

      const close = () => {
        setOpen(false)
        try {
          triggerRef.current?.focus?.()
        } catch {
          /* detached trigger */
        }
      }
      const choose = (family) => {
        try {
          onPick(family)
        } finally {
          close()
        }
      }
      const openPanel = (event) => {
        if (open) {
          close()
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        const width = Math.min(Math.max(rect.width, 320), Math.max(240, window.innerWidth - 16))
        const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
        const below = window.innerHeight - rect.bottom - 14
        const above = rect.top - 14
        const openAbove = below < 300 && above > below
        const maxHeight = Math.max(180, Math.min(380, openAbove ? above : below))
        const top = openAbove ? Math.max(8, rect.top - maxHeight - 6) : rect.bottom + 6
        setPosition({ left, top, width, maxHeight })
        setQuery('')
        setOpen(true)
        try {
          onLoad?.()
        } catch {
          /* the card owns the visible error */
        }
      }

      const defaultOption = h(
        'button',
        {
          key: 'font-default',
          type: 'button',
          className: `lww-font-option is-default${value ? '' : ' is-current'}`,
          onClick: () => choose(''),
        },
        h('span', { className: 'lww-font-option-name' }, t('font.default')),
        h(
          'span',
          {
            className: 'lww-font-option-sample',
            style: { fontFamily: defaultSampleFamily },
          },
          t('font.sample'),
        ),
        h('span', { className: 'lww-font-option-mark', 'aria-hidden': 'true' }, value ? '' : '✓'),
      )
      const customOption = customIsNew
        ? h(
            'button',
            {
              key: 'font-custom',
              type: 'button',
              className: 'lww-font-option',
              title: custom,
              onClick: () => choose(custom),
            },
            h('span', { className: 'lww-font-option-name' }, t('font.custom').replace('{name}', custom)),
            h(
              'span',
              { className: 'lww-font-option-sample', style: { fontFamily: cssFontList(custom) } },
              t('font.sample'),
            ),
            h('span', { className: 'lww-font-option-mark', 'aria-hidden': 'true' }, ''),
          )
        : null
      const list = filtered.map((name) =>
        h(
          'button',
          {
            key: `font-name-${name}`,
            type: 'button',
            className: `lww-font-option${current === name.toLowerCase() ? ' is-current' : ''}`,
            title: name,
            onClick: () => choose(name),
          },
          h('span', { className: 'lww-font-option-name' }, name),
          h(
            'span',
            { className: 'lww-font-option-sample', style: { fontFamily: cssFontName(name) } },
            t('font.sample'),
          ),
          h(
            'span',
            { className: 'lww-font-option-mark', 'aria-hidden': 'true' },
            current === name.toLowerCase() ? '✓' : '',
          ),
        ),
      )
      const note =
        source === 'fallback'
          ? error === 'denied'
            ? t('font.denied')
            : error
              ? t('font.fallback')
              : ''
          : ''
      const panel =
        open && position
          ? createPortal(
              h(
                'div',
                {
                  ref: panelRef,
                  className: 'lww-font-pop',
                  popover: 'manual',
                  role: 'dialog',
                  'aria-label': label,
                  style: {
                    left: `${position.left}px`,
                    top: `${position.top}px`,
                    width: `${position.width}px`,
                    maxHeight: `${position.maxHeight}px`,
                  },
                },
                h(
                  'div',
                  { className: 'lww-font-pop-head' },
                  h('span', { className: 'lww-font-pop-title' }, label),
                ),
                h(
                  'div',
                  { className: 'lww-font-search' },
                  h(
                    'svg',
                    {
                      className: 'lww-font-search-icon',
                      viewBox: '0 0 16 16',
                      'aria-hidden': 'true',
                    },
                    h('circle', {
                      cx: '6.8',
                      cy: '6.8',
                      r: '4.4',
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: '1.6',
                    }),
                    h('path', {
                      d: 'M10.2 10.2 14 14',
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: '1.6',
                      strokeLinecap: 'round',
                    }),
                  ),
                  h('input', {
                    ref: inputRef,
                    className: 'lww-input',
                    value: query,
                    placeholder: t('font.search'),
                    'aria-label': t('font.search'),
                    spellCheck: false,
                    autoComplete: 'off',
                    onChange: (event) => setQuery(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter') return
                      const target = custom || filtered[0]
                      if (target) choose(target)
                    },
                  }),
                  query
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'lww-font-search-clear',
                          'aria-label': t('font.clearSearch'),
                          onClick: () => {
                            setQuery('')
                            try {
                              inputRef.current?.focus?.()
                            } catch {
                              /* detached input */
                            }
                          },
                        },
                        '×',
                      )
                    : null,
                ),
                loading
                  ? h('div', { className: 'lww-font-loading' }, t('font.loading'))
                  : h(
                      'div',
                      {
                        className: 'lww-font-list',
                        style: { maxHeight: `${Math.max(120, position.maxHeight - 126)}px` },
                      },
                      defaultOption,
                      customOption,
                      list.length ? list : h('div', { className: 'lww-font-empty' }, t('font.noMatch')),
                    ),
                note ? h('div', { className: 'lww-font-pop-note' }, note) : null,
                !loading
                  ? h(
                      'div',
                      { className: 'lww-font-pop-foot' },
                      h(
                        'span',
                        null,
                        source === 'system'
                          ? t('font.systemSource')
                          : source === 'fallback'
                            ? t('font.fallbackSource')
                            : '',
                      ),
                      h('span', null, `${filtered.length}/${names.length}`),
                    )
                  : null,
              ),
              document.body,
            )
          : null

      return h(
        'div',
        { className: 'lww-font-field' },
        h('div', { className: 'lww-font-label' }, label),
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            className: 'lww-font-trigger',
            'aria-label': label,
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            onClick: openPanel,
          },
          h('span', { className: `lww-font-value${value ? '' : ' is-default'}` }, fontLabel(value, t('font.default'))),
          h('span', { className: 'lww-font-caret', 'aria-hidden': 'true' }, '▾'),
        ),
        panel,
      )
    }

    /**
     * Font picker card. The official ui-theme service owns the value; this
     * card only enumerates fonts and calls `setFontFamily`, so the official
     * General settings fields and this card always agree.
     */
    function FontCard(props) {
      const { t } = props
      const [fonts, setFonts] = useState(null)
      const [loading, setLoading] = useState(false)
      const [source, setSource] = useState('')
      const [loadError, setLoadError] = useState('')
      const [writeError, setWriteError] = useState('')
      const [notice, setNotice] = useState('')
      const theme = themeRef
      const snapshot = theme && typeof theme.getTheme === 'function' ? theme.getTheme() : null
      const families = snapshot && snapshot.fontFamilies ? snapshot.fontFamilies : { text: '', code: '', terminal: '' }
      const supported = Boolean(theme && typeof theme.setFontFamily === 'function')

      const load = useCallback(
        async (force) => {
          if (fonts && !force) return fonts
          setLoading(true)
          setLoadError('')
          try {
            const result = await fetchSystemFonts()
            setFonts(result.fonts)
            setSource(result.source)
            setLoadError(result.error)
            return result.fonts
          } catch (error) {
            setLoadError(String(error && error.message ? error.message : error))
            return []
          } finally {
            setLoading(false)
          }
        },
        [fonts],
      )

      const reload = () => {
        resetFontListCache()
        void load(true)
      }
      const apply = (role, family) => {
        setWriteError('')
        setNotice('')
        if (!supported) return
        try {
          theme.setFontFamily(role, family)
        } catch (error) {
          setWriteError(String(error && error.message ? error.message : error))
        }
      }
      const reset = () => {
        setWriteError('')
        setNotice('')
        if (!supported) return
        try {
          theme.setFontFamily('text', '')
          theme.setFontFamily('code', '')
          theme.setFontFamily('terminal', '')
          setNotice(t('font.bothDefault'))
        } catch (error) {
          setWriteError(String(error && error.message ? error.message : error))
        }
      }
      const noteText =
        loadError === 'denied'
          ? t('font.denied')
          : loadError
            ? t('font.fallback')
            : ''

      return h(
        'div',
        { className: 'lww-card lww-font-card' },
        h(
          'div',
          { className: 'lww-card-hd' },
          h(
            'div',
            { className: 'lww-card-head-main' },
            h('div', { className: 'lww-card-title' }, t('font.title')),
          ),
          h(
            'button',
            { type: 'button', className: 'lww-btn lww-font-reset', disabled: !supported, onClick: reset },
            t('font.reset'),
          ),
        ),
        supported
          ? h(
              'div',
              { className: 'lww-font-grid' },
              h(FontPicker, {
                t,
                role: 'text',
                label: t('font.ui'),
                value: families.text || '',
                fonts: fonts || [],
                loading,
                source,
                error: loadError,
                onLoad: () => load(false),
                onPick: (family) => apply('text', family),
              }),
              h(FontPicker, {
                t,
                role: 'code',
                label: t('font.code'),
                value: families.code || '',
                fonts: fonts || [],
                loading,
                source,
                error: loadError,
                onLoad: () => load(false),
                onPick: (family) => apply('code', family),
              }),
              h(FontPicker, {
                t,
                role: 'terminal',
                label: t('font.terminal'),
                value: families.terminal || '',
                fonts: fonts || [],
                loading,
                source,
                error: loadError,
                onLoad: () => load(false),
                onPick: (family) => apply('terminal', family),
              }),
            )
          : h('div', { className: 'lww-note lww-gap' }, t('font.unavailable')),
        h(
          'div',
          { className: 'lww-font-preview' },
          h(
            'div',
            { className: 'lww-font-preview-line' },
            h('span', { className: 'lww-font-preview-label' }, t('font.ui')),
            h('span', { className: 'lww-font-preview-ui' }, t('font.previewUi')),
          ),
          h(
            'div',
            { className: 'lww-font-preview-line' },
            h('span', { className: 'lww-font-preview-label' }, t('font.code')),
            h('span', { className: 'lww-font-preview-code' }, t('font.previewCode')),
          ),
          h(
            'div',
            { className: 'lww-font-preview-line' },
            h('span', { className: 'lww-font-preview-label' }, t('font.terminal')),
            h('span', { className: 'lww-font-preview-terminal' }, t('font.previewTerminal')),
          ),
        ),
        writeError ? h('div', { className: 'lww-error lww-gap-sm' }, writeError) : null,
        notice ? h('div', { className: 'lww-note lww-gap-sm' }, notice) : null,
        supported ? h('div', { className: 'lww-font-note' }, t('font.note')) : null,
        noteText
          ? h(
              'div',
              { className: 'lww-font-actions' },
              h('span', { className: 'lww-font-note' }, noteText),
              h(
                'button',
                { type: 'button', className: 'lww-btn lww-font-reset', disabled: loading, onClick: reload },
                t('font.retry'),
              ),
            )
          : null,
      )
    }

    function SettingsPage() {
      const value = useStore()
      const current = value.state
      /* Recently used is the default tab; the source tabs behave as before. */
      const [tab, setTab] = useState('history')
      const translate = useTranslate()
      const disabled = Boolean(value.busy) || !value.ready
      const price = current.wallpaper
      /** Applying a history entry is a local switch: no /pin round trip. */
      const applyHistory = (entry) => {
        if (!entry || !entry.asset) return
        setState({
          wallpaper: {
            asset: entry.asset,
            source: entry.source || '',
            title: entry.title || '',
            credit: entry.credit || '',
            page: entry.page || '',
            thumb: entry.thumb || '',
            addedAt: entry.usedAt || new Date().toISOString(),
          },
        })
      }
      return h(
        'div',
        { className: 'lww-page', 'data-slot': 'settings.section' },
        h(
          'div',
          { className: 'lww-head' },
          h(
            'div',
            { className: 'lww-head-body' },
            h('h1', { className: 'lww-title' }, translate('page.title')),
          ),
          h(
            'div',
            { className: 'lww-enable' },
            h('span', { className: 'lww-card-sub' }, translate('enable')),
            h(Switch, {
              checked: current.enabled,
              label: translate('enable'),
              onChange: (next) => setState({ enabled: next }),
            }),
          ),
        ),

        h('div', { className: 'lww-group' }, translate('group.wallpaper')),
        h(
          'div',
          { className: 'lww-card' },
          h(
            'div',
            { className: 'lww-card-hd' },
            h('div', { className: 'lww-card-title' }, translate('current.title')),
            value.busy ? h('span', { className: 'lww-card-sub' }, translate('busy.' + value.busy)) : null,
          ),
          price
            ? h(
                'div',
                { className: 'lww-current' },
                h('img', { className: 'lww-current-thumb', src: price.asset, alt: '' }),
                h(
                  'div',
                  { className: 'lww-current-body' },
                  h('div', { className: 'lww-current-title' }, price.title || translate('source.name.' + price.source)),
                  h(
                    'div',
                    { className: 'lww-card-sub' },
                    `${translate('current.source')}: ${translate('source.name.' + price.source)}${price.credit ? ` · ${price.credit}` : ''}`,
                  ),
                ),
              )
            : h('div', { className: 'lww-note' }, translate('current.none')),
          value.errorText ? h('div', { className: 'lww-error' }, value.errorText) : null,
        ),

        h(
          'div',
          { className: 'lww-card' },
          h(
            'div',
            { className: 'lww-card-hd' },
            h('div', { className: 'lww-card-title' }, translate('source.title')),
            disabled ? h('span', { className: 'lww-card-sub' }, translate('loading')) : null,
          ),
          h(SourceTabs, { value: tab, onChange: setTab, t: translate }),
          tab === 'history' ? h(HistoryPanel, { t: translate, state: current, onApply: applyHistory }) : null,
          tab === 'bing' ? h(BingPanel, { t: translate, state: current, disabled, pin: pinItem }) : null,
          tab === 'art' ? h(ArtPanel, { t: translate, state: current, disabled, pin: pinItem }) : null,
          tab === 'sites' ? h(SitesPanel, { t: translate, state: current, disabled, pin: pinItem }) : null,
          tab === 'custom' ? h(CustomPanel, { t: translate, state: current, disabled }) : null,
        ),

        h('div', { className: 'lww-group' }, translate('group.display')),
        h(
          'div',
          { className: 'lww-card' },
          h(
            'div',
            { className: 'lww-card-hd' },
            h('div', { className: 'lww-card-title' }, translate('effect.title')),
          ),
          h(
            'div',
            { className: 'lww-row lww-row-split' },
            h('div', { className: 'lww-row-label' }, translate('effect.fit')),
            h(
              'div',
              { className: 'lww-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: `lww-btn${current.fit === 'cover' ? ' is-primary' : ''}`,
                  onClick: () => setState({ fit: 'cover' }),
                },
                translate('effect.fit.cover'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: `lww-btn${current.fit === 'contain' ? ' is-primary' : ''}`,
                  onClick: () => setState({ fit: 'contain' }),
                },
                translate('effect.fit.contain'),
              ),
            ),
          ),
          h(Slider, {
            label: translate('effect.dim'),
            value: current.dim,
            min: 0,
            max: 60,
            step: 1,
            unit: '%',
            onChange: (next) => setState({ dim: next }),
          }),
          h(Slider, {
            label: translate('effect.blur'),
            value: current.blur,
            min: 0,
            max: 24,
            step: 1,
            unit: 'px',
            onChange: (next) => setState({ blur: next }),
          }),
          h(Slider, {
            label: translate('effect.opacity'),
            value: current.opacity,
            min: 30,
            max: 100,
            step: 1,
            unit: '%',
            onChange: (next) => setState({ opacity: next }),
          }),
          h(
            'div',
            { className: 'lww-row lww-row-split' },
            h(
              'div',
              { className: 'lww-row-main' },
              h('div', { className: 'lww-row-label' }, translate('contrast.title')),
              h('div', { className: 'lww-row-hint' }, translate('contrast.hint')),
            ),
            h(Switch, {
              checked: current.contrastEnabled !== false,
              label: translate('contrast.title'),
              onChange: (next) => setState({ contrastEnabled: next }),
            }),
          ),
          h(
            'div',
            { className: 'lww-card-actions' },
            h(
              'button',
              { type: 'button', className: 'lww-btn', onClick: () => sendSelfCheck('manual') },
              translate('effect.selfcheck'),
            ),
            h(
              'button',
              { type: 'button', className: 'lww-btn', onClick: () => setState(EFFECT_DEFAULTS) },
              translate('effect.reset'),
            ),
          ),
        ),

        h(
          'div',
          { className: 'lww-card' },
          h(
            'div',
            { className: 'lww-card-hd' },
            h(
              'div',
              { className: 'lww-card-head-main' },
              h('div', { className: 'lww-card-title' }, translate('panel.title')),
              h('div', { className: 'lww-card-sub' }, translate('panel.desc')),
            ),
            h(
              'div',
              { className: 'lww-actions' },
              h('span', { className: 'lww-card-sub' }, translate('panel.enable')),
              h(Switch, {
                checked: current.panelEnabled !== false,
                label: translate('panel.enable'),
                onChange: (next) => setState({ panelEnabled: next }),
              }),
            ),
          ),
          current.panelEnabled !== false
            ? h(
                'div',
                null,
                h(Slider, {
                  label: translate('panel.alpha'),
                  value: current.panelAlpha,
                  min: 0,
                  max: 100,
                  step: 1,
                  unit: '%',
                  onChange: (next) => setState({ panelAlpha: next }),
                }),
                h(Slider, {
                  label: translate('panel.blur'),
                  value: current.panelBlur,
                  min: 0,
                  max: 40,
                  step: 1,
                  unit: 'px',
                  onChange: (next) => setState({ panelBlur: next }),
                }),
              )
            : h('div', { className: 'lww-note' }, translate('panel.off')),
        ),

        h(
          'div',
          { className: 'lww-card' },
          h(
            'div',
            { className: 'lww-card-hd' },
            h(
              'div',
              { className: 'lww-card-head-main' },
              h('div', { className: 'lww-card-title' }, translate('auto.title')),
              h('div', { className: 'lww-card-sub' }, translate('auto.desc')),
            ),
            h(Switch, {
              checked: current.autoBing,
              label: translate('auto.title'),
              onChange: (next) => setState({ autoBing: next, autoBingDate: next ? current.autoBingDate : '' }),
            }),
          ),
        ),

        h('div', { className: 'lww-group' }, translate('group.fonts')),
        h(FontCard, { t: translate }),

        h('div', { className: 'lww-group' }, translate('group.data')),
        h(CacheCard, { t: translate }),
      )
    }

    let translateRef = null

    function useTranslate() {
      return translateRef || ((key) => key)
    }

    /* ------------------------------------------------------------------ */
    /* Plugin entry                                                       */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      translateRef = t

      ctx.effect(() => {
        const disposers = []
        for (const [locale, dict] of Object.entries(DICTS)) {
          try {
            disposers.push(ctx.locale.register(NS, locale, dict))
          } catch (error) {
            console.warn(`[lightweight-wallpaper] could not register locale ${locale}`, error)
            disposers.push(() => {})
          }
        }
        return () => disposers.forEach((dispose) => dispose())
      })

      ctx.effect(() => {
        const style = document.createElement('style')
        style.id = 'dsh-lightweight-wallpaper-styles'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      })

      const visual = createVisual(ctx.theme)
      visualApply = visual
      themeRef = ctx.theme
      ctx.effect(() => () => visual({ ...state, enabled: false }))
      // The scrim colour follows the active colour scheme. The payload is the
      // authoritative snapshot for this change; the palette attribute on body
      // belongs to another plugin's presenter and may still hold the old value
      // when this callback runs, so it is never the source of truth here.
      ctx.effect(() => {
        if (typeof ctx.on !== 'function') return () => {}
        let fontSignature = ''
        return ctx.on('theme/change', (snapshot) => {
          visual(state, snapshot)
          const fonts = snapshot && snapshot.fontFamilies
          if (!fonts) return
          const signature = `${fonts.text}\u0000${fonts.code}`
          if (signature === fontSignature) return
          fontSignature = signature
          emit()
        })
      })
      // Belt and braces: whichever part of the app flips the palette attribute,
      // repaint once it has landed (a microtask later, so the DOM is already
      // updated). This effect writes root attributes only — no feedback loop.
      ctx.effect(() => {
        if (typeof MutationObserver !== 'function' || !document.body) return () => {}
        const observer = new MutationObserver(() => visual(state))
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return () => observer.disconnect()
      })

      const cached = readPaintCache()
      if (cached) {
        state = hydrateState(cached)
        visual(state)
      }

      ctx.effect(() =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: PLUGIN_ID,
              order: 25,
              label: () => t('nav.title'),
            },
            SettingsPage,
          ),
        ),
      )

      ctx.effect(() => ctx.locale.subscribe(() => {
        /* The nav row label follows the locale, so re-match it after a switch. */
        decorateSettingsNav()
        emit()
      }))

      /* The settings nav has no icon seat for third-party sections: mark our
         row so CSS can paint its glyph instead of the shell's default gear. */
      ctx.effect(() => installSettingsNav())

      ctx.effect(() => {
        const timer = setTimeout(() => sendSelfCheck('boot'), 1600)
        return () => clearTimeout(timer)
      })

      try {
        window.__dshLightweightWallpaper = {
          check: collectSelfCheck,
          report: sendSelfCheck,
          nav: { decorate: decorateSettingsNav, probe: probeSettingsNav },
          fonts: {
            clean: cleanFontName,
            css: cssFontName,
            list: cssFontList,
            merge: mergeFonts,
            label: fontLabel,
          },
        }
      } catch {
        /* non-browser context */
      }

      loadState().then(() => autoRotate())
    }

    return {
      inject: ['slots', 'theme', 'locale'],
      apply,
    }
  },
})
