/**
 * Meta DB - EVE 物品 Meta Group 数据
 * 数据源: fuzzwork SDE dump (invMetaTypes.csv)
 */

import fs from 'node:fs';
import path from 'node:path';

export const META_TYPES_URL = 'https://www.fuzzwork.co.uk/dump/latest/invMetaTypes.csv';

export interface MetaInfo {
  metaGroupID: number;
  parentTypeID: number;
}

export class MetaDb {
  private db: Map<number, MetaInfo> | null = null;
  private readonly cachePath: string;

  constructor(private readonly dataDir: string = path.join(process.cwd(), 'data')) {
    this.cachePath = path.join(dataDir, 'meta_cache.json');
  }

  private loadCache(): Map<number, MetaInfo> {
    if (this.db) return this.db;
    this.db = new Map();
    if (fs.existsSync(this.cachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8')) as Record<string, MetaInfo | number>;
        for (const [typeId, value] of Object.entries(raw)) {
          // 兼容旧格式 { typeId: metaGroupID }
          this.db.set(Number(typeId), typeof value === 'number' ? { metaGroupID: value, parentTypeID: 0 } : value);
        }
      } catch (e) {
        console.warn('[MetaDB] Cache load failed:', e instanceof Error ? e.message : e);
      }
    }
    return this.db;
  }

  private saveCache(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const obj: Record<string, MetaInfo> = {};
    for (const [typeId, info] of this.db ?? []) {
      obj[String(typeId)] = info;
    }
    fs.writeFileSync(this.cachePath, JSON.stringify(obj), 'utf-8');
  }

  /** 从 fuzzwork 下载并解析 invMetaTypes.csv */
  async download(): Promise<Map<number, MetaInfo>> {
    console.log('[MetaDB] Downloading', META_TYPES_URL);
    const res = await fetch(META_TYPES_URL, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Failed to download invMetaTypes.csv: HTTP ${res.status}`);
    const csvData = await res.text();

    const lines = csvData.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) throw new Error('CSV is empty');
    if (!lines[0].startsWith('typeID')) {
      throw new Error('Unexpected CSV header: ' + lines[0]);
    }

    const db = new Map<number, MetaInfo>();
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 3) continue;
      const typeID = parseInt(parts[0], 10);
      const parentTypeID = parseInt(parts[1], 10);
      const metaGroupID = parseInt(parts[2], 10);
      if (isNaN(typeID) || isNaN(metaGroupID)) continue;
      db.set(typeID, { metaGroupID, parentTypeID: isNaN(parentTypeID) ? 0 : parentTypeID });
    }

    this.db = db;
    this.saveCache();
    console.log('[MetaDB] Parsed', db.size, 'entries');
    return db;
  }

  /** 确保数据已加载（缓存优先，否则下载） */
  async ensureLoaded(): Promise<Map<number, MetaInfo>> {
    const cached = this.loadCache();
    if (cached.size > 0) return cached;
    return this.download();
  }

  getMetaLevel(typeId: number): number {
    return this.loadCache().get(typeId)?.metaGroupID ?? 1;
  }

  getMetaInfo(typeId: number): MetaInfo {
    return this.loadCache().get(typeId) ?? { metaGroupID: 1, parentTypeID: 0 };
  }
}
