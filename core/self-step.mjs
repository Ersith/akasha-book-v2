// M3 逻辑步骤 frame 协调器（纯模块，未接宿主）。
// 关键契约：一个 step 只捕获一次；self/self-line/address/refresh/retry 都消费同一个 handle；
// pending/unavailable 显式存在，绝不回退到“读最新源”。handle 的权威状态在私有 WeakMap。
import { createHash, randomUUID } from 'node:crypto';
import { createSelfFrame, checkSelfFrame, validateSelfPayload } from './self-frame.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const frozenAttempts = (attempts) => Object.freeze(attempts.map((a) => Object.freeze({ ...a })));

function viewText(frame, view) {
  if (!frame) return null;
  if (view === 'self') return frame.projection.stableText;
  if (view === 'selfLine') return frame.projection.views.selfLine;
  if (view === 'address') return frame.projection.views.addressText;
  return null;
}

export class SelfStepCoordinator {
  #states = new WeakMap();

  constructor({
    capture,
    subjectId,
    bindingRevision,
    storeRootId,
    requiredSemanticKeys = [],
    renderPolicy = {},
    allowDegraded = false,
    idFactory = randomUUID,
  } = {}) {
    if (typeof capture !== 'function') throw new TypeError('capture 必须有');
    if (typeof idFactory !== 'function') throw new TypeError('idFactory 必须有');
    this.capture = capture;
    this.subjectId = subjectId;
    this.bindingRevision = bindingRevision;
    this.storeRootId = storeRootId;
    this.requiredSemanticKeys = clone(requiredSemanticKeys);
    this.renderPolicy = clone(renderPolicy);
    this.allowDegraded = Boolean(allowDegraded);
    this.idFactory = idFactory;
  }

  #state(handle) {
    const state = handle && typeof handle === 'object' ? this.#states.get(handle) : null;
    if (!state) throw new Error('handle 不属于本协调器');
    return state;
  }

  #makeHandle(state) {
    const handle = Object.freeze({
      get stepId() { return state.stepId; },
      get mode() { return state.mode; },
      get frame() { return state.frame; },
      get frameId() { return state.frame?.frameId ?? null; },
      get sourceGeneration() { return state.frame?.sourceGeneration ?? null; },
      get attempts() { return frozenAttempts(state.attempts); },
      get error() { return state.error; },
    });
    this.#states.set(handle, state);
    return handle;
  }

  #begin(pending) {
    const state = {
      stepId: `step-${this.idFactory()}`,
      mode: pending ? 'pending' : 'unavailable',
      frame: null,
      attempts: [],
      error: null,
    };
    return { state, handle: this.#makeHandle(state) };
  }

  #build(state, captured) {
    try {
      if (!captured || !captured.source || !captured.projection || typeof captured.then === 'function') {
        throw new TypeError('capture 必须是同步的 {source, projection}');
      }
      const frame = createSelfFrame({
        source: captured.source,
        projection: captured.projection,
        subjectId: this.subjectId,
        bindingRevision: this.bindingRevision,
        storeRootId: this.storeRootId,
        requiredSemanticKeys: this.requiredSemanticKeys,
        renderPolicy: this.renderPolicy,
        allowDegraded: this.allowDegraded,
      });
      state.frame = frame;
      state.mode = 'ready';
      state.error = null;
    } catch (error) {
      state.frame = null;
      state.mode = 'unavailable';
      state.error = String(error?.message ?? error);
    }
  }

  begin({ pending = false } = {}) {
    const { state, handle } = this.#begin(pending);
    if (!pending) {
      try { this.#build(state, this.capture()); }
      catch (error) { state.mode = 'unavailable'; state.error = String(error?.message ?? error); }
    }
    return handle;
  }

  /** pending 只允许一次显式解析；不重新捕获、不换 step。非法参数不消耗 pending。 */
  resolve(handle, captured) {
    const state = this.#state(handle);
    if (state.mode !== 'pending') throw new Error('只有 pending handle 可 resolve');
    if (!captured || !captured.source || !captured.projection) throw new TypeError('resolve 需要 source/projection');
    this.#build(state, captured);
    return handle;
  }

  /** 同一 step 的 refresh/retry 只返回同一 handle，不读源。 */
  refresh(handle) {
    this.#state(handle);
    return handle;
  }

  consume(handle, view, { fallback = '' } = {}) {
    const state = this.#state(handle);
    if (state.mode !== 'ready') return { status: state.mode, text: fallback, frameId: null, error: state.error };
    const text = viewText(state.frame, view);
    if (typeof text !== 'string') return { status: 'unsupported-view', text: fallback, frameId: state.frame.frameId };
    return { status: 'frame', text, frameId: state.frame.frameId, stepId: state.stepId };
  }

  attempt(handle) {
    const state = this.#state(handle);
    const attemptId = `attempt-${this.idFactory()}`;
    state.attempts.push({ attemptId, at: new Date().toISOString(), frameId: state.frame?.frameId ?? null });
    return attemptId;
  }

  /** 新逻辑步骤 = 新 handle + 新捕获；与上一个 handle 无共享。 */
  nextStep() {
    return this.begin();
  }

  check(handle, current = null) {
    const state = this.#state(handle);
    if (state.mode !== 'ready') return { status: 'unavailable', reasons: [state.mode] };
    if (!current) {
      try { current = this.capture(); } catch { return { status: 'unavailable', reasons: ['capture-failed'] }; }
    }
    return checkSelfFrame({
      frame: state.frame,
      source: current.source,
      projection: current.projection,
      bindingRevision: this.bindingRevision,
      storeRootId: this.storeRootId,
      renderPolicy: this.renderPolicy,
    });
  }

  /** frame-only 校验；传 attemptId 时额外绑定本 step 的 attempt 记录。 */
  validate(handle, payload, provenance, requiredViews, attemptId = null) {
    const state = this.#state(handle);
    if (state.mode !== 'ready') return { status: 'reject', reasons: [`step-${state.mode}`] };
    if (attemptId != null && !state.attempts.some((a) => a.attemptId === attemptId)) {
      return { status: 'reject', reasons: ['unknown-attempt'] };
    }
    return validateSelfPayload({ frame: state.frame, payload, provenance, requiredViews });
  }

  frameId(handle) { return this.#state(handle).frame?.frameId ?? null; }
  generation(handle) { return this.#state(handle).frame?.sourceGeneration ?? null; }
  snapshotId(handle) { return this.#state(handle).frame ? sha(this.#state(handle).frame.frameId) : null; }
}
