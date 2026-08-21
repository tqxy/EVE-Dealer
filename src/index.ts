/**
 * EVE-Dealer - EVE 国服 ESI 基础支撑模块库
 *
 * 包含：
 * - config        国服默认配置与常量
 * - auth          SSO OAuth2 认证（隐式/授权码/刷新）
 * - esi           ESI HTTP 客户端（限流/重试/分页）+ 市场端点封装
 * - db            SQLite 持久化（配置、建筑、价格缓存、订单缓存）
 * - items         物品数据库（evedata.xlsx）与 Meta Group 数据
 * - prices        吉他价格后台批量刷新服务
 */

export { SERENITY_DEFAULTS, JITA_REGION_ID, JITA_SYSTEM_ID, DEFAULT_SCOPES } from './config.js';
export type { EveConfig } from './config.js';

export {
  buildAuthUrl,
  buildAuthEntryUrl,
  verifyToken,
  exchangeCodeForToken,
  refreshToken,
  isTokenValid,
  parseCallbackUrl
} from './auth/oauth.js';
export type { AccessToken, VerifyResult } from './auth/oauth.js';

export { EsiClient, sleep } from './esi/client.js';
export type { EsiResult, EsiRequestOptions, EsiClientOptions } from './esi/client.js';

export {
  getStructureOrders,
  getStructureInfo,
  getRegionOrders,
  getMarketHistory,
  getJitaSellPrice,
  getJitaBuyPrice
} from './esi/endpoints/market.js';
export type { MarketOrder, StructureInfo, MarketHistoryEntry } from './esi/endpoints/market.js';

export { AppDatabase } from './db/database.js';
export type { StructureRecord, PriceCacheEntry, StructureOrderCacheEntry } from './db/database.js';
export { Registry } from './db/registry.js';

export { MemoryCache } from './cache/memoryCache.js';

export { getRegionIds, getRegion, getSystem } from './esi/endpoints/universe.js';
export type { RegionInfo, SystemInfo } from './esi/endpoints/universe.js';

export { getPublicContracts, getPublicContractItems } from './esi/endpoints/contracts.js';
export type { PublicContract, PublicContractItem } from './esi/endpoints/contracts.js';

export { ItemDatabase, EVEDATA_URL } from './items/itemDatabase.js';
export type { EveItem, CategoryTree } from './items/itemDatabase.js';
export { MetaDb, META_TYPES_URL } from './items/metaDb.js';
export type { MetaInfo } from './items/metaDb.js';

export { PriceService } from './prices/priceService.js';
export type { PriceServiceOptions, PriceUpdateCallback, ProgressCallback } from './prices/priceService.js';
