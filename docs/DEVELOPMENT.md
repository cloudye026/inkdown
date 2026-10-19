# Inkdown 开发文档

面向改动这个项目的人：架构、性能数据、打包细节、验证方式，以及**踩过的每一个坑**。

> 用户向的介绍、功能清单、下载与安装见 [README](../README.md)。
> 版本变更见 [CHANGELOG](../CHANGELOG.md)。

## 架构
```
src/
  services/          无 DOM 依赖或纯逻辑，可单测
    mdcore.ts        标题扫描、列表缩进/标记、滚动同步计算、节流、结构自检
    markdown.ts      marked 管线：消毒 → 公式 → 贴标题行号
    themes.ts        主题注册表（配色 + Shiki 主题名 + 预览色块）
    palette.ts       搜索面板的结果构建（命令 + 文件，纯逻辑可单测）
    blockCache.ts    内容指纹、LRU 缓存、增量更新的前后缀计算
    highlight.ts     Shiki 懒加载（WASM 引擎 + JS 引擎兜底）
    previewRender.ts 代码高亮与 Mermaid 的增强阶段（按主题 + 内容缓存）
    fs.ts            Tauri 命令封装
    pathUtils.ts     路径拼接/比较（跨平台分隔符）
  store/             zustand：docs（文档与标签）、settings、ui（弹窗/菜单）
  editor/            CodeMirror 装配、主题、装饰
  components/        界面组件
  commands/          命令注册表 + 文件操作流程
src-tauri/src/lib.rs  后端：文件 IO、编码探测、目录扫描、外部变更监听
```

几条贯穿全局的原则：

- **纯逻辑与 DOM 分离**：`mdcore.ts` 不碰 DOM，所以滚动同步、列表缩进这些最容易出错的
  计算可以直接跑单测，不用起浏览器。
- **输入路径上不放重活**：见下文「性能」。
- **失败要看得见**：高亮降级、图表渲染失败、保存失败都会给出可见提示，
  而不是只写 console —— 用户看不到的错误等于没有错误。

---

## 性能
输入延迟是编辑器体验的全部。逐项量过、逐项改过：

| 环节 | 优化前 | 现在 |
| --- | --- | --- |
| `renderMarkdown`（消毒顺序） | 42.7 ms | **12.9 ms** |
| 预览重渲染频率 | 每次按键 | **80 ms 防抖** |
| 预览 DOM 更新 | 整棵重建（19–33 ms） | **只替换变化的块** |
| 代码高亮 / 图表 | 每次更新全部重做 | **按主题 + 内容指纹复用** |
| 大纲计算 | 每次按键 O(行数) | **只在显示大纲时算** |
| React 重渲染范围 | 整棵树（含所有编辑器） | **只更新相关组件** |

关键的一条：**消毒必须跑在公式渲染之前**。KaTeX 的 MathML 会把 HTML 从 4.1 KB 撑到
17 KB，让 DOMPurify 去解析它要多花 15 ms —— 而这段代码在每次输入的路径上。

---

## 打包与发布

### 发布流程（三平台安装包 → GitHub Release）

日常只走这一条路：

```bash
# 1. 改版本号（三处必须一致，CI 会校验）
#    package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
# 2. 更新 CHANGELOG.md
# 3. 打标签并推
git tag v0.3.1
git push origin v0.3.1
```

推上去之后 `.github/workflows/release.yml` 会：

| 阶段 | 做什么 |
| --- | --- |
| `guard` | 校验标签 `v0.3.1` 与 `package.json` 的 version 一致，不一致直接失败 |
| `build` | 在矩阵里的平台上各自原生构建，先跑类型检查与 318+15 个测试，任一失败就不出包 |
| `release` | 汇总全部安装包，生成 `SHA256SUMS.txt`，用 `scripts/release-notes.mjs` 从 CHANGELOG 摘出本版本说明作为正文，创建 Release 并挂上资产 |

**当前矩阵只启用 Windows 一路**（`windows-latest`）。macOS 的 arm64/x64 与 Linux 条目
以注释形式留在 `release.yml` 里，解开注释即可一起出 —— 首个版本先只发 Windows，
是因为这一路是唯一在本机反复验证过的，不会在发布时踩平台特有的打包问题。

产物清单：`*-setup.exe`、`*.msi`、`*_aarch64.dmg`、`*_x64.dmg`、
`*.AppImage`、`*.deb`、`*.rpm`、`SHA256SUMS.txt`。

**为什么发布未签名的包还要给校验和**：用户没法靠"发布者身份"判断文件有没有被改过
（这正是签名的用途）。给一份 SHA256 至少能确认下载链路没动手脚，
`certutil -hashfile <文件> SHA256`（Windows）或 `shasum -a 256 <文件>`（macOS）即可核对。

**发布说明为什么不用 GitHub 自动生成**：那只是把 commit 标题堆起来，对使用者没有信息量。
CHANGELOG 里已经认真写过"改了什么、修了什么"，所以改成从里面摘对应版本那一段
（`scripts/release-notes.mjs`，6 个用例覆盖版本号格式、段落边界、找不到时的兜底）。

**手动触发**（`workflow_dispatch`）只构建、不发布 —— 产物留在 Actions 的 Artifacts 里，
适合发版前先验证某个平台能不能过。

### 为什么必须用 CI 打 macOS / Linux

Tauri **不支持交叉编译**：

- macOS 的 `.app` / `.dmg` 需要 macOS 工具链（Xcode 命令行工具 + macOS SDK）；
- Linux 的 `.AppImage` / `.deb` / `.rpm` 需要 `libwebkit2gtk-4.1` 等系统库。

在 Windows 上产不出这两个平台的可用包 —— 这是平台限制，不是配置问题。

几个容易踩的 CI 细节：

| 细节 | 原因 |
| --- | --- |
| Linux 用 `ubuntu-22.04` 而不是 `ubuntu-latest` | AppImage 里的 glibc 符号向旧的看齐；在 24.04 上打出来的包在旧发行版上报 `GLIBC_2.39 not found` |
| 额外装 `rpm` | 出 `.rpm` 需要 `rpmbuild` |
| macOS 两个 target 都装 | 即使只打一个架构，tauri 也可能按需查另一个 |
| `permissions: contents: write` | 不加这一条，`GITHUB_TOKEN` 只能读，建不了 Release |
| Release 单独一个 job | 矩阵里几个 job 同时去建同一个 Release 会撞车 |

### 在本机打 Windows 包（调试用）

```bash
npm run app:build              # targets: "all" → MSI + NSIS
npx tauri build --bundles nsis # 只打 NSIS（推荐，无需下载 WiX）
npx tauri build --bundles msi  # 只打 MSI（需从 GitHub 下载 WiX 工具链）
```

| 产物 | 路径 | 体积 |
| --- | --- | --- |
| 免安装便携版 | `src-tauri/target/release/Inkdown.exe` | ~9 MB |
| NSIS 安装包 | `src-tauri/target/release/bundle/nsis/Inkdown_<版本>_x64-setup.exe` | ~5.5 MB |
| MSI 安装包 | `src-tauri/target/release/bundle/msi/Inkdown_<版本>_x64_en-US.msi` | ~6.3 MB |

NSIS 安装包按**当前用户**安装（`installMode: "currentUser"`），不需要管理员权限；
界面语言支持简体中文与英文。

> 打包器需要从 GitHub 下载 WiX/NSIS 工具链。这台机器访问
> `github.com/.../releases/download/...` 时通时不通——**网络不通时这一步会
> `timeout: global` 失败，但 `Inkdown.exe` 已经编译完成且可直接使用**。
> 遇到这种情况重跑一次，或配置代理后再执行。NSIS 的工具链通常已缓存，
> 所以 `--bundles nsis` 比 `msi` 稳。

### 在 Mac 上手动打（CI 不可用时）

```bash
xcode-select --install     # 只需一次
npm install
npx tauri build --target aarch64-apple-darwin   # M 系列
npx tauri build --target x86_64-apple-darwin    # Intel
```

> **签名与公证**：未签名的 `.dmg` 在 macOS 上打开会被 Gatekeeper 拦（提示"已损坏"或
> "无法验证开发者"）。要正式分发需要 Apple Developer 账号，并设置
> `APPLE_CERTIFICATE` / `APPLE_ID` / `APPLE_TEAM_ID` 等环境变量后再打包。
> 临时自用可以 `xattr -dr com.apple.quarantine /Applications/Inkdown.app` 绕过。

### Linux 包

`bundle.targets: "all"` 会产出 AppImage + deb + rpm。deb 的依赖**不要**手写
`depends: []` —— 那会声明"没有依赖"，装到没有 webkit2gtk 的机器上能装上却起不来。
删掉这个键，让 Tauri 用默认依赖（`libwebkit2gtk-4.1-0`、`libgtk-3-0` 等）。

### 跨平台注意事项（已在代码里处理）

| 事项 | 处理 |
| --- | --- |
| 本地图片地址 | 用 Tauri 的 `convertFileSrc`：Windows 是 `http://asset.localhost/…`，macOS/Linux 是 `asset://localhost/…`。**不能硬编码** |
| DOMPurify 协议白名单 | 默认不含 `asset:`，会把 macOS 上图片的 `src` 整条删掉 → 已在 `ALLOWED_URI_REGEXP` 里补上 |
| 路径分隔符 | 拼接时按目标目录的风格选择 `\` 或 `/`；比较路径时统一归一化并忽略大小写 |
| 后端 | 只用 `std::fs` / `walkdir` / `encoding_rs` / `chardetng` / `trash`，**无平台专有代码** |
| 图标 | `icons/icon.icns`（macOS）、`icons/icon.ico`（Windows）都已就位 |
| 回收站 | `trash` crate 在 Windows 是回收站、macOS 是废纸篓 |
| 显示位置 | 自己实现 `reveal_path`：Windows `explorer /select,`、macOS `open -R`、Linux `xdg-open` |

---

## 验证方式
三层，从便宜到昂贵：

| 层 | 手段 | 覆盖什么 | 数量 |
| --- | --- | --- | --- |
| 1 | `npm test`（Node + jsdom） | 纯逻辑、渲染管线、编辑行为、文件流程、主题与配色 | 298 |
| 2 | `npm run rust:test` | 编码往返、原子写入真落盘、显示位置 | 15 |
| 3 | `scripts/app-verify-*.mjs`（CDP） | **真实 WebView 里**的观感与交互：配色、排版层叠、大纲跳转、文件树图标、改名 | 6 个脚本 |

第 1、2 层在 CI 里常规跑；第 3 层要手动起应用，因为它验的是"单测量不准"的东西——
CSS 层叠、实际渲染出来的像素、跨组件联动。

**为什么要第 3 层**：这个项目里最难的几个 bug 全都"单测全绿但观感是错的"：

- 换主题后代码块不变色（DOM 里早已没有 `pre.code-block`，单测每次都新建 DOM 所以测不到）
- 表格对齐被默认样式盖掉（jsdom 算不准 `align` 属性与作者样式的优先级）
- 点大纲不跳转（编辑器在预览视图下是 `display:none`，逻辑全都"正确"）
- 跳转位置偏 72px（`offsetTop` 的参照物是 `BODY`，只有真实布局能暴露）

### 在真实应用里验证渲染结果

配色、字体这类「只在画面上体现」的东西，光靠单测算不出最终观感。
`scripts/app-verify.mjs` 通过 **WebView2 的远程调试端口（CDP）** 连进正在运行的应用，
用页面内 JS 点击界面切换主题、读取**实际计算出的颜色**，并把代码块截图存成 PNG：

```powershell
# 1. 带调试端口启动（不需要动键鼠，全部由页面内 JS 驱动）
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
.\src-tauri\target\release\Inkdown.exe samples\demo.md

# 2. 另一个终端里跑验证
node scripts/app-verify.mjs
```

它会逐个切换主题、打印 `data-theme` / `data-font` / 代码块 class / 实际底色与 token 颜色，
并输出 `code-<主题>.png` 供肉眼确认。

**为什么要这样做**：之前排查"代码块颜色不对"时，单测全绿但真实观感仍是错的
（配色发白、换主题不重新高亮）。有了这条通道才能看到真实画面。
它只做只读查询 + 页面内点击，**不注入任何系统级输入**，因此不会影响你手头正在编辑的文件。

### 验证大纲导航

`scripts/app-verify-outline.mjs` 专门验证「点大纲 → 跳转」这条链路：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
.\src-tauri\target\release\Inkdown.exe samples\demo.md
node scripts/app-verify-outline.mjs
```

它按三件事打分，任一项不过就以非零码退出：

1. 预览视图下点若干节 → 预览**真的滚动**了，且目标标题落在视口顶部 0–60px；
2. 点完之后大纲高亮**跟到所点那一节**（程序化滚动被有意排除在反向上报之外，
   所以这一步要由点击本身把高亮挪过去，容易漏）；
3. 手动滚到 0/25/50/75/100% → 大纲高亮与"页面自己算出的应高亮项"**逐点一致**。

**它对任意文档生效**：没有打开的标签时会自己从侧栏「最近打开」开一份
（没打开文档时工具会自动切到「文件」标签、必要时先展开侧栏），
标题少于 3 个就明确报错退出，而不是给出误导性的"通过"。

**为什么要专门做这个**：这条链路原来只滚编辑器，在预览视图下等于什么都不做；
而且第一版修好后仍会在"刚切换文档"的第一次点击上偏掉几百像素
（图片与 Shiki 还没稳定），只能靠真实应用里点击才测得出来。

### 验证排版细节

`scripts/app-verify-typography.mjs` 补的是"单测算不准"的那一类——**CSS 层叠**：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
.\src-tauri\target\release\Inkdown.exe samples\demo.md
node scripts/app-verify-typography.mjs
```

它往预览里临时插一张带 `:---` / `:---:` / `---:` / 无对齐 四列的表，读
`getComputedStyle(...).textAlign` 后立刻移除，确认对齐列**没有**被默认规则压成 `left`；
再检查每个代码块 `data-lang` 与 `::before` 的实际内容。

**一个坑**：WebKit 会把 `align` 这个表现性属性算成 **`-webkit-center` / `-webkit-right`**
（不是 `center` / `right`），断言前要去掉前缀，否则会误报失败。jsdom 复现不出这层，
所以只能在真实 WebView 里量。

### 验证文件树图标

`scripts/app-verify-tree.mjs` 检查图标是不是**真的画出来了**，而不只是加了 class：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
.\src-tauri\target\release\Inkdown.exe samples\demo.md
node scripts/app-verify-tree.mjs
```

它逐行打印"名称 / 图标种类 / SVG 元素数 / 计算出来的颜色"，并验三件事：
每行都真的有图形（`path`+`rect`+`circle` 数量 > 0）、**同级行名字左边缘完全一致**
（加了图标最容易破坏的就是对齐）、以及点开文件夹后图标从 `folder` 变成 `folder-open`。

类型分类本身（扩展名表）在 `scripts/fileKind.test.mjs` 里，7 个用例；
分类错了界面只会"图标长得不对"，肉眼很难发现，所以必须靠单测。

### 验证改名是否彻底

`scripts/app-verify-rename.mjs` 在真实应用里核对三件事：顶栏与窗口标题确实是新名字、
状态栏版本号不是过期值、**旧设置还在**（这条最重要——改名最容易把用户配置搞丢）。

```powershell
node scripts/app-verify-rename.mjs
```

改名时**刻意保留旧值**的两处：应用标识 `com.mddeveloper.app` 与设置存储键
`mddeveloper.settings`。它们只是"身份"与"存储位置"，改了会让已装版本失联、
配置在改名当天全部丢失。

### 界面结构的同样待遇

`scripts/ui-verify.mjs` 走同一条 CDP 通道，但查的是**交互结构**，不是配色：
顶栏还剩哪些按钮、切到预览时到底有没有分割条、编辑器切回来是不是同一个实例
（会被重建的话撤销历史就没了）、从搜索面板执行命令是不是真的改了文档、
设置弹窗是不是真的居中、左边四个分类能不能切换、点弹窗外面能不能关掉、
工作区根目录能不能收起再展开、`F5` 之后展开状态还在不在（而且整个前端没有被重载）、
**文件树的层级是不是真的画出来了**（导轨条数、逐层缩进、同级对齐、字重差）、
**展开箭头是不是矢量图标、收起与展开的旋转是否真的不同**、
**编辑器里标题是不是被分成了 token**（不是一整块纯文本），
以及**保存提示的语义**：有改动时保存提示一次，之后再按 `Ctrl+S` 不再提示。

```powershell
# 一定要在**临时工作区**里跑：脚本最后会真的按 Ctrl+S 写盘
$ws = "$env:TEMP\mddev-verify\samples"
Remove-Item $ws -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ws | Out-Null
Copy-Item samples\* $ws -Recurse -Force

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
$env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\mddev-verify-profile"   # 别污染你正在用的设置
.\src-tauri\target\release\Inkdown.exe --workspace $ws "$ws\demo.md"
node scripts/ui-verify.mjs
```

47 项检查，失败会打印是哪一项、实测值是多少，并留下 `ui-*.png` 截图。
脚本可以**在同一个实例上连跑**：每一组都按"点一下应该翻转"来断言，
不依赖上一位用户（或上一次运行）留下的展开状态。

**为什么要这样做**：这一版的改动全是"删掉按钮、换个布局"，单测覆盖不到；
而"按钮删了、功能还在不在"这种事，只有真的点一遍才知道。

---

## 踩过的坑（都已加回归测试）
| 现象 | 根因 |
| --- | --- |
| **换主题后代码块不变色（"颜色不对"）** | **真正的主因，而且是两层。** ① `enhancePreview` 从 `<html data-theme>` 读主题，而那个属性是 App 的 effect 写的；React 的 effect 顺序是**子组件先跑、父组件后跑**，所以预览先执行、读到的是**上一个主题**。② 更隐蔽：第一次增强后 DOM 里**已经没有 `pre.code-block`**（被 Shiki 输出替换），而 `enhancePreview` 只处理 `pre.code-block`；换主题时 HTML 一个字没变，增量更新判定"无需改动" → **没有任何块被重新高亮**，代码块一直沿用旧配色（切到浅色主题时，深色主题的浅色 token 压在浅底上对比度只有 1.0–1.7，几乎看不见）。修法：主题由调用方**显式传入**，且主题变化时**强制整棵重建**把 `pre.code-block` 还原出来。Mermaid 配色也改从主题注册表取（CSS 变量同样滞后）。`scripts/previewThemeSwitch.test.mjs` 在同一棵 DOM 上连续两步复现并锁住 |
| **浅色主题下代码块底色不对** | 变量名是 `--bg-sunken`（下沉），但我为让 token"贴近 Shiki 原底色"把 Catppuccin Latte 与 Solarized 浅色的代码块底色调成了**比页面更亮**，看起来像被高亮。中途还为了迁就 token 可读性把它调成"只比页面暗一点点"，结果代码块几乎与页面糊在一起。最终方案：**用官方下沉色**（Catppuccin 的 `crust`、Solarized 的 `base2`，Δ≈-0.13，与 GitHub 浅色同量级），token 由 `colorReplacements` 兜底。测试卡方向：15 套主题的代码块底色必须都比页面暗 |
| **浅色主题下代码 token 像没上色** | 官方配色里的浅色 token 压在浅底上对比度只有 2.2–2.8（Latte 的黄 `#df8e1d` 2.19、Solarized 浅色的青 `#2aa198` 2.78），**默认前景色**也偏弱（Solarized 浅色 `#657b83` 3.92）。修法：用 Shiki 的 `colorReplacements` **保持色相压暗**到达标。⚠️ 它是**全文替换**，表里混进背景色会把 `background-color` 一起改坏——测试拦这个。另外 `<pre>` 与 `.shiki` 统一用 `--bg-sunken` |
| **打包后代码高亮全部消失（开发模式正常）** | Shiki 3 的默认引擎是 **oniguruma WASM**（`WebAssembly.instantiate`），而 CSP 是 `script-src 'self'` —— **没有 `'wasm-unsafe-eval'`，WASM 编译会被拦掉**，高亮静默降级成纯文本。**开发模式看不出来**：dev 走外部开发服务器（`devUrl`），Tauri 无法给它注入 CSP，只有打包后的 asset 协议才应用。已在 CSP 补上 `'wasm-unsafe-eval'`，并让高亮失败时**弹出可见提示** |
| **按钮文字在部分主题下看不清** | 主/危险按钮是"填充色底 + 写死的白字"，而当时那 12 套主题里只有 2 套的强调色深到白字能读。Gruvbox 亮黄、Monokai 亮绿上白字对比度只有 1.7/1.6。改为由 `--accent-fg` / `--danger-fg` 提供文字色，并用测试按 WCAG 卡阈值 |
| **"在文件管理器中显示"打不开** | 用的是 `tauri-plugin-opener` 的 `revealItemInDir`。它在 Windows 上会先做"路径必须存在"检查，再由**父目录**构造 ITEMIDLIST，任何一步失败都只给一个含义模糊的错误，前端只能显示一句"打开失败"。改为自己实现 `reveal_path`：文件不存在时**降级为打开所在目录**，并把具体路径与原因回传给用户 |
| **打字发滞（输入时整棵树重渲染）** | `App` 订阅了 `docs` 数组，而它在**每次按键**时都会重建 → 敲一个键就重渲染整棵树（含所有编辑器实例）。改为：订阅只在增删文档时变化的 `order`；活动文档的文本/名称/冲突状态改成**只返回原始值**的细粒度订阅；编辑器订阅 `loadVersion`（只在内容被外部替换时变）而不是 `text` |
| **在代码块里按回车会删掉整行** | 我的"空标记行回车即退出"只看行的**文本**，没看**语法上下文**。写 Markdown 教程时代码块里必然出现单独的 `- `、`> `、`1. `（示例内容），于是回车把示例行整行删了。现在要求**语法树确认光标真的处于列表/引用节点内**才动手 |
| **标题锚点链接点不动 / 预览总是整块重画** | 标题 id 用**全局递增计数器**生成（`mdd-1`、`mdd-2`…），每次渲染都变。后果：① 预览的增量更新永远失效（第一块就不同，公共前缀恒为 0）；② 站内锚点链接在重渲染后断掉。改为**基于内容**生成、同文档内去重的稳定 id |
| **在代码块里按回车会插入 `> `** | 文档本身围栏坏了：样例文件里有一行被写成 `> [链接文字](…)```ts`，围栏与正文挤在一行 → 那个代码块**根本没被识别成代码块**，内容被当成引用。已修复文件，并新增「结构自检」按钮专门查这类问题 |
| **打字卡顿、空格像没生效** | 四个叠加原因：① 每次按键都**同步**重渲染整个预览；② 渲染管线里**消毒跑在公式之后**——KaTeX 的 MathML 把 HTML 从 4.1 KB 撑到 17 KB，DOMPurify 从 8.7ms 涨到 24ms；③ 编辑器里每键还跑一遍 `scanHeadings`；④ 预览每次更新都**重新高亮所有代码块、重画所有图表**。现在：先消毒小 HTML 再插入公式、预览 80ms 防抖、大纲按需计算、块结果按主题+内容指纹缓存、预览**增量更新** |
| **空引用行回车不退出引用** | 与列表同源：CodeMirror 只在特定条件下才去掉标记，紧邻时保留 `> `，于是回车变成嵌套引用。已把"空标记行"的处理扩展到引用层级与嵌套情形（`> - `、`1. `） |
| **按回车预览不跟着走** | 编辑时光标移动了，但光标还在可视区内时编辑器**不滚动**，也就没有滚动事件可转发。改为在光标明显移动（移出可视区或跨 3 行以上）时一并上报 |
| **空列表项上按回车不退出列表** | CodeMirror 的 `insertNewlineContinueMarkup` 只在"前面有空行 / 已是第二项之后"等条件下才去掉标记，两项紧邻时会插入空行并**保留标记** `- `。自己补一条优先级更高的 Enter 绑定：空标记行整行清掉 |
| **预览区与编辑器不同步** | 旧实现遇到**没有标题**的文档直接 `return`，表现为完全不动；锚点内部还用硬编码 `26px/行` 推算（实际约 29.6px），必然漂移。另外节流**丢掉了最后一次事件**，预览永远差一点。改为：无标题时按比例同步、有标题时用锚点间实际像素插值、节流带尾补发 |
| **列表第 N 项掉出去、还变成代码块** | 编号标记后没空格（`8.发票…`）。**CommonMark 认这种写法，marked 不认**，会把它当段落；再叠加缩进就被当成缩进代码块。渲染前统一补上空格（跳过代码块） |
| **提示"已保存"但文件没变** | `save()` 里有一句"内容与已保存一致就 `return true`"的提前返回。一旦内存脏标记与磁盘状态不同步（文件被外部程序改过就会），就会**什么都不写却报成功**。显式保存现在永远真写盘；报告成功严格绑定真实写入结果 |
| 点"新建"没反应、也没有提示 | `window.prompt` 在 WebView2 里被静默禁用（不弹窗、直接返回 null），改成自绘对话框 |

---

## README 的写法约束

README 顶部的标题、徽章与导航全部用**纯 HTML**（`<h1 align="center">`、`<p>`、`<a><img></a>`），
不是偷懒，是两个真实限制：

1. **放在 `<div>` 里的 markdown 语法在 GitHub 上不会被解析** —— `# 标题` 会原样显示成
   `# Inkdown · 墨下`。GitHub 对 raw HTML 块内的内容不做 markdown 处理。
2. **本应用开着「软换行断行」时，裸 markdown 链接的换行会变成 `<br>`**：
   五个徽章各占一行会被渲染成一根一行竖着堆（截图为证）。写成 `<p align="center">`
   里的行内 `<a><img></a>` 就没有这个问题。

顺带两个坑：

- **徽章别用 `.markdown-body img { display: block }` 那种全局规则**——它会把同一段里的
  一排徽章撑成竖列。样式只对 `p > img:only-child` 生效（`scripts/imageLayout.test.mjs` 守这条）。
- **`<img src="相对路径">` 必须能被解析**。marked 的 `image()` 只处理 `![]()`，
  raw HTML 的 `<img>` 不经过它，于是相对路径在预览里是碎图（`scripts/imagePath.test.mjs` 守这条）。

## 开发者注意事项
- **不要用 PowerShell 改源码或文档文件**。`Get-Content` / `Set-Content` 会按系统
  ANSI 编码读写 UTF-8，导致中文乱码、**字节不可逆丢失**，还会加上 BOM。
  一律用编辑器或写文件工具操作。这条已被踩过两次，每次都损坏过文件。
  只读地用 `Get-Content` 看也是同样的坑：它会把 UTF-8 显示成乱码，看着像文件坏了。
- 跑测试用 `npm test`；单独跑某个文件：
  `node --import ./scripts/ts-resolve.mjs --test scripts/<名字>.test.mjs`
- 测试里的 React/jsdom 部分较慢（占整体大部分时间），排查纯逻辑问题时可以只跑单个文件。
- 用 `node -e "..."` 传内联脚本时，**整段会先被解析**：任一处的引号被 shell 吃掉就整段不执行
  （看起来像"什么都没发生"）。带引号、反引号或路径的脚本一律写成 `.mjs` 文件再跑。
- 改 `productName` / Cargo 包名后**两处要保留旧值**：应用标识 `com.mddeveloper.app`
  与设置存储键 `mddeveloper.settings`。理由见「验证改名是否彻底」。
