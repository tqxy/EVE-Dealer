/**
 * 全局配置类型与国服默认值
 */

export interface EveConfig {
  /** EVE 开发者应用 Client ID */
  client_id: string;
  /** ESI API 基础地址 */
  esi_base: string;
  /** SSO 认证服务基础地址 */
  auth_base: string;
  /** 数据源（serenity=国服 / tranquility=欧服） */
  datasource: string;
  /** OAuth 回调地址 */
  redirect_uri: string;
}

/** 国服（Serenity）默认配置 */
export const SERENITY_DEFAULTS: EveConfig = {
  client_id: 'bc90aa496a404724a93f41b4f4e97761',
  esi_base: 'https://ali-esi.evepc.163.com',
  auth_base: 'https://login.evepc.163.com',
  datasource: 'serenity',
  redirect_uri: 'https://ali-esi.evepc.163.com/ui/oauth2-redirect.html'
};

/** 常用星域/星系常量 */
export const JITA_REGION_ID = 10000002; // The Forge
export const JITA_SYSTEM_ID = 30000142; // Jita

/** 默认请求 scope：建筑市场读取 + 建筑信息读取 */
export const DEFAULT_SCOPES =
  'esi-markets.structure_markets.v1 esi-universe.read_structures.v1';
