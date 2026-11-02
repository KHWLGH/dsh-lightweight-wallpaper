# dsh-lightweight-wallpaper · 轻量壁纸

给 DeepSeek Harness 的轻量壁纸插件：**必应每日图 + 维基共享艺术 + 克利夫兰 CC0 馆藏 + 本地上传**，零运行时依赖、零构建步骤、不打包任何图片。壁纸铺满整窗，卡片与弹窗保持实心可读，只为输入框卡片和「新会话」按钮加一层毛玻璃。

## 功能

**壁纸与显示**

- **四种来源**：必应每日（最近 16 天，可选地区）、维基共享（公共领域名画，可搜索/预设）、克利夫兰艺术博物馆（CC0）、本地上传。
- **整窗壁纸 + 四个全局参数**：壁纸铺在最底层，画布与侧栏透出、卡片与弹窗保持实心；填充方式（铺满/适应）、整窗遮罩、压暗、壁纸模糊都可调，滑杆所见即所得。
- **毛玻璃**：只给输入框卡片和侧栏「新会话」按钮上玻璃，两者共用一组浓度/模糊；关掉总开关即恢复实心。
- **浅色对比度开关**：无毛玻璃处的次要灰字、小字整体加深两档；深色主题与关闭壁纸时不生效。
- **弹层可读性**：壁纸开启时，输入框「+」菜单、模型选择等弹层改为接近实心并加背景模糊，小字不再糊在壁纸上。
- **深浅主题同步**：遮罩颜色跟随系统深浅主题（含「跟随系统」），切换时不会停在上一套配色。

**选择壁纸**

- **翻页浏览**：艺术页每页 24 张，维基共享可持续翻页、克利夫兰带「共 N 张」总数；必应每日图分 2 页（最近 16 天）。换来源、换预设或重新搜索自动回到第 1 页。
- **8 个艺术预设**：梵高、莫奈、印象派、中国山水、浮世绘、文艺复兴、维米尔、克林姆特，**固定一行**，也可直接输入任意画家/作品/流派。
- **本地壁纸**（默认标签）：列表就是磁盘上的本地图片——下载的与上传的都在这里，最多 **20** 张，按最近使用排序，点一下立刻换回。文件不存在（手工删掉、被挤出或清过缓存）的条目下次读取时自动移除，磁盘上已存在但没记录的图片也会自动补回。

**数据与缓存**

- **本地缓存**：应用过的图片存到 `$DSH_HOME/lightweight-wallpaper/assets/`，断网也能显示；上游失败时回放上次成功的列表，仍有《星空》兜底条目。
- **缩略图缓存**：列表缩略图落到 `thumbs/`，二次进入设置页和重启后都秒出；格子图按 **500px** 取，取不到时回退到列表给的原始 URL。
- **缓存管理**：显示本地壁纸 / 缩略图 / 列表缓存的数量与占用，可分别清理，也可「全部清理」（点一次按钮变「确认清理」，再点执行，点到别处自动取消）。清理**永远保留当前壁纸与全部设置**。
- **每日自动更换**：开启后每次启动取当天的必应每日图并缓存到本地。
- **设置持久化在宿主**：端口变化、换浏览器都不会丢。

## 安装

本仓库就是一个可直接安装的 bundle 目录：

```bash
dsh plugin --profile desktop add "<本目录绝对路径>"
```

或在 Plugin Manager 里选择本地目录安装。**首次安装/启用**需要完整重启一次 Harness；装好之后的代码改动不再需要重启，见「开发（免重启）」。

## 使用

设置 → **壁纸**。页面分三组：

- **壁纸**：顶部总开关、当前壁纸、选择壁纸（本地壁纸 / 必应每日 / 艺术馆藏 / 上传）。
- **显示**：显示效果（卡片底部是「自检 / 恢复推荐值」）、毛玻璃、每日自动更换。
- **数据**：缓存占用与清理。

所有参数自动保存；点任意缩略图即应用。

## 默认参数

| 参数 | 默认 | 说明 |
|---|---|---|
| 填充方式 | 铺满 | 也可选「适应」 |
| 整窗遮罩 | 62% | 全窗基础遮罩，越低壁纸越明显（30–100%） |
| 压暗 | 18% | 在壁纸上叠一层暗色，保证正文对比度 |
| 壁纸模糊 | 0 | 0–24px |
| 毛玻璃 | 开 | 输入框卡片 + 「新会话」按钮 |
| 毛玻璃透明度 | 55% | 0–100%，两处共用；0% 即完全透明 |
| 毛玻璃模糊 | 24px | 0–40px，两处共用 |
| 浅色增强文字对比 | 开 | `label-secondary` / `label-tertiary` / `label-caption` 各加深两档 |

## 来源与许可

| 源 | 接口 | 许可 | 备注 |
|---|---|---|---|
| 必应每日 | `HPImageArchive.aspx` | 微软声明仅限壁纸用途 | 不提供下载/导出按钮 |
| 维基共享 | `commons.wikimedia.org/w/api.php` | 公共领域 / CC | 只用 960/1920 缩略图，不直链原图 |
| 克利夫兰 | `openaccess-api.clevelandart.org` | **CC0** | 只取 `share_license_status = CC0` 的条目 |

缩略图上显示作者与许可，应用后设置页顶部也保留来源与版权信息。

## 数据位置

```
$DSH_HOME/lightweight-wallpaper/
├── state.json            当前壁纸与参数
├── history.json          本地壁纸列表（最多 20 条，含下载与上传）
├── assets/<sha1>.jpg     已下载图片（最多保留 20 张，内容哈希去重）
├── thumbs/<sha1>.img     列表缩略图临时缓存（7 天 TTL，最多 240 张 / 48MB）
├── art-cache.json        最近成功的艺术列表（按来源/关键词/页码，最多 16 组）
├── bing-<mkt>-<idx>.json 上次成功的必应列表（接口失败时兜底）
└── selfcheck.json        最近一次自检报告（点「自检」或启动时自动写入）
```

浏览器 `localStorage` 只存一份“首屏绘制缓存”，不作为事实来源。

## 自检

设置 → 壁纸 →「显示效果」底部 **「自检」**：把壁纸层、遮罩层、官方容器（frame / 侧栏 / 内容列 / 输入区 / 新会话按钮）的计算样式、毛玻璃与对比度状态、主题一致性、不透明面清单与鼠标位置的元素堆栈写到 `selfcheck.json`；页面每次启动也会自动写一次。排查「壁纸看不到 / 白边 / 毛玻璃没生效」时先看它：

- `--dsw-alias-bg-base` 与 `--dsw-specific-sidebar-fill` 应为 `rgba(0,0,0,0)`，`html::after` 是唯一的基础遮罩，`html::before` 的 `background-image` 指向本地 asset；
- `scheme.paint / service / colorScheme` 应与 `scheme.bodyDark` 一致，`scrim.matches` 与 `glassTint.matches` 在壁纸开启时应为 `true`；
- `glassVariables` 在浅色 + 对比开关打开时 `labelSecondary / labelTertiary / labelCaption` 为 `#353638` / `#43454a` / `#61666b`，`menuSurfaceFill` 为 `#f8f9faf0`（浅）/ `#33343af0`（深）；
- `navIcon.matched / decorated` 为 `true` 说明导航图标装饰生效；`opaqueSurfaces` 出现意外条目就是「白块」的来源。

## 已知限制

- Windows 原生标题栏（约 40px）由 Electron 外壳绘制，页面 CSS 覆盖不到，会保持实色。
- 毛玻璃依赖官方 CSS-module 的类名后缀（`_composerSeat`、`_newSession` 等）；DSH 大版本改类名后需按自检报告更新选择器。
- 设置面板固定 800px 宽（内容列约 564px），因此插件设置页是单列布局。
- 环境禁用 `backdrop-filter` 时，毛玻璃只剩浓度遮罩、没有背景模糊，可读性不受影响。
- 浅色对比增强会同时加深弹窗/卡片里的次要灰字（官方 token 是全局的）；不想要时关掉开关即可。
- 少量写死颜色的官方控件不会透出壁纸；设置弹窗本身保持实心（刻意）。
- 本地上传只支持 JPEG / PNG / WebP；超过 6MB 会先在浏览器压到最长边 2560 再上传。
- 维基共享偶发 429/超时，列表显示上次成功结果；翻到很深的页时结果会随上游索引轻微漂移。
- 维基共享只接受标准缩略图宽度（20 / 40 / 60 / 120 / 250 / 330 / 500 / 960 / 1280 / 1920 / 3840），其它宽度会被判 `400`；插件把格子图吸附到最近档位（480 → 500px），仍失败再回退原始 URL。

## 开发（免重启）

改代码不用重启 Harness：

| 改的东西 | 生效方式 |
| --- | --- |
| `src/client.js` | 官方 Client HMR：保存后约 1 秒在页面里重新加载这个 bundle（`/plugins/events` SSE 每 500ms 比对文件 mtime/size），设置页开着就能看到变化，不用刷新 |
| `src/impl.js`、`src/sources.js` | 宿主入口 `src/index.js` 是稳定 shim：每 800ms 比对这两个文件，变了就 `import('./impl.js?rev=…')` 起新一代、dispose 旧一代，约 1 秒后新代码接管 |
| `src/index.js`（shim 本身）、`package.json`、`locale/*.json` 的 meta、`cordis.patch.yml` | 注册层，仍需重启一次 |

```bash
npm run dev     # = node tools/dev.mjs：保存即 node --check + 跑对应测试，红灯先修再保存
npm run check   # 手动跑 host-smoke + client-contract
```

- `src/impl.js` 用同一个 `?rev=` 动态导入 `sources.js`，所以改 `sources.js` 也会跟着热重载；宿主重载失败时保留上一代继续服务，只在插件日志里 warn。
- 版本号开发期固定在 **0.1.0**，不随每次改动递增（插件卡片显示的就是它）。

## 验证

```bash
node --check src/index.js && node --check src/impl.js && node --check src/client.js
node tools/host-smoke.mjs        # 37 项：Host 路由/缓存/历史（20 条 + 回填）/缩略图/入口 shim 与热重载生命周期
node tools/client-contract.mjs   # 13 项：包壳、注册契约、预设/翻页、卡片与版式、本地列表
node tools/probe-sources.mjs     # 上游连通性探针（需网络）
node tools/dev.mjs               # 开发循环：保存即语法闸门 + 对应测试
```

## 实现要点

- **只有一层基础遮罩**：官方容器的 `--dsw-alias-bg-base` / `--dsw-specific-sidebar-fill` 全部置透明，壁纸与遮罩都由插件自己画。
- **毛玻璃只画两处**：`[class*="_composerSeat"] [class*="_card"]` 与 `[class*="_newSession"]`，不改 `--dsw-specific-input-major` 之类的全局 token。
- **主题色取服务快照**：遮罩色 `--lww-floor` 来自 `theme/change` 载荷（其次 `ctx.theme.getTheme()`），玻璃底色 `--lww-scrim-rgb` 由 CSS 按 `body[data-ds-dark-theme]` 决定，另有一个 `MutationObserver` 兜底重画。
- **对比度走官方色阶变量**：浅色时 `label-secondary` 700 → 800、`label-tertiary` 600 → 750、`label-caption` 400 → 700，可随时关闭。

## 结构

```
src/index.js     宿主入口 shim：保持注册层稳定，监听下面两个文件并热重载 Host 半
src/impl.js      Host：同源路由、分页参数、历史记录、缓存统计/清理、上游/列表/缩略图缓存、图片代理、state 落盘
src/sources.js   纯函数：三个源的 URL 构造（含分页）、分页元信息、缩略图宽度、响应归一化
src/client.js    Client：壁纸层 + 整窗遮罩 + 毛玻璃、设置页（本地壁纸 / 缓存管理）、自检
tools/           冒烟测试、契约检查、连通性探针与开发循环（不随包发布）
```

## License

MIT。壁纸版权归各来源所有，本插件只做本地展示与缓存。
