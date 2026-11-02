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

    const DICTS = {
      zh: {
        'nav.title': '壁纸',
        'page.title': '壁纸与背景',
        'page.desc': '从必应每日图、维基共享艺术或克利夫兰 CC0 馆藏里选一张，也可以上传本地图片。壁纸会铺在窗口最底层，画布与侧栏按下方滑杆透出。',
        'enable': '启用壁纸',
        'group.wallpaper': '壁纸',
        'group.display': '显示',
        'group.data': '数据',
        'source.title': '选择壁纸',
        'source.bing': '必应每日',
        'source.art': '艺术馆藏',
        'source.custom': '上传',
        'bing.market': '地区',
        'bing.refresh': '刷新',
        'bing.note': '必应每日图提供最近 16 天，每页 8 张，最多 2 页；图片仅限个人壁纸用途。',
        'art.wikimedia': '维基共享（公共领域）',
        'art.cleveland': '克利夫兰（CC0）',
        'art.search': '搜索画家、作品或流派…',
        'art.searchBtn': '搜索',
        'art.note': '搜索结果来自对应馆藏接口，每页 24 张可翻页，缩略图缓存在本地。',
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
        'effect.hint': '整窗遮罩铺满整个窗口，越低壁纸越明显；卡片、弹窗与代码块始终实心。',
        'effect.reset': '恢复推荐值',
        'effect.selfcheck': '自检',
        'panel.title': '毛玻璃与透明',
        'panel.desc': '只给输入框卡片和侧栏「新会话」按钮上毛玻璃；顶部、底部状态栏与两侧都不覆盖。',
        'panel.enable': '启用毛玻璃',
        'panel.alpha': '毛玻璃透明度',
        'panel.blur': '毛玻璃模糊',
        'panel.hint': '两者共用同一组浓度与模糊；透明度 0% 时完全透明。',
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
        'nav.title': 'Wallpaper',
        'page.title': 'Wallpaper & background',
        'page.desc': 'Pick a Bing daily image, a public-domain artwork from Wikimedia Commons or a CC0 work from the Cleveland Museum of Art — or upload your own. The wallpaper sits behind the whole window; the canvas and sidebar reveal it through the sliders below.',
        'enable': 'Enable wallpaper',
        'group.wallpaper': 'Wallpaper',
        'group.display': 'Display',
        'group.data': 'Data',
        'source.title': 'Choose a wallpaper',
        'source.bing': 'Bing daily',
        'source.art': 'Museum art',
        'source.custom': 'Upload',
        'bing.market': 'Region',
        'bing.refresh': 'Refresh',
        'bing.note': 'Bing serves the last 16 days, 8 images per page, up to 2 pages. Images are for personal wallpaper use only.',
        'art.wikimedia': 'Wikimedia Commons (public domain)',
        'art.cleveland': 'Cleveland Museum (CC0)',
        'art.search': 'Search an artist, work or movement…',
        'art.searchBtn': 'Search',
        'art.note': 'Results come from the selected museum API; 24 images per page with paging, thumbnails are cached locally.',
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
        'effect.hint': 'The window scrim covers the whole window; lower values reveal more wallpaper. Cards, dialogs and code stay solid.',
        'effect.reset': 'Reset to recommended',
        'effect.selfcheck': 'Self-check',
        'panel.title': 'Glass & transparency',
        'panel.desc': 'Only the composer card and the sidebar New session button get the glass; the header, the bottom status bar and both sides stay untouched.',
        'panel.enable': 'Enable glass',
        'panel.alpha': 'Glass opacity',
        'panel.blur': 'Glass blur',
        'panel.hint': 'Both share one opacity and one blur; 0% opacity makes them fully transparent.',
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
      html[data-lww-active]::before{content:"";position:fixed;inset:-3rem;z-index:-1;pointer-events:none;
        background-image:linear-gradient(rgba(0,0,0,var(--lww-dim,0)),rgba(0,0,0,var(--lww-dim,0))),
          var(--lww-image,none);
        background-position:center;background-size:var(--lww-fit,cover);background-repeat:no-repeat;
        filter:blur(var(--lww-blur,0px))}
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
         The card is tinted directly instead of through
         --dsw-specific-input-major, so other cards keep their own surface.
         Selectors match the official CSS-module class suffixes
         (<hash>_localName); a build hash change keeps them working.
         ================================================================== */
      html[data-lww-glass] [class*="_composerSeat"] [class*="_card"],
      html[data-lww-glass] [class*="_composerHero"] [class*="_card"]{
        background-color:rgba(var(--lww-scrim-rgb,255,255,255),var(--lww-panel-a,0))!important;
        -webkit-backdrop-filter:blur(var(--lww-panel-b,0px)) saturate(1.06);
        backdrop-filter:blur(var(--lww-panel-b,0px)) saturate(1.06)}
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
         Settings nav icon. The shell picks a nav glyph by section id and has
         no icon seat for third-party sections, so every unknown id (ours)
         gets the gear of general settings. The Client half marks our row with
         data-lww-nav and paints its own glyph, so the colour still comes from
         the row text (light/dark, hover and the active row all follow). The
         box is 16x16 because the shell renders every built-in glyph with
         size: 16 — anything larger also pushes the label right, so the row no
         longer lines up with the others. If the official rows change,
         decorateSettingsNav matches nothing and the gear stays — nothing breaks.
         ================================================================== */
      [data-lww-nav]{
        --lww-nav-icon:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3.25' y='5.25' width='17.5' height='13.5' rx='2.4' fill='none' stroke='black' stroke-width='1.9'/%3E%3Ccircle cx='8.6' cy='9.6' r='1.45' fill='black'/%3E%3Cpath d='M3.4 17.6 9.1 12l3 3.1 2.6-2.5 6.2 5z' fill='black'/%3E%3C/svg%3E")}
      @supports ((mask-image:linear-gradient(black,black)) or (-webkit-mask-image:linear-gradient(black,black))){
        [data-lww-nav]>svg{display:none!important}
        [data-lww-nav]::before{content:"";flex:none;width:16px;height:16px;
          background-color:currentColor;
          -webkit-mask:var(--lww-nav-icon) center/contain no-repeat;
          mask:var(--lww-nav-icon) center/contain no-repeat}
      }

      .lww-page{width:100%;max-width:100%;box-sizing:border-box;padding:2px 0 32px;
        color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
      .lww-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:0 0 14px}
      .lww-head-body{min-width:0}
      .lww-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
      .lww-desc{margin:5px 0 0;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-width:46ch}
      .lww-enable{display:flex;align-items:center;gap:8px;flex:none;padding-top:3px}
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
          root.style.setProperty('--lww-blur', `${Number(next.blur) || 0}px`)
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
      return {
        found: true,
        card: describeElement(card),
        backdropFilter: String(style.backdropFilter || ''),
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
          windowsTitlebar: root.hasAttribute('data-windows-titlebar'),
          platform: root.getAttribute('data-platform'),
          dark: document.body ? document.body.hasAttribute('data-ds-dark-theme') : null,
        },
        styleTag: Boolean(document.getElementById('dsh-lightweight-wallpaper-styles')),
        tokens,
        navIcon: probeSettingsNav(),
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
          centerCol: describeElement(pick('[class*="_centerCol"]')),
          sidebarCol: describeElement(pick('[class*="_sidebarCol"]')),
          conversationRoot: describeElement(pick('[data-slot="conversation.session"]')),
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
     * kept apart from the three upstream sources by a hairline, because a file
     * already on disk is not a source — it is a shortcut back to one.
     */
    function SourceTabs(props) {
      const tabs = [
        ['history', props.t('history.title')],
        ['bing', props.t('source.bing')],
        ['art', props.t('source.art')],
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
        h('div', { className: 'lww-note lww-gap' }, t('art.note')),
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
            h('p', { className: 'lww-desc' }, translate('page.desc')),
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
          h('div', { className: 'lww-note lww-gap' }, translate('effect.hint')),
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
                h('div', { className: 'lww-note lww-gap' }, translate('panel.hint')),
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
        return ctx.on('theme/change', (snapshot) => visual(state, snapshot))
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
