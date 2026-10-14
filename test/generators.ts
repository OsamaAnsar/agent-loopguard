import type { GuardStep } from '../src/index';

/** Seeded random generators shared by the 0.3.0 property and fuzz tests (see `helpers.ts` for the PRNG). */

export type Rand = () => number;

export const pick = <T>(rand: Rand, items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

/**
 * Steps made of plain, JSON-friendly data, so that a JSON round trip of a snapshot is a fair test and
 * calls repeat often enough for the rules to fire.
 */
export function plainStep(rand: Rand): GuardStep {
  const calls = Array.from({ length: Math.floor(rand() * 4) }, () => {
    const c: Record<string, unknown> = { name: pick(rand, ['a', 'b', 'c', 'search', 'think', 'poll']) };
    if (rand() < 0.9) c['args'] = pick(rand, [1, 2, 'x', { q: 'x' }, { q: 'y', page: 2 }]);
    if (rand() < 0.5) c['result'] = pick(rand, ['r1', 'r2', { n: 1 }, [1, 2]]);
    if (rand() < 0.12) c['error'] = pick(rand, ['boom', 'timeout']);
    return c;
  });
  const out: Record<string, unknown> = { toolCalls: calls };
  if (rand() < 0.7) {
    out['text'] = pick(rand, ['', 'ok', 'Thinking...', 'thinking...', 'Same text', 'a longer line of text that goes on and on and on and on and on and on and on and on and on']);
  }
  if (rand() < 0.8) out['finishReason'] = pick(rand, ['tool-calls', 'tool-calls', 'tool-calls', 'other', 'unknown', 'stop', 'length']);
  if (rand() < 0.6) {
    out['usage'] = { inputTokens: pick(rand, [0, 10, 40]), outputTokens: pick(rand, [0, 5, 20]), costUsd: pick(rand, [0, 0.01, 0.05]) };
  }
  if (rand() < 0.5) out['durationMs'] = pick(rand, [0, 5, 30]);
  return out as GuardStep;
}

/**
 * Hostile values and steps for fuzzing: copies of the generators in `fuzz.test.ts`, kept here so that the
 * 0.3.0 fuzz tests can share them without touching the 0.2.0 test files.
 */
export function hostileValue(rand: Rand, depth = 0): unknown {
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

export function randomStep(rand: Rand): GuardStep {
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

/** Something a caller might pass to `preflight`: a call, several calls, or complete nonsense. */
export function randomPreflightInput(rand: Rand): unknown {
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

