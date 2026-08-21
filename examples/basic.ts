/**
 * 基础用法示例：认证 URL 生成 + 吉他价格拉取
 * 运行: npm run example
 */
import {
  Registry,
  EsiClient,
  PriceService,
  buildAuthEntryUrl,
  getJitaSellPrice
} from '../src/index.js';

const registry = new Registry();
const config = registry.getConfig();

// 1. 生成认证入口 URL（在浏览器打开完成授权）
console.log('认证入口:', buildAuthEntryUrl(config, 'token'));

// 2. 拉取吉他价格（无需认证的公开接口）
const client = new EsiClient(config, { delayMs: 300 });
const price = await getJitaSellPrice(client, 34); // Tritanium
console.log('Tritanium 吉他最低卖价:', price);

// 3. 批量后台刷新（写 SQLite 缓存）
const service = new PriceService(client, registry);
const count = service.startRefresh([34, 35, 36], (typeId, data) => {
  console.log(`已刷新 ${typeId}:`, data.jita_sell);
});
console.log(`待刷新: ${count} 个物品`);
await service.drain();

registry.close();
