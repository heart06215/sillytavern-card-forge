# 优化报告 · SillyTavern Card Forge

日期：2026-10-28（Asia/Shanghai）  
仓库路径：`/workspace/sillytavern-card-forge`  
范围：纯本地前端（无构建链），在保持 V1/V2/V3 · PNG · 世界书无损往返的前提下修 bug、补半成品、改体验与 UI。

---


## v0.5 职责拆分 + 教程子页

### IA
- **「卡内世界书」**：只编辑当前角色卡绑定的 `character_book`；可从独立库「嵌入副本」。
- **「世界书」**：只编写独立世界书（不绑卡）；主操作是导入/导出独立 JSON；「复制到卡内」为次要入口并跳转卡内页。
- 两侧条幅与按钮文案明确「跟卡走」vs「不绑卡」，避免把库页当成卡内编辑器。

### 教程
- 新页签「❓ 教程」：左侧/顶部分块目录锚点跳转。
- 覆盖：两种世界书区别、新建角色卡、写卡内、写独立、嵌入副本、导出、日夜间、常用提示。
- 快捷键扩到 `Ctrl+1`–`8`。

### 文件
`index.html`、`app.js`、`style.css`、`card-model.js`、`test_model.js`、`README.md`、本报告

---

## v0.4 简化制卡步骤 + 世界书内嵌保证

### 问题
1. 从空白到可导出要跨很多页签，必填门槛与文案不够直白。
2. 「世界书库」与「卡内世界书」容易混淆：用户在库里写好书，却忘了嵌入，导出角色卡没有 `character_book` 内容。
3. 世界书有条目但未命名时不写 `extensions.world`，导入酒馆后难关联。
4. 导出校验只硬拦作品名 / 主开局，对「库里有书但卡内为空」silent 放行。

### UX / 流程
1. **顶栏步骤条**：作品名 → 主开局 → 内嵌世界书 → 导出；可点击跳转，旁白提示「下一步做什么」。
2. **作品页「最少三步」**：替代原先八层说明为主路径；八层细节仍可通过各页签完成（加分项不挡导出）。
3. **必填降到作品名**：主开局改为导出前确认；新建作品自动带默认条例并聚焦作品名。
4. **卡内世界书页置顶「内嵌到角色卡」面板**：状态下方拉框「从世界书库嵌入」+「嵌入到当前卡」+「快速常驻条目」；库页按钮改名为「嵌入到当前角色卡」。
5. **导出前校验**：卡内空但库中有书 → 可操作确认（取消则跳到内嵌页）；导出成功 toast 汇报内嵌条数。

### 内嵌保证（数据）
1. `ensureBookForExport`：有条目且书名为空时，用「作品名 + 世界书」自动命名（不重规范化条目，避免 extra 叠层）。
2. `toExportBundle` 始终写出完整 `data.character_book.entries` 全文，并同步 `extensions.world`。
3. 新增单测覆盖 V2/V3/PNG 读回均含条目全文与 world 名（`test_model.js` 现 177 项）。

### 文件
`card-model.js`、`app.js`、`index.html`、`style.css`、`test_model.js`、`README.md`、本报告

---
## v0.3.1 日间模式 + 夜间提亮

### 问题
夜间主题下顶栏尚可，主内容区（panels / tabs / inputs）偏闷、对比不足。

### 改动
1. **夜间提亮**：抬高 `--surface` / `--surface-2` / `--surface-3`，加强 `--border` / `--text` / `--muted`，绿色撞色略更醒目（`#2EE882`）；装饰网格透明度下调，避免灰雾罩住内容。
2. **日间模式**（白:红:黑 ≈ 6:3:1）：
   - 白/浅底 `#F4F4EF` / `#FFFFFF` / `#F7F7F2`
   - 红撞色 `#E03131`（hover `#F04343`，字色 `#C62828`）
   - 黑线条与正文 `#0A0A0A`
3. 顶栏「☾夜间 / ☀日间」切换；`html[data-theme="night"|"day"]` 覆盖同一套 CSS 变量；`localStorage.stCardForgeTheme_v1` 持久化；`<head>` 内联脚本防闪烁。
4. Logo SVG 改用 `var(--accent)` / `var(--line)`，两主题共用几何语言。

### 文件
`style.css`、`index.html`、`app.js`、`README.md`、本报告；预览 `docs/v0.3.1-theme-night.png` / `docs/v0.3.1-theme-day.png`

---
## v0.3 UI 主题（黑 / 绿 / #E9E9E4 · 构成主义 / 包豪斯）

### 色板（约 黑:绿:#E9E9E4 = 6:3:1）
| 角色 | 取值 |
|---|---|
| 背景 / 大面积 | `--bg #0a0a0a`、`--surface #121212` / `#161616` / `#1c1c1c` |
| 撞色强调 | `--accent #2BD576`、`--accent-hover #3EE88A`、`--accent-2 #6EE7A8`、`--accent-dark #1A9E52` |
| 线条 / 描边 | `--line #E9E9E4`（边框用其半透明变体） |
| 正文 | `#E9E9E4`；次要 `--muted` / `--faint` 为线条色半透明 |

### 视觉与交互
- CSS 变量集中定义；紫蓝旧强调色全部替换为绿色系。
- Primary：绿底黑字 + 偏置阴影；Ghost：黑底 + `#E9E9E4` 实线边；选中 tab / badge / focus ring 用绿。
- 圆角收紧（约 3–4px），贴近包豪斯直角语言；危险态仍保留偏红。
- **构成主义 / 包豪斯装饰**（纯 CSS / 内联 SVG，无外链图）：
  - 背景细线网格 + 斜带；右上角几何色块（不挡点击）
  - 顶栏底部分割条（绿 / 线交替）
  - 几何 Logo（方 / 圆 / 三角）+ 顶栏旁 geo-strip
  - 面板左上角标、空状态三角与角线、页签旁方框与绿点
- 微调：`index.html` Logo；`app.js` 状态栏模板与对话预览强调色对齐新主题（不影响编解码逻辑）

### 文件
- 主改：`style.css`
- 辅改：`index.html`、`app.js`（仅外观相关字符串）、`README.md`、本报告

---

## v0.2 改了什么

### 关键 Bug 修复
1. **`importNativeBookList` 未定义**  
   粘贴解析 JSON 世界书、以及顶栏导入原生世界书 JSON 时会调用该函数，但文件中只有 `importNativeBookIntoCurrent`，运行时直接 `ReferenceError`。现已补齐：导入到「世界书库」，并复用覆盖/追加确认逻辑。
2. **Emoji 显示为字面量 `U0001Fxxx`**  
   `index.html` / `app.js` 中粘贴解析按钮、弹窗标题、解析按钮、错误空状态、MD 存档提示等处的 Unicode 转义未写成真正字符，界面上显示成乱码文本。已改为 📋 / 🔍 / 🧩 / 📁。
3. **错别字「追加到末尿」→「追加到末尾」**（粘贴解析写入世界书确认框）。
4. **AI 面板提示的 bat 文件名错误**  
   「启动角色卡工具-兼容模式.bat」→ 实际文件名「启动制卡工具-兼容模式.bat」。
5. **卡内世界书 / 世界书库共用同一套 `bookView` 筛选状态**  
   一侧的搜索词与分类会污染另一侧列表。现拆为 `bookViews.card` / `bookViews.lib`，切换作品或世界书时按模式重置。
6. **死代码** `bkMode = toNew ? 'lib' : 'lib'` 简化为赋值 `'lib'`；修正 `init` 中一处缩进异常。

### UX / 无障碍
- 作品列表、世界书库增加空状态说明。
- 体检条：摘要与问题芯片可点击，跳转到对应页签并尝试聚焦相关控件；`health()` 增加 `tab` / `focus` 元数据。
- 页签：`role="tab"` / `tablist` / `tabpanel`、`aria-selected`、`tabindex`、`aria-hidden`。
- 粘贴弹窗：`role="dialog"`、`aria-modal`、`aria-labelledby`。
- 快捷键：与 7 个左侧页签对齐（`Ctrl+1`–`7`）；新增 `Ctrl+Shift+V` 打开粘贴解析（弹窗已开时改为直接解析）；弹窗打开时不再抢占 `Ctrl+S` / `Ctrl+Enter` / 切页。
- 作品页「八层」说明与 README 八层模型对齐；顶栏 tip 补充快捷键说明。
- 启动 bat 标题与文案统一为「酒馆卡锻造工坊」。

### 文档与测试
- README 升至 v0.2，补充优化摘要、快捷键、测试计数。
- `test_model.js` 增加体检 `tab` / `focus` 断言（+3）。
- 未改 `LICENSE`；未引入 npm 构建链。

---

## 删了什么 / 未删项

| 项 | 处理 |
|---|---|
| `test_card_output.png` | 测试产物，已清理（仍在 `.gitignore`） |
| 无用大段功能模块 | **未删**：粘贴解析、世界书库、统一前端、助手脚本等均为 README 承诺能力，仍在使用 |
| 重复的封面入口 | **保留**：作品页 / 侧栏 / 顶栏三处同步是有意设计 |

---

## 已知未做项（后续可继续）

1. **未做大规模拆分打包**：`app.js` 仍约 3k+ 行。可在不引入构建工具的前提下拆成多个 `<script>`（如 `ui-book.js` / `ui-paste.js`），但需仔细处理共享状态；本次优先修正确性与体验。
2. **预览仍不执行脚本 / 外链**：与 README「只能保留」一致；若要做「沙箱受限脚本预览」需单独设计。
3. **第三方扩展专用编辑器**（QuickReply 等）仍仅为原生 JSON 编辑。
4. **AI 扩写**：未改协议或提示词质量；仅修正兼容模式 bat 提示。
5. **移动端布局**：有基础 media query，未做专项适配。
6. **自动化 UI 测试**：仍依赖手动 / 无头浏览器；本次仅加固 Node 单测。
7. ~~未 push / 未开 PR~~：v0.2 已开 PR；v0.3 主题续推同一分支。

---

## 如何本地验证

```bash
cd sillytavern-card-forge
node test_model.js    # 期望：135 + 164 项全部通过
node test_card.js     # 期望：21 项全部通过

# 浏览器
# 双击 启动制卡工具.bat 或直接打开 index.html
# 建议手动点验：
# 1) 粘贴解析 → 粘一段带【地点】的文本 → 应用到作品
# 2) 粘贴 / 导入一份原生世界书 JSON（{entries:{...}}）→ 应进入世界书库且不报错
# 3) 卡内世界书搜索「xxx」后切到世界书库，两侧筛选互不影响
# 4) 清空作品名 → 体检条红芯片可点回「作品」页
# 5) Ctrl+Shift+V 打开粘贴弹窗；Esc 关闭
# 6) 生成 PNG / 导出 JSON 往返仍正常
```

---

## 关键改动文件

- `app.js` — 主逻辑修复与 UX
- `card-model.js` — `health()` 增加跳转元数据
- `index.html` — emoji、a11y、八层说明、bat 提示
- `style.css` — `.chip-go`、注释更名
- `test_model.js` — 体检断言
- `README.md` — v0.2 与能力对齐
- `启动制卡工具.bat` / `启动制卡工具-兼容模式.bat` — 产品名统一
- `OPTIMIZATION_REPORT.md` — 本报告

