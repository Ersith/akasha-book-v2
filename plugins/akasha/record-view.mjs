// M2 · deterministic record -> M1 view adapter (no writes, no classification guess beyond legacy rules).
import { classifyLegacy, dateOnly, parseInstant, recordDigest } from './forgetting.mjs';

const SUPPORTED_STORES = new Set(['canon', 'mirror', 'session']);
const CLASSES = new Set(['C1', 'C2', 'C3']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function contentOf(store, record) {
  if (store === 'mirror') {
    const tuple = {};
    for (const key of ['situation', 'behavior', 'outcome', 'social_reaction', 'emotion']) {
      if (typeof record[key] !== 'string' || !record[key].trim()) throw new TypeError(`mirror.${key} 必须是非空字符串`);
      tuple[key] = record[key];
    }
    return tuple;
  }
  if (store === 'session') {
    const gist = record.gist;
    if (typeof gist !== 'string' || !gist.trim()) throw new TypeError('session.gist 必须是非空字符串');
    const content = { gist };
    if (record.why != null) {
      if (typeof record.why !== 'string') throw new TypeError('session.why 必须是字符串');
      content.why = record.why;
    }
    return content;
  }
  const text = ['claim', 'line', 'summary', 'why'].map((key) => record[key]).find((value) => typeof value === 'string' && value.trim());
  if (!text) throw bad('missing-content', 'canon 记录缺少可评估正文（claim/line/summary/why）');
  return { text };
}

function timeOf(record) {
  for (const value of [record.event_time, record.last_reviewed, record.logged_at]) {
    if (value == null) continue;
    if (typeof value !== 'string') throw new TypeError('记录时间必须是字符串');
    if (DATE_RE.test(value)) {
      const parsed = dateOnly(value);
      if (parsed.status !== 'ok') throw new TypeError('记录日期非法：' + value);
      return { eventDay: parsed.day };
    }
    const instant = parseInstant(value);
    if (instant.status === 'ok') return { eventTime: value };
    throw bad('invalid-time', '记录时间必须是 YYYY-MM-DD 或带时区的 ISO instant：' + value);
  }
  return {};
}

/** Build a view for one current record. Unknown stores/classes are rejected, never guessed. */
export function recordToView(record, { store, contentClass, contextRef, review = null } = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('record 必须是对象');
  if (typeof store !== 'string' || !SUPPORTED_STORES.has(store)) throw bad('unsupported-store', 'store 目前只支持 canon/mirror/session');
  if (typeof record.id !== 'string' || !record.id) throw new TypeError('record.id 必须是非空字符串');
  const legacy = classifyLegacy(store, record);
  if (contentClass !== undefined && !CLASSES.has(contentClass)) throw new TypeError('contentClass 必须是 C1/C2/C3');
  const klass = contentClass ?? legacy.contentClass;
  if (klass === 'unknown') throw bad('unknown-class', 'record 无已知 contentClass；请显式传入 C2/C3');
  if (contentClass === 'C1' && !legacy.protection) throw new TypeError('只有 legacy 自保护/协议记录可以显式 C1');
  const content = contentOf(store, record);
  const time = timeOf(record);
  return {
    store,
    id: record.id,
    versionId: record.id,
    digest: recordDigest({ store, id: record.id, versionId: record.id, content }),
    content,
    contentClass: klass,
    protection: legacy.protection,
    protectionReasons: legacy.reasons,
    ...time,
    contextRef: contextRef ?? null,
    review: review ?? record.review ?? null,
  };
}
