/**
 * Deterministic fuzzing: seeded random steps full of hostile values must never make the guard
 * throw, and every verdict must be well-formed and JSON-serialisable.
 */
import { describe, expect, it } from 'vitest';
import { canonicalize, createGuard, explain, feedbackFor, restoreGuard } from '../src/index';
import type { Guard, GuardOptions, GuardStep, Preflight, Verdict } from '../src/index';
import { mulberry32 } from './helpers';

type Rand = () => number;
const pick = <T>(rand: Rand, items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

function hostileValue(rand: Rand, depth = 0): unknown {
  const kind = Math.floor(rand() * (depth > 3 ? 12 : 20));
  switch (kind) {
    case 0:
      return undefined;
    case 1:
      return null;
    case 2:
      return NaN;
    case 3:
      return pick(rand, [Infinity, -Infinity, -0, 0, 1e308, Number.MIN_VALUE]);
    case 4:
      return BigInt(Math.floor(rand() * 1e9));
    case 5:
      return new Date(pick(rand, [0, NaN, 1.7e12, -1e12]));
    case 6:
      return pick(rand, ['', 'x', 'search', 'a'.repeat(5000), '\ud800', '日本語', '{"json":true}']);
    case 7:
      return Symbol(`s${Math.floor(rand() * 3)}`);
    case 8:
      return () => 1;
    case 9:
      return rand() < 0.5;
    case 10:
      return {
        get boom(): number {
          throw new Error('getter');
        },
        ok: 1,
      };
    case 11:
      return Math.floor(rand() * 5);
    case 12:
      return Array.from({ length: Math.floor(rand() * 5) }, () => hostileValue(rand, depth + 1));
    case 13: {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(rand() * 5); i += 1) o[`k${Math.floor(rand() * 6)}`] = hostileValue(rand, depth + 1);
      return o;
    }
    case 14: {
      const o: Record<string, unknown> = { name: 'circular' };
      o['self'] = o;
      o['nested'] = { back: o };
      return o;
    }
    case 15:
      return new Map<unknown, unknown>([[hostileValue(rand, depth + 1), hostileValue(rand, depth + 1)]]);
    case 16:
      return new Set<unknown>([hostileValue(rand, depth + 1), hostileValue(rand, depth + 1)]);
    case 17:
      return new Error(pick(rand, ['boom', '', 'timeout']));
    case 18: {
      const p = Proxy.revocable({}, {});
      p.revoke();
      return p.proxy;
    }
    default:
      return Array.from({ length: 3000 }, (_, i) => i % 7);
  }
}

const FINISH = [undefined, 'stop', 'length', 'tool-calls', 'content-filter', 'error', 'other', 'unknown', 'tool_use', '', 7, null];
const TEXTS = [undefined, '', 'ok', 'OK ', 'thinking...', 'The answer is 42.', 12, null];
const NAMES = ['search', 'read', 'write', 'search', 'x', '', undefined, 5];

function randomStep(rand: Rand): GuardStep {
  const r = rand();
  if (r < 0.03) return hostileValue(rand) as GuardStep; // a completely wrong "step"
  const step: Record<string, unknown> = {};
  if (rand() < 0.8) {
    const n = Math.floor(rand() * 4);
    step['toolCalls'] =
      rand() < 0.05
        ? hostileValue(rand)
        : Array.from({ length: n }, () => {
            const c: Record<string, unknown> = { name: pick(rand, NAMES) };
            if (rand() < 0.8) c['args'] = rand() < 0.5 ? { q: pick(rand, ['a', 'b', 'c']) } : hostileValue(rand);
            if (rand() < 0.4) c['result'] = hostileValue(rand);
            if (rand() < 0.15) c['error'] = hostileValue(rand);
            return rand() < 0.05 ? hostileValue(rand) : c;
          });
  }
  if (rand() < 0.7) step['text'] = pick(rand, TEXTS);
  if (rand() < 0.7) step['finishReason'] = pick(rand, FINISH);
  if (rand() < 0.5) {
    step['usage'] = {
      inputTokens: pick(rand, [undefined, 0, 10, 500, NaN, -3, Infinity, '9']),
      outputTokens: pick(rand, [undefined, 0, 5, 80, NaN, -1]),
      totalTokens: pick(rand, [undefined, 0, 700, NaN]),
      costUsd: pick(rand, [undefined, 0, 0.01, 0.2, NaN, -1]),
    };
  }
  if (rand() < 0.4) step['durationMs'] = pick(rand, [undefined, 0, 10, 250, NaN, -5, '12']);
  if (rand() < 0.2) step['timestamp'] = pick(rand, [undefined, 0, 1.7e12, NaN]);
  return step as GuardStep;
}

const CONFIGS: Array<[string, () => GuardOptions]> = [
  ['defaults', () => ({})],
  ['tight thresholds', () => ({ maxSteps: 30, repeatedToolCall: { threshold: 2 }, oscillation: { maxPeriod: 4, repeats: 2 }, noProgress: { threshold: 2 } })],
  ['result-aware and error-ignoring', () => ({ repeatedToolCall: { requireIdenticalResults: true, ignoreErrors: true } })],
  ['budgets with warnings', () => ({ budget: { maxTotalTokens: 5000, maxInputTokens: 3000, maxOutputTokens: 800, maxCostUsd: 1, maxDurationMs: 2000, warnAt: 0.5 }, now: () => 0 })],
  ['finish policy: stop', () => ({ finishReason: { otherPolicy: 'stop', terminal: ['stop', 'end_turn'] } })],
  ['finish policy: continue', () => ({ finishReason: { otherPolicy: 'continue', terminal: [] } })],
  [
    'per-tool policies',
    () => ({
      repeatedToolCall: { threshold: 2 },
      tools: { search: { maxCalls: 6 }, read: { polling: { maxIdenticalResults: 3 } }, write: { ignore: true }, x: { repeatThreshold: 2, maxCalls: 0 } },
    }),
  ],
  ['feedback override', () => ({ maxSteps: 40, feedback: (verdict, { phase }) => (verdict.code === 'MAX_STEPS' ? `over (${phase})` : undefined) })],
  ['custom detectors', () => ({ custom: [(history) => (history.length % 17 === 0 ? { stop: true, code: 'EVERY_17TH' } : undefined), () => ({ stop: false })] })],
];

function assertWellFormed(verdict: Verdict): void {
  expect(typeof verdict.stop).toBe('boolean');
  if (verdict.stop) {
    expect(typeof verdict.reason).toBe('string');
    expect(verdict.code).toMatch(/^[A-Z0-9_]+$/);
    expect(typeof verdict.detail).toBe('string');
    expect(verdict.detail.length).toBeGreaterThan(0);
    expect(verdict.evidence).toBeDefined();
    if (verdict.feedback !== undefined) expect(typeof verdict.feedback).toBe('string');
    expect(feedbackFor(verdict) === undefined || typeof feedbackFor(verdict) === 'string').toBe(true);
  }
  const json = JSON.stringify(verdict);
  expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(verdict)));
  expect(typeof explain(verdict)).toBe('string');
}

function assertPreflightWellFormed(result: Preflight): void {
  expect(typeof result.allow).toBe('boolean');
  if (!result.allow) {
    expect(typeof result.reason).toBe('string');
    expect(result.code).toMatch(/^[A-Z0-9_]+$/);
    expect(result.detail.length).toBeGreaterThan(0);
    expect(typeof result.feedback).toBe('string');
    expect(result.evidence).toBeDefined();
  }
  expect(() => JSON.stringify(result)).not.toThrow();
}

/** Something a caller might pass to `preflight`: a call, several calls, or complete nonsense. */
function randomPreflightInput(rand: Rand): unknown {
  const r = rand();
  if (r < 0.1) return hostileValue(rand);
  const one = (): unknown => {
    const c: Record<string, unknown> = { name: pick(rand, NAMES) };
    if (rand() < 0.8) c['args'] = rand() < 0.5 ? { q: pick(rand, ['a', 'b', 'c']) } : hostileValue(rand);
    if (rand() < 0.1) c['result'] = hostileValue(rand);
    return rand() < 0.05 ? hostileValue(rand) : c;
  };
  return r < 0.6 ? one() : Array.from({ length: Math.floor(rand() * 4) }, one);
}

describe('fuzz: the guard never throws on arbitrary steps', () => {
  it.each(CONFIGS)('%s', (_name, makeOptions) => {
    let checked = 0;
    for (let seed = 1; seed <= 25; seed += 1) {
      const rand = mulberry32(seed * 7919);
      const guard = createGuard(makeOptions());
      for (let i = 0; i < 120; i += 1) {
        const verdict = guard.check(randomStep(rand));
        assertWellFormed(verdict);
        checked += 1;
        if (i % 40 === 39) {
          expect(() => JSON.stringify(guard.summary())).not.toThrow();
          expect(guard.history.length).toBe(i < 80 ? i + 1 : i - 79); // reset() happens after step 79
        }
        if (i === 79) guard.reset();
      }
    }
    expect(checked).toBe(25 * 120);
  });

  it('is deterministic: the same seed produces the same verdicts', () => {
    const run = (seed: number): string => {
      const rand = mulberry32(seed);
      const guard = createGuard({ now: () => 0 });
      const out: string[] = [];
      for (let i = 0; i < 200; i += 1) {
        const v = guard.check(randomStep(rand));
        // Placeholders for unreadable values carry a global counter, so compare codes only.
        out.push(v.stop ? v.code : 'continue');
      }
      return out.join(',');
    };
    for (const seed of [1, 2, 3]) expect(run(seed)).toBe(run(seed));
  });

  it('canonicalize alone never throws on hostile values', () => {
    const rand = mulberry32(2024);
    for (let i = 0; i < 2000; i += 1) {
      expect(() => canonicalize(hostileValue(rand))).not.toThrow();
    }
  });
});

describe('fuzz: preflight, snapshots and restores never throw on hostile data', () => {
  it.each(CONFIGS)('%s', (_name, makeOptions) => {
    let probes = 0;
    let restores = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const rand = mulberry32(seed * 6151);
      let guard: Guard = createGuard(makeOptions());
      for (let i = 0; i < 90; i += 1) {
        for (let k = 0; k < 2; k += 1) {
          assertPreflightWellFormed(guard.preflight(randomPreflightInput(rand) as never));
          probes += 1;
        }
        assertWellFormed(guard.check(randomStep(rand)));

        if (i % 15 === 14) {
          const redact = rand() < 0.3;
          const snapshot = guard.snapshot({ redact });
          // JSON-safe, whatever the steps were made of.
          const json = JSON.stringify(snapshot);
          expect(JSON.parse(json)).toEqual(snapshot);
          expect(structuredClone(snapshot)).toEqual(snapshot);
          expect(JSON.stringify(guard)).toBe(JSON.stringify(guard.toJSON()));
          // ...and always restorable, from either form, into a guard that keeps working.
          const restored = restoreGuard(rand() < 0.5 ? snapshot : JSON.parse(json), makeOptions());
          restores += 1;
          expect(restored.toJSON()).toEqual(snapshot);
          guard = restored;
        }
        if (i === 60) guard.reset();
      }
    }
    expect(probes).toBe(12 * 90 * 2);
    expect(restores).toBe(12 * 6);
  });
});
