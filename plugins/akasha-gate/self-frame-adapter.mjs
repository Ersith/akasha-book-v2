// A 层纯接口（未激活）：协调方显式传入一个已 pin 的 SelfFrame；本模块不读取全局 latest。
// 这样 refresh/retry 的 frame 归属由调用方决定，而不是由 provider 调用先后猜测。
export function renderSelfFromFrame(frame, view, { fallback = '', taintRe = null } = {}) {
  if (!frame || typeof frame !== 'object') return { status: 'unavailable', text: fallback, frameId: null };
  const projection = frame.projection;
  if (!projection || projection.status === 'failed' || projection.status === 'empty') {
    return { status: 'unavailable', text: fallback, frameId: frame.frameId ?? null };
  }
  let text;
  if (view === 'self') text = projection.stableText;
  else if (view === 'selfLine') text = projection.views?.selfLine;
  else if (view === 'address') text = projection.views?.addressText;
  else return { status: 'unsupported-view', text: fallback, frameId: frame.frameId ?? null };
  if (typeof text !== 'string' || !text.trim()) return { status: 'empty', text: fallback, frameId: frame.frameId ?? null };
  if (taintRe instanceof RegExp && taintRe.test(text)) return { status: 'tainted', text: fallback, frameId: frame.frameId ?? null };
  return { status: 'frame', text, frameId: frame.frameId, sourceGeneration: frame.sourceGeneration };
}

/** 显式消费一个 frame 的三个视图；不缓存、不重新读库、不跨调用借用。 */
export function consumeSelfFrame(frame, options = {}) {
  return {
    self: renderSelfFromFrame(frame, 'self', options),
    selfLine: renderSelfFromFrame(frame, 'selfLine', options),
    address: renderSelfFromFrame(frame, 'address', options),
  };
}
