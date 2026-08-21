import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildAuthUrl,
  buildAuthEntryUrl,
  isTokenValid,
  parseCallbackUrl
} from '../src/auth/oauth.js';
import { SERENITY_DEFAULTS } from '../src/config.js';

const config = { ...SERENITY_DEFAULTS };

describe('auth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('buildAuthUrl 包含必要参数', () => {
    const url = buildAuthUrl(config, 'code');
    expect(url.startsWith(`${config.auth_base}/v2/oauth/authorize?`)).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(config.client_id);
    expect(params.get('redirect_uri')).toBe(config.redirect_uri);
    expect(params.get('state')).toBeTruthy();
    expect(params.get('scope')).toContain('esi-markets.structure_markets.v1');
  });

  it('buildAuthEntryUrl 先走 logoff 再跳转 authorize', () => {
    const url = buildAuthEntryUrl(config, 'token');
    expect(url.startsWith(`${config.auth_base}/account/logoff?returnUrl=`)).toBe(true);
    const returnUrl = decodeURIComponent(url.split('returnUrl=')[1]);
    expect(returnUrl).toContain('/v2/oauth/authorize?');
    expect(returnUrl).toContain('response_type=token');
  });

  it('isTokenValid 判断有效期（提前 60 秒过期）', () => {
    expect(isTokenValid(null)).toBe(false);
    expect(isTokenValid({ access_token: 'x', token_type: 'Bearer', expires_in: 0, expires_at: '' })).toBe(false);
    const valid = {
      access_token: 'x',
      token_type: 'Bearer',
      expires_in: 1200,
      expires_at: new Date(Date.now() + 1200 * 1000).toISOString()
    };
    expect(isTokenValid(valid)).toBe(true);
    const almostExpired = { ...valid, expires_at: new Date(Date.now() + 30 * 1000).toISOString() };
    expect(isTokenValid(almostExpired)).toBe(false);
  });

  it('parseCallbackUrl 解析隐式认证的 hash token', async () => {
    // verifyToken 会走网络，这里 stub 掉
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ CharacterID: 123, CharacterName: 'Tester', ExpiresOn: '', Scopes: 'scope1' })
    }));
    const token = await parseCallbackUrl(
      config,
      'https://callback.example/#access_token=abc123&expires_in=1199&state=xyz'
    );
    expect(token.access_token).toBe('abc123');
    expect(token.mode).toBe('implicit');
    expect(token.character_id).toBe(123);
    expect(token.character_name).toBe('Tester');
    expect(isTokenValid(token)).toBe(true);
  });

  it('parseCallbackUrl 对无效 URL 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(parseCallbackUrl(config, 'https://callback.example/')).rejects.toThrow();
  });
});
