import { describe, expect, it } from 'vitest';
import { createGuard } from '../src/index';
import type { BudgetOptions, GuardOptions, GuardStep } from '../src/index';
import { feed, firstStop } from './helpers';

const OFF: GuardOptions = {
  maxSteps: false,
  repeatedToolCall: false,
  oscillation: false,
  noProgress: false,
  finishReason: false,
};
const withBudget = (budget: BudgetOptions, extra: GuardOptions = {}): GuardOptions => ({ ...OFF, budget, ...extra });
const tokens = (total: number): GuardStep => ({ usage: { totalTokens: total } });

describe('budget limits', () => {
  // [option, usage per step, steps needed to reach the limit, code, metric]
  const cases = [
    { option: 'maxTotalTokens', usage: { totalTokens: 400 }, limit: 1000, stopsAt: 3, code: 'BUDGET_TOTAL_TOKENS', metric: 'totalTokens' },
    { option: 'maxInputTokens', usage: { inputTokens: 300 }, limit: 900, stopsAt: 3, code: 'BUDGET_INPUT_TOKENS', metric: 'inputTokens' },
    { option: 'maxOutputTokens', usage: { outputTokens: 50 }, limit: 200, stopsAt: 4, code: 'BUDGET_OUTPUT_TOKENS', metric: 'outputTokens' },
    { option: 'maxCostUsd', usage: { costUsd: 0.25 }, limit: 1, stopsAt: 4, code: 'BUDGET_COST_USD', metric: 'costUsd' },
  ] as const;

  it.each(cases)('$option stops the step it is reached on (value >= limit), not before', (c) => {
    const guard = createGuard(withBudget({ [c.option]: c.limit }));
    const verdicts = feed(guard, Array.from({ length: c.stopsAt + 2 }, () => ({ usage: c.usage })));
    expect(firstStop(verdicts)).toBe(c.stopsAt - 1);
    const v = verdicts[c.stopsAt - 1];
    expect(v).toMatchObject({ stop: true, reason: 'budget', code: c.code });
    expect(v && v.stop && v.evidence).toMatchObject({ metric: c.metric, limit: c.limit });
  });

  it('reaching the limit exactly stops; one short does not', () => {
    expect(createGuard(withBudget({ maxTotalTokens: 100 })).check(tokens(99)).stop).toBe(false);
    expect(createGuard(withBudget({ maxTotalTokens: 100 })).check(tokens(100)).stop).toBe(true);
    expect(createGuard(withBudget({ maxTotalTokens: 100 })).check(tokens(101)).stop).toBe(true);
  });

  it('maxDurationMs sums step durations', () => {
    const guard = createGuard(withBudget({ maxDurationMs: 1000 }, { now: () => 0 }));
    const verdicts = feed(guard, [{ durationMs: 400 }, { durationMs: 400 }, { durationMs: 200 }]);
    expect(firstStop(verdicts)).toBe(2);
    expect(verdicts[2]).toMatchObject({ code: 'BUDGET_DURATION_MS', evidence: { metric: 'durationMs', value: 1000, limit: 1000 } });
  });

  it('maxDurationMs also watches the wall clock through the injected now()', () => {
    let clock = 10_000;
    const guard = createGuard(withBudget({ maxDurationMs: 5000 }, { now: () => clock }));
    expect(guard.check({}).stop).toBe(false);
    clock += 4999;
    expect(guard.check({}).stop).toBe(false);
    clock += 1;
    const v = guard.check({});
    expect(v).toMatchObject({ stop: true, code: 'BUDGET_DURATION_MS', evidence: { value: 5000 } });
  });

  it('uses the larger of summed durations and wall-clock time', () => {
    let clock = 0;
    const guard = createGuard(withBudget({ maxDurationMs: 1000 }, { now: () => clock }));
    clock = 100; // wall clock says 100ms, steps say 900ms
    expect(guard.check({ durationMs: 900 }).stop).toBe(false);
    clock = 200;
    expect(guard.check({ durationMs: 100 }).stop).toBe(true); // 1000 summed
  });

  it('reset() restarts the wall clock', () => {
    let clock = 0;
    const guard = createGuard(withBudget({ maxDurationMs: 100 }, { now: () => clock }));
    clock = 150;
    expect(guard.check({}).stop).toBe(true);
    guard.reset();
    expect(guard.check({}).stop).toBe(false);
    clock = 249;
    expect(guard.check({}).stop).toBe(false);
    clock = 250;
    expect(guard.check({}).stop).toBe(true);
  });

  it('does not read the clock when there is no duration limit', () => {
    let reads = 0;
    const guard = createGuard(withBudget({ maxTotalTokens: 10 }, { now: () => ++reads }));
    const readsAfterCreate = reads;
    guard.check({});
    guard.check({});
    expect(reads).toBe(readsAfterCreate);
  });

  it('derives total tokens from input + output when no total is given', () => {
    const guard = createGuard(withBudget({ maxTotalTokens: 100 }));
    expect(guard.check({ usage: { inputTokens: 60 } }).stop).toBe(false);
    expect(guard.check({ usage: { outputTokens: 40 } }).stop).toBe(true);
  });

  it('prefers an explicit total over input + output', () => {
    const guard = createGuard(withBudget({ maxTotalTokens: 100 }));
    expect(guard.check({ usage: { inputTokens: 500, outputTokens: 500, totalTokens: 10 } }).stop).toBe(false);
    expect(guard.summary().totals).toMatchObject({ totalTokens: 10, inputTokens: 500, outputTokens: 500 });
  });

  it('ignores unusable numbers instead of poisoning the totals', () => {
    const guard = createGuard(withBudget({ maxTotalTokens: 100 }));
    const junk = [NaN, Infinity, -5, '30' as unknown as number, null as unknown as number, undefined];
    for (const totalTokens of junk) expect(guard.check({ usage: { totalTokens } }).stop).toBe(false);
    expect(guard.summary().totals.totalTokens).toBe(0);
    expect(guard.check({ usage: { totalTokens: 100 } }).stop).toBe(true);
  });

  it('reports the first limit hit in a fixed order when several are hit at once', () => {
    const guard = createGuard(withBudget({ maxCostUsd: 1, maxTotalTokens: 10 }));
    const v = guard.check({ usage: { totalTokens: 10, costUsd: 1 } });
    expect(v).toMatchObject({ stop: true, code: 'BUDGET_TOTAL_TOKENS' });
  });

  it('accepts the { limit, warnAt } form', () => {
    const guard = createGuard(withBudget({ maxTotalTokens: { limit: 100 } }));
    expect(guard.check(tokens(100)).stop).toBe(true);
  });

  it.each([
    [{ maxTotalTokens: 0 }],
    [{ maxTotalTokens: -1 }],
    [{ maxCostUsd: NaN }],
    [{ maxInputTokens: Infinity }],
    [{ maxOutputTokens: { limit: 0 } }],
    [{ maxTotalTokens: 10, warnAt: 1 }],
    [{ maxTotalTokens: 10, warnAt: 0 }],
    [{ maxTotalTokens: { limit: 10, warnAt: 1.5 } }],
  ] as Array<[BudgetOptions]>)('rejects invalid options %j', (options) => {
    expect(() => createGuard({ budget: options })).toThrow(TypeError);
  });

  it('is off unless a budget is configured, and can be disabled explicitly', () => {
    expect(createGuard({ ...OFF }).check(tokens(1e12)).stop).toBe(false);
    expect(createGuard({ ...OFF, budget: false }).check(tokens(1e12)).stop).toBe(false);
    expect(createGuard({ ...OFF, budget: {} }).check(tokens(1e12)).stop).toBe(false);
  });
});

describe('budget warnings', () => {
  it('returns a non-stopping verdict with warnings once warnAt is passed', () => {
    const guard = createGuard(withBudget({ maxTotalTokens: { limit: 1000, warnAt: 0.8 } }));
    expect(guard.check(tokens(700))).toEqual({ stop: false });
    const v = guard.check(tokens(100)); // 800 / 1000
    expect(v).toEqual({
      stop: false,
      warnings: [
        {
          code: 'BUDGET_WARNING',
          metric: 'totalTokens',
          value: 800,
          limit: 1000,
          ratio: 0.8,
          detail: 'Budget warning: total tokens is at 80% of the 1000 allowed (800 used).',
        },
      ],
    });
  });

  it('warns on every step while in the warning zone, then stops at the limit', () => {
    const guard = createGuard(withBudget({ maxTotalTokens: { limit: 100, warnAt: 0.5 } }));
    const verdicts = feed(guard, [tokens(40), tokens(20), tokens(20), tokens(20)]); // 40, 60, 80, 100
    expect(verdicts.map((v) => v.stop)).toEqual([false, false, false, true]);
    expect(verdicts.map((v) => v.warnings?.length ?? 0)).toEqual([0, 1, 1, 0]);
  });

  it('uses the shared default warnAt and lets a limit override it', () => {
    const guard = createGuard(
      withBudget({ warnAt: 0.5, maxTotalTokens: 100, maxCostUsd: { limit: 10, warnAt: 0.9 } }),
    );
    const v = guard.check({ usage: { totalTokens: 60, costUsd: 6 } });
    expect(v.stop).toBe(false);
    expect(v.warnings?.map((w) => w.metric)).toEqual(['totalTokens']);
  });

  it('never warns without a warnAt', () => {
    const guard = createGuard(withBudget({ maxTotalTokens: 100 }));
    expect(guard.check(tokens(99))).toEqual({ stop: false });
  });

  it('attaches warnings for other metrics to a stop verdict', () => {
    const guard = createGuard(withBudget({ maxTotalTokens: 100, maxCostUsd: { limit: 1, warnAt: 0.5 } }));
    const v = guard.check({ usage: { totalTokens: 100, costUsd: 0.6 } });
    expect(v.stop).toBe(true);
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings?.[0]).toMatchObject({ metric: 'costUsd', ratio: 0.6 });
  });

  it('warns about duration', () => {
    const guard = createGuard(withBudget({ maxDurationMs: { limit: 1000, warnAt: 0.5 } }, { now: () => 0 }));
    const v = guard.check({ durationMs: 600 });
    expect(v.warnings?.[0]).toMatchObject({ metric: 'durationMs', value: 600 });
  });
});
