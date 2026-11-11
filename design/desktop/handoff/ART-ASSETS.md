# 晴湾纸雕 · 美术资产清单

> 方向：**B · 晴湾纸雕**。  
> 日期：2026-11-10。  
> 用途：供其他 AI / 开发直接制作或替换资产，使实现与 `design/desktop/papercut.html` 的视觉语言一致。  
> 原则：矢量优先、透明背景、不烘焙文字/数字/数量；玩家色和地形色尽量由 CSS 变量或 currentColor 驱动。

---

## 0. 版权与来源

- 本轮所有地形、棋子、图标、纹理与布局均为**项目内原创矢量/代码生成**，不使用任何《卡坦岛》官方美术、卡面、Logo、字体或扫描件。
- 字体只用开源可商用字体：**Noto Sans SC**（SIL OFL）、**Inter**（SIL OFL）；自托管 WOFF2，附 OFL 许可证文件。
- 不引入网络图库素材、AI 生成的写实照片或带水印素材。
- 若后续补充位图纹理，必须记录来源与许可；默认以 SVG/CSS 实现，避免资产许可混乱。
- 资产中不出现品牌名、真实地名、政治符号、宗教符号、可识别真人。

---

## 1. 视觉口径

- **纸雕层叠**：每块地形是一张纸，边缘有 1.5–3px 深墨线；底部有 2–4px 实色投影；高光在左上。
- **丝网印海面**：青绿径向渐变 + 浅色短波纹；不画写实海浪、不用照片。
- **厚木块棋子**：屋顶/墙体是两块纸片，奶油高光边；玩家色只染屋顶和墙体，不染描边。
- **暖色桌面**：奶油纸、麦黄、珊瑚、叶绿；不用紫色、荧光、霓虹、玻璃。
- **清晰优先**：数字片中心、资源图标、玩家首字必须可读；插画不能压过数字。
- **不烘焙**：数字、`2:1/3:1`、资源数量、玩家名、按钮文字都由代码渲染；资产只提供形状和装饰。

---

## 2. 原型内资产映射

正式实现可先从这些函数提取形状，再按本清单拆成文件：

| 原型位置 | 内容 | 生产资产 |
|---|---|---|
| `design/desktop/js/board.js` → `bTree` | 纸雕树 | `board/decor-tree.svg` |
| `bSheep` | 纸雕羊 | `board/decor-sheep.svg` |
| `bWheat` | 麦穗 | `board/decor-wheat.svg` |
| `bBrickStack` | 砖堆 | `board/decor-brick.svg` |
| `bMountain` | 纸山 | `board/decor-mountain.svg` |
| `bDune` / 沙漠仙人掌 | 沙丘/仙人掌 | `board/decor-dune.svg` / `decor-cactus.svg` |
| `bTerrainDecor` | 按地形组合装饰 | 可直接拆入 6 个地形 SVG |
| `numberToken` | 数字圆片（环色随地形/6·8） | `board/token-blank.svg` + 代码文字 |
| `bBuilding` | 村庄/城市（含玩家首字） | `pieces/settlement-*.svg` / `city-*.svg` |
| 道路绘制 | 纸带道路 + 玩家色 + 中心虚线 | `pieces/road-*.svg` + 代码 dash |
| `robberMarkup` | 强盗 pawn | `pieces/robber.svg` |
| `portMarkup` | 港口牌 + 木桩 | `board/port-sign.svg` / `port-dock.svg` |
| B 海面 `seaDecor` | 太阳、海鸥、帆船、波纹 | `board/sun.svg` / `gull.svg` / `boat.svg` / `wave-pattern.svg` |
| `Board.resourceIcon` | 五种资源图标 | `icons/resource-*.svg` |
| `playCardFly` / `.draw-fly` | 强盗抽牌、购买发展卡的背面卡飞行 | `cards/card-back-flight.svg` |
| `app.js` 的 `ICON` | 手牌、发展卡、建造、交易、兑换、结束、帮助、关闭、警告、骰子等 | `icons/ui-*.svg` |
| `css/papercut.css` | 桌面/海面径向渐变、纸张颗粒、卡片阴影 | CSS 变量 + `textures/paper-fiber.png` |

---

## 3. 命名、目录与导出

建议生产目录：

```text
public/assets/ui/papercut/
  board/
    terrain-wood.svg
    terrain-brick.svg
    terrain-sheep.svg
    terrain-wheat.svg
    terrain-ore.svg
    terrain-desert.svg
    token-blank.svg
    port-sign.svg
    port-dock.svg
    robber.svg
    sun.svg
    gull.svg
    boat.svg
    wave-pattern.svg
    decor-tree.svg
    decor-sheep.svg
    decor-wheat.svg
    decor-brick.svg
    decor-mountain.svg
    decor-dune.svg
    decor-cactus.svg
  pieces/
    settlement-a.svg ... settlement-d.svg
    city-a.svg ... city-d.svg
    road-a.svg ... road-d.svg
  icons/
    resource-wood.svg ... resource-ore.svg
    ui-roll.svg, ui-hand.svg, ui-dev.svg, ui-build.svg,
    ui-trade.svg, ui-exchange.svg, ui-end.svg, ui-help.svg,
    ui-close.svg, ui-warn.svg, ui-check.svg, ui-plus.svg,
    ui-minus.svg, ui-zoom-in.svg, ui-zoom-out.svg, ui-reset.svg,
    ui-lock.svg, ui-crown.svg, ui-knight.svg, ui-road.svg
  cards/
    dev-back.svg
    card-back-flight.svg
    dev-knight.svg
    dev-road-building.svg
    dev-year-plenty.svg
    dev-monopoly.svg
    dev-victory.svg
  textures/
    paper-fiber.png
  fonts/
    NotoSansSC-Regular.woff2
    NotoSansSC-Medium.woff2
    NotoSansSC-SemiBold.woff2
    NotoSansSC-Bold.woff2
    NotoSansSC-ExtraBold.woff2
    Inter-Regular.woff2
    Inter-SemiBold.woff2
    Inter-Bold.woff2
    Inter-ExtraBold.woff2
  LICENSE-art.md
  LICENSE-fonts.md
```

命名：

- 全小写、连字符；不用中文文件名；不用空格。
- 语义前缀：`terrain-` / `decor-` / `pieces-` / `icon-` / `ui-` / `tex-` / `dev-`。
- 同一形状的多色版本用 `-a/-b/-c/-d`；玩家 A=甲红、B=乙蓝、C=丙黄、D=丁绿。
- 版本变体用 `-v2`，不要用 `final-final`。

导出：

- SVG 1.1，含 `viewBox`，无宽度/高度硬编码；`role`/`aria` 由使用它的 HTML 决定。
- 无 `<text>`；所有文字由代码渲染；如需内嵌字，必须转路径并记录原因。
- 移除外部引用、字体依赖、metadata、编辑器命名空间；ID 加文件前缀。
- 建议 SVGO 压缩，但保留 `viewBox`、`currentColor`、`stroke-linecap`、`stroke-linejoin`。
- 位图只用于纸张颗粒；PNG/WebP 1x/2x，透明，单个 ≤ 120KB；优先 WebP，PNG 回退。
- 所有资产在 Chrome/Safari 1280 与 1440 下目检；图标至少在 16/24/32px 三档检查。

---

## 4. 棋盘资产

### 4.1 地形

| 文件 | 用途 | 尺寸 / viewBox | 透明 | 说明 |
|---|---|---|---|---|
| `board/terrain-wood.svg` | 森林地块 | 256×222（viewBox 0 0 256 222） | 是 | 平顶六边形；中心 96px 直径留空给数字片；3–5 棵树、苔藓阴影、地面小刺 |
| `board/terrain-brick.svg` | 丘陵/砖 | 256×222 | 是 | 陶土红；2–3 堆砖 + 草簇；中心留空 |
| `board/terrain-sheep.svg` | 牧场 | 256×222 | 是 | 浅绿；3–5 只纸羊 + 花；中心留空 |
| `board/terrain-wheat.svg` | 麦田 | 256×222 | 是 | 麦黄；3 行田垄 + 5–6 束麦穗；中心留空 |
| `board/terrain-ore.svg` | 矿山 | 256×222 | 是 | 灰蓝；3 座纸山 + 石屑；中心留空 |
| `board/terrain-desert.svg` | 沙丘 | 256×222 | 是 | 沙色；3 层沙丘 + 仙人掌 + 小石块；中心留空 |

生产尺寸建议 256×222 为 1x，512×444 为 2x；实际按棋盘最大显示尺寸（约 120px 宽）缩放，中心留空区按比例保持 ≥ 46px 显示直径。

- 地形画在 **沙色底盘之上**；每块资产不要自带六边形外框和底部投影，外框/阴影由代码统一绘制，避免接缝。
- 边缘 8% 为安全区；建筑/道路/港口标签可能压在地块边缘，装饰不要贴边。
- 地形可有 2–3 个装饰变体（`-v2/-v3`），但数字片位置与中心留空必须一致；不要用随机布局破坏可读性。
- 地形色由资产负责；不要依赖 CSS 给同一张图换色，否则纸雕阴影会变脏。

### 4.2 数字圆片

| 文件 | 用途 | 尺寸 | 透明 | 说明 |
|---|---|---|---|---|
| `board/token-blank.svg` | 数字片底盘 | 96×96（显示 44px） | 是 | 奶油圆 + 2px 墨边 + 内圈细线 + 小钉孔；不带数字 |
| 数字/点数 | 2–12、5 个点 | 代码渲染 | — | 数字 23px/800；下方 5 个小点；6/8 用珊瑚红数字与环 |
| `token-rim-hot.svg`（可选） | 6/8 红环 | 96×96 | 是 | 也可用 CSS 变量换环色，不单独出图 |

要求：

- 数字必须用代码文字/可访问文本，不能烘焙；字体用 Inter tabular，6/8 变红。
- 数字片要能旋转 ±3°，纸边有 1px 错位；不要阴影过重压住地形。
- 数字片在所有插画、道路、建筑、强盗之上；只有高亮 overlay 可以在它之上。

### 4.3 港口

| 文件 | 用途 | 尺寸 | 透明 | 说明 |
|---|---|---|---|---|
| `board/port-sign.svg` | 空白港口牌 | 92×44 | 是 | 奶油纸牌 + 2px 墨边 + 顶部木条；无文字 |
| `board/port-dock.svg` | 木桩/栈桥 | 44×28 | 是 | 2–3 根深棕木桩 + 绳圈 |
| `icons/port-3to1.svg` | 通用 3:1 图标 | 24×24 | 是 | 锚/交换箭头 + 3:1 由代码文字 |
| `icons/port-2to1-wood.svg` 等 5 个 | 专用 2:1 | 24×24 | 是 | 对应资源图标 + 2:1 文字由代码渲染 |

- 港口牌文字、2:1/3:1 必须代码渲染；资产只给牌形与图标。
- 港口牌可旋转 ±3°，不要烘焙旋转。

### 4.4 强盗、太阳、帆船、海鸥、波纹

| 文件 | 用途 | 尺寸 | 透明 | 说明 |
|---|---|---|---|---|
| `board/robber.svg` | 强盗 | 48×60（显示 30×38） | 是 | 深墨绿纸雕 pawn + 珊瑚围巾 + 奶油高光；底部椭圆阴影 |
| `board/sun.svg` | 右上纸雕太阳 | 220×220（显示 ~110px） | 是 | 外环、内盘、8 道短光；奶油/麦黄/浅青边；低对比，不抢棋盘 |
| `board/gull.svg` | 海鸥 | 32×18 | 是 | 两笔弧线 + 深青描边；可镜像 |
| `board/boat.svg` | 帆船 | 80×64 | 是 | 三角帆 + 船身 + 小旗；纸雕描边 |
| `board/wave-pattern.svg` | 海面波纹 | 240×120 tileable | 是 | 浅青短弧；透明度由 CSS 控制（.44）；不要整张海面大图 |

- 太阳只放在棋盘右上空白海域；在 1280 下仍不压住岛屿与港口。
- 波纹作为 `<pattern>` 或 CSS mask；不要用一张 1440 大图。
- 海面渐变由 CSS `--sea-bg` 负责，不导出为图片。

---

## 5. 玩家棋子

| 文件 | 用途 | 尺寸 | 透明 | 说明 |
|---|---|---|---|---|
| `pieces/settlement-a.svg` 等 4 个 | 村庄 | 72×64（显示 24×28） | 是 | 纸墙体 + 奶油屋顶 + 2px 墨边 + 底部 3px 深色投影；玩家色染屋顶/墙体 |
| `pieces/city-a.svg` 等 4 个 | 城市 | 84×72（显示 34×38） | 是 | 加高塔楼 + 小旗；玩家色染屋顶/塔/旗；保留奶油纸高光 |
| `pieces/road-a.svg` 等 4 个 | 道路 | 64×18（显示 28×8） | 是 | 奶油底 + 墨边 + 玩家色芯；中心白虚线由代码叠加，不烘焙 |

玩家色：`a #C9503F`、`b #3B6FA0`、`c #B4741D`、`d #4C8B67`（C 已加深，避免和黄麦田融合）。

- 为保证兼容性，建议每个玩家色出 4 个独立文件；如使用 `currentColor` 变量，需在 Chrome/Safari 真机验证 `fill`/`stroke` 继承。
- 屋顶上由代码叠一个 **名字首字**（甲/乙/丙/丁），墨色 7–8px；资产不要烘焙首字。
- 道路中心虚线图案由代码按玩家设置 `stroke-dasharray`：
  - A 实线；B `3 4`；C `.5 4`（圆点）；D `6 3`。资产只提供纯色道路底。
- 棋子不要自带白色描边以外的背景；底部投影可包含在资产内，也可用 CSS `drop-shadow`，但需统一。
- 建筑/道路的中心点/端点必须与棋盘 vertex/edge 对齐；资产画布以锚点为中心，不要偏移。

---

## 6. 资源图标

| 文件 | 用途 | viewBox / 尺寸 | 说明 |
|---|---|---|---|
| `icons/resource-wood.svg` | 木材 | 24×24 | 两块斜叠木料 + 树轮；主色棕绿 |
| `icons/resource-brick.svg` | 砖块 | 24×24 | 两块砖 + 顶面高光；陶土红 |
| `icons/resource-sheep.svg` | 羊毛 | 24×24 | 纸羊头/云朵；奶油 + 墨线 |
| `icons/resource-wheat.svg` | 麦子 | 24×24 | 三束麦穗 + 麦芒；麦黄 |
| `icons/resource-ore.svg` | 矿石 | 24×24 | 两块灰蓝晶体 + 高光面 |
| `icons/resource-generic.svg` | 3:1/任意 | 24×24 | 四向交换箭头或木箱；用于通用港 |

- 统一 24×24 viewBox、1.8–2px 墨线、`stroke-linejoin=round`；能在 16/20/24/32px 使用。
- 图标本身表达资源，不依赖颜色；在深色/浅色底上都可读。
- 在资源卡、报价、港口、日志中复用同一组；不要每个地方画不同版本。

---

## 7. UI 图标

| 文件 | 用途 | viewBox |
|---|---|---|
| `ui-roll.svg` | 掷骰按钮（两枚骰子） | 24×24 |
| `ui-hand.svg` | 手牌/弃牌 | 24×24 |
| `ui-dev.svg` | 发展卡 | 24×24 |
| `ui-build.svg` | 建造（小房子） | 24×24 |
| `ui-trade.svg` | 交易（双向箭头） | 24×24 |
| `ui-exchange.svg` | 兑换（循环箭头） | 24×24 |
| `ui-end.svg` | 结束回合（小旗） | 24×24 |
| `ui-help.svg` | 帮助（问号） | 24×24 |
| `ui-close.svg` | 关闭（×） | 24×24 |
| `ui-warn.svg` | 警告（三角） | 24×24 |
| `ui-check.svg` | 确认/选中 | 24×24 |
| `ui-plus.svg` / `ui-minus.svg` | 加减 | 24×24 |
| `ui-zoom-in/out/reset.svg` | 棋盘缩放 | 24×24 |
| `ui-lock.svg` | 锁定 | 24×24 |
| `ui-crown.svg` | 最长路/成就 | 24×24 |
| `ui-knight.svg` | 骑士/强盗日志 | 24×24 |
| `ui-road.svg` | 道路 | 24×24 |

- 全部 `stroke="currentColor"`，1.8px 线宽（小尺寸可 1.6），圆头圆角；不填色或只在必要时填。
- 不烘焙 2px 底色；按钮/徽章背景由 CSS。
- 图标在 24px 下有足够内边距（1.5px），不要贴边。

---

## 8. 发展卡

| 文件 | 用途 | 尺寸 | 说明 |
|---|---|---|---|
| `cards/dev-back.svg` | 卡背 | 240×336 | 纸雕卡背 + 三色斜条 + 六角压纹；无文字 |
| `cards/card-back-flight.svg` | 抽牌飞行卡背 | 60×80（显示 30×40） | 深墨绿纸卡背 + 奶油内框 + 问号/星形；强盗抽牌和购买发展卡共用；不显示牌面 |
| `cards/dev-knight.svg` | 骑士 | 240×336 | 纸雕骑士/剑；无文字 |
| `cards/dev-road-building.svg` | 道路建设 | 240×336 | 两段道路 + 小房子 |
| `cards/dev-year-plenty.svg` | 丰收 | 240×336 | 麦穗/资源篮 |
| `cards/dev-monopoly.svg` | 垄断 | 240×336 | 一只手/资源堆 |
| `cards/dev-victory.svg` | 胜利点 | 240×336 | 月桂/六角星 |

- 卡名、数量、说明由代码叠加；资产不烘焙文字。
- **抽牌飞行**：从玩家头像或发展卡堆飞向手牌/计数时只显示卡背；牌面内容不提前翻出，避免泄露。减少动态模式直接显示结果，不播放飞行。
- 卡背与卡面同一 2:3 比例；卡角 12px，墨边 2px；可只导出 96×96 图标层，由 CSS 卡框承载。
- 发展卡堆的扇形与数量显示由 CSS，不需要额外资产。

---

## 9. 纹理与字体

| 文件 | 用途 | 规格 | 说明 |
|---|---|---|---|
| `textures/paper-fiber.png` | 纸纹 | 512×512 无缝，透明 8–12% | 叠在奶油底色上；不要高对比噪点 |
| `textures/paper-fiber@2x.png` | 2x | 1024×1024 | 同上 |
| `textures/wave-pattern.svg` | 海面波纹 | 240×120 pattern | 浅青短弧；透明度由 CSS |
| `textures/sun.svg` | 太阳 | 220×220 | 也可归入 board |
| `fonts/NotoSansSC-*.woff2` | 中文 | 400/500/600/700/800 | SIL OFL；附许可 |
| `fonts/Inter-*.woff2` | 拉丁/数字 | 400/600/700/800 | SIL OFL；附许可 |

- 不导出“整个桌面背景”为图片；用 CSS 径向渐变 + 纸纹。
- 字体失败回退：`"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif`；拉丁：`"Inter", "Avenir Next", "Segoe UI", sans-serif`。

---

## 10. 资产与布局的接口约定

1. **棋盘画布**：`viewBox 0 0 1040 720`；六角几何 `HEX_SIZE=56`，顶点/边 key 与引擎一致。资产按此坐标系绘制，不要按 1440 像素硬编码。
2. **数字片**：显示直径 44px；中心留空 ≥46px；地形装饰不得进入中心圆。
3. **建筑锚点**：村庄/城市 SVG 以底部中心为原点；道路以两端中点为中心；资产画布可留透明边。
4. **港口**：牌中心对齐港口坐标；木桩向外海方向；旋转由代码。
5. **玩家色**：顶栏/头像/棋子/道路同源；不要给 A 玩家用两种红。
6. **数字片/港口文字**：全部由代码渲染，资产不带字形；文字必须能翻译/缩放。
7. **阴影**：资产内的阴影统一来自左上光；CSS 阴影只用于卡片/面板，不重复给棋子加两套。
8. **可访问性**：玩家建筑屋顶名字首字、道路虚线纹理、图标+文字+颜色三重表达；资产不能移除这些扩展位。

---

## 11. 生产验收

- [ ] 六种地形 + 沙底盘 + 数字片 + 港口 + 强盗 + 太阳/帆船/海鸥/波纹齐全。
- [ ] 四色村庄/城市/道路齐全；道路中心线纹理由代码正确叠加。
- [ ] 资源图标、UI 图标、发展卡在 16/24/32px 下清晰，无锯齿/断线。
- [ ] `card-back-flight.svg` 在 30×40 尺寸可读，且不暴露牌面；减少动态模式可跳过。
- [ ] 所有交互资产透明背景；无白底方块、无烘焙文字、无外部链接。
- [ ] 数字片中心 46px 留空；建筑/道路锚点与几何 key 对齐。
- [ ] 1040×720 画布缩放到 1440×900 与 1280×720 无错位；1280 下棋子首字仍可辨。
- [ ] 玩家色色盲复核：名字首字与道路纹理可区分；不依赖红绿。
- [ ] 纸质纹理在 2x 下无摩尔纹；WebP/PNG 有回退。
- [ ] 字体许可文件、资产来源记录、OFL 文本齐全。
- [ ] 所有资产通过本地加载（无 404），并记录在实现 PR 的资产表中。

---

## 12. 不要做

- 不要使用《卡坦岛》官方 Logo、卡面、地形插画、木块照片或字体。
- 不要把“木材 2”“2:1”“甲”等文字/数字烘焙进 SVG/PNG。
- 不要用写实 3D 渲染、照片纹理、玻璃/霓虹/紫渐变，破坏纸雕语言。
- 不要给地形加会遮住中心数字的高对比装饰；不要把建筑画得比数字片更抢眼。
- 不要只靠颜色区分玩家；不要删除屋顶首字与道路纹理。
- 不要为每个状态复制一套静态棋盘图；棋盘必须由同一套 SVG/状态渲染。
