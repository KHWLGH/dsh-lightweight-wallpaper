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

    const PRESETS = [
      { id: 'vanGogh', label: 'preset.vanGogh', query: 'Vincent van Gogh paintings' },
      { id: 'monet', label: 'preset.monet', query: 'Claude Monet paintings' },
      { id: 'impressionism', label: 'preset.impressionism', query: 'Impressionism painting' },
      { id: 'landscape', label: 'preset.landscape', query: 'Chinese landscape painting' },
      { id: 'ukiyoe', label: 'preset.ukiyoe', query: 'Ukiyo-e woodblock print' },
      { id: 'renaissance', label: 'preset.renaissance', query: 'Renaissance painting' },
    ]

    const DICTS = {
      zh: {
        'nav.title': '壁纸',
        'page.title': '壁纸与背景',
        'page.desc': '从必应每日图、维基共享艺术或克利夫兰 CC0 馆藏里选一张，也可以上传本地图片。壁纸会铺在窗口最底层，画布与侧栏按下方滑杆透出。',
        'enable': '启用壁纸',
        'source.title': '图片来源',
        'source.bing': '必应每日',
        'source.art': '艺术馆藏',
        'source.custom': '本地上传',
        'bing.market': '地区',
        'bing.refresh': '刷新',
        'bing.note': '必应每日图按本地日期提供最近 8 天，图片仅限个人壁纸用途。',
        'art.wikimedia': '维基共享（公共领域）',
        'art.cleveland': '克利夫兰（CC0）',
        'art.search': '搜索画家、作品或流派…',
        'art.searchBtn': '搜索',
        'art.note': '搜索结果来自对应馆藏接口，作者与许可显示在缩略图上。',
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
        'error.pick': '应用这张图失败',
        'error.upload': '上传失败',
        'busy.pin': '正在下载并缓存…',
        'busy.upload': '正在处理图片…',
      },
      en: {
        'nav.title': 'Wallpaper',
        'page.title': 'Wallpaper & background',
        'page.desc': 'Pick a Bing daily image, a public-domain artwork from Wikimedia Commons or a CC0 work from the Cleveland Museum of Art — or upload your own. The wallpaper sits behind the whole window; the canvas and sidebar reveal it through the sliders below.',
        'enable': 'Enable wallpaper',
        'source.title': 'Source',
        'source.bing': 'Bing daily',
        'source.art': 'Museum art',
        'source.custom': 'Upload',
        'bing.market': 'Region',
        'bing.refresh': 'Refresh',
        'bing.note': 'Bing serves the last 8 days for your date. Images are for personal wallpaper use only.',
        'art.wikimedia': 'Wikimedia Commons (public domain)',
        'art.cleveland': 'Cleveland Museum (CC0)',
        'art.search': 'Search an artist, work or movement…',
        'art.searchBtn': 'Search',
        'art.note': 'Results come from the selected museum API; artist and license are shown on each thumbnail.',
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
        'error.pick': 'Could not apply that image',
        'error.upload': 'Upload failed',
        'busy.pin': 'Downloading and caching…',
        'busy.upload': 'Processing image…',
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
      .lww-page{width:100%;max-width:100%;box-sizing:border-box;padding:2px 0 32px;
        color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
      .lww-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:0 0 14px}
      .lww-head-body{min-width:0}
      .lww-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
      .lww-desc{margin:5px 0 0;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-width:46ch}
      .lww-enable{display:flex;align-items:center;gap:8px;flex:none;padding-top:3px}
      .lww-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;
        padding:14px 16px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1)}
      body[data-ds-dark-theme] .lww-card{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1))}
      .lww-card:last-child{margin-bottom:0}
      .lww-card-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
      .lww-card-head-main{min-width:0}
      .lww-card-title{font-size:13.5px;font-weight:600;line-height:20px}
      .lww-card-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
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
      .lww-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
      .lww-chip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
        border-radius:999px;padding:3px 11px;font:inherit;font-size:12px;cursor:pointer;
        color:var(--dsw-alias-label-secondary);transition:color .12s,border-color .12s}
      .lww-chip:hover{color:var(--dsw-alias-label-primary)}
      .lww-chip.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);
        background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
      .lww-row{display:grid;grid-template-columns:minmax(88px,1fr) minmax(110px,1.7fr) 54px 20px;
        align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .lww-row:last-child{border-bottom:none}
      .lww-row-split{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .lww-row-main{min-width:0}
      .lww-row-label{font-size:12.5px}
      .lww-row-hint{margin-top:1px;font-size:11px;color:var(--dsw-alias-label-secondary)}
      .lww-unit{font-size:11px;color:var(--dsw-alias-label-secondary)}
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
      .lww-num{width:54px;height:26px;box-sizing:border-box;border-radius:7px;
        border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
        color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 4px;text-align:center}
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
      .lww-current{display:flex;align-items:center;gap:12px}
      .lww-current-thumb{width:92px;height:58px;border-radius:9px;object-fit:cover;flex:none;
        background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
      .lww-current-body{min-width:0}
      .lww-current-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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

    function tileImage(item) {
      return `${PREFIX}/proxy?u=${encodeURIComponent(item.thumb)}`
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

    function SourceTabs(props) {
      const tabs = [
        ['bing', props.t('source.bing')],
        ['art', props.t('source.art')],
        ['custom', props.t('source.custom')],
      ]
      return h(
        'div',
        { className: 'lww-tabs', role: 'tablist' },
        tabs.map(([id, label]) =>
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
        ),
      )
    }

    function BingPanel(props) {
      const { t, state: current, disabled, pin } = props
      const [items, setItems] = useState([])
      const [loading, setLoading] = useState(true)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const load = useCallback(
        async (market) => {
          setLoading(true)
          setError('')
          setNote('')
          try {
            const data = await api(`/bing?mkt=${encodeURIComponent(market)}&n=8`)
            setItems(Array.isArray(data && data.items) ? data.items : [])
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
        load(current.market)
      }, [load, current.market])
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'lww-actions', style: { marginBottom: 10 } },
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
          h('button', { type: 'button', className: 'lww-btn', disabled, onClick: () => load(current.market) }, t('bing.refresh')),
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
        error ? h('div', { className: 'lww-error' }, error) : null,
        note ? h('div', { className: 'lww-note', style: { marginTop: 8 } }, note) : null,
        h('div', { className: 'lww-note', style: { marginTop: 10 } }, t('bing.note')),
      )
    }

    function ArtPanel(props) {
      const { t, state: current, disabled, pin } = props
      const [source, setSource] = useState('wikimedia')
      const [preset, setPreset] = useState('vanGogh')
      const [query, setQuery] = useState(PRESETS[0].query)
      const [items, setItems] = useState([])
      const [loading, setLoading] = useState(true)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const load = useCallback(
        async (nextSource, nextQuery) => {
          if (!nextQuery.trim()) return
          setLoading(true)
          setError('')
          setNote('')
          try {
            const data = await api(
              `/art?source=${encodeURIComponent(nextSource)}&q=${encodeURIComponent(nextQuery)}&limit=24`,
            )
            setItems(Array.isArray(data && data.items) ? data.items : [])
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
        load('wikimedia', PRESETS[0].query)
      }, [load])
      const choosePreset = (next) => {
        setPreset(next.id)
        setQuery(next.query)
        load(source, next.query)
      }
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'lww-actions', style: { marginBottom: 10 } },
          h(
            'select',
            {
              className: 'lww-select',
              value: source,
              onChange: (event) => {
                const next = event.target.value
                setSource(next)
                load(next, query)
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
              if (event.key === 'Enter') load(source, query)
            },
          }),
          h(
            'button',
            { type: 'button', className: 'lww-btn is-primary', disabled, onClick: () => load(source, query) },
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
        error ? h('div', { className: 'lww-error' }, error) : null,
        note ? h('div', { className: 'lww-note', style: { marginTop: 8 } }, note) : null,
        h('div', { className: 'lww-note', style: { marginTop: 10 } }, t('art.note')),
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
        h('div', { className: 'lww-note', style: { marginTop: 8 } }, t('custom.hint')),
        preview
          ? h('img', { src: preview, alt: '', style: { marginTop: 12, maxWidth: '100%', maxHeight: 220, borderRadius: 10, display: 'block' } })
          : isUpload
            ? h('img', { src: current.wallpaper.asset, alt: '', style: { marginTop: 12, maxWidth: '100%', maxHeight: 220, borderRadius: 10, display: 'block' } })
            : null,
        error ? h('div', { className: 'lww-error' }, error) : null,
      )
    }

    function SettingsPage() {
      const value = useStore()
      const current = value.state
      const [tab, setTab] = useState('bing')
      const translate = useTranslate()
      const disabled = Boolean(value.busy) || !value.ready
      const price = current.wallpaper
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
          tab === 'bing' ? h(BingPanel, { t: translate, state: current, disabled, pin: pinItem }) : null,
          tab === 'art' ? h(ArtPanel, { t: translate, state: current, disabled, pin: pinItem }) : null,
          tab === 'custom' ? h(CustomPanel, { t: translate, state: current, disabled }) : null,
        ),

        h(
          'div',
          { className: 'lww-card' },
          h(
            'div',
            { className: 'lww-card-hd' },
            h('div', { className: 'lww-card-title' }, translate('effect.title')),
            h(
              'div',
              { className: 'lww-actions' },
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
          h('div', { className: 'lww-note', style: { marginTop: 10 } }, translate('effect.hint')),
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
                h('div', { className: 'lww-note', style: { marginTop: 9 } }, translate('panel.hint')),
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

      ctx.effect(() => ctx.locale.subscribe(() => emit()))

      ctx.effect(() => {
        const timer = setTimeout(() => sendSelfCheck('boot'), 1600)
        return () => clearTimeout(timer)
      })

      try {
        window.__dshLightweightWallpaper = { check: collectSelfCheck, report: sendSelfCheck }
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
