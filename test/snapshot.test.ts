import { describe, expect, expectTypeOf, it } from 'vitest';
import { createGuard, restoreGuard } from '../src/index';
import type { Guard, GuardOptions, GuardSnapshot, GuardStep, Verdict } from '../src/index';
import { call, feed, firstStop, mulberry32, step } from './helpers';

/** Options that switch every detector off, so a test can enable exactly one. */
const ONLY: GuardOptions = {
  maxSteps: false,
  repeatedToolCall: false,
  oscillation: false,
  noProgress: false,
  finishReason: false,
};

const SECRET = 'SENTINEL-sk-live-4d3c2b1a';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A guard that has seen a bit of everything, so every section of the snapshot has content. */
function busyOptions(): GuardOptions {
  return {
    repeatedToolCall: {},
    oscillation: {},
    noProgress: {},
    budget: { maxTotalTokens: 100_000, maxDurationMs: 60_000, warnAt: 0.9 },
    tools: { search: { maxCalls: 9 }, poll: { polling: true }, think: { ignore: true } },
    now: () => 0,
  };
}

function busyGuard(options: GuardOptions = busyOptions()): Guard {
  const guard = createGuard(options);
  feed(guard, [
    { toolCalls: [call('search', { q: 'a' }, { result: 1 })], text: 'looking', usage: { totalTokens: 50 }, finishReason: 'tool-calls' },
    { toolCalls: [call('read', { path: 'x' }, { result: 'ok' })], text: 'reading', usage: { totalTokens: 50 }, finishReason: 'tool-calls' },
    { toolCalls: [call('search', { q: 'a' }, { result: 1 })], text: 'again', durationMs: 5 },
    { toolCalls: [call('read', { path: 'x' }, { result: 'ok' })], text: 'again' },
    { toolCalls: [call('search', { q: 'a' }, { result: 1 })], text: 'again' },
  ]);
  return guard;
}

// ---------------------------------------------------------------------------
describe('snapshot: format', () => {
  it('a fresh guard has an all-zero version 1 snapshot', () => {
    const s = createGuard({ tools: { search: { maxCalls: 2 } }, budget: { maxTotalTokens: 10 } }).toJSON();
    expect(s.version).toBe(1);
    expect(s).toMatchObject({
      steps: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 },
      wallClockMs: null,
      detectors: {
        repeatedToolCall: { key: null, tool: '', length: 0, steps: [], longest: 0 },
        oscillation: { sigs: [], labels: [], names: [], matches: [0, 0], current: null },
        noProgress: { seen: [], streak: 0, textKey: null, textPreview: '' },
        finishReason: { lastFinishReason: null },
        toolLimits: [{ tool: 'search', calls: 0 }],
      },
    });
    expect(Object.keys(s.options).sort()).toEqual(
      ['budget', 'custom', 'finishReason', 'maxSteps', 'noProgress', 'oscillation', 'repeatedToolCall', 'tools'],
    );
  });

  it('is plain JSON-safe data that survives a JSON round trip unchanged', () => {
    const s = busyGuard().toJSON();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(structuredClone(s)).toEqual(s);
  });

  it('JSON.stringify(guard) produces the snapshot', () => {
    const guard = busyGuard();
    expect(JSON.parse(JSON.stringify(guard))).toEqual(guard.toJSON());
    expect(JSON.parse(JSON.stringify({ run: guard }))).toEqual({ run: guard.toJSON() });
    expect(guard.snapshot()).toEqual(guard.toJSON());
    // toJSON is called with a key by JSON.stringify; snapshot() must not mistake it for options.
    expect((guard.toJSON as (key: string) => GuardSnapshot)('redact')).toEqual(guard.toJSON());
  });

  it('every disabled detector has a null section', () => {
    const s = createGuard({ ...ONLY }).toJSON();
    expect(s.detectors).toEqual({ repeatedToolCall: null, oscillation: null, noProgress: null, finishReason: null, toolLimits: null });
  });

  it('taking a snapshot changes nothing about the guard', () => {
    const a = busyGuard();
    const b = busyGuard();
    for (let i = 0; i < 5; i += 1) a.toJSON();
    a.snapshot({ redact: true });
    expect(a.summary()).toEqual(b.summary());
    expect(a.history).toEqual(b.history);
    const next = step(call('search', { q: 'a' }, { result: 1 }));
    expect(a.check(next)).toEqual(b.check(next));
  });

  it('exports the same function as createGuard.fromJSON and restoreGuard', () => {
    expect(createGuard.fromJSON).toBe(restoreGuard);
    expectTypeOf(createGuard.fromJSON).parameter(0).toBeUnknown();
    expectTypeOf(createGuard.fromJSON).returns.toEqualTypeOf<Guard>();
    const snapshot: GuardSnapshot = createGuard().toJSON();
    expectTypeOf(snapshot.version).toEqualTypeOf<1>();
  });
});

// ---------------------------------------------------------------------------
describe('snapshot: a restored guard carries on', () => {
  it('repeated calls: the run, its previews and its step indexes continue', () => {
    const original = createGuard({ ...ONLY, repeatedToolCall: {} });
    feed(original, [step(call('search', { q: 'cats' })), step(call('search', { q: 'cats' }))]);
    const restored = restoreGuard(JSON.parse(JSON.stringify(original.toJSON())), { ...ONLY, repeatedToolCall: {} });
    const expected = original.check(step(call('search', { q: 'cats' })));
    const actual = restored.check(step(call('search', { q: 'cats' })));
    expect(actual).toEqual(expected);
    expect(actual).toMatchObject({
      stop: true,
      reason: 'repeated-tool-call',
      evidence: { tool: 'search', argsPreview: '{"q":"cats"}', count: 3, stepIndexes: [0, 1, 2] },
    });
  });

  it('oscillation: a cycle entered before the snapshot is completed after it', () => {
    const options: GuardOptions = { ...ONLY, oscillation: {} };
    const original = createGuard(options);
    feed(original, ['a', 'b', 'a', 'b', 'a'].map((n) => step(call(n, n))));
    const restored = restoreGuard(original.toJSON(), options);
    const next = step(call('b', 'b'));
    const expected = original.check(next);
    const actual = restored.check(next);
    expect(actual).toEqual(expected);
    expect(actual).toMatchObject({
      stop: true,
      reason: 'oscillation',
      evidence: { period: 2, repeats: 3, cycle: ['a("a")', 'b("b")'], tools: ['a', 'b'] },
    });
  });

  it('oscillation: the cycle being detected right now is part of the state', () => {
    const options: GuardOptions = { ...ONLY, oscillation: {} };
    const original = createGuard(options);
    feed(original, ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'].map((n) => step(call(n, n))));
    expect(original.summary().detectors.oscillation?.current).toEqual({ period: 2, repeats: 4 });
    const restored = restoreGuard(JSON.parse(JSON.stringify(original.toJSON())), options);
    expect(restored.summary().detectors).toEqual(original.summary().detectors);
  });

  it('no progress: the streak and its text continue', () => {
    const options: GuardOptions = { ...ONLY, noProgress: {} };
    const original = createGuard(options);
    feed(original, [{ text: 'Still trying' }, { text: 'still   TRYING' }]);
    const restored = restoreGuard(original.toJSON(), options);
    expect(restored.check({ text: 'still trying' })).toMatchObject({
      stop: true,
      reason: 'no-progress',
      evidence: { steps: 3, textPreview: 'still trying' },
    });
    // The outcomes seen before the snapshot are still known: a repeated outcome is not progress.
    const calls = createGuard({ ...ONLY, noProgress: { threshold: 2 } });
    calls.check(step(call('t', 1, { result: 'r' })));
    const again = restoreGuard(calls.toJSON(), { ...ONLY, noProgress: { threshold: 2 } });
    expect(again.check(step(call('t', 1, { result: 'r' }))).stop).toBe(false); // stalled, streak 1
    expect(again.check(step(call('t', 1, { result: 'r' }))).stop).toBe(true); // streak 2
  });

  it('tool caps: calls already made still count', () => {
    const options: GuardOptions = { ...ONLY, tools: { search: { maxCalls: 3 } } };
    const original = createGuard(options);
    feed(original, [step(call('search', 1)), step(call('search', 2)), step(call('search', 3))]);
    const restored = restoreGuard(original.toJSON(), options);
    expect(restored.preflight({ name: 'search', args: 4 })).toMatchObject({ allow: false, code: 'TOOL_CALL_CAP' });
    expect(restored.check(step(call('search', 4)))).toMatchObject({ stop: true, evidence: { calls: 4, limit: 3 } });
    expect(restored.summary().detectors.toolLimits).toEqual([{ tool: 'search', limit: 3, calls: 4 }]);
  });

  it('counters, totals, step count and max steps continue; history starts empty', () => {
    const options: GuardOptions = { ...ONLY, maxSteps: 4, budget: { maxTotalTokens: 100 }, now: () => 0 };
    const original = createGuard(options);
    feed(original, [
      { toolCalls: [call('t', 1, { error: 'x' }), call('t', 2)], usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 }, durationMs: 20 },
      { usage: { totalTokens: 30 } },
    ]);
    const restored = restoreGuard(original.toJSON(), options);
    expect(restored.history).toEqual([]);
    expect(restored.summary()).toEqual({ ...original.summary(), lastVerdict: null });
    expect(restored.summary().steps).toBe(2);
    expect(restored.check({}).stop).toBe(false);
    expect(restored.check({})).toMatchObject({ stop: true, reason: 'max-steps', evidence: { steps: 4, limit: 4 } });
    expect(restored.history).toHaveLength(2); // only the steps this guard object has seen
    expect(restored.summary().steps).toBe(4);
  });

  it('budget: totals continue towards the limit', () => {
    const options: GuardOptions = { ...ONLY, budget: { maxTotalTokens: 100 } };
    const original = createGuard(options);
    original.check({ usage: { totalTokens: 60 } });
    const restored = restoreGuard(original.toJSON(), options);
    expect(restored.check({ usage: { totalTokens: 39 } }).stop).toBe(false);
    expect(restored.check({ usage: { totalTokens: 1 } })).toMatchObject({ stop: true, reason: 'budget', evidence: { value: 100 } });
  });

  it('wall-clock time already used counts, and time between snapshot and restore does not', () => {
    let clock = 10_000;
    const options: GuardOptions = { ...ONLY, budget: { maxDurationMs: 1000 }, now: () => clock };
    const original = createGuard(options);
    clock += 600;
    original.check({});
    const snapshot = original.toJSON();
    expect(snapshot.wallClockMs).toBe(600);

    clock += 3_600_000; // the process was away for an hour
    const restored = restoreGuard(snapshot, options);
    expect(restored.check({}).stop).toBe(false); // 600 ms used, not an hour
    clock += 399;
    expect(restored.check({}).stop).toBe(false);
    clock += 1;
    expect(restored.check({})).toMatchObject({ stop: true, code: 'BUDGET_DURATION_MS', evidence: { value: 1000 } });
  });

  it('wallClockMs is null, and the clock is never read, without a duration budget', () => {
    let reads = 0;
    const guard = createGuard({ budget: { maxTotalTokens: 5 }, now: () => (reads += 1) });
    const before = reads;
    expect(guard.toJSON().wallClockMs).toBeNull();
    expect(reads).toBe(before);
  });

  it('finish reason: the last one is remembered', () => {
    const original = createGuard();
    original.check({ finishReason: 'tool-calls', toolCalls: [call('t')] });
    const restored = restoreGuard(original.toJSON());
    expect(restored.summary().detectors.finishReason).toEqual({ lastFinishReason: 'tool-calls' });
  });

  it('feedback and the clock are not part of the fingerprint: a different function is fine', () => {
    const original = createGuard({ maxSteps: 1, feedback: () => 'one' });
    original.check({});
    const restored = restoreGuard(original.toJSON(), { maxSteps: 1, feedback: () => 'two', now: () => 5 });
    expect(restored.check({})).toMatchObject({ stop: true, feedback: 'two' });
  });

  it('custom detectors see only the steps recorded since the restore', () => {
    const seen: number[] = [];
    const options: GuardOptions = {
      custom: (history) => {
        seen.push(history.length);
        return undefined;
      },
    };
    const original = createGuard(options);
    feed(original, [{}, {}, {}]);
    const restored = restoreGuard(original.toJSON(), options);
    seen.length = 0;
    restored.check({});
    restored.check({});
    expect(seen).toEqual([1, 2]);
    expect(restored.summary().steps).toBe(5);
  });

  it('the restored guard and the original are independent', () => {
    const options: GuardOptions = { ...ONLY, repeatedToolCall: { threshold: 2 } };
    const original = createGuard(options);
    original.check(step(call('t', 1)));
    const restored = restoreGuard(original.toJSON(), options);
    expect(restored.check(step(call('t', 1))).stop).toBe(true);
    expect(original.summary().steps).toBe(1);
    expect(original.check(step(call('u', 1))).stop).toBe(false);
  });

  it('reset() on a restored guard gives a fresh guard', () => {
    const options = busyOptions();
    const restored = restoreGuard(busyGuard(options).toJSON(), options);
    restored.reset();
    const fresh = createGuard(options);
    expect(restored.toJSON()).toEqual(fresh.toJSON());
    const trace = [step(call('a', 1)), step(call('b', 1)), step(call('a', 1)), step(call('b', 1)), step(call('a', 1)), step(call('b', 1))];
    expect(feed(restored, trace)).toEqual(feed(fresh, trace));
  });

  it('a snapshot of a restored guard is the snapshot it was restored from', () => {
    const options = busyOptions();
    const snapshot = busyGuard(options).toJSON();
    expect(restoreGuard(snapshot, options).toJSON()).toEqual(snapshot);
    expect(restoreGuard(restoreGuard(snapshot, options).toJSON(), options).toJSON()).toEqual(snapshot);
  });

  it('preflight on a restored guard answers like the original', () => {
    const options: GuardOptions = { ...ONLY, repeatedToolCall: {}, oscillation: {}, tools: { search: { maxCalls: 4 } } };
    const original = createGuard(options);
    feed(original, ['a', 'b', 'a', 'b', 'a', 'search', 'search'].map((n) => step(call(n, 1))));
    const restored = restoreGuard(original.toJSON(), options);
    for (const probe of [{ name: 'b', args: 1 }, { name: 'a', args: 1 }, { name: 'search', args: 1 }, { name: 'z' }]) {
      expect(restored.preflight(probe)).toEqual(original.preflight(probe));
    }
  });

  it('does not modify the snapshot it is given, and accepts a deeply frozen one', () => {
    const snapshot = busyGuard().toJSON();
    const copy = structuredClone(snapshot);
    const restored = restoreGuard(deepFreeze(structuredClone(snapshot)), busyOptions());
    restored.check(step(call('search', { q: 'a' }, { result: 1 })));
    expect(snapshot).toEqual(copy);
    expect(restoreGuard(snapshot, busyOptions()).toJSON()).toEqual(snapshot);
  });

  it('very long tool names are cut in the snapshot but still compare correctly', () => {
    const long = 'tool_'.repeat(400);
    const options: GuardOptions = { ...ONLY, repeatedToolCall: {} };
    const original = createGuard(options);
    feed(original, [step(call(long, 1)), step(call(long, 1))]);
    const snapshot = original.toJSON();
    expect(snapshot.detectors.repeatedToolCall?.tool).toHaveLength(256);
    const restored = restoreGuard(snapshot, options);
    expect(restored.check(step(call(long, 1)))).toMatchObject({ stop: true, code: 'REPEATED_TOOL_CALL', evidence: { count: 3 } });
    expect(restored.check(step(call(`${long}x`, 1))).stop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The differential property
// ---------------------------------------------------------------------------

type Rand = () => number;
const pick = <T>(rand: Rand, items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

/** Steps made of plain, JSON-friendly data, so a JSON round trip of a snapshot is a fair test. */
function plainStep(rand: Rand): GuardStep {
  const calls = Array.from({ length: Math.floor(rand() * 4) }, () => {
    const c: Record<string, unknown> = { name: pick(rand, ['a', 'b', 'c', 'search', 'think', 'poll']) };
    if (rand() < 0.9) c['args'] = pick(rand, [1, 2, 'x', { q: 'x' }, { q: 'y', page: 2 }]);
    if (rand() < 0.5) c['result'] = pick(rand, ['r1', 'r2', { n: 1 }, [1, 2]]);
    if (rand() < 0.12) c['error'] = pick(rand, ['boom', 'timeout']);
    return c;
  });
  const out: Record<string, unknown> = { toolCalls: calls };
  if (rand() < 0.7) out['text'] = pick(rand, ['', 'ok', 'Thinking...', 'thinking...', 'Same text', 'a longer line of text that goes on and on and on and on and on and on and on and on and on']);
  if (rand() < 0.8) out['finishReason'] = pick(rand, ['tool-calls', 'tool-calls', 'tool-calls', 'other', 'unknown', 'stop', 'length']);
  if (rand() < 0.6) {
    out['usage'] = { inputTokens: pick(rand, [0, 10, 40]), outputTokens: pick(rand, [0, 5, 20]), costUsd: pick(rand, [0, 0.01, 0.05]) };
  }
  if (rand() < 0.5) out['durationMs'] = pick(rand, [0, 5, 30]);
  return out as GuardStep;
}

interface Clock {
  t: number;
}

const DIFFERENTIAL_CONFIGS: Array<[string, (clock: Clock) => GuardOptions]> = [
  ['defaults', () => ({})],
  [
    'tight thresholds',
    () => ({ maxSteps: 45, repeatedToolCall: { threshold: 2 }, oscillation: { maxPeriod: 4, repeats: 2 }, noProgress: { threshold: 2 } }),
  ],
  ['result-aware and error-ignoring', () => ({ repeatedToolCall: { requireIdenticalResults: true, ignoreErrors: true } })],
  [
    'budgets, warnings and the wall clock',
    (clock) => ({
      budget: { maxTotalTokens: 900, maxInputTokens: 600, maxOutputTokens: 300, maxCostUsd: 2, maxDurationMs: 600, warnAt: 0.5 },
      now: () => clock.t,
    }),
  ],
  [
    'per-tool policies',
    () => ({
      tools: {
        search: { maxCalls: 6 },
        poll: { polling: { maxIdenticalResults: 3 } },
        think: { ignore: true },
        a: { repeatThreshold: 2 },
        c: { maxCalls: 2, repeatThreshold: 4 },
      },
    }),
  ],
  ['finish policy: stop', () => ({ finishReason: { otherPolicy: 'stop', terminal: ['stop', 'end_turn'] } })],
  ['finish policy: continue', () => ({ finishReason: { otherPolicy: 'continue', terminal: [] } })],
  ['only some detectors', () => ({ oscillation: false, finishReason: false, maxSteps: 60, noProgress: { threshold: 4 } })],
  ['everything off', () => ({ ...ONLY })],
  [
    'a stateless custom detector and a feedback override',
    () => ({
      custom: (_history, s) => (s.toolCalls?.length === 3 ? { stop: true, code: 'THREE_CALLS', feedback: 'Fewer calls, please.' } : undefined),
      feedback: (verdict) => (verdict.code === 'NO_PROGRESS' ? 'Change approach.' : undefined),
    }),
  ],
];

describe('snapshot: restore == carry on (differential property)', () => {
  const STEPS = 70;

  it.each(DIFFERENTIAL_CONFIGS)('%s', (_name, makeOptions) => {
    let stops = 0;
    let restoredRuns = 0;
    for (let seed = 1; seed <= 14; seed += 1) {
      const rand = mulberry32(seed * 104729);
      const trace = Array.from({ length: STEPS }, () => plainStep(rand));
      const clockA: Clock = { t: 0 };

      // The reference run, with a snapshot (and summary) recorded after every step.
      const a = createGuard(makeOptions(clockA));
      const clockControl: Clock = { t: 0 };
      const controlGuard = createGuard(makeOptions(clockControl));
      const verdicts: Verdict[] = [];
      const summaries = [a.summary()];
      const snapshots = [a.toJSON()];
      trace.forEach((s, i) => {
        clockA.t = i * 7;
        clockControl.t = i * 7;
        const verdict = a.check(s);
        // Snapshotting after every step must not disturb the run: compare with one that never does.
        expect(controlGuard.check(s)).toEqual(verdict);
        verdicts.push(verdict);
        summaries.push(a.summary());
        snapshots.push(a.toJSON());
      });
      expect(snapshots[STEPS]).toEqual(controlGuard.toJSON());

      const cuts = [0, 1, STEPS, STEPS - 1, ...Array.from({ length: 4 }, () => Math.floor(rand() * (STEPS + 1)))];
      for (const k of cuts) {
        // Three ways of getting the snapshot to the other side.
        const carriers: Array<[string, unknown]> = [
          ['direct', snapshots[k]],
          ['structuredClone', structuredClone(snapshots[k])],
          ['JSON', JSON.parse(JSON.stringify(snapshots[k]))],
        ];
        for (const [carrier, snapshot] of carriers) {
          const clockB: Clock = { t: k === 0 ? 0 : (k - 1) * 7 };
          const b = restoreGuard(snapshot, makeOptions(clockB));
          restoredRuns += 1;
          const label = `seed ${seed}, cut ${k}, ${carrier}`;

          // Right after the restore: the same state (the last verdict is not carried over).
          expect(b.toJSON(), label).toEqual(snapshots[k]);
          expect({ ...b.summary(), lastVerdict: null }, label).toEqual({ ...summaries[k], lastVerdict: null });

          for (let j = k; j < STEPS; j += 1) {
            clockB.t = j * 7;
            const got = b.check(trace[j] as GuardStep);
            expect(got, `${label}, step ${j}`).toEqual(verdicts[j]);
            expect(b.summary(), `${label}, step ${j}`).toEqual(summaries[j + 1]);
            if (got.stop) stops += 1;
          }
          expect(b.toJSON(), label).toEqual(snapshots[STEPS]);
        }
      }
    }
    expect(restoredRuns).toBe(14 * 8 * 3);
    if (_name !== 'everything off') expect(stops).toBeGreaterThan(0); // the property is not vacuous
  });

  it('chains: restoring a restored guard, repeatedly, still matches the uninterrupted run', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const rand = mulberry32(seed * 31337);
      const trace = Array.from({ length: 90 }, () => plainStep(rand));
      const makeOptions = (): GuardOptions => ({
        repeatedToolCall: { threshold: 2 },
        oscillation: { repeats: 2 },
        noProgress: {},
        tools: { search: { maxCalls: 8 }, think: { ignore: true } },
        maxSteps: 200,
      });
      const uninterrupted = createGuard(makeOptions());
      const expected = feed(uninterrupted, trace);

      let guard = createGuard(makeOptions());
      const got: Verdict[] = [];
      trace.forEach((s, i) => {
        got.push(guard.check(s));
        if (i % 7 === 3) guard = restoreGuard(JSON.parse(JSON.stringify(guard.toJSON())), makeOptions());
      });
      expect(got).toEqual(expected);
      expect(guard.toJSON()).toEqual(uninterrupted.toJSON());
      expect(firstStop(got)).toBe(firstStop(expected));
    }
  });
});

// ---------------------------------------------------------------------------
describe('snapshot: options', () => {
  const base = (): GuardOptions => ({
    maxSteps: 30,
    repeatedToolCall: { threshold: 4 },
    oscillation: { maxPeriod: 4, repeats: 3 },
    noProgress: { threshold: 3 },
    finishReason: { terminal: ['stop', 'length'], otherPolicy: 'stop' },
    budget: { maxTotalTokens: 1000, maxDurationMs: 5000, warnAt: 0.8 },
    tools: { search: { maxCalls: 5 }, poll: { polling: true } },
    custom: () => undefined,
  });
  const snapshot = (): GuardSnapshot => createGuard(base()).toJSON();

  it('restores under the same options, and under equal options built separately', () => {
    expect(() => restoreGuard(snapshot(), base())).not.toThrow();
    const reordered: GuardOptions = { ...base(), finishReason: { otherPolicy: 'stop', terminal: ['length', 'stop'] } };
    expect(() => restoreGuard(snapshot(), reordered)).not.toThrow();
  });

  it('defaults to the default options', () => {
    const s = createGuard().toJSON();
    expect(() => restoreGuard(s)).not.toThrow();
    expect(() => restoreGuard(s, {})).not.toThrow();
    expect(() => restoreGuard(s, { maxSteps: 51 })).toThrow(/maxSteps/);
  });

  it.each([
    { name: 'maxSteps', group: 'maxSteps', change: { maxSteps: 31 } },
    { name: 'maxSteps off', group: 'maxSteps', change: { maxSteps: false as const } },
    { name: 'repeated threshold', group: 'repeatedToolCall', change: { repeatedToolCall: { threshold: 5 } } },
    { name: 'repeated requireIdenticalResults', group: 'repeatedToolCall', change: { repeatedToolCall: { threshold: 4, requireIdenticalResults: true } } },
    { name: 'repeated ignoreErrors', group: 'repeatedToolCall', change: { repeatedToolCall: { threshold: 4, ignoreErrors: true } } },
    { name: 'repeated off', group: 'repeatedToolCall', change: { repeatedToolCall: false as const } },
    { name: 'oscillation maxPeriod', group: 'oscillation', change: { oscillation: { maxPeriod: 5, repeats: 3 } } },
    { name: 'oscillation repeats', group: 'oscillation', change: { oscillation: { maxPeriod: 4, repeats: 2 } } },
    { name: 'oscillation off', group: 'oscillation', change: { oscillation: false as const } },
    { name: 'noProgress threshold', group: 'noProgress', change: { noProgress: { threshold: 4 } } },
    { name: 'noProgress off', group: 'noProgress', change: { noProgress: false as const } },
    { name: 'finish terminal', group: 'finishReason', change: { finishReason: { terminal: ['stop'], otherPolicy: 'stop' as const } } },
    { name: 'finish policy', group: 'finishReason', change: { finishReason: { terminal: ['stop', 'length'], otherPolicy: 'continue' as const } } },
    { name: 'finish off', group: 'finishReason', change: { finishReason: false as const } },
    { name: 'budget limit', group: 'budget', change: { budget: { maxTotalTokens: 2000, maxDurationMs: 5000, warnAt: 0.8 } } },
    { name: 'budget warnAt', group: 'budget', change: { budget: { maxTotalTokens: 1000, maxDurationMs: 5000, warnAt: 0.7 } } },
    { name: 'budget removed', group: 'budget', change: { budget: false as const } },
    { name: 'a tool cap', group: 'tools', change: { tools: { search: { maxCalls: 6 }, poll: { polling: true } } } },
    { name: 'a tool policy added', group: 'tools', change: { tools: { search: { maxCalls: 5 }, poll: { polling: true }, think: { ignore: true } } } },
    { name: 'a tool policy removed', group: 'tools', change: { tools: { search: { maxCalls: 5 } } } },
    { name: 'a polling threshold', group: 'tools', change: { tools: { search: { maxCalls: 5 }, poll: { polling: { maxIdenticalResults: 7 } } } } },
    { name: 'no tools at all', group: 'tools', change: { tools: undefined } },
    { name: 'custom detectors removed', group: 'custom', change: { custom: undefined } },
    { name: 'custom detectors added', group: 'custom', change: { custom: [() => undefined, () => undefined] } },
  ] as Array<{ name: string; group: string; change: Partial<GuardOptions> }>)('refuses a changed $name', ({ group, change }) => {
    const options = { ...base(), ...change };
    expect(() => restoreGuard(snapshot(), options)).toThrow(TypeError);
    expect(() => restoreGuard(snapshot(), options)).toThrow(/taken with different options/);
    expect(() => restoreGuard(snapshot(), options)).toThrow(new RegExp(`\\(.*\\b${group}\\b.*\\)`));
  });

  it('names every group that differs, once, and only those', () => {
    const options: GuardOptions = { ...base(), oscillation: false, noProgress: { threshold: 9 }, tools: {} };
    expect(() => restoreGuard(snapshot(), options)).toThrow('(oscillation, noProgress, tools)');
  });

  it('allowLimitChanges lets maxSteps and budget differ, and nothing else', () => {
    const loosened: GuardOptions = { ...base(), maxSteps: 100, budget: { maxTotalTokens: 5000 } };
    expect(() => restoreGuard(snapshot(), loosened)).toThrow(/\(maxSteps, budget\)/);
    expect(() => restoreGuard(snapshot(), loosened, { allowLimitChanges: true })).not.toThrow();
    expect(() => restoreGuard(snapshot(), { ...loosened, maxSteps: false, budget: false }, { allowLimitChanges: true })).not.toThrow();
    expect(() => restoreGuard(snapshot(), { ...loosened, oscillation: { maxPeriod: 9 } }, { allowLimitChanges: true })).toThrow(
      /\(oscillation\)/,
    );
    expect(() => restoreGuard(snapshot(), { ...loosened, tools: {} }, { allowLimitChanges: true })).toThrow(/\(tools\)/);
  });

  it('allowLimitChanges: a run that hit its step limit can be given more room', () => {
    const tight: GuardOptions = { ...ONLY, maxSteps: 3 };
    const original = createGuard(tight);
    const verdicts = feed(original, [{}, {}, {}]);
    expect(firstStop(verdicts)).toBe(2);
    const resumed = restoreGuard(original.toJSON(), { ...ONLY, maxSteps: 6 }, { allowLimitChanges: true });
    expect(resumed.summary().detectors.maxSteps).toEqual({ limit: 6, remaining: 3 });
    expect(feed(resumed, [{}, {}, {}]).map((v) => v.stop)).toEqual([false, false, true]);
  });

  it('allowLimitChanges: a budget tightened below what was already spent stops at the next step', () => {
    const original = createGuard({ ...ONLY, budget: { maxTotalTokens: 1000 } });
    original.check({ usage: { totalTokens: 400 } });
    const resumed = restoreGuard(original.toJSON(), { ...ONLY, budget: { maxTotalTokens: 300 } }, { allowLimitChanges: true });
    expect(resumed.check({})).toMatchObject({ stop: true, code: 'BUDGET_TOTAL_TOKENS', evidence: { value: 400, limit: 300 } });
  });

  it('allowLimitChanges: adding a duration budget starts its clock at the restore', () => {
    let clock = 0;
    const original = createGuard({ ...ONLY, budget: { maxTotalTokens: 10 } });
    original.check({});
    expect(original.toJSON().wallClockMs).toBeNull();
    const resumed = restoreGuard(original.toJSON(), { ...ONLY, budget: { maxDurationMs: 100 }, now: () => clock }, { allowLimitChanges: true });
    clock += 99;
    expect(resumed.check({}).stop).toBe(false);
    clock += 1;
    expect(resumed.check({}).stop).toBe(true);
  });

  it('invalid options still fail with their own error first', () => {
    expect(() => restoreGuard(createGuard().toJSON(), { maxSteps: 0 })).toThrow(/maxSteps must be an integer/);
  });
});

// ---------------------------------------------------------------------------
describe('snapshot: rejects snapshots that cannot be trusted', () => {
  const options = (): GuardOptions => ({
    repeatedToolCall: {},
    oscillation: { maxPeriod: 3 },
    noProgress: {},
    budget: { maxTotalTokens: 1e9, maxDurationMs: 1e9 },
    tools: { search: { maxCalls: 9 } },
    now: () => 0,
  });
  /** A valid snapshot with something in every section. */
  const valid = (): GuardSnapshot => {
    const guard = createGuard(options());
    feed(guard, [
      { toolCalls: [call('search', 1, { result: 1 }), call('read', 2, { result: 2 })], text: 'one', usage: { totalTokens: 5 }, finishReason: 'tool-calls' },
      { toolCalls: [call('read', 2, { result: 2 })], text: 'two' },
      { toolCalls: [call('read', 2, { result: 2 })], text: 'two' },
      { text: 'two' },
    ]);
    return guard.toJSON();
  };
  type Path = Array<string | number>;
  type Slot = Record<string | number, unknown>;
  const at = (root: unknown, path: Path): unknown => path.reduce<unknown>((current, key) => (current as Slot)[key], root);
  const put = (root: unknown, path: Path, value: unknown): void => {
    (at(root, path.slice(0, -1)) as Slot)[path[path.length - 1] as string | number] = value;
  };
  const drop = (root: unknown, path: Path): void => {
    Reflect.deleteProperty(at(root, path.slice(0, -1)) as Slot, path[path.length - 1] as string | number);
  };
  /** A change to a copy of the valid snapshot: set `path` to `value`. */
  const set = (path: Path, value: unknown) => (root: unknown) => put(root, path, value);
  const mutate = (change: (root: unknown) => void): unknown => {
    const root = structuredClone(valid()) as unknown;
    change(root);
    return root;
  };
  const det = (name: string, ...rest: Path): Path => ['detectors', name, ...rest];
  type Case = [name: string, change: (root: unknown) => void, message: RegExp];
  const rejects = (cases: Case[]): void =>
    it.each(cases)('rejects %s', (_name, change, message) => {
      expect(() => restoreGuard(mutate(change), options())).toThrow(TypeError);
      expect(() => restoreGuard(mutate(change), options())).toThrow(message);
    });

  it('the base snapshot is valid and has content in every section', () => {
    const s = valid();
    expect(() => restoreGuard(s, options())).not.toThrow();
    expect(s.detectors.repeatedToolCall?.length).toBe(3);
    expect(s.detectors.oscillation?.sigs.length).toBe(3);
    expect(s.detectors.noProgress?.streak).toBeGreaterThan(0);
    expect(s.detectors.toolLimits).toEqual([{ tool: 'search', calls: 1 }]);
  });

  it.each([
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'a number', value: 7 },
    { name: 'a string', value: JSON.stringify(valid()) },
    { name: 'an array', value: [valid()] },
    { name: 'true', value: true },
    { name: 'a function', value: () => valid() },
  ])('is not an object: $name', ({ value }) => {
    expect(() => restoreGuard(value, options())).toThrow(TypeError);
    expect(() => restoreGuard(value, options())).toThrow(/snapshot must be an object/);
  });

  it.each([0, 2, 99, '1', 1.5, null, true, {}, [1]])('rejects version %j', (version) => {
    const s = mutate(set(['version'], version));
    expect(() => restoreGuard(s, options())).toThrow(TypeError);
    expect(() => restoreGuard(s, options())).toThrow(/snapshot\.version is .*reads version 1/);
  });

  it('rejects a missing version, naming it', () => {
    expect(() => restoreGuard(mutate((x) => drop(x, ['version'])), options())).toThrow('snapshot.version is missing');
  });

  it.each(['steps', 'toolCalls', 'failedToolCalls', 'totals', 'wallClockMs', 'options', 'detectors'])('rejects a missing %s', (key) => {
    expect(() => restoreGuard(mutate((x) => drop(x, [key])), options())).toThrow(`snapshot.${key} is missing`);
  });

  it.each([
    { path: ['steps'], values: [-1, 1.5, NaN, Infinity, '3', null, 2 ** 53, {}] },
    { path: ['toolCalls'], values: [-1, 0.5, NaN, '1', null] },
    { path: ['failedToolCalls'], values: [-1, 99, NaN, '1', null] },
    { path: ['totals', 'inputTokens'], values: [-1, NaN, Infinity, '1', null] },
    { path: ['totals', 'outputTokens'], values: [-1, NaN, Infinity, '1', null] },
    { path: ['totals', 'totalTokens'], values: [-1, NaN, Infinity, '1', null] },
    { path: ['totals', 'costUsd'], values: [-0.01, NaN, Infinity, '1', null] },
    { path: ['totals', 'durationMs'], values: [-1, NaN, Infinity, '1', null] },
    { path: ['wallClockMs'], values: [-1, NaN, Infinity, '5', {}] },
  ])('rejects bad values at $path', ({ path, values }) => {
    for (const value of values) {
      expect(() => restoreGuard(mutate(set(path, value)), options()), `${path.join('.')} = ${String(value)}`).toThrow(TypeError);
    }
  });

  it('rejects totals that are not an object or are missing a member', () => {
    expect(() => restoreGuard(mutate(set(['totals'], [])), options())).toThrow('snapshot.totals must be an object');
    expect(() => restoreGuard(mutate((x) => drop(x, ['totals', 'costUsd'])), options())).toThrow('snapshot.totals.costUsd is missing');
  });

  it('rejects fingerprints that are missing, not strings or absurdly long', () => {
    expect(() => restoreGuard(mutate((x) => drop(x, ['options', 'tools'])), options())).toThrow('snapshot.options.tools is missing');
    expect(() => restoreGuard(mutate(set(['options', 'tools'], 5)), options())).toThrow(/snapshot\.options\.tools must be a string/);
    expect(() => restoreGuard(mutate(set(['options', 'tools'], 'x'.repeat(65))), options())).toThrow(/at most 64 characters/);
    expect(() => restoreGuard(mutate(set(['options'], null)), options())).toThrow('snapshot.options must be an object');
    expect(() => restoreGuard(mutate(set(['options', 'tools'], 'abc')), options())).toThrow(/different options \(tools\)/);
  });

  it('rejects detector state for a detector that is off, and none for one that is on', () => {
    expect(() => restoreGuard(mutate(set(det('oscillation'), null)), options())).toThrow(
      /detectors\.oscillation is null, but that detector is enabled/,
    );
    expect(() => restoreGuard(valid(), { ...options(), finishReason: false })).toThrow(/different options \(finishReason\)/);
    const withoutFinish = createGuard({ ...options(), finishReason: false }).toJSON();
    put(withoutFinish, det('finishReason'), { lastFinishReason: 'x' });
    expect(() => restoreGuard(withoutFinish, { ...options(), finishReason: false })).toThrow(
      /detectors\.finishReason has state, but that detector is disabled/,
    );
    expect(() => restoreGuard(mutate((x) => drop(x, det('noProgress'))), options())).toThrow('detectors.noProgress is missing');
    expect(() => restoreGuard(mutate(set(['detectors'], [])), options())).toThrow('snapshot.detectors must be an object');
  });

  describe('repeatedToolCall state', () => {
    const rep = (key: string): Path => det('repeatedToolCall', key);
    rejects([
      ['a key that is not a hash', set(rep('key'), 'abc'), /key must be a 28-character hex hash/],
      ['a key in the wrong case', set(rep('key'), 'A'.repeat(28)), /key must be a 28-character hex hash/],
      ['no key for a run', set(rep('key'), null), /key, length and steps disagree/],
      ['a key for no run', set(rep('length'), 0), /key, length and steps disagree/],
      ['no steps for a run', set(rep('steps'), []), /key, length and steps disagree/],
      ['more steps than calls', set(rep('steps'), [0, 1, 2, 3]), /key, length and steps disagree/],
      ['steps out of order', set(rep('steps'), [2, 1]), /strictly increasing/],
      ['repeated steps', set(rep('steps'), [1, 1]), /strictly increasing/],
      ['a negative step', set(rep('steps'), [-1, 1]), /steps\[0\] must be a non-negative integer/],
      [
        'eleven steps',
        (x) => {
          put(x, rep('length'), 20);
          put(x, rep('longest'), 20);
          put(x, rep('steps'), Array.from({ length: 11 }, (_, i) => i));
        },
        /at most 10 entries/,
      ],
      ['a longest below the run', set(rep('longest'), 1), /longest must be at least/],
      ['a tool that is not a string', set(rep('tool'), 5), /tool must be a string/],
      ['a tool name that is too long', set(rep('tool'), 'x'.repeat(257)), /at most 256 characters/],
      ['a preview that is too long', set(rep('preview'), 'x'.repeat(129)), /at most 128 characters/],
      ['a preview that is not a string', set(rep('preview'), null), /preview must be a string/],
      ['a section that is not an object', set(det('repeatedToolCall'), 'run'), /repeatedToolCall must be an object/],
    ]);
  });

  describe('oscillation state', () => {
    const osc = (...rest: Path): Path => det('oscillation', ...rest);
    rejects([
      [
        'more calls than maxPeriod',
        (x) => {
          for (const key of ['sigs', 'labels', 'names']) put(x, osc(key), [...(at(x, osc(key)) as unknown[]), ...(at(x, osc(key)) as unknown[])]);
        },
        /at most 3 entries/,
      ],
      ['a sig that is not a hash', set(osc('sigs', 0), 'nope'), /sigs\[0\] must be a 28-character hex hash/],
      ['labels of another length', set(osc('labels'), ['a']), /rings of different lengths/],
      ['names of another length', set(osc('names'), []), /rings of different lengths/],
      ['a label that is too long', set(osc('labels', 0), 'x'.repeat(1025)), /at most 1024 characters/],
      ['a name that is not a string', set(osc('names', 0), 1), /names\[0\] must be a string/],
      ['too few counters', set(osc('matches'), [0]), /exactly 2 entries/],
      ['too many counters', set(osc('matches'), [0, 0, 0]), /at most 2 entries/],
      ['a negative counter', set(osc('matches'), [-1, 0]), /matches\[0\] must be a non-negative integer/],
      [
        'a counter for calls that are not there',
        (x) => {
          for (const key of ['sigs', 'labels', 'names']) put(x, osc(key), []);
          put(x, osc('matches'), [1, 0]);
        },
        /counts calls that are not in the ring/,
      ],
      ['a current period of 1', set(osc('current'), { period: 1, repeats: 3 }), /period must be between 2 and maxPeriod/],
      ['a current period above maxPeriod', set(osc('current'), { period: 4, repeats: 3 }), /period must be between 2 and maxPeriod/],
      ['a current that is not an object', set(osc('current'), 'now'), /current must be an object/],
      ['a current with a bad repeat count', set(osc('current'), { period: 2, repeats: -1 }), /repeats must be a non-negative integer/],
      ['an array that is a string', set(osc('sigs'), 'abc'), /sigs must be an array/],
      ['a sparse array', set(osc('sigs'), new Array(3)), /sigs\[0\] must be a 28-character hex hash/],
    ]);
  });

  describe('noProgress state', () => {
    const np = (key: string): Path => det('noProgress', key);
    rejects([
      ['a repeated outcome', (x) => put(x, np('seen'), [at(x, [...np('seen'), 0]), at(x, [...np('seen'), 0])]), /must not repeat an outcome/],
      [
        'too many outcomes',
        set(np('seen'), Array.from({ length: 1025 }, (_, i) => i.toString(16).padStart(28, '0'))),
        /at most 1024 entries/,
      ],
      ['an outcome that is not a hash', set([...np('seen'), 0], 7), /seen\[0\] must be a 28-character hex hash/],
      ['a negative streak', set(np('streak'), -1), /streak must be a non-negative integer/],
      ['a streak with no text key', set(np('textKey'), null), /streak and a text that disagree/],
      ['a text key without a streak', set(np('streak'), 0), /streak and a text that disagree/],
      [
        'a preview without a streak',
        (x) => {
          put(x, np('streak'), 0);
          put(x, np('textKey'), null);
          put(x, np('textPreview'), 'x');
        },
        /streak and a text that disagree/,
      ],
      ['a preview that is too long', set(np('textPreview'), 'x'.repeat(129)), /at most 128 characters/],
    ]);
  });

  describe('finishReason and toolLimits state', () => {
    rejects([
      ['a finish reason that is not a string', set(det('finishReason', 'lastFinishReason'), 5), /lastFinishReason must be a string/],
      ['a finish reason that is too long', set(det('finishReason', 'lastFinishReason'), 'x'.repeat(257)), /at most 256 characters/],
      ['tool limits that are not an array', set(det('toolLimits'), {}), /toolLimits must be an array/],
      ['an extra tool limit', (x) => (at(x, det('toolLimits')) as unknown[]).push({ tool: 'x', calls: 1 }), /at most 1 entries/],
      ['a missing tool limit', set(det('toolLimits'), []), /one entry for each of the 1 capped tools/],
      ['the wrong tool', set(det('toolLimits', 0, 'tool'), 'read'), /is not the tool capped at that position/],
      ['a negative count', set(det('toolLimits', 0, 'calls'), -1), /calls must be a non-negative integer/],
      ['a tool limit that is not an object', set(det('toolLimits', 0), 'search'), /toolLimits\[0\] must be an object/],
    ]);
  });

  describe('hostile objects', () => {
    it('ignores keys it does not know, at any level, including __proto__ and cycles', () => {
      const s = structuredClone(valid()) as unknown;
      put(s, ['extra'], 1);
      put(s, ['totals', 'extra'], 2);
      put(s, det('loop'), s);
      Object.defineProperty(s, '__proto__', { value: { polluted: true }, enumerable: true });
      Object.defineProperty(at(s, det('oscillation')), '__proto__', { value: { polluted: true }, enumerable: true });
      const guard = restoreGuard(s, options());
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(guard.toJSON()).toEqual(valid());
    });

    it('does not read inherited properties', () => {
      const inherited = Object.create(valid()) as unknown;
      expect(() => restoreGuard(inherited, options())).toThrow('snapshot.version is missing');
      const nested = mutate(set(['totals'], Object.create(valid().totals)));
      expect(() => restoreGuard(nested, options())).toThrow('snapshot.totals.inputTokens is missing');
    });

    it('turns a throwing getter into a TypeError', () => {
      const s = structuredClone(valid()) as unknown;
      Object.defineProperty(s, 'steps', {
        enumerable: true,
        get() {
          throw new RangeError('hostile getter');
        },
      });
      expect(() => restoreGuard(s, options())).toThrow(TypeError);
      const e = structuredClone(valid()) as unknown;
      Object.defineProperty(at(e, det('noProgress')), 'streak', {
        enumerable: true,
        get() {
          throw new Error('plain error');
        },
      });
      expect(() => restoreGuard(e, options())).toThrow(/agent-loopguard: invalid snapshot: it could not be read/);
    });

    it('turns a revoked proxy into a TypeError, at any level', () => {
      const dead = Proxy.revocable({}, {});
      dead.revoke();
      expect(() => restoreGuard(dead.proxy, options())).toThrow(TypeError);
      expect(() => restoreGuard(mutate(set(['totals'], dead.proxy)), options())).toThrow(TypeError);
      expect(() => restoreGuard(mutate(set(det('oscillation', 'sigs'), dead.proxy)), options())).toThrow(TypeError);
    });

    it('rejects huge arrays by their length before looking inside', () => {
      const huge = new Array(2 ** 31);
      expect(() => restoreGuard(mutate(set(det('noProgress', 'seen'), huge)), options())).toThrow(/at most 1024 entries/);
    });

    it('does not mutate what it is given when it throws', () => {
      const s = structuredClone(valid()) as unknown;
      put(s, det('oscillation', 'sigs', 0), 'bad');
      const copy = structuredClone(s);
      expect(() => restoreGuard(s, options())).toThrow(TypeError);
      expect(s).toEqual(copy);
    });
  });

  it('every message names the package and says what is wrong', () => {
    for (const value of [null, mutate(set(['steps'], -1)), mutate(set(['version'], 3))]) {
      try {
        restoreGuard(value, options());
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toMatch(/^agent-loopguard: invalid snapshot: .+/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('snapshot: fuzzed corruption never gets past the door', () => {
  const options = (): GuardOptions => ({
    repeatedToolCall: {},
    oscillation: { maxPeriod: 4 },
    noProgress: {},
    budget: { maxTotalTokens: 1e9, maxDurationMs: 1e9 },
    tools: { search: { maxCalls: 9 }, poll: { polling: true } },
    now: () => 0,
  });

  /** Every path to a value inside a snapshot (containers included). */
  function paths(value: unknown, prefix: Array<string | number> = []): Array<Array<string | number>> {
    const out: Array<Array<string | number>> = [prefix];
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) out.push(...paths(child, [...prefix, Array.isArray(value) ? Number(key) : key]));
    }
    return out;
  }

  const hostileValues = (): unknown[] => [
    undefined, null, NaN, Infinity, -Infinity, -1, 0, 1, 2, 2 ** 53, 1e308, 0.5, '', 'x', 'abc', '0'.repeat(28), 'F'.repeat(28), 'x'.repeat(5000),
    true, false, [], [[]], [null], {}, { a: 1 }, new Array(4), Array.from({ length: 2000 }, () => 'a'.repeat(28)), () => 1, 10n,
  ];

  it('a corrupted snapshot is either refused with a TypeError or yields a guard that works', () => {
    const rand = mulberry32(99);
    let refused = 0;
    let accepted = 0;
    for (let round = 0; round < 6; round += 1) {
      const guard = createGuard(options());
      const stepsRand = mulberry32(round + 1);
      for (let i = 0; i < 25; i += 1) guard.check(plainStep(stepsRand));
      const good = guard.toJSON();
      const all = paths(good);
      for (let i = 0; i < 250; i += 1) {
        const snap = structuredClone(good) as unknown as Record<string, unknown>;
        const target = pick(rand, all);
        if (target.length === 0) continue;
        const parent = target.slice(0, -1).reduce<unknown>((current, key) => (current as Record<string | number, unknown>)[key], snap) as Record<string | number, unknown>;
        const last = target[target.length - 1] as string | number;
        const replacement = pick(rand, hostileValues());
        if (replacement === undefined && rand() < 0.5) Reflect.deleteProperty(parent, last);
        else parent[last] = replacement;

        let restored: Guard;
        try {
          restored = restoreGuard(snap, options());
        } catch (error) {
          expect(error, `${target.join('.')} = ${String(replacement)}`).toBeInstanceOf(TypeError);
          expect((error as Error).message).toMatch(/^agent-loopguard: /);
          refused += 1;
          continue;
        }
        accepted += 1;
        // Anything it accepted must be fully usable, and must save and restore cleanly again.
        expect(() => {
          for (let k = 0; k < 8; k += 1) restored.check(plainStep(stepsRand));
          restored.preflight({ name: 'a', args: 1 });
          restored.summary();
        }).not.toThrow();
        const again = restored.toJSON();
        expect(JSON.parse(JSON.stringify(again))).toEqual(again);
        expect(() => restoreGuard(again, options())).not.toThrow();
      }
    }
    expect(refused).toBeGreaterThan(200);
    expect(accepted).toBeGreaterThan(50); // harmless edits (a longer preview, a bigger counter) are fine
  });
});

// ---------------------------------------------------------------------------
describe('snapshot: what it contains and what it does not', () => {
  it('holds no results, errors or text beyond the short previews, and no raw long arguments', () => {
    const options: GuardOptions = { ...busyOptions(), now: () => 0 };
    const guard = createGuard(options);
    // Keys are sorted in the canonical form, so the secret comes after the 80 characters that are kept.
    const longArgs = { padding: 'p'.repeat(120), zkey: SECRET };
    feed(guard, [
      { toolCalls: [call('search', longArgs, { result: { token: SECRET } })], text: `${'same '.repeat(30)}${SECRET}` },
      { toolCalls: [call('search', longArgs, { error: new Error(SECRET) })], text: `${'same '.repeat(30)}${SECRET}` },
      { toolCalls: [call('fetch', { url: `https://example.test/${'a'.repeat(100)}${SECRET}` }, { result: SECRET })], text: `${'same '.repeat(30)}${SECRET}` },
      { toolCalls: [call('fetch', { url: `https://example.test/${'a'.repeat(100)}${SECRET}` }, { result: SECRET })], text: `${'same '.repeat(30)}${SECRET}` },
    ]);
    const json = JSON.stringify(guard.toJSON());
    expect(json).not.toContain('SENTINEL');
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp');
  });

  it('holds short previews of recent arguments and text, so that evidence reads the same after a restore', () => {
    const options: GuardOptions = { ...ONLY, repeatedToolCall: {}, noProgress: {} };
    const guard = createGuard(options);
    feed(guard, [{ toolCalls: [call('search', { q: 'cats' })], text: 'Still trying' }, { toolCalls: [call('search', { q: 'cats' })], text: 'Still trying' }]);
    const json = JSON.stringify(guard.toJSON());
    expect(json).toContain('{\\"q\\":\\"cats\\"}');
    expect(json).toContain('still trying');
  });

  it('redact: true replaces every preview, and stop decisions stay the same', () => {
    const options: GuardOptions = { ...ONLY, repeatedToolCall: {}, oscillation: {}, noProgress: {} };
    const steps = [
      { toolCalls: [call('a', { secret: SECRET })], text: SECRET },
      { toolCalls: [call('b', { secret: SECRET })], text: SECRET },
      { toolCalls: [call('a', { secret: SECRET })], text: SECRET },
      { toolCalls: [call('b', { secret: SECRET })], text: SECRET },
      { toolCalls: [call('a', { secret: SECRET })], text: SECRET },
    ];
    const original = createGuard(options);
    feed(original, steps);
    const redacted = original.snapshot({ redact: true });
    expect(JSON.stringify(redacted)).not.toContain('SENTINEL');
    expect(JSON.stringify(redacted).toLowerCase()).not.toContain('sentinel');
    expect(JSON.stringify(redacted)).toContain('[redacted]');
    expect(redacted.detectors.oscillation?.labels).toEqual(['a([redacted])', 'b([redacted])', 'a([redacted])']);
    expect(redacted.detectors.oscillation?.names).toEqual(['a', 'b', 'a']);
    expect(JSON.stringify(original.toJSON())).toContain('SENTINEL'); // the default keeps them (documented)

    const next = step(call('b', { secret: SECRET }));
    const resumed = restoreGuard(redacted, options);
    const expected = original.check(next);
    const actual = resumed.check(next);
    expect(actual).toMatchObject({ stop: true, reason: expected.stop ? expected.reason : '', code: expected.stop ? expected.code : '' });
    // What differs is only the quoted previews of calls made before the snapshot.
    const strip = (v: Verdict): string => JSON.stringify(v).replace(/\([^()]*\)|\[redacted\]/g, '()').replace(/"textPreview":"[^"]*"/g, '"textPreview":""');
    expect(strip(actual)).toBe(strip(expected));
    expect(resumed.summary().detectors).toEqual(original.summary().detectors);
  });

  it('redact keeps empty text empty, so "no text" messages stay right', () => {
    const options: GuardOptions = { ...ONLY, noProgress: { threshold: 2 } };
    const guard = createGuard(options);
    guard.check({});
    const resumed = restoreGuard(guard.snapshot({ redact: true }), options);
    expect(resumed.check({})).toMatchObject({ stop: true, evidence: { textPreview: '' }, detail: expect.stringContaining('no text') as string });
  });

  it('redact is only honoured as the literal true', () => {
    const guard = busyGuard();
    expect(guard.snapshot({ redact: 'yes' as unknown as boolean })).toEqual(guard.toJSON());
    expect(guard.snapshot({})).toEqual(guard.toJSON());
    expect(guard.snapshot(null as unknown as undefined)).toEqual(guard.toJSON());
  });

  it('stays small: bounded by the options, not by the length of the run', () => {
    const rand = mulberry32(7);
    const run = (steps: number): number => {
      const guard = createGuard({ maxSteps: false, repeatedToolCall: {}, oscillation: {}, noProgress: {}, budget: { maxTotalTokens: 1e12 } });
      for (let i = 0; i < steps; i += 1) {
        guard.check({
          toolCalls: [call('tool', { n: i, blob: 'x'.repeat(2000) }, { result: { n: i, text: 'y'.repeat(3000) } })],
          text: `step ${i} ${'z'.repeat(500)}`,
          usage: { totalTokens: Math.floor(rand() * 100) },
        });
      }
      return JSON.stringify(guard.toJSON()).length;
    };
    const small = run(1500);
    const large = run(6000);
    expect(large).toBeLessThan(small * 1.05);
    expect(large).toBeLessThan(40 * 1024); // 1024 remembered outcomes at 31 bytes each, plus a few hundred bytes
  });
});
