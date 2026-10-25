// 自我请求 frame（P4 纯模块）：把一次逻辑步骤的自我投影钉住，供装配/发送边界核验。
// 本模块不接线宿主、不写 profile，也不把 frame/hash 标记塞进模型正文。
import { createHash } from 'node:crypto';

export const FRAME_SCHEMA = 'self-frame/v1';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const freeze = (value, seen = new WeakSet()) => {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freeze(item, seen);
  return Object.freeze(value);
};
const canonical = (value) => JSON.stringify(value);

const VIEW_TEXT = {
  self: (projection) => projection.stableText,
  selfLine: (projection) => projection.views.selfLine,
  address: (projection) => projection.views.addressText,
};

function frameCore(frame) {
  return {
    schemaVersion: frame.schemaVersion,
    subjectId: frame.subjectId,
    bindingRevision: frame.bindingRevision,
    storeRootId: frame.storeRootId,
    sourceGeneration: frame.sourceGeneration,
    sourceRootIds: frame.sourceRootIds,
    sourceRevisions: frame.sourceRevisions,
    schemaProjection: frame.projection.schemaVersion,
    policyVersion: frame.policyVersion,
    renderPolicy: frame.renderPolicy,
    projectionStableHash: frame.projection.stableHash,
    projectionCardHash: frame.projection.cardHash,
    projectionStatus: frame.projection.status,
    allowDegraded: frame.allowDegraded,
    requiredSemanticKeys: frame.requiredSemanticKeys,
  };
}

function coveredBySelection(projection, key) {
  const selected = new Set(projection.selectedStableIds ?? []);
  return projection.entries.some((entry) => !entry.conflict
    && entry.semanticKey === key && selected.has(entry.id));
}

/**
 * 从已捕获的 source 和 projection 建帧。frameId 绑定源 generation、revision 映射、
 * render policy 与投影正文哈希；stableHash 单独存在时不等于版本绑定。
 */
export function createSelfFrame({ source, projection, subjectId, bindingRevision, storeRootId, requiredSemanticKeys = [], renderPolicy = {}, allowDegraded = false } = {}) {
  if (!source || !projection) throw new TypeError('source/projection 必填');
  if (typeof subjectId !== 'string' || !subjectId) throw new TypeError('subjectId 必填');
  if (typeof bindingRevision !== 'string' || !bindingRevision) throw new TypeError('bindingRevision 必填');
  if (typeof storeRootId !== 'string' || !storeRootId) throw new TypeError('storeRootId 必填');
  if (!Array.isArray(requiredSemanticKeys)) throw new TypeError('requiredSemanticKeys 必须是数组');
  if (source.subjectId !== subjectId) throw new Error('source subject 不匹配');
  if (!source.generation || !Array.isArray(source.errors) || source.errors.length > 0) {
    throw new Error('source 不健康：缺 generation 或存在解析错误');
  }
  if (!projection || projection.subjectId !== subjectId) throw new Error('projection subject 不匹配');
  if (!['ok', 'degraded'].includes(projection.status) || (projection.status === 'degraded' && !allowDegraded)) {
    throw new Error(`projection 不可投递：${projection.status}`);
  }
  for (const key of requiredSemanticKeys) {
    if (!coveredBySelection(projection, key)) throw new Error(`缺少必需 semantic key：${key}`);
  }
  const frame = {
    schemaVersion: FRAME_SCHEMA,
    subjectId,
    bindingRevision,
    storeRootId,
    sourceGeneration: source.generation,
    sourceRootIds: [...(projection.sourceRootIds ?? [])],
    sourceRevisions: { ...(projection.sourceRevisions ?? {}) },
    schemaProjection: projection.schemaVersion,
    policyVersion: projection.policyVersion,
    renderPolicy: clone(renderPolicy),
    projection: clone(projection),
    allowDegraded: Boolean(allowDegraded),
    requiredSemanticKeys: [...requiredSemanticKeys],
  };
  const id = sha(canonical(frameCore(frame)));
  return freeze({ ...frame, frameId: id });
}

/** 判断帧是否仍是当前源/投影；先判硬不匹配/不可用，再判同一绑定内的 stale。 */
export function checkSelfFrame({ frame, source, projection, bindingRevision, storeRootId, renderPolicy } = {}) {
  if (!frame || !source || !projection) throw new TypeError('frame/source/projection 必填');
  const reasons = [];
  if (!source.generation || !Array.isArray(source.errors) || source.errors.length > 0) return { status: 'unavailable', reasons: ['source-unavailable'] };
  if (!projection || !['ok', 'degraded'].includes(projection.status)
      || (projection.status === 'degraded' && !frame.allowDegraded)) return { status: 'unavailable', reasons: ['projection-unavailable'] };
  if (frame.subjectId !== source.subjectId || frame.subjectId !== projection.subjectId) reasons.push('subject-mismatch');
  if (bindingRevision !== undefined && frame.bindingRevision !== bindingRevision) reasons.push('binding-mismatch');
  if (storeRootId !== undefined && frame.storeRootId !== storeRootId) reasons.push('root-mismatch');
  if (renderPolicy !== undefined && canonical(frame.renderPolicy) !== canonical(renderPolicy)) reasons.push('render-policy-mismatch');
  if (reasons.length) return { status: 'mismatch', reasons };
  if (frame.sourceGeneration !== source.generation) return { status: 'stale', reasons: ['source-generation'] };
  if (frame.projection.stableHash !== projection.stableHash) return { status: 'mismatch', reasons: ['stable-hash'] };
  if (frame.projection.cardHash !== projection.cardHash) return { status: 'mismatch', reasons: ['card-hash'] };
  if (canonical(frame.sourceRevisions) !== canonical(projection.sourceRevisions)) return { status: 'mismatch', reasons: ['source-revisions'] };
  if (frame.schemaProjection !== projection.schemaVersion || frame.policyVersion !== projection.policyVersion) return { status: 'mismatch', reasons: ['policy'] };
  return { status: 'current', reasons: [] };
}

function locateExact(payload, location, text) {
  if (!payload || typeof payload !== 'object') return false;
  if (location === 'system') return typeof payload.system === 'string' && payload.system === text;
  if (location === 'context') {
    return Array.isArray(payload.contexts) && payload.contexts.some((ctx) => ctx && ctx.text === text);
  }
  return false; // metadata/debug 等位置不能承载受管人格事实
}

/**
 * 最终请求前的纯校验：provenance 必须由受管来源提供，且每个 view 的完整预期正文
 * 必须出现在声明的实际位置；不允许跨 payload 全字段搜索或用户引用替代。
 */
export function validateSelfPayload({ frame, payload, provenance, requiredViews = ['self'] } = {}) {
  if (!frame || payload === undefined || !Array.isArray(provenance)) throw new TypeError('frame/payload/provenance 必填');
  const reasons = [];
  let body = payload;
  if (typeof payload === 'string') {
    try { body = JSON.parse(payload); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') return { status: 'reject', reasons: ['payload-shape'] };
  const byView = new Map();
  for (const item of provenance) {
    if (!item || item.frameId !== frame.frameId || !['system', 'context'].includes(item.location)) {
      reasons.push('provenance-frame/location');
      continue;
    }
    if (item.reassemblyRequired === true) reasons.push('reassembly-required');
    const expected = VIEW_TEXT[item.view]?.(frame.projection);
    if (expected === undefined) { reasons.push(`unknown-view:${item.view}`); continue; }
    if (item.text !== expected) { reasons.push(`view-text:${item.view}`); continue; }
    if (!locateExact(body, item.location, item.text)) { reasons.push(`payload-location:${item.view}`); continue; }
    if (byView.has(item.view) && byView.get(item.view) !== item.text) reasons.push(`conflicting-view:${item.view}`);
    byView.set(item.view, item.text);
  }
  for (const view of requiredViews) {
    if (!byView.has(view)) reasons.push(`missing-view:${view}`);
  }
  const requiredLines = frame.projection.stableText.split(String.fromCharCode(10)).filter(Boolean);
  for (const line of requiredLines) {
    if (!requiredViews.some((view) => (VIEW_TEXT[view]?.(frame.projection) ?? '').includes(line))) {
      reasons.push(`required-line-not-in-view:${line}`);
    }
  }
  for (const key of frame.requiredSemanticKeys) {
    if (!coveredBySelection(frame.projection, key)) reasons.push(`missing-required-key:${key}`);
  }
  if (reasons.length === 0) return { status: 'allow' };
  return { status: 'reject', reasons: [...new Set(reasons)] };
}
