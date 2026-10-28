# 优化报告 · SillyTavern Card Forge v0.2

日期：2026-10-28（Asia/Shanghai）  
仓库路径：`/workspace/sillytavern-card-forge`  
范围：纯本地前端（无构建链），在保持 V1/V2/V3 · PNG · 世界书无损往返的前提下修 bug、补半成品、改体验。

---

## 改了什么

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
7. **未 push / 未开 PR**：本地可 commit；GitHub 需用户登录后再推送。

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

