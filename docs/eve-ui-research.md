# EVE 科幻风 UI 调研笔记

> 目的：为后续前端页面（Electron/Web）确立 EVE 风格的视觉规范与可复用设计令牌。
> 调研日期：2026-08-21

## 1. 参考软件清单

| 软件 | 形态 | 值得学习的点 |
| --- | --- | --- |
| [RIFT Intel Fusion Tool](https://gitlab.com/rift-intel-fusion-tool/rift-intel-fusion-tool/) | Kotlin Compose 桌面应用（开源） | **最重要的参考**。完整复刻了 EVE 游戏内 UI 的设计令牌：颜色、字体、间距、透明度窗口、文本投影。本文档第 3 节的令牌即提取自其源码 `compose/theme/` |
| [zkillboard](https://zkillboard.com) | Web | 深色底 + 表格密集型信息展示，击杀报告卡片式布局 |
| [EVE Workbench](https://www.eveworkbench.com) | Web | 现代 EVE 第三方工具，深色科幻风 + 舰船装配卡片 |
| [Pathfinder](https://github.com/goryn-clade/pathfinder) | Web（自托管） | 虫洞地图工具，签名表格 + 地图节点连线，EVE 风格弹窗 |
| [SeAT](https://github.com/eveseat/seat) | Web（自托管） | 军团管理后台，深色 AdminLTE 变体，可借鉴数据表格/权限分组 |
| [EVE-Ref](https://everef.net) | Web | 数据查询站，物品图标 + 属性的展示方式 |
| 游戏本体 Photon UI | — | 权威基准：CCP 2022 年重做的 UI，主色 cryo blue、深色半透明窗口、EVE Sans Neue 字体 |

## 2. EVE 科幻风的设计特征（提炼）

- **近黑深色底**：不是纯黑，是带青蓝色相的深灰蓝（`#070707` 窗口底、`#172327` 面板底）。
- **主色是"冷冻蓝"**：`#58A7BF`（cryo blue / focus blue），用于强调、选中态、边框高光，而不是常见 SaaS 的亮蓝。
- **文字几乎全是带透明度的白色**：`rgba(255,255,255,0.75)` 主文字、`0.5` 次级、`0.3` 禁用；高亮文字偏冰蓝 `#C3E9FF`。
- **细边框 + 微弱青蓝描边**：1px 边框，普通态 `#41707F`，高亮态 `#71BED3`， hover 才提亮。
- **链接用橙/金色而非蓝色**：`#D98D00`（hover `#FFB732`）——这是 EVE 游戏内链接的标志性配色。
- **语义色克制**：成功绿 `#8DC169`、危险红 `#FF454B`、警告橙 `#F39058`、Omega 金 `#FFC64A`。
- **字体**：EVE Sans Neue（CCP 官方 UI 字体），12/14/16/19/24px 五档字阶，所有文字带 1px 黑色硬投影（offset(1,1), blur 0, 50% 黑），小字加 0.5px 字距。
- **间距体系**：2/4/8/12/16/24 六档。
- **窗口可半透明**：EVE 窗口支持 40% 透明度叠加在游戏画面上；桌面工具（如 RIFT）保留了这个质感。
- **装饰性字体**：Triglavian 字体用于特殊氛围文本（可选）。

## 3. 设计令牌（提取自 RIFT 源码，已转成可直接用的形式）

配套的 `eve-theme.css` 已把以下令牌写成 CSS 变量，前端页面直接引用即可。

### 3.1 颜色

**背景层级（由深到浅）**

- `windowBackground` `#070707` — 窗口底色
- `mapBackground` `#0A0E15` — 地图/画布底色
- `backgroundPrimaryDark` `#0A1215` — 凹陷区/输入框
- `windowBackgroundSecondary` `#141414` — 次级面板
- `backgroundHovered` `#131C1F` — 悬停
- `backgroundPrimary` `#172327` — 主面板/卡片
- `backgroundSelected` `#355866` — 选中行
- `backgroundPrimaryLight` `#36525E` — 凸起的强调面板

**文字**

- `textHighlighted` `rgba(255,255,255,0.9)` / `textPrimary` `rgba(255,255,255,0.75)` / `textSecondary` `rgba(255,255,255,0.5)` / `textDisabled` `rgba(255,255,255,0.3)`
- `textSpecialHighlighted` `#C3E9FF` — 冰蓝高亮（如重要数值）
- 链接：`#D98D00` → hover `#FFB732`；外部链接 `#FFE400`；帮助链接 `#94CCFF`

**边框**

- `borderPrimaryDark` `#213841` → `borderPrimary` `#41707F` → `borderPrimaryLight` `#71BED3`
- 错误边框 `#FE5B61`；分隔线 `#1E2022`

**EVE 官方命名色板（EveColors）**

| 名称 | 值 | 用途 |
| --- | --- | --- |
| cryoBlue / focusBlue | `#58A7BF` | 主色 |
| primaryBlue | `#407196` | 次级蓝 |
| smokeBlue | `#305665` | 暗蓝 |
| iceWhite | `#C2E5F2` | 冰白 |
| successGreen / leafyGreen | `#8DC169` | 成功 |
| limeGreen | `#B2F84D` | 亮绿 |
| hotRed / dangerRed | `#FF454B` | 危险 |
| cherryRed | `#991F24` | 深红 |
| warningOrange | `#F39058` | 警告 |
| sandYellow | `#FFB845` | 离开/提示黄 |
| omegaYellow | `#FFC64A` | Omega 金 |
| plexYellow | `#FFCC00` | PLEX |
| auraPurple | `#956BEC` | Aura 紫 |
| airTurquoise | `#70F0E3` | 青绿 |
| evermarkGreen | `#CEFF01` | EverMark |
| burnishedGold | `#996A1F` | 暗金 |
| 灰阶 | `#000/#1A1A1A/#303030/#4D4D4D/#8A8A8A/#B0B0B0/#D9D9D9/#F2F2F2/#FFF` | coalBlack→platinumGrey |

### 3.2 字体与字阶

- 字体族：`EVE Sans Neue`（Regular / Italic / Bold / BoldItalic 四款字重文件）。CCP 官方字体，RIFT 仓库 `composeResources/font/` 内有 TTF；用于公开发布的项目需注意其授权（CCP 对第三方应用素材有[许可条款](https://developers.eveonline.com/license-agreement)）。
- 备选 Web 安全栈：`"EVE Sans Neue", "Segoe UI", "Noto Sans SC", sans-serif`
- 字阶：detail 12px（+0.5px 字距）/ body 14px / header 16px / headline 19px / display 24px
- **文字投影**：`text-shadow: 1px 1px 0 rgba(0,0,0,0.5)` —— 这是 EVE 文字"浮在界面上"质感的关键

### 3.3 间距

`2 / 4 / 8 / 12 / 16 / 24 px` 六档（verySmall → veryLarge）。

### 3.4 组件观感要点

- 按钮：深色底 + `#41707F` 1px 边框，hover 边框提到 `#71BED3`，无大圆角（≤3px）。
- 输入框/下拉：`#0A1215` 底，聚焦时边框变 cryo blue。
- 进度条：底 `#1A1E1F`，填充 `#0D557E`。
- 警告条：`#180F09` 底 + `#F39058` 文字。
- 选中行：`#355866`；滑块 thumb `#58A7BF`。

## 4. 配套资源

- **官方图片服务器**：`https://images.evetech.net/` — 物品/舰船图标（`/types/{id}/icon?size=64`）、角色头像（`/characters/{id}/portrait`）、军团/联盟 logo，前端直接引用，无需下载。
- **静态数据（SDE）**：[hoboleaks SDE 镜像](https://sde.hoboleaks.space/)（及时更新的 JSONL 版）、[Fuzzwork](https://www.fuzzwork.co.uk/)（SQL/CSV 转换版）。
- **ESI 文档**：[developers.eveonline.net / ESI](https://esi.evetech.net/)；国服注意走 Serenity 端点（本项目 `src/esi` 已封装）。
- **CCP 第三方许可**：使用 EVE 字体/图标/截图需遵守 [CCP Developer License](https://developers.eveonline.com/license-agreement)，禁止商用收费。

## 5. 落地建议（结合本仓库）

1. 前端页面引入 `docs/eve-theme.css`（CSS 变量 + 基础组件类），替代现有 GitHub-dark 风格的变量（`--bg: #0d1117` / `--primary: #58a6ff` 等）。
2. 数字、ISK 金额、数量用 `textSpecialHighlighted` 冰蓝突出；正收益/负收益分别用 successGreen / hotRed。
3. 图标一律走 images.evetech.net，不本地化。
4. 如需 Electron 透明窗口质感，可给主容器加 `rgba(7,7,7,0.9)` 级别的半透明叠加，但数据密集页面建议不透明，保证可读性。
