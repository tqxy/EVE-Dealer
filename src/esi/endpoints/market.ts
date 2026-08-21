/**
 * Market / Universe ESI 端点封装
 * 建筑订单、建筑信息、星域订单、市场历史、吉他价格
 */

import type { EsiClient, EsiResult } from '../client.js';
import type { AccessToken } from '../../auth/oauth.js';
import { JITA_REGION_ID, JITA_SYSTEM_ID } from '../../config.js';

export interface MarketOrder {
  order_id: number;
  type_id: number;
  location_id: number;
  system_id?: number;
  price: number;
  volume_remain: number;
  volume_total: number;
  is_buy_order: boolean;
  issued: string;
  duration: number;
  range: string;
  min_volume?: number;
}

export interface StructureInfo {
  name: string;
  solar_system_id: number;
  type_id?: number;
}

export interface MarketHistoryEntry {
  date: string;
  average: number;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
}

/** 获取建筑市场全部订单（自动翻页，需要 esi-markets.structure_markets.v1） */
export function getStructureOrders(
  client: EsiClient,
  structureId: number,
  token: AccessToken
): Promise<EsiResult<MarketOrder[]>> {
  return client.requestPaginated<MarketOrder>(`/markets/structures/${structureId}/`, { token });
}

/** 获取建筑信息（需要 esi-universe.read_structures.v1） */
export function getStructureInfo(
  client: EsiClient,
  structureId: number,
  token: AccessToken
): Promise<EsiResult<StructureInfo>> {
  return client.request<StructureInfo>(`/universe/structures/${structureId}/`, { token });
}

/** 获取星域某物品的订单 */
export function getRegionOrders(
  client: EsiClient,
  regionId: number,
  typeId: number,
  orderType: 'sell' | 'buy' | 'all' = 'sell'
): Promise<EsiResult<MarketOrder[]>> {
  return client.request<MarketOrder[]>(`/markets/${regionId}/orders/`, {
    query: { order_type: orderType, type_id: typeId }
  });
}

/** 获取星域某物品的市场历史 */
export function getMarketHistory(
  client: EsiClient,
  regionId: number,
  typeId: number
): Promise<EsiResult<MarketHistoryEntry[]>> {
  return client.request<MarketHistoryEntry[]>(`/markets/${regionId}/history/`, {
    query: { type_id: typeId }
  });
}

/**
 * 吉他（Jita 4-4）最低卖价
 * 过滤条件：Jita 星系 + 空间站订单（排除建筑订单，location_id < 1e12）
 */
export async function getJitaSellPrice(client: EsiClient, typeId: number): Promise<number | null> {
  const result = await getRegionOrders(client, JITA_REGION_ID, typeId, 'sell');
  if (!result.success || !result.data) return null;
  const orders = result.data
    .filter(o => o.system_id === JITA_SYSTEM_ID && o.location_id < 1_000_000_000_000)
    .sort((a, b) => a.price - b.price);
  return orders.length > 0 ? orders[0].price : null;
}

/** 吉他最高买价 */
export async function getJitaBuyPrice(client: EsiClient, typeId: number): Promise<number | null> {
  const result = await getRegionOrders(client, JITA_REGION_ID, typeId, 'buy');
  if (!result.success || !result.data) return null;
  const orders = result.data
    .filter(o => o.system_id === JITA_SYSTEM_ID && o.location_id < 1_000_000_000_000)
    .sort((a, b) => b.price - a.price);
  return orders.length > 0 ? orders[0].price : null;
}
