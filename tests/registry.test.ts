import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppDatabase } from '../src/db/database.js';
import { Registry } from '../src/db/registry.js';
import { SERENITY_DEFAULTS } from '../src/config.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-dealer-reg-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Registry', () => {
  it('空库时自动填充国服默认配置', () => {
    const registry = new Registry(new AppDatabase(dbPath));
    const config = registry.getConfig();
    expect(config.esi_base).toBe(SERENITY_DEFAULTS.esi_base);
    expect(config.auth_base).toBe(SERENITY_DEFAULTS.auth_base);
    expect(config.datasource).toBe('serenity');
    registry.close();
  });

  it('token 设置/读取/清除，并跨实例持久化', () => {
    const registry = new Registry(new AppDatabase(dbPath));
    expect(registry.getToken()).toBeNull();
    registry.setToken({
      access_token: 'tok', refresh_token: 'ref', token_type: 'Bearer',
      expires_in: 1200, expires_at: new Date(Date.now() + 1200000).toISOString(),
      character_id: 42, character_name: '测试角色'
    });
    registry.close();

    // 重新打开数据库，数据仍在
    const registry2 = new Registry(new AppDatabase(dbPath));
    const token = registry2.getToken();
    expect(token?.access_token).toBe('tok');
    expect(token?.character_name).toBe('测试角色');
    registry2.clearToken();
    expect(registry2.getToken()).toBeNull();
    registry2.close();
  });

  it('structures 管理与持久化', () => {
    const registry = new Registry(new AppDatabase(dbPath));
    registry.addStructure({
      id: 2001, name: '测试堡垒', system_id: 30000142, system_name: 'Jita',
      region_id: 10000002, region_name: 'The Forge', type_id: 35834, type_name: 'Keepstar',
      tags: ['主站'], notes: '', accessible: true, last_scan: null
    });
    expect(registry.getStructures()).toHaveLength(1);
    registry.close();

    const registry2 = new Registry(new AppDatabase(dbPath));
    expect(registry2.getStructure(2001)?.name).toBe('测试堡垒');
    registry2.removeStructure(2001);
    expect(registry2.getStructures()).toHaveLength(0);
    registry2.close();
  });
});
