import { describe, it, expect, vi, afterEach } from 'vitest';
import { EsiClient } from '../src/esi/client.js';
import { SERENITY_DEFAULTS } from '../src/config.js';

const config = { ...SERENITY_DEFAULTS };

function jsonResponse(data: unknown, headers: Record<string, string> = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: async () => data
  } as unknown as Response;
}

describe('EsiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('成功请求返回数据并拼上 datasource 参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EsiClient(config, { delayMs: 0 });

    const result = await client.request<{ ok: number }>('/markets/10000002/orders/', {
      query: { type_id: 34, order_type: 'sell' }
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: 1 });

    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(calledUrl.origin).toBe(config.esi_base);
    expect(calledUrl.pathname).toBe('/latest/markets/10000002/orders/');
    expect(calledUrl.searchParams.get('datasource')).toBe('serenity');
    expect(calledUrl.searchParams.get('type_id')).toBe('34');
  });

  it('携带 Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EsiClient(config, { delayMs: 0 });
    await client.request('/universe/structures/1/', {
      token: { access_token: 'tok123', token_type: 'Bearer', expires_in: 1, expires_at: '' }
    });
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer tok123');
  });

  it('HTTP 420/429 限流时退避重试', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(null, {}, 429))
      .mockResolvedValueOnce(jsonResponse({ retried: true }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    const client = new EsiClient(config, { delayMs: 0 });

    const promise = client.request('/test/');
    // 推进退避等待（第一次 429 后 backoff = 2^1 * 1000）
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ retried: true });
  });

  it('非 2xx 返回失败结果', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(null, {}, 403)));
    const client = new EsiClient(config, { delayMs: 0 });
    const result = await client.request('/forbidden/');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('网络异常重试后仍失败则返回错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const client = new EsiClient(config, { delayMs: 0, retryCount: 2 });
    const result = await client.request('/down/');
    expect(result.success).toBe(false);
    expect(result.error).toBe('network down');
  });

  it('requestPaginated 按 x-pages 聚合所有页', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([1, 2], { 'x-pages': '3' }))
      .mockResolvedValueOnce(jsonResponse([3, 4], { 'x-pages': '3' }))
      .mockResolvedValueOnce(jsonResponse([5], { 'x-pages': '3' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EsiClient(config, { delayMs: 0, pageDelayMs: 0 });

    const result = await client.requestPaginated<number>('/markets/structures/1/');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([1, 2, 3, 4, 5]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('requestPaginated 中途 404 视为分页结束', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([1], { 'x-pages': '5' }))
      .mockResolvedValueOnce(jsonResponse(null, {}, 404));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EsiClient(config, { delayMs: 0, pageDelayMs: 0 });

    const result = await client.requestPaginated<number>('/markets/structures/1/');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([1]);
  });
});
