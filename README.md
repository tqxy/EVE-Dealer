# EVE-Dealer

EVE 国服（Serenity）ESI **基础支撑模块库**，从 ESI补货 项目中提取并重构，不含补货分析等业务功能，可作为任何 EVE 国服工具项目的底座。

## 技术栈

- **TypeScript + ESM**（strict 模式，编译产物含类型声明）
- **Node.js >= 20**，原生 `fetch`（已移除 axios 依赖）
- **better-sqlite3** — SQLite 持久化（WAL 模式）
- **exceljs** — 解析 evedata.xlsx 物品数据
- **Vitest** — 单元测试（网络请求全部 mock，可离线运行）

## 模块一览

| 模块 | 路径 | 说明 |
|------|------|------|
| 配置常量 | `src/config.ts` | 国服默认配置、Jita 星域/星系常量、默认 scope |
| SSO 认证 | `src/auth/oauth.ts` | 隐式/授权码两种 OAuth 流程、token 校验与刷新、回调 URL 解析；含国服特有的 logoff 前置跳转处理 |
| ESI 客户端 | `src/esi/client.ts` | 限流、指数退避重试（420/429）、自动翻页、Bearer 认证 |
| 市场端点 | `src/esi/endpoints/market.ts` | 建筑订单/建筑信息/星域订单/市场历史/吉他买卖价 |
| SQLite 层 | `src/db/database.ts` | config、structures、price_cache、structure_order_cache 四张表 |
| 数据管理 | `src/db/registry.ts` | 配置（含 token）、建筑名单、缓存的统一入口，自动补齐国服默认配置 |
| 物品数据库 | `src/items/itemDatabase.ts` | 下载/解析 ceve-market 的 evedata.xlsx，物品搜索、三级分类树，24h 缓存 |
| Meta 数据 | `src/items/metaDb.ts` | fuzzwork invMetaTypes.csv，查询物品 metaGroup/parentType |
| 价格服务 | `src/prices/priceService.ts` | 吉他价格+销量后台批量刷新：并发队列、逐条回调、全局进度 |
| 内存缓存 | `src/cache/memoryCache.ts` | 通用进程内 TTL 缓存，过期即丢弃，支持元信息读取与批量清理 |
| Universe 端点 | `src/esi/endpoints/universe.ts` | 星域列表、星域/星系信息（支持中文名） |

## 快速开始

```bash
npm install
npm test          # 运行单元测试
npm run build     # 编译到 dist/
npm run example   # 运行示例（会真实请求吉他公开市场数据）
npm run serve     # 启动 Web 前端: http://localhost:8321
```

## Web 前端（价格查询）

`npm run serve` 启动本地服务（端口 8321，可用 `PORT` 环境变量修改），打开浏览器即可使用：

- 左侧功能栏预留了市场扫描、物品数据库、资产分析等入口（当前开放：价格查询、设置）
- **设置 - ESI 凭证**：网易账号授权（授权码模式，持有 refresh_token）；授权链接先经 logoff 清理旧会话；粘贴回调地址即完成绑定；状态页显示角色头像、到期倒计时与权限范围；服务端每 60 秒检查，到期前 5 分钟自动换新；支持手动立即刷新与清除凭证
- **星域选择**：星域列表从 ESI 动态拉取（中文名，SQLite 持久缓存），吉他看 Jita 4-4 空间站订单，其他星域看全星域订单
- 支持物品名称模糊搜索（中/英文），带物品图标与分类
- 实时价格卡：卖一价/买一价/昨日成交量/昨日均价，标注数据更新时间与是否命中缓存
- **60 秒自动轮询**：价格数字与订单行在数据变化时播放闪烁特效（EVE 主题色渐变）
- **订单明细**：卖单（升序）/买单（降序）各前 20 条，含数量、星系名（中文）、挂单时间，玩家建筑订单有标识
- **公开合同**：自动索引星域公开合同（后台扫描，30 分钟刷新），只含该物品的合同按总价折算单价；含其他物品的合同按"其他物品估值 = 基准价 × 折扣 × 数量"扣除后折算（≈ 标记为估算）；合同行以金色"合同"徽章并入订单表；全星域模式自动合并主要贸易星域的合同
- **全星域模式**：星域选择含"全星域"，聚合所有星域的订单（最优价标注来源星域）与合同价格；此模式暂不提供历史曲线
- **数据即时性**：价格内存缓存 15 分钟硬过期，过期必重新拉取；订单缓存 60 秒；拉取失败的结果只缓存 30 秒以便快速重试，且有 15 分钟内的 lastGood 数据时兜底返回，避免瞬时故障覆盖好数据
- **自动刷新**：服务端每 60 秒预热最近 15 分钟内查询过的 (星域, 物品)；前端打开中的物品每 15 秒轮询价格/订单/合同
- **设置 - 合同单价公式**：估值基准（最高收单价/最低卖单价）与折扣系数（默认 0.9）可在设置页自定义，保存到 SQLite 立即生效
- 历史价格曲线（uPlot，约 400 天日线，按所选星域）：均价/最高/最低三线 + 成交量柱（右轴），支持 30/90/180 天/全部切换，滚轮框选缩放
- 视觉遵循 `docs/eve-theme.css` 的 EVE Photon UI 设计令牌（cryo blue 主色、深色面板、文字硬投影）
- 物品图标直接引用 `images.evetech.net`

前端为无构建的静态页面（`web/`），后端是 `app/server.ts`（Node 内置 http，REST API + 静态文件）。支持 `?type=<typeId>` 深链直达某物品。

API（均支持 `?region=<regionId>` 参数，默认 10000002 伏尔戈）：

- `GET /api/regions` — 星域列表
- `GET /api/search?q=` — 物品搜索
- `GET /api/item/:typeId` — 物品详情
- `GET /api/price/:typeId` — 实时价格（内存缓存，15 分钟硬过期）
- `GET /api/orders/:typeId` — 订单簿卖/买各前 20（内存缓存 60 秒）
- `GET /api/contracts/:typeId` — 公开合同（后台索引，单价折算规则见设置页公式）
- `GET /api/history/:typeId` — 历史日线（内存缓存 30 分钟）
- `GET/POST /api/config/valuation` — 合同单价公式配置（估值基准 + 折扣系数）

认证 API：

- `GET /api/auth/status` — 凭证状态（角色、有效期、是否可自动刷新）
- `GET /api/auth/url` — 生成授权入口链接（授权码模式，含 logoff 前置跳转）
- `POST /api/auth/callback` `{url}` — 解析回调地址并保存凭证（支持 code 与隐式 token）
- `POST /api/auth/refresh` — 立即用 refresh_token 换新
- `POST /api/auth/clear` — 清除凭证

作为库引用：

```ts
import { Registry, EsiClient, PriceService, buildAuthEntryUrl } from 'eve-dealer';

const registry = new Registry();          // data/eve_dealer.db
const config = registry.getConfig();      // 自动填充国服默认值

// 认证
console.log(buildAuthEntryUrl(config, 'token'));   // 浏览器打开完成授权

// ESI 请求
const client = new EsiClient(config);
const service = new PriceService(client, registry);
service.startRefresh([34, 35], (typeId, data) => console.log(typeId, data.jita_sell));
```

## 与原项目的差异

- 移除了补货业务模块：analyzer、candidateGenerator、gapAnalyzer、guristasScorer、diagnoseAuth、Electron 壳与渲染层
- `targets` / `hidden_items` 等业务表未保留；数据库仅保留通用的 config / structures / 缓存表
- axios → 原生 fetch；xlsx(SheetJS) → exceljs；CommonJS → ESM + TypeScript
- 所有模块改为可注入依赖的类（`EsiClient` / `Registry` / `ItemDatabase` / `MetaDb` / `PriceService`），便于测试与复用
