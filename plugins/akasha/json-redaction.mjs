// Lossless JSON redaction: decode string tokens only, never JSON numbers.
// These bounds cover object traversal AND JSON encoded inside string values.
export const REDACTION_LIMITS = Object.freeze({ depth: 64, nodes: 100000, chars: 8 * 1024 * 1024 });

function failure(code, reason) {
  const error = new Error('Akasha redaction refused input: ' + reason);
  error.code = 'AKASHA_REDACTION_' + code;
  return error;
}

const whitespace = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const digit = (c) => c >= '0' && c <= '9';
class InvalidJson extends Error {
  constructor() { super('Invalid JSON fragment'); this.sensitive = false; }
}

/** Inject the existing credential policy and plain-text fallback. No I/O. */
export function createRedactor({ redactText, isSensitiveKey, shouldMask }) {
  const context = () => ({ nodes: 0, chars: 0, ancestors: new WeakSet() });
  function visit(state, depth, chars = 0) {
    state.nodes++;
    state.chars += chars;
    if (depth > REDACTION_LIMITS.depth || state.nodes > REDACTION_LIMITS.nodes || state.chars > REDACTION_LIMITS.chars) {
      throw failure('LIMIT', 'maximum depth, node count or text work exceeded');
    }
  }

  function quoted(text, start) {
    let at = start;
    if (text[at++] !== '"') throw new InvalidJson();
    while (at < text.length) {
      const c = text[at++];
      if (c === '"') {
        // JSON.parse sees one string token; no numeric lexeme enters it.
        try { return { start, end: at, value: JSON.parse(text.slice(start, at)) }; }
        catch (error) {
          if (error instanceof SyntaxError) throw new InvalidJson();
          throw error;
        }
      }
      if (c.charCodeAt(0) < 32) throw new InvalidJson();
      if (c === '\\') {
        const escape = text[at++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4))) throw new InvalidJson();
          at += 4;
        } else if (!'"\\/bfnrt'.includes(escape ?? '\0')) throw new InvalidJson();
      }
    }
    throw new InvalidJson();
  }

  // Parse one complete JSON span, not the entire enclosing prose. Failure after
  // a recognized credential key is distinguished from an ordinary text fragment.
  function jsonSpan(text, start, depth, state, inheritedSensitive = false) {
    let at = start;
    const edits = [];
    const invalid = () => { throw new InvalidJson(); };
    const skip = () => { while (whitespace(text[at])) at++; };
    const primitiveEnd = () => {
      if (at < text.length && !whitespace(text[at]) && text[at] !== ',' && text[at] !== '}' && text[at] !== ']') invalid();
    };
    function number() {
      if (text[at] === '-') at++;
      if (text[at] === '0') at++;
      else {
        if (!(text[at] >= '1' && text[at] <= '9')) invalid();
        while (digit(text[at])) at++;
      }
      if (text[at] === '.') {
        at++;
        if (!digit(text[at])) invalid();
        while (digit(text[at])) at++;
      }
      if (text[at] === 'e' || text[at] === 'E') {
        at++;
        if (text[at] === '+' || text[at] === '-') at++;
        if (!digit(text[at])) invalid();
        while (digit(text[at])) at++;
      }
    }
    function value(level, sensitive = false) {
      try { return valueBody(level, sensitive); }
      catch (error) {
        if (error instanceof InvalidJson) error.sensitive ||= sensitive;
        throw error;
      }
    }
    function valueBody(level, sensitive) {
      visit(state, level);
      skip();
      const c = text[at];
      if (c === '"') {
        const token = quoted(text, at); at = token.end;
        const replacement = stringValue(token.value, sensitive, level + 1, state);
        if (replacement !== token.value) edits.push({ start: token.start, end: token.end, value: JSON.stringify(replacement) });
      } else if (c === '{' || c === '[') {
        const object = c === '{';
        const close = object ? '}' : ']';
        at++;
        skip();
        if (text[at] === close) { at++; return; }
        while (at < text.length) {
          let childSensitive = sensitive;
          if (object) {
            const key = quoted(text, at); at = key.end;
            visit(state, level + 1, key.value.length);
            childSensitive ||= isSensitiveKey(key.value);
            const replacement = redactText(key.value);
            if (replacement !== key.value) edits.push({ start: key.start, end: key.end, value: JSON.stringify(replacement) });
            skip();
            if (text[at++] !== ':') {
              const error = new InvalidJson(); error.sensitive = childSensitive; throw error;
            }
          }
          value(level + 1, childSensitive);
          skip();
          if (text[at] === close) { at++; return; }
          if (text[at++] !== ',') invalid();
          skip();
        }
        invalid();
      } else if (c === '-' || digit(c)) { number(); primitiveEnd(); }
      else {
        const literal = ['true', 'false', 'null'].find((word) => text.startsWith(word, at));
        if (!literal) invalid();
        at += literal.length;
        primitiveEnd();
      }
    }
    value(depth, inheritedSensitive);
    // Apply only changed string spans. Keep all other bytes, including duplicate
    // keys, whitespace, escapes, negative zero and arbitrary precision numbers.
    let end = start;
    const parts = [];
    for (const edit of edits) {
      parts.push(text.slice(end, edit.start), edit.value);
      end = edit.end;
    }
    parts.push(text.slice(end, at));
    return { end: at, value: parts.join('') };
  }

  function stringValue(text, sensitive, depth, state) {
    visit(state, depth, text.length);
    if (sensitive && shouldMask(text)) return '[redacted]';
    const parts = [];
    let copied = 0;
    for (let at = 0; at < text.length;) {
      if (text[at] !== '{' && text[at] !== '[' && text[at] !== '"') { at++; continue; }
      try {
        let span;
        if (text[at] === '"') {
          const key = quoted(text, at);
          let colon = key.end;
          while (whitespace(text[colon])) colon++;
          if (text[colon] === ':') {
            // Also recognize standalone key/value fragments. This catches an
            // escaped credential key after an unrelated malformed JSON prefix.
            const keyOut = redactText(key.value);
            let valueStart = colon + 1;
            while (whitespace(text[valueStart])) valueStart++;
            const first = text[valueStart];
            const jsonOpening = first === '"' || first === '{' || first === '[' || first === '-' || digit(first)
              || ['true', 'false', 'null'].some(word => text.startsWith(word, valueStart));
            if (isSensitiveKey(key.value) && jsonOpening) {
              const tail = jsonSpan(text, colon + 1, depth + 1, state, true);
              span = { end: tail.end, value: (keyOut === key.value ? text.slice(at, key.end) : JSON.stringify(keyOut)) + text.slice(key.end, colon + 1) + tail.value };
            } else {
              span = { end: key.end, value: keyOut === key.value ? text.slice(at, key.end) : JSON.stringify(keyOut) };
            }
          }
        }
        span ??= jsonSpan(text, at, depth, state);
        parts.push(text.slice(copied, at), span.value);
        at = span.end; copied = at;
      } catch (error) {
        // Resource limits and unexpected errors are never swallowed. An ordinary
        // quote/list marker/truncated non-sensitive snippet is still text. Once
        // a credential value is malformed, its end is unknowable: replace the
        // candidate plus its remaining tail visibly, including any secret suffix.
        // This also keeps retrieval of already-masked but truncated text usable.
        if (!(error instanceof InvalidJson)) throw error;
        if (error.sensitive) {
          parts.push(text.slice(copied, at), '[redacted-invalid-json]');
          copied = text.length;
          break;
        }
        at++;
      }
    }
    parts.push(text.slice(copied));
    // Preserve the legacy fallback across boundaries (e.g. password="...").
    return redactText(parts.join(''));
  }

  function objectValue(value, sensitive, depth, state) {
    if (typeof value === 'string') return stringValue(value, sensitive, depth, state);
    visit(state, depth);
    if (!value || typeof value !== 'object') return value;
    if (state.ancestors.has(value)) throw failure('CYCLE', 'cyclic object');
    state.ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => objectValue(item, sensitive, depth + 1, state));
      const result = {};
      for (const key of Object.keys(value)) {
        visit(state, depth + 1, key.length);
        // defineProperty preserves an own __proto__ as data, not a prototype setter.
        Object.defineProperty(result, key, {
          value: objectValue(value[key], sensitive || isSensitiveKey(key), depth + 1, state),
          enumerable: true, configurable: true, writable: true,
        });
      }
      return result;
    } finally { state.ancestors.delete(value); }
  }

  return {
    redact: (value) => stringValue(String(value ?? ''), false, 0, context()),
    redactDeep: (value, keyHint) => objectValue(value, Boolean(keyHint && isSensitiveKey(keyHint)), 0, context()),
  };
}
