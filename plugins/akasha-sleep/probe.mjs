// 开发探针：验证宿主/工具链 node 能否 require 工作区的 ESM（lib.mjs）。
const { createRequire } = await import('node:module');
const r = createRequire(import.meta.url);
try {
  const m = r('<AKASHA_DIR>/lib.mjs');
  console.log('require(esm) ok:', typeof m.audit, typeof m.loadStore, typeof m.stats);
} catch (error) {
  console.log('require(esm) FAILED:', error.code, String(error.message).slice(0, 160));
}
