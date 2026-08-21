/**
 * Contracts ESI 端点封装
 * 公开合同查询（无需认证）
 */

import type { EsiClient, EsiResult } from '../client.js';

export interface PublicContract {
  contract_id: number;
  type: 'item_exchange' | 'auction' | 'courier' | 'loan' | string;
  /** 接受方需支付给发起方的 ISK（出售合同要价） */
  price: number;
  /** 发起方支付给接受方的 ISK（收购合同出价） */
  reward: number;
  title: string;
  volume: number;
  date_issued: string;
  date_expired: string;
  start_location_id?: number;
  end_location_id?: number;
  issuer_id: number;
  for_corporation?: boolean;
}

export interface PublicContractItem {
  type_id: number;
  quantity: number;
  is_included: boolean;
  is_blueprint_copy?: boolean;
}

/** 星域公开合同列表（自动翻页） */
export function getPublicContracts(
  client: EsiClient,
  regionId: number
): Promise<EsiResult<PublicContract[]>> {
  return client.requestPaginated<PublicContract>(`/contracts/public/${regionId}/`);
}

/** 公开合同物品清单 */
export function getPublicContractItems(
  client: EsiClient,
  contractId: number
): Promise<EsiResult<PublicContractItem[]>> {
  return client.request<PublicContractItem[]>(`/contracts/public/items/${contractId}/`);
}
