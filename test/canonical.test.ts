import { describe, expect, it } from 'vitest';
import { canonicalize, stableHash } from '../src/index';
import { describe as describeValue, hashString } from '../src/canonical';
import { mulberry32 } from './helpers';

describe('canonicalize: equality classes', () => {
  const equal: Array<[string, unknown, unknown]> = [
    ['key order', { a: 1, b: 2 }, { b: 2, a: 1 }],
    ['nested key order', { x: { a: 1, b: [1, { c: 3, d: 4 }] } }, { x: { b: [1, { d: 4, c: 3 }], a: 1 } }],
    ['undefined properties are omitted', { a: 1, b: undefined }, { a: 1 }],
    ['-0 and 0', -0, 0],
    ['NaN and NaN', NaN, Number.NaN],
    ['equal dates', new Date('2024-01-02T03:04:05Z'), new Date('2024-01-02T03:04:05.000Z')],
    ['invalid dates', new Date('nope'), new Date(NaN)],
    ['Map insertion order', new Map([['a', 1], ['b', 2]]), new Map([['b', 2], ['a', 1]])],
    ['Set insertion order', new Set([3, 1, 2]), new Set([1, 2, 3])],
    ['equal bigint', 10n, BigInt(10)],
    ['regexps', /a+/gi, /a+/gi],
    ['URLs via toJSON', new URL('https://example.com/a?b=1'), new URL('https://example.com/a?b=1')],
    ['typed arrays', new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])],
    ['errors', new Error('boom'), new Error('boom')],
  ];
  it.each(equal)('treats %s as equal', (_name, a, b) => {
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  const different: Array<[string, unknown, unknown]> = [
    ['array order', [1, 2], [2, 1]],
    ['number vs string', 1, '1'],
    ['null vs undefined', null, undefined],
    ['null vs "null"', null, 'null'],
    ['NaN vs "NaN"', NaN, 'NaN'],
    ['NaN vs null', NaN, null],
    ['Infinity vs -Infinity', Infinity, -Infinity],
    ['bigint vs number', 1n, 1],
    ['bigint vs string', 1n, '1n'],
    ['undefined in array vs missing', [undefined], []],
    ['Date vs its ISO string', new Date('2024-01-01T00:00:00Z'), '2024-01-01T00:00:00.000Z'],
    ['different dates', new Date(0), new Date(1)],
    ['Map vs plain object', new Map([['a', 1]]), { a: 1 }],
    ['Set vs array', new Set([1]), [1]],
    ['different Map values', new Map([['a', 1]]), new Map([['a', 2]])],
    ['different keys', { a: 1 }, { b: 1 }],
    ['nested difference', { a: { b: [1, 2, 3] } }, { a: { b: [1, 2, 4] } }],
    ['true vs "true"', true, 'true'],
    ['empty object vs empty array', {}, []],
    ['class instance vs plain object', new (class Foo { a = 1; })(), { a: 1 }],
    ['different typed arrays', new Uint8Array([1]), new Uint8Array([2])],
    ['different URLs', new URL('https://a.example'), new URL('https://b.example')],
    ['keys that look like structure', { 'a":1,"b': 2 }, { a: 1, b: 2 }],
    ['strings that look like structure', ['a', 'b'], ['a","b']],
  ];
  it.each(different)('treats %s as different', (_name, a, b) => {
    expect(canonicalize(a)).not.toBe(canonicalize(b));
  });
});

describe('canonicalize: robustness', () => {
  it('handles a self-referencing object', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(canonicalize(a)).toBe('{"name":"a","self":[Circular:0]}');
  });

  it('handles mutual references and gives structurally equal cycles equal forms', () => {
    const make = () => {
      const a: Record<string, unknown> = { id: 1 };
      const b: Record<string, unknown> = { id: 2, a };
      a['b'] = b;
      return a;
    };
    expect(canonicalize(make())).toBe(canonicalize(make()));
    expect(canonicalize(make())).toContain('[Circular:0]');
  });

  it('distinguishes which ancestor a cycle points to', () => {
    const toRoot: Record<string, unknown> = { child: {} };
    (toRoot['child'] as Record<string, unknown>)['back'] = toRoot;
    const toChild: Record<string, unknown> = { child: {} };
    const child = toChild['child'] as Record<string, unknown>;
    child['back'] = child;
    expect(canonicalize(toRoot)).not.toBe(canonicalize(toChild));
  });

  it('handles cycles through arrays, Maps and Sets', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    const map = new Map<string, unknown>();
    map.set('me', map);
    const set = new Set<unknown>();
    set.add(set);
    expect(canonicalize(arr)).toBe('[1,[Circular:0]]');
    expect(canonicalize(map)).toContain('[Circular:0]');
    expect(canonicalize(set)).toContain('[Circular:0]');
  });

  it('does not mistake a repeated (non-circular) reference for a cycle', () => {
    const shared = { x: 1 };
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('caps nesting depth instead of overflowing the stack', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 5000; i += 1) deep = { next: deep };
    expect(() => canonicalize(deep)).not.toThrow();
    expect(canonicalize(deep)).toContain('[MaxDepth]');
  });

  it('truncates absurdly large inputs instead of doing unbounded work', () => {
    const huge = new Array<number>(500_000).fill(1);
    const out = canonicalize(huge);
    expect(out).toContain('[Truncated]');
  });

  it('survives getters that throw', () => {
    const hostile = {
      ok: 1,
      get boom(): number {
        throw new Error('nope');
      },
    };
    expect(canonicalize(hostile)).toBe('{"boom":"[Unreadable]","ok":1}');
  });

  it('gives values it cannot read a unique placeholder so they never compare equal', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const a = canonicalize(revoked.proxy);
    const b = canonicalize(revoked.proxy);
    expect(a).toMatch(/^\[Uncanonicalizable#\d+\]$/);
    expect(a).not.toBe(b);
  });

  it('survives a toJSON that throws', () => {
    const bad = {
      toJSON(): never {
        throw new Error('no');
      },
    };
    expect(canonicalize(bad)).toMatch(/^\[Uncanonicalizable#\d+\]$/);
  });

  it('handles odd primitives', () => {
    expect(canonicalize(Symbol('s'))).toBe('Symbol(s)');
    expect(canonicalize(function namedFn() {})).toBe('[Function namedFn]');
    expect(canonicalize(undefined)).toBe('undefined');
    expect(canonicalize(Object.create(null))).toBe('{}');
    expect(canonicalize(new ArrayBuffer(2))).toBe('ArrayBuffer<0,0>');
    expect(canonicalize(new Date(NaN))).toBe('Date(invalid)');
    expect(canonicalize('lone \ud800 surrogate')).toContain('surrogate');
  });

  it('writes sparse array holes as undefined', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalize([1, , 3])).toBe('[1,undefined,3]');
  });
});

// ---------------------------------------------------------------------------
// Property tests (seeded, so failures are reproducible)
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function randomJson(rand: () => number, depth: number): Json {
  const kind = Math.floor(rand() * (depth > 3 ? 4 : 6));
  switch (kind) {
    case 0:
      return null;
    case 1:
      return rand() < 0.5;
    case 2:
      return Math.round(rand() * 1000) / 10;
    case 3:
      return Math.floor(rand() * 1e6).toString(36);
    case 4:
      return Array.from({ length: Math.floor(rand() * 4) }, () => randomJson(rand, depth + 1));
    default: {
      const obj: { [key: string]: Json } = {};
      const n = Math.floor(rand() * 5);
      for (let i = 0; i < n; i += 1) obj[`k${Math.floor(rand() * 8)}`] = randomJson(rand, depth + 1);
      return obj;
    }
  }
}

/** Rebuild with every object's keys in a different (shuffled) insertion order. */
function shuffleKeys(value: Json, rand: () => number): Json {
  if (Array.isArray(value)) return value.map((v) => shuffleKeys(v, rand));
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
    }
    const out: { [key: string]: Json } = {};
    for (const k of keys) out[k] = shuffleKeys(value[k] as Json, rand);
    return out;
  }
  return value;
}

describe('canonicalize: properties', () => {
  it('is invariant under key reordering (1000 random values)', () => {
    const rand = mulberry32(1234);
    for (let i = 0; i < 1000; i += 1) {
      const value = randomJson(rand, 0);
      expect(canonicalize(shuffleKeys(value, rand))).toBe(canonicalize(value));
    }
  });

  it('is idempotent and deterministic across repeated calls', () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 300; i += 1) {
      const value = randomJson(rand, 0);
      expect(canonicalize(value)).toBe(canonicalize(value));
    }
  });

  it('separates structurally different values (appending an element always changes the form)', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 500; i += 1) {
      const value = randomJson(rand, 0);
      expect(canonicalize([value])).not.toBe(canonicalize([value, value]));
      expect(canonicalize({ a: value })).not.toBe(canonicalize({ a: value, b: 0 }));
    }
  });

  it('changing any single number leaf changes the form', () => {
    const rand = mulberry32(31337);
    let mutated = 0;
    for (let i = 0; i < 1000; i += 1) {
      const value = randomJson(rand, 0);
      const leaves: Array<() => void> = [];
      const copy = JSON.parse(JSON.stringify(value)) as Json;
      collectNumberLeaves(copy, leaves);
      if (leaves.length === 0) continue;
      leaves[Math.floor(rand() * leaves.length)]?.();
      expect(canonicalize(copy)).not.toBe(canonicalize(value));
      mutated += 1;
    }
    expect(mutated).toBeGreaterThan(100); // the generator does produce numbers
  });
});

/** Collect closures that each bump one number leaf in place. */
function collectNumberLeaves(node: Json, out: Array<() => void>): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      if (typeof child === 'number') out.push(() => void (node[i] = child + 1));
      else collectNumberLeaves(child, out);
    });
  } else if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const child = node[key] as Json;
      if (typeof child === 'number') out.push(() => void (node[key] = child + 1));
      else collectNumberLeaves(child, out);
    }
  }
}

describe('stableHash, hashString and describe', () => {
  it('is deterministic, 28 hex chars, and order-insensitive for objects', () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
    expect(stableHash({ a: 1 })).toMatch(/^[0-9a-f]{28}$/);
  });

  it('has no collisions across 20000 distinct short strings', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(hashString(`value-${i}`));
    expect(seen.size).toBe(20_000);
  });

  it('keeps short canonical forms inline and hashes long ones with a length prefix', () => {
    const short = describeValue({ q: 'x' });
    expect(short.signature).toBe('{"q":"x"}');
    const long = describeValue('x'.repeat(10_000));
    expect(long.signature).toMatch(/^#10002:[0-9a-f]{28}$/);
    expect(long.preview.length).toBeLessThanOrEqual(80);
    expect(long.preview.endsWith('…')).toBe(true);
  });

  it('distinguishes large values that differ in a single late element, and equates identical ones', () => {
    const make = (last: number) => Array.from({ length: 50_000 }, (_, i) => (i === 49_999 ? last : i));
    expect(describeValue(make(1)).signature).toBe(describeValue(make(1)).signature);
    expect(describeValue(make(1)).signature).not.toBe(describeValue(make(2)).signature);
    // Large values never collide with the inline form of a small string.
    expect(describeValue(make(1)).signature.startsWith('#')).toBe(true);
  });
});
