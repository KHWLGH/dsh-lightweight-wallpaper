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
      autoBing: false,
      autoBingDate: '',
      market: 'zh-CN',
      wallpaper: null,
    }

    /** Same numbers as the Host default, exposed for the one-click reset. */
    const EFFECT_DEFAULTS = { fit: 'cover', dim: 18, blur: 0, opacity: 62 }

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
        'effect.blur': '模糊',
        'effect.opacity': '面板不透明度',
        'effect.hint': '面板越低越透出壁纸；卡片与弹窗始终保持实心以保证可读。',
        'effect.reset': '恢复推荐值',
        'effect.selfcheck': '自检',
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
        'effect.blur': 'Blur',
        'effect.opacity': 'Panel opacity',
        'effect.hint': 'Lower panel opacity reveals more wallpaper; cards and dialogs stay solid for readability.',
        'effect.reset': 'Reset to recommended',
        'effect.selfcheck': 'Self-check',
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
         one scrim: html::after. */
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
      .lww-page{max-width:880px;margin:0 auto;padding:26px 4px 56px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
      .lww-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}
      .lww-title{margin:0;font-size:20px;font-weight:600}
      .lww-desc{margin:6px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary);max-width:560px}
      .lww-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px;margin-bottom:16px;background:var(--dsw-alias-bg-layer-1)}
      .lww-card-hd{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
      .lww-card-title{font-size:14px;font-weight:600}
      .lww-card-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
      .lww-switch{position:relative;width:40px;height:22px;border-radius:11px;border:none;background:var(--dsw-alias-border-l2);cursor:pointer;flex:none;padding:0;transition:background .15s}
      .lww-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
      .lww-switch>span{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
      .lww-switch[aria-checked="true"]>span{transform:translateX(18px)}
      .lww-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:14px}
      .lww-tab{border:none;background:none;padding:7px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
      .lww-tab.is-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
      .lww-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(152px,1fr));gap:10px}
      .lww-tile{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:0;overflow:hidden;background:var(--dsw-alias-bg-layer-2);cursor:pointer;text-align:left;color:inherit;font:inherit;aspect-ratio:16/10}
      .lww-tile:disabled{cursor:default;opacity:.7}
      .lww-tile img{width:100%;height:100%;object-fit:cover;display:block}
      .lww-tile.is-active{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .lww-tile-meta{position:absolute;inset:auto 0 0 0;padding:16px 8px 6px;background:linear-gradient(transparent,rgba(0,0,0,.74));color:#fff;font-size:11px;line-height:1.35;display:flex;flex-direction:column;gap:2px;pointer-events:none}
      .lww-tile-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-tile-credit{opacity:.82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
      .lww-chip{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:4px 11px;font:inherit;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
      .lww-chip.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
      .lww-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .lww-row:last-child{border-bottom:none}
      .lww-row-label{font-size:13px}
      .lww-row-hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
      .lww-range{flex:1;max-width:200px;accent-color:var(--dsw-alias-brand-primary)}
      .lww-num{width:58px;height:26px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px;padding:0 6px}
      .lww-select{height:28px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px;padding:0 6px}
      .lww-btn{height:30px;padding:0 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px;cursor:pointer}
      .lww-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
      .lww-btn:disabled{opacity:.55;cursor:default}
      .lww-btn.is-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
      .lww-actions{display:flex;align-items:center;gap:8px}
      .lww-input{height:28px;flex:1;min-width:0;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px;padding:0 8px}
      .lww-note{font-size:12px;color:var(--dsw-alias-label-secondary)}
      .lww-error{margin-top:10px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px}
      .lww-empty{padding:26px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
      .lww-current{display:flex;align-items:center;gap:12px}
      .lww-current-thumb{width:84px;height:52px;border-radius:8px;object-fit:cover;background:var(--dsw-alias-bg-layer-2);flex:none}
      .lww-current-body{min-width:0}
      .lww-current-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lww-fade{opacity:.72}
    `

    /* ------------------------------------------------------------------ */
    /* Store                                                              */
    /* ------------------------------------------------------------------ */

    let state = { ...DEFAULT_STATE }
    let ready = false
    let errorText = ''
    let busy = ''
    const listeners = new Set()
    let visualApply = () => {}
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
        return parsed && typeof parsed === 'object' ? { ...DEFAULT_STATE, ...parsed } : null
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
          state = { ...DEFAULT_STATE, ...data.state }
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
      const root = document.documentElement

      function clearTokens() {
        if (disposeTokenLayer) {
          disposeTokenLayer()
          disposeTokenLayer = null
        }
      }

      /** Theme-aware scrim so the single masked layer works in light and dark. */
      function floorColor(alpha) {
        const dark = document.body ? document.body.hasAttribute('data-ds-dark-theme') : false
        return dark ? `rgba(21,21,23,${alpha})` : `rgba(255,255,255,${alpha})`
      }

      return function applyVisual(next) {
        try {
          const wallpaper = next && next.enabled ? next.wallpaper : null
          if (!wallpaper || !wallpaper.asset) {
            root.removeAttribute('data-lww-active')
            root.style.removeProperty('--lww-image')
            root.style.removeProperty('--lww-fit')
            root.style.removeProperty('--lww-blur')
            root.style.removeProperty('--lww-dim')
            root.style.removeProperty('--lww-floor')
            clearTokens()
            return
          }
          root.setAttribute('data-lww-active', '')
          root.style.setProperty('--lww-image', `url("${wallpaper.asset}")`)
          root.style.setProperty('--lww-fit', next.fit === 'contain' ? 'contain' : 'cover')
          root.style.setProperty('--lww-blur', `${Number(next.blur) || 0}px`)
          root.style.setProperty('--lww-dim', String(((Number(next.dim) || 0) / 100).toFixed(3)))
          root.style.setProperty(
            '--lww-floor',
            floorColor(((Number(next.opacity) || 0) / 100).toFixed(3)),
          )
          if (!disposeTokenLayer) {
            disposeTokenLayer = theme.overrideTokens(PLUGIN_ID, {
              '--dsw-alias-bg-base': { light: 'rgba(0,0,0,0)', dark: 'rgba(0,0,0,0)' },
              '--dsw-specific-sidebar-fill': { light: 'rgba(0,0,0,0)', dark: 'rgba(0,0,0,0)' },
            })
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
      const { label, hint, value, min, max, step, unit, onChange } = props
      return h(
        'div',
        { className: 'lww-row' },
        h(
          'div',
          null,
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
          'aria-label': label,
          onChange: (event) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)))
          },
        }),
        h('span', { className: 'lww-card-sub' }, unit),
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
          asset: state.wallpaper && state.wallpaper.asset,
          source: state.wallpaper && state.wallpaper.source,
        },
        attributes: {
          lwwActive: root.hasAttribute('data-lww-active'),
          windowsTitlebar: root.hasAttribute('data-windows-titlebar'),
          platform: root.getAttribute('data-platform'),
          dark: document.body ? document.body.hasAttribute('data-ds-dark-theme') : null,
        },
        styleTag: Boolean(document.getElementById('dsh-lightweight-wallpaper-styles')),
        tokens,
        pseudo: { before: describePseudo(root, '::before'), after: describePseudo(root, '::after') },
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
            null,
            h('h1', { className: 'lww-title' }, translate('page.title')),
            h('p', { className: 'lww-desc' }, translate('page.desc')),
          ),
          h(
            'div',
            { className: 'lww-actions' },
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
            { className: 'lww-row' },
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
              null,
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
      ctx.effect(() => () => visual({ ...state, enabled: false }))
      // The scrim colour follows the active colour scheme.
      ctx.effect(() => {
        if (typeof ctx.on !== 'function') return () => {}
        return ctx.on('theme/change', () => visual(state))
      })

      const cached = readPaintCache()
      if (cached) {
        state = { ...DEFAULT_STATE, ...cached }
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
