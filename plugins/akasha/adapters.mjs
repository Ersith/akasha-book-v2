// adapters.mjs —— CompanionPort 的「宿主侧」薄适配：把任意 MCP callTool 包成 hooks。
//
// 核心（companion.mjs）零依赖、不 import 本文件；宿主（DSH 插件 / CLI 桥）按需 import。
// 本文件只做**形状映射**：不重试、不缓存、不合并结果——失败与超时由 callTool 决定，原样带出。
//
// 用法：
//   import { hindsightHooks } from './adapters.mjs';
//   const ports = resolvePorts({ hooks: { hindsight: hindsightHooks(callTool) } });

/**
 * 通用 MCP hooks 工厂。
 * @param {object} o
 * @param {(name:string,args:object)=>any} o.callTool
 * @param {string} o.searchTool
 * @param {(query:string, opts:object)=>object} [o.searchArgs]
 * @param {(raw:any, query:string)=>object} [o.mapSearch]
 * @param {string} [o.readTool]
 * @param {(id:string, opts:object)=>object} [o.readArgs]
 * @param {(raw:any, id:string)=>object} [o.mapRead]
 */
export function mcpHooks({
  callTool, searchTool,
  searchArgs = (query) => ({ query }),
  mapSearch = (raw, query) => ({ hits: normalizeHits(raw), via: searchTool, query }),
  readTool, readArgs = (id) => ({ id }),
  mapRead = (raw, id) => ({ record: raw, depth: 'summary', id }),
} = {}) {
  if (typeof callTool !== 'function' || !searchTool) throw new Error('mcpHooks 需要 callTool + searchTool');
  return {
    search: (query, opts = {}) => {
      const raw = callTool(searchTool, searchArgs(String(query ?? ''), opts));
      return raw && typeof raw.then === 'function' ? raw.then((r) => mapSearch(r, String(query ?? ''))) : mapSearch(raw, String(query ?? ''));
    },
    read: readTool ? (id, opts = {}) => {
      const raw = callTool(readTool, readArgs(String(id ?? ''), opts));
      return raw && typeof raw.then === 'function' ? raw.then((r) => mapRead(r, String(id ?? ''))) : mapRead(raw, String(id ?? ''));
    } : undefined,
    health: () => ({ ok: true, detail: 'hooks 已注入（不主动探测服务）' }),
  };
}

function hasKnownShape(raw) {
  return Boolean(raw && (Array.isArray(raw) || Array.isArray(raw.hits) || Array.isArray(raw.pages) || Array.isArray(raw.results)));
}

function normalizeHits(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.hits)) return raw.hits;
  if (Array.isArray(raw.pages)) return raw.pages;
  if (Array.isArray(raw.results)) return raw.results;
  return [];
}

/** Hindsight：仓记忆知识页（只读）。 */
export function hindsightHooks(callTool) {
  return mcpHooks({
    callTool,
    searchTool: 'hindsight_search_knowledge_pages',
    searchArgs: (query) => ({ query }),
    mapSearch: (raw, query) => ({
      ...(hasKnownShape(raw) ? {} : { degraded: true, reason: 'Hindsight 返回未知形状（已保留 raw）', raw }),
      hits: (hasKnownShape(raw) ? normalizeHits(raw) : []).map((p) => (p && typeof p === 'object'
        ? { id: p.page_id ?? p.id ?? null, title: p.page ?? p.title ?? '', text: p.snippet ?? p.description ?? '', raw: p }
        : { id: null, title: '', text: String(p), raw: p })),
      via: 'hindsight', query, ...(hasKnownShape(raw) ? { degraded: false } : {}),
    }),
    readTool: 'hindsight_read_knowledge_page',
    readArgs: (id) => ({ page_id: id }),
    mapRead: (raw, id) => ({ record: raw, depth: 'summary', id, via: 'hindsight' }),
  });
}

// OpenViking（2026-10-19 复核）：其 MCP 工具返回「Found N item(s)…」格式化文本，不是结构化 hits；
// v1 不接（避免把文本当 hits 静默空）。等 REST 或文本解析器落地后再加 openvikingHooks。

/**
 * Hindsight **REST**（本机 daemon，只读）：不依赖 MCP 文本形状。
 * 端点：GET /v1/default/banks/{bank}/knowledge-base/search?q=&limit=
 *      GET /v1/default/banks/{bank}/knowledge-base/pages/{id}
 * 失败/非 2xx ⇒ {hits:[], degraded:true}（保留 status/reason，不静默成功）。
 */
export function hindsightHttpHooks({ baseUrl, bankId, token, fetchImpl = globalThis.fetch, limit = 5 } = {}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('hindsightHttpHooks 需要 baseUrl');
  if (typeof fetchImpl !== 'function') throw new Error('hindsightHttpHooks 需要 fetch');
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  let bankPromise = bankId ? Promise.resolve(String(bankId)) : null;
  const resolveBank = () => {
    if (bankPromise) return bankPromise;
    bankPromise = (async () => {
      const r = await fetchImpl(base + '/v1/default/banks', { headers });
      if (!r.ok) throw new Error('banks HTTP ' + r.status);
      const j = await r.json();
      const ids = (Array.isArray(j?.banks) ? j.banks : []).map((x) => x.bank_id).filter(Boolean);
      if (ids.length === 1) return ids[0];
      throw new Error('需要 HINDSIGHT_BANK_ID（发现 ' + ids.length + ' 个 bank）');
    })();
    return bankPromise;
  };
  const bankUrl = async (suffix) => `${base}/v1/default/banks/${encodeURIComponent(await resolveBank())}${suffix}`;
  return {
    search: async (query, opts = {}) => {
      const q = '?q=' + encodeURIComponent(String(query ?? '')) + '&limit=' + encodeURIComponent(String(opts.limit ?? limit));
      try {
        const r = await fetchImpl(await bankUrl('/knowledge-base/search' + q), { headers });
        if (!r.ok) return { hits: [], via: 'hindsight-http', degraded: true, reason: 'HTTP ' + r.status };
        const j = await r.json();
        if (!Array.isArray(j?.results)) return { hits: [], via: 'hindsight-http', degraded: true, reason: '响应无 results 数组', raw: j };
        return { hits: j.results.map((x) => ({ id: x.id ?? null, title: x.name ?? '', text: x.snippet ?? '', raw: x })), via: 'hindsight-http', degraded: false };
      } catch (e) { return { hits: [], via: 'hindsight-http', degraded: true, reason: '请求失败：' + e.message }; }
    },
    read: async (id) => {
      try {
        const r = await fetchImpl(await bankUrl('/knowledge-base/pages/' + encodeURIComponent(String(id ?? ''))), { headers });
        if (!r.ok) return { record: null, via: 'hindsight-http', degraded: true, reason: 'HTTP ' + r.status };
        return { record: await r.json(), depth: 'summary', id, via: 'hindsight-http' };
      } catch (e) { return { record: null, via: 'hindsight-http', degraded: true, reason: '请求失败：' + e.message }; }
    },
    health: async () => {
      try {
        const r = await fetchImpl(base + '/v1/default/banks', { headers });
        return { ok: r.ok, detail: 'HTTP ' + r.status };
      } catch (e) { return { ok: false, detail: '请求失败：' + e.message }; }
    },
  };
}

/**
 * OpenViking **REST**（本机 HTTP Server，只读）：POST /api/v1/search/search。
 * 返回 { status:'ok', result:{ memories:[{uri,abstract,score,…}] } }；read 走 GET /api/v1/content/read?uri=…
 * 非 2xx / body 无 memories 数组 ⇒ {hits:[], degraded:true, reason}（保留 raw），不静默空。
 */
export function openvikingHttpHooks({ baseUrl, token, fetchImpl = globalThis.fetch, limit = 5 } = {}) {
  const port = process.env.OPENVIKING_PORT || 1933;
  const base = String(baseUrl || ('http://127.0.0.1:' + port)).replace(/\/+$/, '');
  if (!base) throw new Error('openvikingHttpHooks 需要 baseUrl');
  if (typeof fetchImpl !== 'function') throw new Error('openvikingHttpHooks 需要 fetch');
  const auth = token ? { authorization: 'Bearer ' + token } : {};
  return {
    search: async (query, opts = {}) => {
      try {
        const r = await fetchImpl(base + '/api/v1/search/search', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ query: String(query ?? ''), limit: opts.limit ?? limit, mode: 'list' }),
        });
        if (!r.ok) return { hits: [], via: 'openviking-http', degraded: true, reason: 'HTTP ' + r.status };
        const j = await r.json();
        const rows = j?.result?.memories;
        if (!Array.isArray(rows)) return { hits: [], via: 'openviking-http', degraded: true, reason: '响应无 result.memories 数组', raw: j };
        return {
          hits: rows.map((x) => ({
            id: x.uri ?? null,
            title: String(x.uri ?? '').split('/').pop() || '',
            text: x.abstract ?? x.overview ?? '',
            raw: x,
          })),
          via: 'openviking-http', degraded: false,
        };
      } catch (e) { return { hits: [], via: 'openviking-http', degraded: true, reason: '请求失败：' + e.message }; }
    },
    read: async (id) => {
      try {
        const r = await fetchImpl(base + '/api/v1/content/read?uri=' + encodeURIComponent(String(id ?? '')), { headers: auth });
        if (!r.ok) return { record: null, via: 'openviking-http', degraded: true, reason: 'HTTP ' + r.status };
        const j = await r.json();
        return { record: j?.result ?? j, depth: 'summary', id, via: 'openviking-http' };
      } catch (e) { return { record: null, via: 'openviking-http', degraded: true, reason: '请求失败：' + e.message }; }
    },
    health: async () => {
      try {
        const r = await fetchImpl(base + '/health', { headers: auth });
        return { ok: r.ok, detail: 'HTTP ' + r.status };
      } catch (e) { return { ok: false, detail: '请求失败：' + e.message }; }
    },
  };
}
