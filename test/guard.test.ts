import { describe, expect, it, expectTypeOf } from 'vitest';
import { createGuard, explain, isFault } from '../src/index';
import type { CustomDetector, GuardStep, StopVerdict, Verdict } from '../src/index';
import { call, feed, firstStop, step } from './helpers';

describe('Guard basics', () => {
  it('returns { stop: false } for a quiet step', () => {
    expect(createGuard().check({ text: 'hi' })).toEqual({ stop: false });
    expect(createGuard().check({})).toEqual({ stop: false });
  });

  it('verdicts are JSON-serialisable and round-trip', () => {
    const guard = createGuard();
    const verdicts = feed(guard, Array.from({ length: 3 }, () => step(call('t', { a: 1 }))));
    const stop = verdicts[2] as Verdict;
    expect(stop.stop).toBe(true);
    expect(JSON.parse(JSON.stringify(stop))).toEqual(stop);
  });

  it('narrows verdict types by `reason`', () => {
    const v: Verdict = createGuard({ maxSteps: 1 }).check({});
    if (v.stop && v.reason === 'max-steps') {
      expectTypeOf(v.evidence.limit).toBeNumber();
      expect(v.evidence.limit).toBe(1);
    } else {
      throw new Error('expected a max-steps stop');
    }
    const w: Verdict = createGuard({ finishReason: {} }).check({ finishReason: 'length' });
    if (w.stop && w.reason === 'finish-reason') expectTypeOf(w.evidence.policy).toBeString();
  });

  it('tolerates non-object steps and malformed fields at runtime', () => {
    const guard = createGuard();
    const junk: unknown[] = [null, undefined, 42, 'text', [], { toolCalls: 'nope' }, { toolCalls: [null, 1, 'x', {}] }, { text: 5, finishReason: 7, usage: 'x' }];
    for (const j of junk) expect(() => guard.check(j as GuardStep)).not.toThrow();
    expect(guard.summary().steps).toBe(junk.length);
  });

  it('records the call even when the tool name is not a string', () => {
    const guard = createGuard();
    guard.check({ toolCalls: [{ name: 5 as unknown as string }] });
    expect(guard.summary().toolCalls).toBe(1);
  });
});

describe('priority and consistency', () => {
  it('a normal finish wins over everything else in the same step', () => {
    const guard = createGuard({ maxSteps: 1, budget: { maxTotalTokens: 1 } });
    const v = guard.check({ finishReason: 'stop', usage: { totalTokens: 5 } });
    expect(v).toMatchObject({ stop: true, reason: 'finish-reason' });
  });

  it('order is finish, budget, maxSteps, repeated, oscillation, noProgress, custom', () => {
    const base = { oscillation: false, noProgress: false, repeatedToolCall: false, finishReason: false, maxSteps: false } as const;
    // budget before maxSteps
    expect(
      createGuard({ ...base, maxSteps: 1, budget: { maxTotalTokens: 1 } }).check({ usage: { totalTokens: 1 } }),
    ).toMatchObject({ reason: 'budget' });
    // maxSteps before repeatedToolCall
    expect(
      createGuard({ ...base, maxSteps: 3, repeatedToolCall: { threshold: 3 } }).check(step(call('t'), call('t'), call('t'))),
    ).toMatchObject({ reason: 'repeated-tool-call' }); // only 1 step so far: maxSteps not reached
    const g = createGuard({ ...base, maxSteps: 3, repeatedToolCall: { threshold: 3 } });
    g.check({});
    g.check({});
    expect(g.check(step(call('t'), call('t'), call('t')))).toMatchObject({ reason: 'max-steps' });
    // repeated before custom
    expect(
      createGuard({ ...base, repeatedToolCall: { threshold: 2 }, custom: () => ({ stop: true }) }).check(step(call('t'), call('t'))),
    ).toMatchObject({ reason: 'repeated-tool-call' });
  });

  it('detectors keep tracking after another one has stopped the run', () => {
    // maxSteps stops at step 2, but repeatedToolCall must still have counted both calls.
    const guard = createGuard({ maxSteps: 2, repeatedToolCall: { threshold: 3 } });
    guard.check(step(call('t', 1)));
    expect(guard.check(step(call('t', 1)))).toMatchObject({ reason: 'max-steps' });
    expect(guard.summary().detectors.repeatedToolCall?.currentRun).toEqual({ tool: 't', length: 2 });
  });
});

describe('reset()', () => {
  it('clears history, totals, detector state and lastVerdict, and keeps the options', () => {
    const guard = createGuard({ maxSteps: 3, budget: { maxTotalTokens: 100 } });
    feed(guard, [
      { usage: { totalTokens: 10 }, toolCalls: [call('t', 1)], text: 'same' },
      { usage: { totalTokens: 10 }, toolCalls: [call('t', 1)], text: 'same' },
    ]);
    guard.reset();
    expect(guard.history).toEqual([]);
    const s = guard.summary();
    expect(s.steps).toBe(0);
    expect(s.toolCalls).toBe(0);
    expect(s.totals).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 });
    expect(s.lastVerdict).toBeNull();
    expect(s.detectors.repeatedToolCall).toMatchObject({ currentRun: null, longestRun: 0 });
    expect(s.detectors.noProgress?.streak).toBe(0);
    expect(s.detectors.maxSteps).toEqual({ limit: 3, remaining: 3 });
    // Options survive: three steps still stop at the third.
    const verdicts = feed(guard, [{}, {}, {}]);
    expect(firstStop(verdicts)).toBe(2);
  });

  it('a run after reset behaves exactly like a fresh guard', () => {
    const trace: GuardStep[] = [step(call('a', 1)), step(call('b', 2)), step(call('a', 1)), step(call('b', 2)), step(call('a', 1)), step(call('b', 2))];
    const used = createGuard();
    feed(used, trace);
    used.reset();
    expect(feed(used, trace)).toEqual(feed(createGuard(), trace));
  });
});

describe('history', () => {
  it('is a frozen copy: mutating it does not affect the guard', () => {
    const guard = createGuard();
    guard.check({ text: 'one' });
    const h = guard.history;
    expect(Object.isFrozen(h)).toBe(true);
    expect(() => (h as GuardStep[]).push({ text: 'x' })).toThrow();
    guard.check({ text: 'two' });
    expect(h).toHaveLength(1);
    expect(guard.history).toHaveLength(2);
    expect(guard.history.map((s) => s.text)).toEqual(['one', 'two']);
  });
});

describe('summary()', () => {
  it('reports counts, totals and per-detector state, and is JSON-serialisable', () => {
    const guard = createGuard({
      maxSteps: 10,
      budget: { maxTotalTokens: 1000, maxCostUsd: 2 },
      repeatedToolCall: { threshold: 4 },
    });
    guard.check({
      toolCalls: [call('search', { q: 1 }, { result: 'r' }), call('fetch', 'u', { error: 'boom' })],
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
      durationMs: 250,
      finishReason: 'tool-calls',
    });
    guard.check({ toolCalls: [call('fetch', 'u')], usage: { totalTokens: 50 }, durationMs: 100 });

    const s = guard.summary();
    expect(s.steps).toBe(2);
    expect(s.toolCalls).toBe(3);
    expect(s.failedToolCalls).toBe(1);
    expect(s.totals).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 170, costUsd: 0.01, durationMs: 350 });
    expect(s.detectors.maxSteps).toEqual({ limit: 10, remaining: 8 });
    expect(s.detectors.repeatedToolCall).toEqual({ threshold: 4, currentRun: { tool: 'fetch', length: 2 }, longestRun: 2 });
    expect(s.detectors.oscillation).toEqual({ maxPeriod: 3, repeats: 3, current: null });
    expect(s.detectors.noProgress).toEqual({ threshold: 3, streak: 0 });
    expect(s.detectors.finishReason).toEqual({ lastFinishReason: 'tool-calls' });
    expect(s.detectors.budget).toEqual({
      limits: { totalTokens: 1000, costUsd: 2 },
      used: { totalTokens: 170, inputTokens: 100, outputTokens: 20, costUsd: 0.01, durationMs: 350 },
    });
    expect(s.lastVerdict).toEqual({ stop: false });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('shows null for disabled detectors', () => {
    const s = createGuard({
      maxSteps: false,
      repeatedToolCall: false,
      oscillation: false,
      noProgress: false,
      finishReason: false,
    }).summary();
    expect(s.detectors).toEqual({
      maxSteps: null,
      repeatedToolCall: null,
      oscillation: null,
      noProgress: null,
      finishReason: null,
      budget: null,
    });
  });

  it('never contains wall-clock readings, so it is deterministic', () => {
    let clock = 0;
    const guard = createGuard({ budget: { maxDurationMs: 1_000_000 }, now: () => clock });
    clock = 5000;
    guard.check({ durationMs: 10 });
    const first = JSON.stringify(guard.summary());
    clock = 99_999;
    expect(JSON.stringify(guard.summary())).toBe(first);
    expect(guard.summary().detectors.budget?.used.durationMs).toBe(10);
  });

  it('exposes the current oscillation while it is being detected', () => {
    const guard = createGuard();
    feed(guard, ['a', 'b', 'a', 'b', 'a', 'b'].map((n) => step(call(n))));
    expect(guard.summary().detectors.oscillation?.current).toEqual({ period: 2, repeats: 3 });
  });
});

describe('custom detectors', () => {
  it('can stop the run, with a code, detail and evidence', () => {
    const forbidden: CustomDetector = (_history, s) =>
      s.toolCalls?.some((c) => c.name === 'rm')
        ? { stop: true, code: 'FORBIDDEN_TOOL', detail: 'The agent tried to call rm.', evidence: { tool: 'rm' } }
        : undefined;
    const guard = createGuard({ custom: forbidden });
    expect(guard.check(step(call('ls'))).stop).toBe(false);
    const v = guard.check(step(call('rm', '-rf')));
    expect(v).toEqual({
      stop: true,
      reason: 'custom',
      code: 'FORBIDDEN_TOOL',
      detail: 'The agent tried to call rm.',
      evidence: { tool: 'rm' },
    });
  });

  it('receives the whole history, current step last', () => {
    const seen: number[] = [];
    const last: GuardStep[] = [];
    const guard = createGuard({
      custom: (history, s) => {
        seen.push(history.length);
        last.push(history[history.length - 1] as GuardStep);
        expect(history[history.length - 1]).toBe(s);
        return undefined;
      },
    });
    guard.check({ text: 'a' });
    guard.check({ text: 'b' });
    expect(seen).toEqual([1, 2]);
    expect(last.map((s) => s.text)).toEqual(['a', 'b']);
  });

  it('fills in defaults for a minimal stop and ignores { stop: false }', () => {
    expect(createGuard({ custom: () => ({ stop: true }) }).check({})).toEqual({
      stop: true,
      reason: 'custom',
      code: 'CUSTOM',
      detail: 'Stopped by a custom detector.',
      evidence: null,
    });
    expect(createGuard({ custom: () => ({ stop: false }) }).check({}).stop).toBe(false);
  });

  it('accepts several detectors; the first to stop wins', () => {
    const guard = createGuard({
      custom: [() => undefined, () => ({ stop: true, code: 'SECOND' }), () => ({ stop: true, code: 'THIRD' })],
    });
    expect(guard.check({})).toMatchObject({ code: 'SECOND' });
  });

  it('lets errors from the detector propagate', () => {
    const guard = createGuard({
      custom: () => {
        throw new Error('detector bug');
      },
    });
    expect(() => guard.check({})).toThrow('detector bug');
  });
});

describe('explain() and isFault()', () => {
  it('describes continue and stop verdicts', () => {
    expect(explain({ stop: false })).toBe('Continue.');
    const text = explain(createGuard({ maxSteps: 1 }).check({}));
    expect(text).toContain('Stop [MAX_STEPS] Reached the limit of 1 steps.');
    expect(text).toContain('Hint:');
  });

  it('includes warnings', () => {
    const v = createGuard({ budget: { maxTotalTokens: { limit: 100, warnAt: 0.5 } } }).check({ usage: { totalTokens: 60 } });
    expect(explain(v)).toBe('Continue.\nWarning [BUDGET_WARNING] Budget warning: total tokens is at 60% of the 100 allowed (60 used).');
  });

  it.each([
    ['max-steps', createGuard({ maxSteps: 1 }).check({})],
    ['repeated-tool-call', createGuard({ repeatedToolCall: { threshold: 2 } }).check(step(call('t'), call('t')))],
    ['oscillation', feedLast(['a', 'b', 'a', 'b', 'a', 'b'])],
    ['no-progress', feedLast([undefined, undefined, undefined].map(() => 'x'), true)],
    ['finish-reason', createGuard().check({ finishReason: 'length' })],
    ['budget', createGuard({ budget: { maxTotalTokens: 1 } }).check({ usage: { totalTokens: 1 } })],
    ['custom', createGuard({ custom: () => ({ stop: true }) }).check({})],
  ] as Array<[string, Verdict]>)('gives a hint for %s', (reason, verdict) => {
    expect(verdict.stop && verdict.reason).toBe(reason);
    const text = explain(verdict);
    expect(text).toMatch(/^Stop \[[A-Z_]+\] .+\nHint: .+/);
  });

  it('isFault: a normal "stop" finish is not a fault, everything else that stops is', () => {
    expect(isFault({ stop: false })).toBe(false);
    expect(isFault(createGuard().check({ finishReason: 'stop' }))).toBe(false);
    expect(explain(createGuard().check({ finishReason: 'stop' }))).toContain('normal end of a run');
    expect(isFault(createGuard().check({ finishReason: 'length' }))).toBe(true);
    expect(isFault(createGuard().check({ finishReason: 'other', text: 'x' }))).toBe(true);
    expect(isFault(createGuard({ maxSteps: 1 }).check({}))).toBe(true);
    expectTypeOf(isFault).guards.toEqualTypeOf<StopVerdict>();
  });
});

/** Run steps through a default guard and return the final verdict. */
function feedLast(names: string[], textOnly = false): Verdict {
  const guard = createGuard();
  let v: Verdict = { stop: false };
  for (const n of names) v = guard.check(textOnly ? { text: n } : step(call(n)));
  return v;
}
