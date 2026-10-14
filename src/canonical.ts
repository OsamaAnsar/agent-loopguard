/**
 * Canonicalisation: turn any JavaScript value into a deterministic string so that two
 * "equal" tool-call arguments compare equal regardless of key order, and so that nothing
 * a model can send (NaN, bigint, circular objects, Maps...) can make the guard throw.
 *
 * This is NOT JSON. JSON loses too much (undefined, NaN, bigint, Map, Set, Date vs string,
 * cycles). The output is only meant for equality checks and short human previews.
 */

/** Deepest nesting that is written out; anything below becomes `[MaxDepth]`. */
const MAX_DEPTH = 64;
/** Values visited before the rest is replaced by `[Truncated]`. Bounds work on huge inputs. */
const MAX_NODES = 200_000;

/** Counter that makes the failure fallback unique, so unreadable values never compare equal. */
let fallbackCounter = 0;

interface Walk {
  nodes: number;
  /** Objects currently being written (ancestors of the current value), for cycle detection. */
  stack: object[];
}

/**
 * Deterministic, key-order-insensitive string form of `value`. Never throws.
 *
 * Rules:
 * - Object keys are sorted; properties whose value is `undefined` are omitted (like JSON).
 * - Array items keep their order; `undefined` items are kept.
 * - `NaN`, `Infinity`, `-Infinity` and bigint (`10n`) are distinct from strings and numbers
 *   that print the same; `-0` is normalised to `0`.
 * - Dates are written as ISO strings (or `invalid`); Maps and Sets are sorted by the canonical
 *   form of their entries, so insertion order does not matter.
 * - A reference back to an ancestor is written `[Circular:<depth of that ancestor>]`.
 * - Objects with a `toJSON` method are written as the result of calling it.
 * - If something throws while reading the value (hostile getters, revoked proxies) the result is
 *   a unique placeholder, so such values are never considered equal to anything.
 */
export function canonicalize(value: unknown): string {
  try {
    const out: string[] = [];
    write(value, { nodes: 0, stack: [] }, out);
    return out.join('');
  } catch {
    fallbackCounter += 1;
    return `[Uncanonicalizable#${fallbackCounter}]`;
  }
}

function write(value: unknown, walk: Walk, out: string[]): void {
  walk.nodes += 1;
  if (walk.nodes > MAX_NODES) {
    out.push('[Truncated]');
    return;
  }

  switch (typeof value) {
    case 'undefined':
      out.push('undefined');
      return;
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (Number.isNaN(value)) out.push('NaN');
      else if (Object.is(value, -0)) out.push('0');
      else out.push(String(value)); // 'Infinity' and '-Infinity' included
      return;
    case 'bigint':
      out.push(`${value.toString()}n`);
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'symbol':
      out.push(`Symbol(${String(value.description)})`);
      return;
    case 'function':
      out.push(`[Function ${String(value.name)}]`);
      return;
    case 'object':
      break;
  }

  if (value === null) {
    out.push('null');
    return;
  }

  const obj = value as object;

  // Cycle: `obj` is already being written further up the stack.
  const ancestor = walk.stack.indexOf(obj);
  if (ancestor !== -1) {
    out.push(`[Circular:${ancestor}]`);
    return;
  }
  if (walk.stack.length >= MAX_DEPTH) {
    out.push('[MaxDepth]');
    return;
  }

  walk.stack.push(obj);
  try {
    writeObject(obj, walk, out);
  } finally {
    walk.stack.pop();
  }
}

function writeObject(obj: object, walk: Walk, out: string[]): void {
  if (obj instanceof Date) {
    const time = obj.getTime();
    out.push(Number.isNaN(time) ? 'Date(invalid)' : `Date(${obj.toISOString()})`);
    return;
  }
  if (obj instanceof RegExp) {
    out.push(`RegExp(${String(obj)})`);
    return;
  }
  if (Array.isArray(obj)) {
    out.push('[');
    for (let i = 0; i < obj.length; i += 1) {
      if (i > 0) out.push(',');
      write(obj[i] as unknown, walk, out);
    }
    out.push(']');
    return;
  }
  if (obj instanceof Map) {
    const entries: string[] = [];
    for (const [k, v] of obj) {
      const part: string[] = [];
      write(k, walk, part);
      part.push('=>');
      write(v, walk, part);
      entries.push(part.join(''));
    }
    out.push(`Map{${entries.sort().join(',')}}`);
    return;
  }
  if (obj instanceof Set) {
    const items: string[] = [];
    for (const v of obj) {
      const part: string[] = [];
      write(v, walk, part);
      items.push(part.join(''));
    }
    out.push(`Set{${items.sort().join(',')}}`);
    return;
  }
  if (ArrayBuffer.isView(obj)) {
    const bytes = new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    out.push(`${constructorName(obj)}<${Array.prototype.join.call(bytes, ',')}>`);
    return;
  }
  if (obj instanceof ArrayBuffer) {
    out.push(`ArrayBuffer<${Array.prototype.join.call(new Uint8Array(obj), ',')}>`);
    return;
  }
  if (obj instanceof Error) {
    out.push(`Error(${String(obj.name)}: ${String(obj.message)})`);
    return;
  }

  // Objects that know how to serialise themselves (URL, Decimal, ...). Date handled above.
  const toJSON = (obj as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    const json: unknown = (toJSON as () => unknown).call(obj);
    out.push('toJSON:');
    write(json, walk, out);
    return;
  }

  // Plain objects and class instances: own enumerable string keys, sorted.
  const proto: unknown = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) out.push(constructorName(obj));
  out.push('{');
  let first = true;
  for (const key of Object.keys(obj).sort()) {
    let v: unknown;
    try {
      v = (obj as Record<string, unknown>)[key];
    } catch {
      v = '[Unreadable]'; // a getter that throws must not take the guard down
    }
    if (v === undefined) continue;
    if (!first) out.push(',');
    first = false;
    out.push(JSON.stringify(key), ':');
    write(v, walk, out);
  }
  out.push('}');
}

function constructorName(obj: object): string {
  const ctor = (obj as { constructor?: { name?: unknown } }).constructor;
  return typeof ctor?.name === 'string' && ctor.name !== '' ? ctor.name : 'Object';
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** 53-bit string hash (cyrb53). Fast, well distributed, NOT cryptographic. */
function cyrb53(input: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Stable, non-cryptographic hash of any value: two independent 53-bit hashes of its canonical
 * form (28 hex characters). Equal values always hash equally; a collision between different values
 * is possible in principle but not a practical concern for loop detection. Do not use it for
 * anything security-related.
 */
export function stableHash(value: unknown): string {
  return hashString(canonicalize(value));
}

export function hashString(text: string): string {
  const a = cyrb53(text, 0).toString(16).padStart(14, '0');
  const b = cyrb53(text, 0x9e3779b9).toString(16).padStart(14, '0');
  return a + b;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** Canonical forms longer than this are replaced by `#<length>:<hash>` in signatures. */
const INLINE_LIMIT = 256;
const PREVIEW_LIMIT = 80;

export interface Described {
  /** Compact equality key: the canonical form when short, otherwise a length-prefixed hash. */
  signature: string;
  /** Short canonical text for messages (truncated with an ellipsis). */
  preview: string;
}

/** Canonicalise once and derive both an equality key and a display preview. */
export function describe(value: unknown): Described {
  const canonical = canonicalize(value);
  return {
    signature:
      canonical.length <= INLINE_LIMIT ? canonical : `#${canonical.length}:${hashString(canonical)}`,
    preview: truncate(canonical, PREVIEW_LIMIT),
  };
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
