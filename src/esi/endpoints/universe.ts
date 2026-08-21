/**
 * Universe ESI 端点封装
 * 星域 / 星系基础信息查询
 */

import type { EsiClient, EsiResult } from '../client.js';

export interface RegionInfo {
  region_id: number;
  name: string;
  description?: string;
}

export interface SystemInfo {
  system_id: number;
  name: string;
  constellation_id: number;
  security_status?: number;
}

/** 全部星域 ID 列表 */
export async function getRegionIds(client: EsiClient): Promise<number[]> {
  const result = await client.request<number[]>('/universe/regions/');
  return result.success && Array.isArray(result.data) ? result.data : [];
}

/** 单个星域信息（language=zh 返回中文名） */
export function getRegion(
  client: EsiClient,
  regionId: number,
  language = 'zh'
): Promise<EsiResult<RegionInfo>> {
  return client.request<RegionInfo>(`/universe/regions/${regionId}/`, {
    query: { language }
  });
}

/** 单个星系信息（language=zh 返回中文名） */
export function getSystem(
  client: EsiClient,
  systemId: number,
  language = 'zh'
): Promise<EsiResult<SystemInfo>> {
  return client.request<SystemInfo>(`/universe/systems/${systemId}/`, {
    query: { language }
  });
}

export interface StationInfo {
  station_id: number;
  name: string;
  system_id: number;
}

/** 空间站信息（可解析所属星系） */
export function getStation(
  client: EsiClient,
  stationId: number
): Promise<EsiResult<StationInfo>> {
  return client.request<StationInfo>(`/universe/stations/${stationId}/`);
}
