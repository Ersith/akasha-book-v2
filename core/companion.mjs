// companion.mjs —— 配套端口（CompanionPort）v1：**只读**契约。
//
// 目标（2026-10-19 设计稿裁定）：阿卡夏核只依赖「端口」，不依赖 Hindsight / OpenViking 品牌；
// 将来换成自建 Ledger / Persona 时，六库 / MCP / CLI 不动，只换 driver。
//
// v1 明确**只做**：
//   · identity / skipTags / health / capabilities —— 静态、零外部调用；
//   · recall / read —— 未接 adapter 前返回 degraded（不抛死会话、不静默假装有数据）。
// v1 明确**不做**：写入、远端同步、向量检索。写语义等上游异步抽取口径定死再开。
//
// 零依赖（仅 node stdlib）；配置来源：显式 file，或 AKASHA_COMPANIONS，或 AKASHA_DIR/companions.json。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 已知注入标签（含未来 Ledger / Persona 的默认标签）——索引/睡眠必须跳过。 */
export const DEFAULT_SKIP_TAGS = Object.freeze([
  '<hindsight_knowledge',
  '<openviking-context',
  '<ledger_knowledge',
  '<persona_context',
]);

function readConfig(file) {
  if (!file) return null;
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

/** 解析配置：显式 file **独占**（给了就只读它，便于测试与环境隔离）；否则 AKASHA_COMPANIONS → AKASHA_DIR/companions.json。 */
export function resolvePorts({ file, hooks } = {}) {
  const hookMap = hooks && typeof hooks === 'object' ? hooks : {};
  const candidates = file
    ? [file]
    : [
        process.env.AKASHA_COMPANIONS,
        process.env.AKASHA_DIR ? join(process.env.AKASHA_DIR, 'companions.json') : null,
      ].filter(Boolean);
  const cfg = candidates.map(readConfig).find(Boolean) || {};
  const companions = cfg.companions && typeof cfg.companions === 'object' ? cfg.companions : {};
  const ports = [];
  for (const kind of ['repo', 'persona']) {
    const c = companions[kind] && typeof companions[kind] === 'object' ? companions[kind] : {};
    const driver = typeof c.driver === 'string' && c.driver.trim() ? c.driver.trim() : 'none';
    ports.push(makePort(kind, driver, c, hookMap[driver]));
  }
  return ports;
}

/**
 * 单端口对象（只读）。
 * mode：absent＝未配置 driver；degraded＝配置了 driver 但 v1 尚未接 adapter。
 * （live 只在注入了同步 search hook 时出现；health hook 若返回 Promise，调用方需自行 await。）
 */
export function makePort(kind, driver = 'none', cfg = {}, hooks = null) {
  const configured = typeof driver === 'string' && driver !== 'none';
  const live = configured && hooks && typeof hooks.search === 'function';
  const mode = live ? 'live' : (configured ? 'degraded' : 'absent');
  const tags = Array.isArray(cfg.tags)
    ? [...DEFAULT_SKIP_TAGS, ...cfg.tags.filter((t) => typeof t === 'string' && t.trim())]
    : [...DEFAULT_SKIP_TAGS];
  return {
    kind,
    driver,
    identity() { return { kind, driver, mode, version: 'v1' }; },
    capabilities() { return { read: live && typeof hooks.read === 'function', write: false, recall: live, inject: false, reason: live ? 'adapter 已注入（只读）' : 'v1 只读契约，未注入 adapter hooks' }; },
    skipTags() { return [...new Set(tags)]; },
    health() {
      if (live && typeof hooks.health === 'function') {
        try {
          const r = hooks.health();
          if (r && typeof r.then === 'function') {
            r.then(() => {}, () => {});   // 丢弃但吞掉 rejection，避免 unhandledRejection
            return { ok: null, mode: 'degraded', detail: 'health 返回 Promise（v1 不 await；调用方自行探测）' };
          }
          return { ...r, mode };
        } catch (e) { return { ok: false, mode: 'degraded', detail: 'health 失败：' + e.message }; }
      }
      if (live) return { ok: true, mode, detail: 'hooks 已注入（未提供 health 探测）' };
      return { ok: !configured, mode, detail: configured ? `driver=${driver} 已配置，v1 未接 adapter` : '未配置（absent）' };
    },
    recall(query, opts = {}) {
      if (!live) return { hits: [], via: 'degraded', degraded: true, reason: 'v1 只读契约，未注入 adapter hooks' };
      return hooks.search(String(query ?? ''), opts);
    },
    read(id, opts = {}) {
      if (!live || typeof hooks.read !== 'function') return { record: null, depth: 'pointer', degraded: true, reason: 'adapter 未提供 read' };
      return hooks.read(String(id ?? ''), opts);
    },
  };
}

/** 所有端口的 skipTags 并集（默认标签始终在，避免切换期漏跳）。 */
export function skipTagsFor(ports = []) {
  const set = new Set(DEFAULT_SKIP_TAGS);
  for (const p of ports) for (const t of p.skipTags()) set.add(t);
  return [...set];
}

/** 端口健康汇总（给 doctor / 起床包；不联网）。 */
export function healthOf(ports = []) {
  return ports.map((p) => ({ kind: p.kind, driver: p.driver, ...p.health() }));
}
