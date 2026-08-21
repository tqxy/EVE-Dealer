/**
 * Auth Module - EVE SSO OAuth2 认证
 * 支持隐式认证 (Implicit Grant) 和授权码模式 (Authorization Code + Refresh)
 *
 * 关键：国服 ESI 认证必须先访问 /account/logoff 清除已有 session，
 * 再重定向到 authorize，否则残留的 cookie 会导致各种错误。
 * 参考: https://kb.ceve-market.org/login/ 的 clickeve() 函数
 */

import type { EveConfig } from '../config.js';
import { DEFAULT_SCOPES } from '../config.js';

export interface AccessToken {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  /** ISO 时间字符串，到期时刻 */
  expires_at: string;
  mode?: 'code' | 'refresh' | 'implicit';
  character_id?: number | null;
  character_name?: string | null;
  scopes?: string;
  state?: string | null;
}

export interface VerifyResult {
  character_id: number;
  character_name: string;
  expires_on: string;
  scopes: string;
}

export function buildAuthUrl(
  config: EveConfig,
  responseType: 'token' | 'code' = 'token',
  scope: string = DEFAULT_SCOPES,
  state?: string
): string {
  const finalState = state ?? `eve_auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const params = new URLSearchParams({
    response_type: responseType,
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    state: finalState,
    scope,
    realm: 'ESI',
    device_id: 'eve_dealer'
  });
  return `${config.auth_base}/v2/oauth/authorize?${params.toString()}`;
}

/**
 * 生成实际打开的 URL：先 logoff 清除 session，再自动跳转到 authorize
 */
export function buildAuthEntryUrl(
  config: EveConfig,
  responseType: 'token' | 'code' = 'token',
  scope?: string,
  state?: string
): string {
  const authUrl = buildAuthUrl(config, responseType, scope, state);
  return `${config.auth_base}/account/logoff?returnUrl=${encodeURIComponent(authUrl)}`;
}

export async function verifyToken(config: EveConfig, accessToken: string): Promise<VerifyResult> {
  const res = await fetch(`${config.auth_base}/oauth/verify`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    throw new Error(`Verify failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    CharacterID: number;
    CharacterName: string;
    ExpiresOn: string;
    Scopes: string;
  };
  return {
    character_id: data.CharacterID,
    character_name: data.CharacterName,
    expires_on: data.ExpiresOn,
    scopes: data.Scopes
  };
}

async function tokenRequest(config: EveConfig, params: URLSearchParams): Promise<AccessToken> {
  const res = await fetch(`${config.auth_base}/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token request failed: HTTP ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString()
  };
}

export async function exchangeCodeForToken(config: EveConfig, code: string): Promise<AccessToken> {
  const token = await tokenRequest(config, new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    code
  }));
  token.mode = 'code';
  return token;
}

export async function refreshToken(config: EveConfig, refreshTokenValue: string): Promise<AccessToken> {
  const token = await tokenRequest(config, new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.client_id,
    refresh_token: refreshTokenValue
  }));
  token.mode = 'refresh';
  return token;
}

/** 提前 60 秒视为过期，留出刷新余量 */
export function isTokenValid(token: AccessToken | null | undefined): boolean {
  if (!token?.expires_at) return false;
  return Date.now() < new Date(token.expires_at).getTime() - 60000;
}

/**
 * 从回调 URL 解析 token（隐式认证 #access_token=... 或授权码 ?code=...）
 * 授权码模式会自动换取 token 并 verify；隐式模式只做 verify。
 */
export async function parseCallbackUrl(
  config: EveConfig,
  callbackUrl: string
): Promise<AccessToken> {
  const hashIdx = callbackUrl.indexOf('#');
  const queryIdx = callbackUrl.indexOf('?');

  if (hashIdx >= 0) {
    const params = new URLSearchParams(callbackUrl.substring(hashIdx + 1));
    const accessToken = params.get('access_token');
    if (accessToken) {
      const expiresIn = parseInt(params.get('expires_in') ?? '1199', 10);
      let charInfo: Partial<VerifyResult> = {};
      try {
        charInfo = await verifyToken(config, accessToken);
      } catch (e) {
        console.warn('[Auth] verify token failed:', e instanceof Error ? e.message : e);
      }
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        state: params.get('state'),
        mode: 'implicit',
        character_id: charInfo.character_id ?? null,
        character_name: charInfo.character_name ?? null,
        scopes: charInfo.scopes
      };
    }
  }

  if (queryIdx >= 0) {
    const params = new URLSearchParams(callbackUrl.substring(queryIdx + 1));
    const code = params.get('code');
    if (code) {
      const token = await exchangeCodeForToken(config, code);
      try {
        const charInfo = await verifyToken(config, token.access_token);
        token.character_id = charInfo.character_id;
        token.character_name = charInfo.character_name;
        token.scopes = charInfo.scopes;
      } catch (e) {
        console.warn('[Auth] verify token failed:', e instanceof Error ? e.message : e);
      }
      return token;
    }
  }

  throw new Error('未在 URL 中找到 access_token 或 code');
}
