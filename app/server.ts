/**
 * EVE-Dealer 本地 Web 服务
 * 静态前端 + JSON API：星域列表 / 物品搜索 / 实时价格 / 订单簿 / 历史价格
 *
 * 缓存策略（内存缓存 MemoryCache）：
 * - 实时价格：15 分钟硬过期，过期必重新拉取，绝不返回更旧的数据
 * - 订单簿：60 秒
 * - 历史日线：30 分钟
 * - 星域/星系名称：24 小时（并持久化到 SQLite config）
 *
 * 自动刷新：后台每 60 秒检查最近 15 分钟内被查询过的 (星域, 物品)，
 * 若缓存年龄超过 60 秒则重新拉取，保证打开中的页面数据接近实时。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Registry } from '../src/db/registry.js';
import { EsiClient } from '../src/esi/client.js';
import { getRegionOrders, getMarketHistory } from '../src/esi/endpoints/market.js';
import type { MarketOrder } from '../src/esi/endpoints/market.js';
import { getRegionIds, getRegion, getSystem, getStation } from '../src/esi/endpoints/universe.js';
import { getPublicContracts, getPublicContractItems } from '../src/esi/endpoints/contracts.js';
import { ItemDatabase } from '../src/items/itemDatabase.js';
import { MemoryCache } from '../src/cache/memoryCache.js';
import { buildAuthEntryUrl, parseCallbackUrl, refreshToken, isTokenValid } from '../src/auth/oauth.js';
import { SERENITY_DEFAULTS, JITA_REGION_ID, JITA_SYSTEM_ID } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT ?? 8321);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

// ---------- 缓存 ----------

const PRICE_TTL_MS = 15 * 60 * 1000;   // 价格硬上限：15 分钟
const ORDERS_TTL_MS = 60 * 1000;       // 订单簿 60 秒
const HISTORY_TTL_MS = 30 * 60 * 1000; // 历史 30 分钟
const NAME_TTL_MS = 24 * 60 * 60 * 1000; // 名称 24 小时
const AUTO_REFRESH_INTERVAL_MS = 60 * 1000;
const AUTO_REFRESH_MIN_AGE_MS = 60 * 1000; // 缓存超过 60 秒就刷新
const RECENT_WINDOW_MS = 15 * 60 * 1000;   // 只跟踪最近 15 分钟被查过的物品

interface RegionPrice {
  type_id: number;
  region_id: number;
  sell: number | null;
  buy: number | null;
  /** 全星域聚合时标注最优价来源星域 */
  sell_region_name?: string | null;
  buy_region_name?: string | null;
  /** 全星域模式附带的吉他（Jita 4-4）参考价 */
  jita?: { sell: number | null; buy: number | null };
  volume: {
    date: string;
    average: number;
    highest: number;
    lowest: number;
    order_count: number;
    volume: number;
  } | null;
  updatedAt: string;
}

interface OrderRow {
  order_id: number;
  price: number;
  volume_remain: number;
  system_id: number;
  system_name: string | null;
  /** 星系安等（-1.0 ~ 1.0） */
  security?: number | null;
  is_structure: boolean;
  issued: string;
  duration: number;
  /** 全星域聚合时标注来源星域 */
  region_id?: number;
  region_name?: string | null;
}

/** 公开合同索引条目（记录完整物品构成，查询时按需折算单价） */
interface IndexedContract {
  contract_id: number;
  /** 物品构成：typeId → 数量 */
  items: Record<number, number>;
  /** sell=发起方出售（price>0）/ buy=发起方收购（reward>0） */
  side: 'sell' | 'buy';
  total_price: number;
  region_id: number;
  /** 合同所在地点（空间站或玩家建筑） */
  location_id: number;
  title: string;
  date_issued: string;
  date_expired: string;
}

/** 查询返回的合同条目（已折算单价） */
interface QueriedContract {
  contract_id: number;
  type_id: number;
  quantity: number;
  side: 'sell' | 'buy';
  unit_price: number;
  total_price: number;
  /** true=含其他物品，单价为扣除其他物品估值（收单价×0.9）后的估算值 */
  estimated: boolean;
  region_id: number;
  region_name?: string | null;
  /** 合同所在星系（空间站可解析，玩家建筑为 null） */
  system_name?: string | null;
  security?: number | null;
  is_structure?: boolean;
  title: string;
  date_issued: string;
  date_expired: string;
}

interface OrderBook {
  type_id: number;
  region_id: number;
  sell: OrderRow[];
  buy: OrderRow[];
  updatedAt: string;
}

const priceCache = new MemoryCache<RegionPrice>();
/** 各 (星域,物品) 最后一份非空价格：拉取失败时兜底，避免瞬时故障覆盖好数据 */
const lastGoodPrice = new Map<string, RegionPrice>();
const ordersCache = new MemoryCache<OrderBook>();
const historyCache = new MemoryCache<unknown[]>();
const nameCache = new MemoryCache<string>();
const regionListCache = new MemoryCache<{ region_id: number; name: string }[]>();

/** 最近被查询的 (星域:物品) -> 最后查询时间，用于自动刷新 */
const recentQueries = new Map<string, number>();

// ---------- 服务初始化 ----------

const registry = new Registry();
const config = { ...SERENITY_DEFAULTS, ...registry.getConfig() };
const client = new EsiClient(config, { delayMs: 100 });
/** 批量扫描专用客户端：更快的请求节奏，与交互式请求隔离 */
const scanClient = new EsiClient(config, { delayMs: 20 });
const itemDb = new ItemDatabase();

const cacheKey = (regionId: number, typeId: number) => `${regionId}:${typeId}`;

/** 该星域的有效订单过滤规则：吉他只看 4-4 空间站，其他星域看全星域 */
function orderInScope(order: MarketOrder, regionId: number): boolean {
  if (regionId === JITA_REGION_ID) {
    return order.system_id === JITA_SYSTEM_ID && order.location_id < 1_000_000_000_000;
  }
  return true;
}

/**
 * 价格落库策略：
 * - 非空数据：15 分钟硬 TTL + 记录 lastGood
 * - 完全拉取失败：若有 15 分钟内的 lastGood 则返回它兜底；
 *   否则空结果只缓存 30 秒，让自动刷新尽快重试
 */
function commitPrice(key: string, entry: RegionPrice, allEmpty: boolean): RegionPrice {
  if (allEmpty) {
    const good = lastGoodPrice.get(key);
    if (good && Date.now() - new Date(good.updatedAt).getTime() < PRICE_TTL_MS) {
      return good;
    }
    priceCache.set(key, entry, 30 * 1000);
    return entry;
  }
  lastGoodPrice.set(key, entry);
  priceCache.set(key, entry, PRICE_TTL_MS);
  return entry;
}

// ---------- 数据拉取 ----------

async function fetchPrice(regionId: number, typeId: number): Promise<RegionPrice> {
  const [sellRes, buyRes, histRes] = await Promise.allSettled([
    getRegionOrders(client, regionId, typeId, 'sell'),
    getRegionOrders(client, regionId, typeId, 'buy'),
    getMarketHistory(client, regionId, typeId)
  ]);

  let sell: number | null = null;
  if (sellRes.status === 'fulfilled' && sellRes.value.success && Array.isArray(sellRes.value.data)) {
    const orders = sellRes.value.data
      .filter(o => orderInScope(o, regionId))
      .sort((a, b) => a.price - b.price);
    sell = orders.length > 0 ? orders[0].price : null;
  }

  let buy: number | null = null;
  if (buyRes.status === 'fulfilled' && buyRes.value.success && Array.isArray(buyRes.value.data)) {
    const orders = buyRes.value.data
      .filter(o => orderInScope(o, regionId))
      .sort((a, b) => b.price - a.price);
    buy = orders.length > 0 ? orders[0].price : null;
  }

  let volume: RegionPrice['volume'] = null;
  if (histRes.status === 'fulfilled' && histRes.value.success &&
      Array.isArray(histRes.value.data) && histRes.value.data.length > 0) {
    const latest = histRes.value.data[histRes.value.data.length - 1];
    volume = { ...latest };
  }

  const entry: RegionPrice = {
    type_id: typeId,
    region_id: regionId,
    sell,
    buy,
    volume,
    updatedAt: new Date().toISOString()
  };
  const allEmpty = sell == null && buy == null && volume == null;
  return commitPrice(cacheKey(regionId, typeId), entry, allEmpty);
}

interface SystemBrief {
  name: string | null;
  security: number | null;
}

async function resolveSystemInfo(systemId: number): Promise<SystemBrief> {
  const cached = nameCache.getWithMeta(`sys:${systemId}`);
  if (cached) {
    const [name, sec] = String(cached.value).split('|');
    return { name: name || null, security: sec ? Number(sec) : null };
  }
  const result = await getSystem(client, systemId);
  if (result.success && result.data?.name) {
    const sec = typeof result.data.security_status === 'number'
      ? Math.round(result.data.security_status * 10) / 10
      : null;
    nameCache.set(`sys:${systemId}`, `${result.data.name}|${sec ?? ''}`, NAME_TTL_MS);
    return { name: result.data.name, security: sec };
  }
  return { name: null, security: null };
}

async function fetchOrders(regionId: number, typeId: number): Promise<OrderBook> {
  const [sellRes, buyRes] = await Promise.allSettled([
    getRegionOrders(client, regionId, typeId, 'sell'),
    getRegionOrders(client, regionId, typeId, 'buy')
  ]);

  const toRow = (o: MarketOrder): OrderRow => ({
    order_id: o.order_id,
    price: o.price,
    volume_remain: o.volume_remain,
    system_id: o.system_id ?? 0,
    system_name: null,
    is_structure: o.location_id >= 1_000_000_000_000,
    issued: o.issued,
    duration: o.duration
  });

  const sellOrders = (sellRes.status === 'fulfilled' && sellRes.value.success && sellRes.value.data)
    ? sellRes.value.data.filter(o => orderInScope(o, regionId)).sort((a, b) => a.price - b.price).slice(0, 20).map(toRow)
    : [];
  const buyOrders = (buyRes.status === 'fulfilled' && buyRes.value.success && buyRes.value.data)
    ? buyRes.value.data.filter(o => orderInScope(o, regionId)).sort((a, b) => b.price - a.price).slice(0, 20).map(toRow)
    : [];

  // 解析展示的星系名称与安等（带内存缓存，失败时保留 null）
  const systemIds = [...new Set([...sellOrders, ...buyOrders].map(o => o.system_id).filter(Boolean))];
  const infos = await Promise.allSettled(systemIds.map(id => resolveSystemInfo(id)));
  const infoMap = new Map<number, SystemBrief>();
  systemIds.forEach((id, i) => {
    infoMap.set(id, infos[i].status === 'fulfilled' ? infos[i].value : { name: null, security: null });
  });
  for (const row of [...sellOrders, ...buyOrders]) {
    const info = infoMap.get(row.system_id);
    row.system_name = info?.name ?? null;
    row.security = info?.security ?? null;
  }

  const book: OrderBook = {
    type_id: typeId,
    region_id: regionId,
    sell: sellOrders,
    buy: buyOrders,
    updatedAt: new Date().toISOString()
  };
  ordersCache.set(cacheKey(regionId, typeId), book, ORDERS_TTL_MS);
  return book;
}

/** ESI 不可达时的兜底星域列表 */
const FALLBACK_REGIONS = [
  { region_id: 10000002, name: 'The Forge 伏尔戈' },
  { region_id: 10000043, name: 'Domain 多美' },
  { region_id: 10000032, name: 'Sinq Laison 破碎星域' },
  { region_id: 10000042, name: 'Metropolis 美特伯里斯' },
  { region_id: 10000030, name: 'Heimatar 海默特' },
  { region_id: 10000064, name: 'Essence 精华' },
  { region_id: 10000037, name: 'Everyshore 埃弗肖尔' },
  { region_id: 10000048, name: 'Placid 平静' },
  { region_id: 10000033, name: 'The Citadel 堡垒' },
  { region_id: 10000001, name: 'Derelik 德里克' }
];

async function fetchRegionList(): Promise<{ region_id: number; name: string }[]> {
  // 1. 内存缓存
  const memHit = regionListCache.get('regions');
  if (memHit) return memHit;

  // 2. SQLite 持久缓存
  const persisted = registry.getConfigValue('regions');
  if (persisted) {
    try {
      const list = JSON.parse(String(persisted)) as { region_id: number; name: string }[];
      if (Array.isArray(list) && list.length > 0) {
        regionListCache.set('regions', list, NAME_TTL_MS);
        return list;
      }
    } catch { /* 忽略损坏数据，重新拉取 */ }
  }

  // 3. ESI 拉取全量星域（约 60+ 个，逐个取中文名）
  try {
    const ids = await getRegionIds(client);
    if (ids.length === 0) throw new Error('empty region list');
    const list: { region_id: number; name: string }[] = [];
    for (const id of ids) {
      const result = await getRegion(client, id);
      list.push({ region_id: id, name: result.success && result.data?.name ? result.data.name : `Region ${id}` });
    }
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    regionListCache.set('regions', list, NAME_TTL_MS);
    registry.setConfigValue('regions', JSON.stringify(list));
    console.log('[Server] 星域列表已加载:', list.length, '个');
    return list;
  } catch (err) {
    console.warn('[Server] 星域列表拉取失败，使用兜底列表:', err instanceof Error ? err.message : err);
    return FALLBACK_REGIONS;
  }
}

// ---------- 公开合同索引 ----------

const CONTRACT_INDEX_TTL_MS = 30 * 60 * 1000; // 索引 30 分钟内视为新鲜
const CONTRACT_SCAN_CONCURRENCY = 10;

interface ContractScanState {
  scanning: boolean;
  /** 最近一次扫描尝试时间（无论成败，用于失败冷却） */
  attemptedAt: number;
  scannedAt: number;
  byType: Map<number, IndexedContract[]>;
}

const contractScans = new Map<number, ContractScanState>();

/** 扫描一个星域的全部公开合同，建立 typeId → 单一种类合同索引 */
async function scanRegionContracts(regionId: number): Promise<void> {
  const state = contractScans.get(regionId);
  if (state?.scanning) return;
  if (state && Date.now() - state.scannedAt < CONTRACT_INDEX_TTL_MS) return;

  contractScans.set(regionId, { scanning: true, attemptedAt: Date.now(), scannedAt: state?.scannedAt ?? 0, byType: state?.byType ?? new Map() });
  console.log('[Contracts] 开始扫描星域', regionId);

  try {
    const list = await getPublicContracts(scanClient, regionId);
    if (!list.success || !list.data) throw new Error(list.error ?? '合同列表获取失败');

    const now = Date.now();
    const candidates = list.data.filter(c =>
      c.type === 'item_exchange' &&
      new Date(c.date_expired).getTime() > now &&
      (c.price > 0 || c.reward > 0)
    );

    const byType = new Map<number, IndexedContract[]>();
    let cursor = 0;
    const workers = Array.from({ length: CONTRACT_SCAN_CONCURRENCY }, async () => {
      while (cursor < candidates.length) {
        const c = candidates[cursor++];
        try {
          const itemsRes = await getPublicContractItems(scanClient, c.contract_id);
          if (!itemsRes.success || !Array.isArray(itemsRes.data)) continue;
          const included = itemsRes.data.filter(i => i.is_included);
          if (included.length === 0) continue;

          // 记录完整构成（同 typeId 合并数量），查询时按物品匹配并折算单价
          const items: Record<number, number> = {};
          for (const i of included) {
            items[i.type_id] = (items[i.type_id] ?? 0) + i.quantity;
          }

          const side: 'sell' | 'buy' = c.price > 0 ? 'sell' : 'buy';
          const entry: IndexedContract = {
            contract_id: c.contract_id,
            items,
            side,
            total_price: c.price > 0 ? c.price : c.reward,
            region_id: regionId,
            location_id: c.start_location_id ?? 0,
            title: c.title ?? '',
            date_issued: c.date_issued,
            date_expired: c.date_expired
          };
          // 构成中的每种物品都建索引，按任意物品都能查到该合同
          for (const tid of Object.keys(items)) {
            const arr = byType.get(Number(tid)) ?? [];
            arr.push(entry);
            byType.set(Number(tid), arr);
          }
        } catch { /* 单个合同失败跳过 */ }
      }
    });
    await Promise.all(workers);

    contractScans.set(regionId, { scanning: false, attemptedAt: Date.now(), scannedAt: Date.now(), byType });
    console.log(`[Contracts] 星域 ${regionId} 索引完成: ${candidates.length} 个有效合同 → ${byType.size} 种物品`);
  } catch (err) {
    console.warn('[Contracts] 星域', regionId, '扫描失败:', err instanceof Error ? err.message : err);
    // 保留旧索引，attemptedAt 用于失败冷却（SCAN_FAIL_COOLDOWN_MS 内不再重试）
    contractScans.set(regionId, { scanning: false, attemptedAt: Date.now(), scannedAt: contractScans.get(regionId)?.scannedAt ?? 0, byType: contractScans.get(regionId)?.byType ?? new Map() });
  }
}

/** 合同单价比价公式配置（可在设置页自定义） */
interface ValuationConfig {
  /** 其他物品估值基准：buy=该星域最高收单价 / sell=该星域最低卖单价 */
  basis: 'buy' | 'sell';
  /** 折扣系数（默认 0.9，即收单九折） */
  discount: number;
}
const DEFAULT_VALUATION: ValuationConfig = { basis: 'buy', discount: 0.9 };

function getValuationConfig(): ValuationConfig {
  try {
    const raw = registry.getConfigValue('contract_valuation');
    if (raw) {
      const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Partial<ValuationConfig>;
      const basis: 'buy' | 'sell' = parsed.basis === 'sell' ? 'sell' : 'buy';
      const discount = Number(parsed.discount);
      if (isFinite(discount) && discount > 0 && discount <= 2) {
        return { basis, discount };
      }
    }
  } catch { /* 配置损坏时用默认值 */ }
  return { ...DEFAULT_VALUATION };
}

const BASIS_PRICE_TTL_MS = 15 * 60 * 1000;
const basisPriceCache = new MemoryCache<number | null>();

/** 其他物品估值单价：按配置取该星域最高收单价或最低卖单价 */
async function getRegionBasisPrice(regionId: number, typeId: number, basis: 'buy' | 'sell'): Promise<number | null> {
  const key = `basis:${basis}:${regionId}:${typeId}`;
  const hit = basisPriceCache.get(key);
  if (hit !== null) return hit;
  let value: number | null = null;
  try {
    const result = await getRegionOrders(scanClient, regionId, typeId, basis);
    if (result.success && Array.isArray(result.data) && result.data.length > 0) {
      value = basis === 'buy'
        ? result.data.reduce((m, o) => (o.price > m ? o.price : m), -Infinity)
        : result.data.reduce((m, o) => (o.price < m ? o.price : m), Infinity);
      if (!isFinite(value)) value = null;
    }
  } catch { /* 估值失败按无数据处理 */ }
  basisPriceCache.set(key, value, BASIS_PRICE_TTL_MS);
  return value;
}

/** 空间站 → 星系ID 缓存（空间站不会搬家，缓存 24 小时） */
const stationSystemCache = new MemoryCache<number | null>();

/** 解析合同地点所属星系：空间站可解析，玩家建筑返回 null */
async function resolveContractSystem(locationId: number): Promise<SystemBrief | null> {
  if (!locationId || locationId >= 1_000_000_000_000) return null; // 玩家建筑无法公开解析
  let systemId = stationSystemCache.get(`st:${locationId}`);
  if (systemId === null) {
    try {
      const result = await getStation(scanClient, locationId);
      systemId = result.success && result.data?.system_id ? result.data.system_id : null;
    } catch {
      systemId = null;
    }
    stationSystemCache.set(`st:${locationId}`, systemId, NAME_TTL_MS);
  }
  if (!systemId) return null;
  return resolveSystemInfo(systemId);
}

/**
 * 折算某星域合同中指定物品的单价（公式可在设置页自定义）：
 * - 合同只含该物品：总价 ÷ 数量
 * - 含其他物品：总价 − Σ(其他物品基准价×折扣×数量)，再 ÷ 该物品数量（标记为估算）
 * - 其他物品无法估值或折算后单价 ≤ 0 的合同剔除
 */
async function valuateContracts(
  contracts: IndexedContract[],
  typeId: number,
  regionId: number,
  regionName: string | null
): Promise<QueriedContract[]> {
  const valuation = getValuationConfig();
  const matched = contracts.filter(c => c.items[typeId] != null && c.items[typeId] > 0);
  const result: QueriedContract[] = [];

  // 收集所有需要估值的其他物品，批量预热缓存
  const otherTypeIds = new Set<number>();
  for (const c of matched) {
    for (const tid of Object.keys(c.items)) {
      if (Number(tid) !== typeId) otherTypeIds.add(Number(tid));
    }
  }
  const basisPriceMap = new Map<number, number | null>();
  let cursor = 0;
  const others = [...otherTypeIds];
  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < others.length) {
      const tid = others[cursor++];
      basisPriceMap.set(tid, await getRegionBasisPrice(regionId, tid, valuation.basis));
    }
  });
  await Promise.all(workers);

  // 解析合同所在星系（只对匹配到的合同解析，数量少）
  const locationIds = [...new Set(matched.map(c => c.location_id).filter(Boolean))];
  const locMap = new Map<number, SystemBrief | null>();
  let locCursor = 0;
  const locWorkers = Array.from({ length: 4 }, async () => {
    while (locCursor < locationIds.length) {
      const lid = locationIds[locCursor++];
      locMap.set(lid, await resolveContractSystem(lid));
    }
  });
  await Promise.all(locWorkers);

  for (const c of matched) {
    const quantity = c.items[typeId];
    const otherEntries = Object.entries(c.items).filter(([tid]) => Number(tid) !== typeId);
    const loc = locMap.get(c.location_id) ?? null;
    const locFields = {
      system_name: loc?.name ?? null,
      security: loc?.security ?? null,
      is_structure: c.location_id >= 1_000_000_000_000
    };

    if (otherEntries.length === 0) {
      result.push({
        contract_id: c.contract_id,
        type_id: typeId,
        quantity,
        side: c.side,
        unit_price: c.total_price / quantity,
        total_price: c.total_price,
        estimated: false,
        region_id: regionId,
        region_name: regionName,
        ...locFields,
        title: c.title,
        date_issued: c.date_issued,
        date_expired: c.date_expired
      });
      continue;
    }

    // 含其他物品：扣除其他物品估值
    let othersValue = 0;
    let canValue = true;
    for (const [tid, qty] of otherEntries) {
      const basisPrice = basisPriceMap.get(Number(tid));
      if (basisPrice == null) { canValue = false; break; }
      othersValue += basisPrice * valuation.discount * qty;
    }
    if (!canValue) continue;

    const adjusted = c.total_price - othersValue;
    const unitPrice = adjusted / quantity;
    if (unitPrice <= 0) continue;

    result.push({
      contract_id: c.contract_id,
      type_id: typeId,
      quantity,
      side: c.side,
      unit_price: unitPrice,
      total_price: c.total_price,
      estimated: true,
      region_id: regionId,
      region_name: regionName,
      ...locFields,
      title: c.title,
      date_issued: c.date_issued,
      date_expired: c.date_expired
    });
  }
  return result;
}

/** 全星域合同时优先扫描的主要贸易星域（排扫描队列最前） */
const MAJOR_TRADE_REGIONS = [10000002, 10000043, 10000032, 10000042, 10000030];

/** 星域扫描队列：最多同时扫 MAX_REGION_SCANS 个星域，避免打满 ESI */
const MAX_REGION_SCANS = 4;
const regionScanQueue: number[] = [];

/** 扫描失败冷却：失败 5 分钟内不再重试，避免网络故障时重试风暴 */
const SCAN_FAIL_COOLDOWN_MS = 5 * 60 * 1000;

function queueRegionScan(regionId: number): void {
  const state = contractScans.get(regionId);
  if (state?.scanning) return;
  if (state && Date.now() - state.scannedAt < CONTRACT_INDEX_TTL_MS) return;
  if (state && state.attemptedAt > 0 && Date.now() - state.attemptedAt < SCAN_FAIL_COOLDOWN_MS) return;
  if (regionScanQueue.includes(regionId)) return;
  regionScanQueue.push(regionId);
  void pumpScanQueue();
}

async function pumpScanQueue(): Promise<void> {
  while (regionScanQueue.length > 0) {
    const current = [...contractScans.values()].filter(s => s.scanning).length;
    if (current >= MAX_REGION_SCANS) return;
    const next = regionScanQueue.shift();
    if (next == null) return;
    void scanRegionContracts(next).finally(() => pumpScanQueue());
  }
}

interface ContractQueryResult {
  ready: boolean;
  scanning: boolean;
  contracts: QueriedContract[];
  /** 已完成扫描并纳入合并的星域 */
  scannedRegions: number[];
  /** 全星域模式下的星域总数（扫描进度分母） */
  totalRegions?: number;
  /** 其中实际有该物品合同的星域数 */
  regionsWithContracts: number;
  scannedAt: number | null;
}

async function queryContracts(regionId: number, typeId: number): Promise<ContractQueryResult> {
  if (regionId !== 0) {
    const state = contractScans.get(regionId);
    const fresh = state && Date.now() - state.scannedAt < CONTRACT_INDEX_TTL_MS;
    if (!fresh) queueRegionScan(regionId);
    const current = contractScans.get(regionId);
    const raw = current?.byType.get(typeId) ?? [];
    const contracts = (await valuateContracts(raw, typeId, regionId, null))
      .sort((a, b) => a.unit_price - b.unit_price);
    return {
      ready: Boolean(fresh),
      scanning: current?.scanning ?? false,
      contracts,
      scannedRegions: current && current.scannedAt > 0 ? [regionId] : [],
      regionsWithContracts: contracts.length > 0 ? 1 : 0,
      scannedAt: current?.scannedAt || null
    };
  }

  // 全星域：立即触发所有 K 空间星域的扫描（主要贸易星域排前，虫洞/特殊星域除外），
  // 已完成扫描的星域结果先返回，前端轮询渐进更新
  const allRegions = (await fetchRegionList()).filter(r => r.region_id < 11000000);
  const restIds = allRegions.map(r => r.region_id).filter(id => !MAJOR_TRADE_REGIONS.includes(id));
  for (const id of [...MAJOR_TRADE_REGIONS, ...restIds]) {
    queueRegionScan(id);
  }
  const nameMap = new Map(allRegions.map(r => [r.region_id, r.name]));
  const merged: QueriedContract[] = [];
  const scannedRegions: number[] = [];
  let anyScanning = regionScanQueue.length > 0;
  let latestScan = 0;
  for (const [rid, s] of contractScans) {
    if (s.scanning) anyScanning = true;
    if (s.scannedAt <= 0) continue;
    scannedRegions.push(rid);
    latestScan = Math.max(latestScan, s.scannedAt);
    const valued = await valuateContracts(s.byType.get(typeId) ?? [], typeId, rid, nameMap.get(rid) ?? `星域 ${rid}`);
    merged.push(...valued);
  }
  merged.sort((a, b) => a.unit_price - b.unit_price);
  return {
    ready: scannedRegions.length > 0,
    scanning: anyScanning,
    contracts: merged,
    scannedRegions,
    totalRegions: allRegions.length,
    regionsWithContracts: new Set(merged.map(c => c.region_id)).size,
    scannedAt: latestScan || null
  };
}

// ---------- 全星域聚合 ----------

/** 全星域实时价：所有星域订单中的最低卖 / 最高买 */
async function fetchAllRegionsPrice(typeId: number): Promise<RegionPrice> {
  const regions = await fetchRegionList();
  const nameMap = new Map(regions.map(r => [r.region_id, r.name]));
  const best: {
    sell: { price: number; region_id: number } | null;
    buy: { price: number; region_id: number } | null;
  } = { sell: null, buy: null };

  let cursor = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (cursor < regions.length) {
      const r = regions[cursor++];
      const [s, b] = await Promise.allSettled([
        getRegionOrders(scanClient, r.region_id, typeId, 'sell'),
        getRegionOrders(scanClient, r.region_id, typeId, 'buy')
      ]);
      if (s.status === 'fulfilled' && s.value.success && Array.isArray(s.value.data) && s.value.data.length > 0) {
        const min = s.value.data.reduce((m, o) => (o.price < m ? o.price : m), Infinity);
        if (!best.sell || min < best.sell.price) best.sell = { price: min, region_id: r.region_id };
      }
      if (b.status === 'fulfilled' && b.value.success && Array.isArray(b.value.data) && b.value.data.length > 0) {
        const max = b.value.data.reduce((m, o) => (o.price > m ? o.price : m), -Infinity);
        if (!best.buy || max > best.buy.price) best.buy = { price: max, region_id: r.region_id };
      }
    }
  });
  await Promise.all(workers);

  // 附带吉他参考价（走缓存，几乎零成本）
  const jita = await fetchPrice(JITA_REGION_ID, typeId);

  const entry: RegionPrice = {
    type_id: typeId,
    region_id: 0,
    sell: best.sell ? best.sell.price : null,
    buy: best.buy ? best.buy.price : null,
    sell_region_name: best.sell ? nameMap.get(best.sell.region_id) ?? null : null,
    buy_region_name: best.buy ? nameMap.get(best.buy.region_id) ?? null : null,
    jita: { sell: jita.sell, buy: jita.buy },
    volume: null,
    updatedAt: new Date().toISOString()
  };
  const allEmpty = entry.sell == null && entry.buy == null;
  return commitPrice(cacheKey(0, typeId), entry, allEmpty);
}

/** 全星域订单簿：聚合各星域订单，全局卖前 20 / 买前 20 */
async function fetchAllRegionsOrders(typeId: number): Promise<OrderBook> {
  const regions = await fetchRegionList();
  const nameMap = new Map(regions.map(r => [r.region_id, r.name]));
  const sellAll: OrderRow[] = [];
  const buyAll: OrderRow[] = [];

  let cursor = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (cursor < regions.length) {
      const r = regions[cursor++];
      const [s, b] = await Promise.allSettled([
        getRegionOrders(scanClient, r.region_id, typeId, 'sell'),
        getRegionOrders(scanClient, r.region_id, typeId, 'buy')
      ]);
      const toRow = (o: MarketOrder): OrderRow => ({
        order_id: o.order_id,
        price: o.price,
        volume_remain: o.volume_remain,
        system_id: o.system_id ?? 0,
        system_name: null,
        is_structure: o.location_id >= 1_000_000_000_000,
        issued: o.issued,
        duration: o.duration,
        region_id: r.region_id,
        region_name: nameMap.get(r.region_id) ?? null
      });
      if (s.status === 'fulfilled' && s.value.success && Array.isArray(s.value.data)) {
        for (const o of s.value.data) sellAll.push(toRow(o));
      }
      if (b.status === 'fulfilled' && b.value.success && Array.isArray(b.value.data)) {
        for (const o of b.value.data) buyAll.push(toRow(o));
      }
    }
  });
  await Promise.all(workers);

  const sellOrders = sellAll.sort((a, b) => a.price - b.price).slice(0, 20);
  const buyOrders = buyAll.sort((a, b) => b.price - a.price).slice(0, 20);

  const systemIds = [...new Set([...sellOrders, ...buyOrders].map(o => o.system_id).filter(Boolean))];
  const infos = await Promise.allSettled(systemIds.map(id => resolveSystemInfo(id)));
  const infoMap = new Map<number, SystemBrief>();
  systemIds.forEach((id, i) => {
    infoMap.set(id, infos[i].status === 'fulfilled' ? infos[i].value : { name: null, security: null });
  });
  for (const row of [...sellOrders, ...buyOrders]) {
    const info = infoMap.get(row.system_id);
    row.system_name = info?.name ?? null;
    row.security = info?.security ?? null;
  }

  const book: OrderBook = {
    type_id: typeId,
    region_id: 0,
    sell: sellOrders,
    buy: buyOrders,
    updatedAt: new Date().toISOString()
  };
  ordersCache.set(cacheKey(0, typeId), book, ORDERS_TTL_MS);
  return book;
}

// ---------- 自动刷新 ----------

function trackQuery(regionId: number, typeId: number): void {
  recentQueries.set(cacheKey(regionId, typeId), Date.now());
}

async function autoRefreshTick(): Promise<void> {
  const now = Date.now();
  for (const [key, lastQueryAt] of recentQueries) {
    if (now - lastQueryAt > RECENT_WINDOW_MS) {
      recentQueries.delete(key);
      continue;
    }
    const hit = priceCache.getWithMeta(key);
    if (hit && hit.ageMs < AUTO_REFRESH_MIN_AGE_MS) continue; // 够新，跳过
    const [regionId, typeId] = key.split(':').map(Number);
    try {
      await fetchPrice(regionId, typeId);
    } catch (err) {
      console.warn('[AutoRefresh]', key, err instanceof Error ? err.message : err);
    }
  }
}

// ---------- ESI 凭证（认证） ----------

const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 到期前 5 分钟自动刷新

function tokenStatus() {
  const token = registry.getToken();
  if (!token) return { loggedIn: false as const };
  const expiresAtMs = new Date(token.expires_at).getTime();
  return {
    loggedIn: true as const,
    valid: isTokenValid(token),
    character_id: token.character_id ?? null,
    character_name: token.character_name ?? null,
    expires_at: token.expires_at,
    expires_in_sec: Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
    mode: token.mode ?? null,
    scopes: token.scopes ?? null,
    can_refresh: Boolean(token.refresh_token)
  };
}

/** 用 refresh_token 换新 token，保留角色信息并持久化 */
async function refreshStoredToken(): Promise<{ refreshed: boolean; error?: string }> {
  const token = registry.getToken();
  if (!token?.refresh_token) {
    return { refreshed: false, error: '当前凭证不含 refresh_token（隐式模式无法自动刷新，请用授权码模式重新登录）' };
  }
  try {
    const newToken = await refreshToken(config, token.refresh_token);
    newToken.character_id = token.character_id;
    newToken.character_name = token.character_name;
    newToken.scopes = token.scopes ?? newToken.scopes;
    registry.setToken(newToken);
    return { refreshed: true };
  } catch (err) {
    return { refreshed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 自动刷新：token 临期且有 refresh_token 时换新 */
async function autoTokenRefresh(): Promise<void> {
  const token = registry.getToken();
  if (!token?.refresh_token) return;
  const msLeft = new Date(token.expires_at).getTime() - Date.now();
  if (msLeft >= TOKEN_REFRESH_THRESHOLD_MS) return;
  const result = await refreshStoredToken();
  if (result.refreshed) {
    console.log('[Auth] 凭证已自动刷新，新到期时间:', registry.getToken()?.expires_at);
  } else {
    console.warn('[Auth] 凭证自动刷新失败:', result.error);
  }
}

// ---------- 静态文件 ----------

function serveStatic(res: http.ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404).end('Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- API ----------

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseRegion(reqUrl: URL): number {
  const r = reqUrl.searchParams.get('region');
  if (r === 'all' || r === '0') return 0; // 全星域
  const n = Number(r);
  return Number.isInteger(n) && n > 0 ? n : JITA_REGION_ID;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function handleApi(req: http.IncomingMessage, reqUrl: URL, res: http.ServerResponse): Promise<void> {
  const p = reqUrl.pathname;

  // ---------- ESI 凭证 ----------
  if (p === '/api/auth/status') {
    return sendJson(res, tokenStatus());
  }

  if (p === '/api/auth/url') {
    // 授权码模式：拿 refresh_token，服务端才能自动刷新
    return sendJson(res, { url: buildAuthEntryUrl(config, 'code'), mode: 'code' });
  }

  if (p === '/api/auth/callback' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { url?: string };
    if (!body.url) return sendJson(res, { error: '缺少回调地址' }, 400);
    try {
      const token = await parseCallbackUrl(config, body.url);
      registry.setToken(token);
      return sendJson(res, { success: true, status: tokenStatus() });
    } catch (err) {
      return sendJson(res, { success: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  if (p === '/api/auth/refresh' && req.method === 'POST') {
    const result = await refreshStoredToken();
    return sendJson(res, { ...result, status: tokenStatus() }, result.refreshed ? 200 : 400);
  }

  if (p === '/api/auth/clear' && req.method === 'POST') {
    registry.clearToken();
    return sendJson(res, { success: true, status: tokenStatus() });
  }

  // 星域列表
  if (p === '/api/regions') {
    return sendJson(res, { regions: await fetchRegionList() });
  }

  // 物品搜索
  if (p === '/api/search') {
    const q = reqUrl.searchParams.get('q') ?? '';
    const results = itemDb.searchItems(q, 30).map(i => ({
      type_id: i.type_id,
      name: i.name,
      category: i.category_3 || i.category_2 || i.category_1 || ''
    }));
    return sendJson(res, { results });
  }

  // 物品详情
  const itemMatch = p.match(/^\/api\/item\/(\d+)$/);
  if (itemMatch) {
    const item = itemDb.getItemById(Number(itemMatch[1]));
    if (!item) return sendJson(res, { error: '物品不存在' }, 404);
    return sendJson(res, { item });
  }

  // 实时价格：内存缓存 15 分钟硬过期，过期必重新拉取
  const priceMatch = p.match(/^\/api\/price\/(\d+)$/);
  if (priceMatch) {
    const typeId = Number(priceMatch[1]);
    const regionId = parseRegion(reqUrl);
    trackQuery(regionId, typeId);

    const hit = priceCache.get(cacheKey(regionId, typeId));
    if (hit) return sendJson(res, { price: hit, fromCache: true });

    const entry = regionId === 0
      ? await fetchAllRegionsPrice(typeId)
      : await fetchPrice(regionId, typeId);
    return sendJson(res, { price: entry, fromCache: false });
  }

  // 订单簿：卖单/买单各前 20，内存缓存 60 秒
  const ordersMatch = p.match(/^\/api\/orders\/(\d+)$/);
  if (ordersMatch) {
    const typeId = Number(ordersMatch[1]);
    const regionId = parseRegion(reqUrl);
    trackQuery(regionId, typeId);

    const hit = ordersCache.get(cacheKey(regionId, typeId));
    if (hit) return sendJson(res, { orders: hit, fromCache: true });

    const book = regionId === 0
      ? await fetchAllRegionsOrders(typeId)
      : await fetchOrders(regionId, typeId);
    return sendJson(res, { orders: book, fromCache: false });
  }

  // 公开合同：只含单一种类物品的按总价折算，含其他物品的按设置页
  // 配置的公式（基准价×折扣）扣除其他物品估值后折算单价（标记 estimated）
  const contractsMatch = p.match(/^\/api\/contracts\/(\d+)$/);
  if (contractsMatch) {
    const typeId = Number(contractsMatch[1]);
    const regionId = parseRegion(reqUrl);
    trackQuery(regionId, typeId);
    const result = await queryContracts(regionId, typeId);
    return sendJson(res, { type_id: typeId, region_id: regionId, valuation: getValuationConfig(), ...result });
  }

  // 合同单价公式配置
  if (p === '/api/config/valuation') {
    if (req.method === 'GET') {
      return sendJson(res, getValuationConfig());
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { basis?: string; discount?: number };
      const basis = body.basis === 'sell' ? 'sell' : 'buy';
      const discount = Number(body.discount);
      if (!isFinite(discount) || discount <= 0 || discount > 2) {
        return sendJson(res, { error: '折扣系数需为 (0, 2] 之间的数字' }, 400);
      }
      const value: ValuationConfig = { basis, discount };
      registry.setConfigValue('contract_valuation', JSON.stringify(value));
      return sendJson(res, { success: true, ...value });
    }
  }

  // 历史价格（按星域，内存缓存 30 分钟）
  const histMatch = p.match(/^\/api\/history\/(\d+)$/);
  if (histMatch) {
    const typeId = Number(histMatch[1]);
    const regionId = parseRegion(reqUrl);
    trackQuery(regionId, typeId);

    if (regionId === 0) {
      return sendJson(res, { error: '全星域模式暂不支持历史曲线，请选择具体星域' }, 400);
    }
    const key = cacheKey(regionId, typeId);
    const hit = historyCache.get(key);
    if (hit) return sendJson(res, { history: hit, region_id: regionId, fromCache: true });

    const result = await getMarketHistory(client, regionId, typeId);
    if (!result.success || !result.data) {
      return sendJson(res, { error: result.error ?? '获取历史数据失败' }, 502);
    }
    historyCache.set(key, result.data, HISTORY_TTL_MS);
    return sendJson(res, { history: result.data, region_id: regionId, fromCache: false });
  }

  sendJson(res, { error: 'Unknown API' }, 404);
}

// ---------- 启动 ----------

async function main(): Promise<void> {
  console.log('[Server] 加载物品数据库...');
  await itemDb.ensureLoaded();
  console.log('[Server] 物品数:', itemDb.getAllItems().length);

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    if (reqUrl.pathname.startsWith('/api/')) {
      handleApi(req, reqUrl, res).catch(err => {
        console.error('[API]', reqUrl.pathname, err);
        sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      });
      return;
    }

    if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
      return serveStatic(res, path.join(ROOT, 'web', 'index.html'));
    }
    if (reqUrl.pathname.startsWith('/docs/')) {
      return serveStatic(res, path.join(ROOT, reqUrl.pathname));
    }
    return serveStatic(res, path.join(ROOT, 'web', reqUrl.pathname));
  });

  server.listen(PORT, () => {
    console.log(`[Server] EVE-Dealer 已启动: http://localhost:${PORT}`);
  });

  // 后台预热：默认星域（吉他）的合同索引
  void scanRegionContracts(JITA_REGION_ID);

  // 后台自动刷新循环（市场价格 + ESI 凭证）
  setInterval(() => {
    autoRefreshTick().catch(err => console.error('[AutoRefresh]', err));
    autoTokenRefresh().catch(err => console.error('[Auth] 自动刷新异常:', err));
  }, AUTO_REFRESH_INTERVAL_MS);
}

main().catch(err => {
  console.error('[Server] 启动失败:', err);
  process.exit(1);
});
