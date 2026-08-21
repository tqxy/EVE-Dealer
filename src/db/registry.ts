/**
 * Registry - 应用级数据管理
 * 配置（含 token）、建筑名单、各类缓存的统一入口
 */

import { AppDatabase } from './database.js';
import type { StructureRecord, PriceCacheEntry, StructureOrderCacheEntry } from './database.js';
import type { EveConfig } from '../config.js';
import { SERENITY_DEFAULTS } from '../config.js';
import type { AccessToken } from '../auth/oauth.js';

export class Registry {
  private db: AppDatabase;
  private config: Record<string, unknown> = {};
  private structures: StructureRecord[] = [];

  constructor(db?: AppDatabase) {
    this.db = db ?? new AppDatabase();
    this.loadConfig();
    this.loadStructures();
    this.ensureDefaults();
  }

  private loadConfig(): void {
    const raw = this.db.getAllConfig();
    this.config = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'token') {
        try {
          this.config.token = JSON.parse(value);
        } catch {
          this.config.token = value;
        }
      } else {
        this.config[key] = value;
      }
    }
  }

  private loadStructures(): void {
    this.structures = this.db.getAllStructures();
  }

  /** 缺失的配置项用国服默认值补齐 */
  ensureDefaults(): void {
    let changed = false;
    for (const [key, value] of Object.entries(SERENITY_DEFAULTS)) {
      if (!this.config[key]) {
        this.config[key] = value;
        changed = true;
      }
    }
    // 旧地址升级
    if (this.config.esi_base === 'https://esi.evepc.163.com') {
      this.config.esi_base = SERENITY_DEFAULTS.esi_base;
      changed = true;
    }
    if (typeof this.config.redirect_uri === 'string' &&
        this.config.redirect_uri.startsWith('https://esi.evepc.163.com/')) {
      this.config.redirect_uri = SERENITY_DEFAULTS.redirect_uri;
      changed = true;
    }
    if (changed) this.saveConfig();
  }

  // ---------- Config ----------

  saveConfig(): void {
    for (const [key, value] of Object.entries(this.config)) {
      if (value == null) {
        this.db.deleteConfigValue(key);
      } else if (typeof value === 'object') {
        this.db.setConfigValue(key, JSON.stringify(value));
      } else {
        this.db.setConfigValue(key, String(value));
      }
    }
  }

  getConfig(): EveConfig {
    return this.config as unknown as EveConfig;
  }

  setConfigValue(key: string, value: unknown): void {
    this.config[key] = value;
    this.saveConfig();
  }

  getConfigValue(key: string): unknown {
    return this.config[key] ?? null;
  }

  // ---------- Token ----------

  getToken(): AccessToken | null {
    return (this.config.token as AccessToken) ?? null;
  }

  setToken(token: AccessToken): void {
    this.config.token = token;
    this.db.setConfigValue('token', JSON.stringify(token));
  }

  clearToken(): void {
    delete this.config.token;
    this.db.deleteConfigValue('token');
  }

  // ---------- Structures ----------

  getStructure(id: number): StructureRecord | null {
    return this.structures.find(s => s.id === id) ?? null;
  }

  getStructures(): StructureRecord[] {
    return this.structures;
  }

  addStructure(st: StructureRecord): void {
    const idx = this.structures.findIndex(s => s.id === st.id);
    if (idx >= 0) this.structures[idx] = st;
    else this.structures.push(st);
    this.db.upsertStructure(st);
  }

  removeStructure(id: number): void {
    this.structures = this.structures.filter(s => s.id !== id);
    this.db.deleteStructure(id);
  }

  saveStructures(): void {
    for (const s of this.structures) {
      this.db.upsertStructure(s);
    }
  }

  // ---------- Cache（直接读写 SQLite，不做内存缓冲） ----------

  getPriceCache(typeId: number): PriceCacheEntry | null {
    return this.db.getPriceCache(typeId);
  }

  setPriceCache(typeId: number, data: PriceCacheEntry): void {
    this.db.setPriceCache(typeId, data);
  }

  getBatchPriceCache(typeIds: number[]): Record<string, PriceCacheEntry> {
    return this.db.getBatchPriceCache(typeIds);
  }

  getStructureOrderCache(structureId: number): StructureOrderCacheEntry | null {
    return this.db.getStructureOrderCache(structureId);
  }

  setStructureOrderCache(structureId: number, data: Partial<StructureOrderCacheEntry>): void {
    this.db.setStructureOrderCache(structureId, data);
  }

  clearCache(): void {
    this.db.clearAllCache();
  }

  close(): void {
    this.db.close();
  }
}
