/**
 * ESI Client - HTTP 请求封装
 * 认证头、限流、重试、分页、错误处理
 *
 * 基于 Node 原生 fetch（Node >= 20），不再依赖 axios。
 */

import type { EveConfig } from '../config.js';
import type { AccessToken } from '../auth/oauth.js';

export interface EsiResult<T = unknown> {
  success: boolean;
  statusCode: number | null;
  headers: Record<string, string>;
  data: T | null;
  error?: string;
}

export interface EsiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  token?: AccessToken | null;
}

export interface EsiClientOptions {
  /** 两次请求之间的最小间隔（毫秒） */
  delayMs?: number;
  /** 翻页请求之间的间隔（毫秒） */
  pageDelayMs?: number;
  /** 单请求超时（毫秒） */
  timeoutMs?: number;
  /** 失败重试次数 */
  retryCount?: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class EsiClient {
  private lastRequestTime = 0;
  private readonly delayMs: number;
  private readonly pageDelayMs: number;
  private readonly timeoutMs: number;
  private readonly retryCount: number;

  constructor(
    private readonly config: EveConfig,
    options: EsiClientOptions = {}
  ) {
    this.delayMs = options.delayMs ?? 300;
    this.pageDelayMs = options.pageDelayMs ?? 150;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.retryCount = options.retryCount ?? 3;
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.delayMs) {
      await sleep(this.delayMs - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  async request<T = unknown>(path: string, options: EsiRequestOptions = {}): Promise<EsiResult<T>> {
    const { method = 'GET', headers = {}, query = {}, body = null, token = null } = options;

    const url = new URL(`/latest${path}`, this.config.esi_base);
    url.searchParams.set('datasource', this.config.datasource);
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, String(v));
    }

    const reqHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...headers
    };
    if (token?.access_token) {
      reqHeaders.Authorization = `Bearer ${token.access_token}`;
    }

    await this.rateLimit();

    for (let attempt = 1; attempt <= this.retryCount; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: reqHeaders,
          body: body != null ? JSON.stringify(body) : null,
          signal: AbortSignal.timeout(this.timeoutMs)
        });

        if (response.status >= 200 && response.status < 300) {
          const data = (await response.json()) as T;
          return {
            success: true,
            statusCode: response.status,
            headers: Object.fromEntries(response.headers),
            data
          };
        }

        // 限流响应：指数退避后重试
        if (response.status === 420 || response.status === 429) {
          const backoff = Math.pow(2, attempt) * 1000;
          console.warn(`[ESI] Rate limited (HTTP ${response.status}). Backing off ${backoff}ms...`);
          await sleep(backoff);
          continue;
        }

        return {
          success: false,
          statusCode: response.status,
          headers: Object.fromEntries(response.headers),
          error: `HTTP ${response.status}: ${response.statusText}`,
          data: null
        };
      } catch (err) {
        if (attempt >= this.retryCount) {
          return {
            success: false,
            statusCode: null,
            headers: {},
            error: err instanceof Error ? err.message : String(err),
            data: null
          };
        }
        await sleep(500);
      }
    }

    return { success: false, statusCode: null, headers: {}, error: 'Max retries exceeded', data: null };
  }

  /** 自动翻页请求，聚合所有页的数据 */
  async requestPaginated<T = unknown>(path: string, options: EsiRequestOptions = {}): Promise<EsiResult<T[]>> {
    const allData: T[] = [];
    let page = 1;

    while (true) {
      const result = await this.request<T | T[]>(path, {
        ...options,
        query: { ...options.query, page }
      });

      if (!result.success) {
        // 翻页越过最后一页时 ESI 返回 404，视为正常结束
        if (page > 1 && result.statusCode === 404) break;
        return { success: false, statusCode: result.statusCode, headers: result.headers, error: result.error, data: allData };
      }

      if (Array.isArray(result.data)) {
        allData.push(...result.data);
      } else if (result.data != null) {
        allData.push(result.data);
      }

      const xPages = result.headers['x-pages'];
      if (!xPages || page >= parseInt(xPages, 10)) break;

      page++;
      await sleep(this.pageDelayMs);
    }

    return { success: true, statusCode: 200, headers: {}, data: allData };
  }
}
