import { describe, expect, expectTypeOf, it } from 'vitest';
import { createGuard, explain, feedbackForWarning } from '../src/index';
import type { Guard, GuardOptions, GuardStep, GuardWarning, Verdict } from '../src/index';
import { call, feed, mulberry32, step } from './helpers';

/** Options that switch every detector off, so a test can enable exactly one. */
const ONLY: GuardOptions = {
  maxSteps: false,
  repeatedToolCall: false,
  oscillation: false,
  noProgress: false,
  finishReason: false,
};

const SECRET = 'SENTINEL-sk-live-5521';

const named = (names: string): GuardStep[] => [...names].map((n) => step(call(n, n)));
const codes = (v: Verdict): string[] => (v.warnings ?? []).map((w) => w.code);
const warningsOf = (verdicts: readonly Verdict[]): string[][] => verdicts.map(codes);

// ---------------------------------------------------------------------------
describe('warnings: off by default, so 0.2.0 code sees exactly what it saw before', () => {
  it('a run that would warn at every level carries no warnings and no warnings key', () => {
    const guard = createGuard({ tools: { t: { maxCalls: 4 } }, repeatedToolCall: { window: { size: 6, maxRepeats: 4 } } });
    const verdicts = feed(guard, [...named('tt'), { text: 'same' }, { text: 'same' }, ...named('ab'), ...named('ab')]);
    for (const v of verdicts) expect(v).not.toHaveProperty('warnings');
    expect(createGuard().check(step(call('t', 1)))).toEqual({ stop: false });
    expect(createGuard().preflight({ name: 't' })).toEqual({ allow: true });
  });

  it('options without warnAt, or with warnings: undefined, behave the same', () => {
    expect(codes(createGuard({ warnings: undefined }).check(step(call('t'), call('t'))))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('warnings: one step before each rule stops', () => {
  it('repeatedToolCall: warns on the call before the threshold, then stops', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {} });
    const verdicts = feed(guard, [1, 2, 3].map(() => step(call('search', { q: SECRET }))));
    expect(warningsOf(verdicts)).toEqual([[], ['REPEATED_TOOL_CALL_WARNING'], []]);
    expect(verdicts[2]?.stop).toBe(true);
    const w = (verdicts[1] as { warnings: GuardWarning[] }).warnings[0];
    expect(w).toMatchObject({
      code: 'REPEATED_TOOL_CALL_WARNING',
      evidence: { tool: 'search', count: 2, threshold: 3, identicalResults: false, stepIndexes: [0, 1] },
    });
    expect(w?.detail).toBe(`Tool "search" has been called 2 times in a row with identical arguments (the limit is 3): search({"q":"${SECRET}"}).`);
    expect(w?.feedback).toBe(
      'You have called `search` 2 times in a row with the same arguments. Calling it that way once more will stop this task. Try a different tool or different arguments, or answer with what you have.',
    );
  });

  it.each([3, 4, 6])('repeatedToolCall threshold %i: the warning is on the call at threshold - 1 only', (threshold) => {
    const verdicts = feed(createGuard({ ...ONLY, warnings: true, repeatedToolCall: { threshold } }), Array.from({ length: threshold }, () => step(call('t', 1))));
    expect(verdicts.map((v) => codes(v).length)).toEqual(Array.from({ length: threshold }, (_, i) => (i === threshold - 2 ? 1 : 0)));
  });

  it('repeatedToolCall at threshold 2 has no earlier step, so it never warns', () => {
    const verdicts = feed(createGuard({ ...ONLY, warnings: true, repeatedToolCall: { threshold: 2 } }), named('tt'));
    expect(warningsOf(verdicts)).toEqual([[], []]);
  });

  it('repeatedToolCall: a tool\'s own threshold and result-aware runs set the level', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {}, tools: { slow: { repeatThreshold: 5 }, poll: { polling: true } } });
    const slow = feed(guard, Array.from({ length: 5 }, () => step(call('slow', 1))));
    expect(warningsOf(slow)).toEqual([[], [], [], ['REPEATED_TOOL_CALL_WARNING'], []]);
    expect(slow[3]?.warnings?.[0]).toMatchObject({ evidence: { count: 4, threshold: 5 } });
    const poll = feed(createGuard({ ...ONLY, warnings: true, repeatedToolCall: {}, tools: { poll: { polling: true } } }), [1, 2, 3].map(() => step(call('poll', 1, { result: 'p' }))));
    expect(poll[1]?.warnings?.[0]).toMatchObject({ evidence: { identicalResults: true } });
    expect(poll[1]?.warnings?.[0]?.feedback).toContain('and got the same result each time');
  });

  it('windowed repeats: warns when a call is one short, even with other calls in between', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: { threshold: 9, window: { size: 8, maxRepeats: 3 } } });
    const verdicts = feed(guard, [step(call('s', 'x')), step(call('r', 1)), step(call('s', 'x')), step(call('r', 2)), step(call('s', 'x'))]);
    expect(warningsOf(verdicts)).toEqual([[], [], ['REPEATED_TOOL_CALL_WINDOW_WARNING'], [], []]);
    expect(verdicts[2]?.warnings?.[0]).toMatchObject({
      evidence: { tool: 's', count: 2, threshold: 3, windowSize: 8, windowCalls: 3 },
    });
    expect(verdicts[2]?.warnings?.[0]?.feedback).toBe(
      'You have called `s` 2 times with the same arguments within your last 8 calls, even with other calls in between. Calling it that way once more will stop this task. Try a different tool or different arguments, or answer with what you have.',
    );
    expect(verdicts[4]?.stop).toBe(true);
  });

  it('windowed repeats: a parallel step warns about the most repeated call it added', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: { window: { size: 10, maxRepeats: 4 } } });
    guard.check(step(call('a', 1), call('b', 1), call('b', 1)));
    const v = guard.check(step(call('b', 1), call('a', 1), call('c', 1)));
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings?.[0]).toMatchObject({ code: 'REPEATED_TOOL_CALL_WINDOW_WARNING', evidence: { tool: 'b', count: 3 } });
  });

  it('oscillation: warns when the cycle has been seen one time short of the limit', () => {
    const guard = createGuard({ ...ONLY, warnings: true, oscillation: {} });
    const verdicts = feed(guard, named('ababab'));
    expect(warningsOf(verdicts)).toEqual([[], [], [], ['OSCILLATION_WARNING'], ['OSCILLATION_WARNING'], []]);
    expect(verdicts[3]?.warnings?.[0]).toMatchObject({ evidence: { period: 2, repeats: 2, threshold: 3, tools: ['a', 'b'] } });
    expect(verdicts[3]?.warnings?.[0]?.feedback).toBe(
      'You may be going round in a cycle of calls (`a` and `b`). Going round once more will stop this task: try a different approach, or answer with what you have.',
    );
    expect(verdicts[5]?.stop).toBe(true);
  });

  it('noProgress: warns on the step before the threshold, from the streak alone', () => {
    const guard = createGuard({ ...ONLY, warnings: true, noProgress: {} });
    const verdicts = feed(guard, [{ text: `Still ${SECRET}` }, { text: 'still sentinel-sk-live-5521' }, { text: 'Still SENTINEL-sk-live-5521' }]);
    expect(warningsOf(verdicts)).toEqual([[], ['NO_PROGRESS_WARNING'], []]);
    expect(verdicts[1]?.warnings?.[0]).toMatchObject({ evidence: { steps: 2, threshold: 3 } });
    expect(verdicts[1]?.warnings?.[0]?.feedback).toBe(
      'Your last 2 steps added nothing new: no new tool results and the same text. One more step like that will stop this task. Do something different, such as using another tool or approach, or answer with what you have.',
    );
    // New text, or a new outcome, ends the streak and the warning with it.
    const fresh = feed(createGuard({ ...ONLY, warnings: true, noProgress: {} }), [{ text: 'a' }, { text: 'a' }, { text: 'b' }]);
    expect(warningsOf(fresh)).toEqual([[], ['NO_PROGRESS_WARNING'], []]);
  });

  it('tool caps: warns while the cap is almost or just used up, and the next call stops', () => {
    const guard = createGuard({ ...ONLY, warnings: true, tools: { search: { maxCalls: 3 } } });
    const verdicts = feed(guard, [1, 2, 3, 4].map((i) => step(call('search', i))));
    expect(warningsOf(verdicts)).toEqual([[], ['TOOL_CALL_CAP_WARNING'], ['TOOL_CALL_CAP_WARNING'], []]);
    expect(verdicts[1]?.warnings?.[0]).toMatchObject({ evidence: { tool: 'search', calls: 2, limit: 3 } });
    expect(verdicts[1]?.warnings?.[0]?.feedback).toBe(
      'You have used `search` 2 of the 3 times allowed for it in this task (1 left). Use the rest sparingly, or answer with what you have.',
    );
    expect(verdicts[2]?.warnings?.[0]?.feedback).toBe(
      'You have used `search` 3 times, the most allowed for it in this task. Do not call it again; use a different tool, or answer with what you have.',
    );
    expect(verdicts[3]).toMatchObject({ stop: true, code: 'TOOL_CALL_CAP' });
  });

  it('tool caps: maxCalls 1 warns on the first call, maxCalls 0 never warns, other tools are not mentioned', () => {
    const one = feed(createGuard({ ...ONLY, warnings: true, tools: { t: { maxCalls: 1 } } }), [step(call('t')), step(call('o'))]);
    expect(warningsOf(one)).toEqual([['TOOL_CALL_CAP_WARNING'], []]);
    expect(codes(createGuard({ ...ONLY, warnings: true, tools: { t: { maxCalls: 0 } } }).check(step(call('t'))))).toEqual([]);
  });

  it('a step carries the warnings of every rule that is one short, and of a rule that stops, in the verdict', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {}, oscillation: {}, tools: { t: { maxCalls: 2 } } });
    guard.check(step(call('t', 1)));
    const v = guard.check(step(call('t', 1)));
    expect(codes(v)).toEqual(['TOOL_CALL_CAP_WARNING', 'REPEATED_TOOL_CALL_WARNING']);
    const stop = guard.check(step(call('t', 1)));
    expect(stop).toMatchObject({ stop: true, code: 'TOOL_CALL_CAP' });
    expect(stop.warnings).toBeUndefined(); // the repeat rule stopped too, the cap rule is over its limit: nothing is one short
  });
});

// ---------------------------------------------------------------------------
describe('warnings: when one is raised', () => {
  it('only on a step that adds to what it warns about: a text-only step after it carries none', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {}, tools: { t: { maxCalls: 5 } } });
    guard.check(step(call('t', 1)));
    expect(codes(guard.check(step(call('t', 1))))).toContain('REPEATED_TOOL_CALL_WARNING');
    expect(guard.check({ text: 'thinking' })).toEqual({ stop: false });
    expect(codes(guard.check(step(call('other', 1))))).toEqual([]);
  });

  it('ignored tools never raise a warning, and are left out of the counts that do', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {}, tools: { think: { ignore: true } } });
    const verdicts = feed(guard, [step(call('think', 1)), step(call('t', 1)), step(call('think', 1)), step(call('think', 1)), step(call('t', 1))]);
    expect(warningsOf(verdicts)).toEqual([[], [], [], [], ['REPEATED_TOOL_CALL_WARNING']]);
  });

  it('failed calls left out by ignoreErrors do not warn either', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: { ignoreErrors: true } });
    const verdicts = feed(guard, [step(call('t', 1)), step(call('t', 1, { error: 'x' })), step(call('t', 1, { error: 'x' }))]);
    expect(warningsOf(verdicts)).toEqual([[], [], []]);
  });
});

// ---------------------------------------------------------------------------
describe('warnings: switching them on and off', () => {
  const trace = named('ababab');

  it('warnAt: a number turns that rule on by itself, at that level', () => {
    const options: GuardOptions = { ...ONLY, oscillation: { repeats: 5, warnAt: 2 } };
    const verdicts = feed(createGuard(options), named('abababab'));
    expect(warningsOf(verdicts)).toEqual([[], [], [], ['OSCILLATION_WARNING'], ['OSCILLATION_WARNING'], ['OSCILLATION_WARNING'], ['OSCILLATION_WARNING'], ['OSCILLATION_WARNING']]);
    expect(codes(createGuard({ ...ONLY, repeatedToolCall: {} }).check(step(call('t'), call('t'))))).toEqual([]);
  });

  it.each([
    ['repeatedToolCall', { repeatedToolCall: { threshold: 5, warnAt: 2 } }, ['REPEATED_TOOL_CALL_WARNING', 'REPEATED_TOOL_CALL_WARNING', 'REPEATED_TOOL_CALL_WARNING']],
    ['noProgress', { noProgress: { threshold: 5, warnAt: 3 } }, ['NO_PROGRESS_WARNING', 'NO_PROGRESS_WARNING']],
    ['a tool cap', { tools: { t: { maxCalls: 5, warnAt: 4 } } }, ['TOOL_CALL_CAP_WARNING', 'TOOL_CALL_CAP_WARNING']],
    ['the window', { repeatedToolCall: { window: { size: 20, maxRepeats: 6, warnAt: 4 }, threshold: 20 } }, ['REPEATED_TOOL_CALL_WINDOW_WARNING', 'REPEATED_TOOL_CALL_WINDOW_WARNING']],
  ] as Array<[string, GuardOptions, string[]]>)('warnAt on %s sets where the warning starts', (_name, extra, expected) => {
    const options: GuardOptions = { ...ONLY, ...extra };
    const steps: GuardStep[] = Array.from({ length: 5 }, () => ({ text: 'same', toolCalls: [call('t', 1)] }));
    const found = feed(createGuard(options), steps).flatMap(codes);
    expect(found.slice(0, expected.length)).toEqual(expected);
  });

  it('warnAt: false turns one rule off while warnings: true keeps the others', () => {
    const options: GuardOptions = { ...ONLY, warnings: true, oscillation: { warnAt: false }, repeatedToolCall: {} };
    const found = feed(createGuard(options), trace).flatMap(codes);
    expect(found).toEqual([]);
    const both = feed(createGuard({ ...options, oscillation: {} }), trace).flatMap(codes);
    expect(both).toContain('OSCILLATION_WARNING');
    const capOff = createGuard({ ...ONLY, warnings: true, tools: { t: { maxCalls: 2, warnAt: false } } });
    expect(codes(capOff.check(step(call('t'), call('t'))))).toEqual([]);
  });

  it('warnings: false silences everything, budget warnings and explicit warnAt included', () => {
    const options: GuardOptions = {
      ...ONLY,
      warnings: false,
      oscillation: { warnAt: 2 },
      budget: { maxTotalTokens: { limit: 100, warnAt: 0.5 } },
    };
    const verdicts = feed(createGuard(options), [...named('abab'), { usage: { totalTokens: 60 } }]);
    for (const v of verdicts) expect(v).not.toHaveProperty('warnings');
    expect(createGuard({ ...options, warnings: undefined }).check({ usage: { totalTokens: 60 } }).warnings).toHaveLength(1);
    const pre = createGuard({ ...options, warnings: false });
    pre.check({ usage: { totalTokens: 60 } });
    expect(pre.preflight({ name: 't' })).toEqual({ allow: true });
  });

  it('warnings: true leaves budget warnings alone: they still need their own warnAt', () => {
    const quiet = createGuard({ ...ONLY, warnings: true, budget: { maxTotalTokens: 100 } });
    expect(quiet.check({ usage: { totalTokens: 90 } })).toEqual({ stop: false });
    const loud = createGuard({ ...ONLY, warnings: true, budget: { maxTotalTokens: { limit: 100, warnAt: 0.5 } } });
    expect(codes(loud.check({ usage: { totalTokens: 90 } }))).toEqual(['BUDGET_WARNING']);
  });

  it('reports a bad setting from createGuard', () => {
    const bad = (options: unknown): (() => void) => () => createGuard(options as GuardOptions);
    expect(bad({ warnings: 'yes' })).toThrow(/warnings must be a boolean, got yes/);
    expect(bad({ warnings: 1 })).toThrow(TypeError);
    expect(bad({ repeatedToolCall: { warnAt: 3 } })).toThrow(/repeatedToolCall\.warnAt must be false or an integer from 2 to 2, got 3/);
    expect(bad({ repeatedToolCall: { threshold: 2, warnAt: 2 } })).toThrow(/must be false or omitted: the rule already stops at 2/);
    expect(bad({ repeatedToolCall: { warnAt: 1 } })).toThrow(/integer from 2 to 2/);
    expect(bad({ repeatedToolCall: { warnAt: 2.5, threshold: 9 } })).toThrow(/warnAt/);
    expect(bad({ repeatedToolCall: { warnAt: '2' } })).toThrow(/warnAt/);
    expect(bad({ repeatedToolCall: { window: { size: 5, maxRepeats: 3, warnAt: 3 } } })).toThrow(/window\.warnAt must be false or an integer from 2 to 2/);
    expect(bad({ oscillation: { warnAt: 3 } })).toThrow(/oscillation\.warnAt must be false or an integer from 2 to 2/);
    expect(bad({ noProgress: { warnAt: 3 } })).toThrow(/noProgress\.warnAt/);
    expect(bad({ tools: { t: { maxCalls: 3, warnAt: 4 } } })).toThrow(/tools\["t"\]\.warnAt must be an integer from 1 to 3, got 4/);
    expect(bad({ tools: { t: { maxCalls: 3, warnAt: 0 } } })).toThrow(/tools\["t"\]\.warnAt/);
    expect(bad({ tools: { t: { warnAt: 2 } } })).toThrow(/tools\["t"\]\.warnAt needs maxCalls/);
    expect(bad({ tools: { t: { maxCalls: 3, warnAt: 'x' } } })).toThrow(/warnAt must be false or an integer from 1 to maxCalls, got x/);
    expect(bad({ tools: { t: { maxCalls: 0, warnAt: 1 } } })).toThrow(/warnAt/);
    expect(bad({ repeatedToolCall: { warnAt: 2, threshold: 3 }, tools: { t: { maxCalls: 3, warnAt: 3 }, u: { ignore: true, warnAt: 5 } } })).not.toThrow();
    expect(bad({ tools: { t: { warnAt: false } } })).not.toThrow();
  });

  it('warnAt is not part of the snapshot fingerprint: it never changes a stop', () => {
    const a = createGuard({ warnings: true, oscillation: { warnAt: 2, repeats: 4 }, tools: { t: { maxCalls: 4, warnAt: 2 } } }).toJSON();
    const b = createGuard({ oscillation: { repeats: 4 }, tools: { t: { maxCalls: 4 } } }).toJSON();
    expect(a.options).toEqual(b.options);
  });
});

// ---------------------------------------------------------------------------
describe('warnings: preflight', () => {
  it('an allowed call that would reach the warning level comes back with the warning, and nothing is recorded', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {} });
    guard.check(step(call('search', { q: 1 })));
    const before = JSON.stringify(guard.toJSON());
    const pre = guard.preflight({ name: 'search', args: { q: 1 } });
    expect(pre).toMatchObject({ allow: true, warnings: [{ code: 'REPEATED_TOOL_CALL_WARNING', evidence: { count: 2, threshold: 3 } }] });
    expect(JSON.stringify(guard.toJSON())).toBe(before);
    expect(guard.preflight({ name: 'search', args: { q: 2 } })).toEqual({ allow: true });
    expect(guard.preflight({ name: 'search', args: { q: 1 } }).allow).toBe(true);
  });

  it('carries the cap, window and oscillation warnings too, next to budget warnings, in the order check uses', () => {
    const guard = createGuard({
      ...ONLY,
      warnings: true,
      budget: { maxTotalTokens: { limit: 100, warnAt: 0.5 } },
      tools: { t: { maxCalls: 3 } },
      repeatedToolCall: { threshold: 9, window: { size: 6, maxRepeats: 3 } },
    });
    guard.check({ toolCalls: [call('t', 1), call('o', 1)], usage: { totalTokens: 60 } });
    const pre = guard.preflight({ name: 't', args: 1 });
    expect(pre.allow && pre.warnings?.map((w) => w.code)).toEqual(['BUDGET_WARNING', 'TOOL_CALL_CAP_WARNING', 'REPEATED_TOOL_CALL_WINDOW_WARNING']);
  });

  it('a denial carries no warnings, and noProgress is never judged', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {}, noProgress: {} });
    guard.check(step(call('t', 1)));
    guard.check(step(call('t', 1)));
    expect(guard.preflight({ name: 't', args: 1 })).not.toHaveProperty('warnings');
    expect(guard.preflight({ name: 'u' })).toEqual({ allow: true });
  });

  it('agrees with check (property): the warnings preflight announces are the ones the call then carries', () => {
    const names = ['a', 'b', 'c'];
    let compared = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const rand = mulberry32(seed * 977);
      const makeOptions = (): GuardOptions => ({
        ...ONLY,
        warnings: true,
        repeatedToolCall: { threshold: 4, window: { size: 7, maxRepeats: 3 } },
        oscillation: { repeats: 4 },
        tools: { c: { maxCalls: 6 } },
      });
      const guard = createGuard(makeOptions());
      for (let i = 0; i < 30; i += 1) {
        const calls = Array.from({ length: 1 + Math.floor(rand() * 2) }, () => ({ name: names[Math.floor(rand() * 3)] as string, args: Math.floor(rand() * 2) }));
        const pre = guard.preflight(calls);
        const verdict = guard.check({ toolCalls: calls });
        if (pre.allow && !verdict.stop) {
          expect((pre.warnings ?? []).map((w) => w.code)).toEqual(codes(verdict));
          expect(pre.warnings ?? []).toEqual(verdict.warnings ?? []);
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
describe('warnings: what is safe to send to the model', () => {
  const everything = (): Guard =>
    createGuard({
      warnings: true,
      repeatedToolCall: { window: { size: 10, maxRepeats: 4 } },
      oscillation: { repeats: 4 },
      noProgress: { threshold: 4 },
      tools: { 'bad name with spaces': { maxCalls: 3 }, ok_tool: { maxCalls: 3 } },
    });

  it('feedback never contains arguments, results or text, and unusual tool names become "that tool"', () => {
    const guard = everything();
    const secretCall = (name: string) => call(name, { token: SECRET }, { result: SECRET });
    const all: GuardWarning[] = [];
    for (let i = 0; i < 6; i += 1) {
      const v = guard.check({ text: SECRET, toolCalls: [secretCall('bad name with spaces'), secretCall('ok_tool'), secretCall(i % 2 === 0 ? 'x' : 'y')] });
      all.push(...(v.warnings ?? []));
    }
    expect(new Set(all.map((w) => w.code)).size).toBeGreaterThanOrEqual(3);
    for (const w of all) {
      expect((w.feedback ?? '').toLowerCase()).not.toContain('sentinel');
      expect(w.feedback).not.toContain('bad name with spaces');
      expect(feedbackForWarning(w)).toBe(w.feedback);
    }
    const cap = all.find((w) => w.code === 'TOOL_CALL_CAP_WARNING' && w.evidence.tool === 'bad name with spaces');
    expect(cap?.feedback).toContain('that tool');
    expect(all.some((w) => w.detail.includes(SECRET))).toBe(true); // the developer-facing detail does show previews
  });

  it('a long or odd name never reaches the model', () => {
    const long = 'x'.repeat(65);
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {} });
    guard.check(step(call(long, 1)));
    const v = guard.check(step(call(long, 1)));
    expect(v.warnings?.[0]?.feedback).toContain('You have called that tool 2 times');
  });

  it('feedbackForWarning words a budget warning from counts only', () => {
    const v = createGuard({ budget: { maxTotalTokens: { limit: 100, warnAt: 0.5 } } }).check({ usage: { totalTokens: 60 } });
    const warning = v.warnings?.[0] as GuardWarning;
    expect(feedbackForWarning(warning)).toBe('The token budget for this task is 60% used. Plan to wrap up soon, and answer with what you have when you can.');
    expect(warning).not.toHaveProperty('feedback'); // the 0.2.0 shape is unchanged
  });
});

// ---------------------------------------------------------------------------
describe('warnings: shape and types', () => {
  it('are JSON-safe, and explain() prints them', () => {
    const v = feed(createGuard({ ...ONLY, warnings: true, repeatedToolCall: {} }), named('tt'))[1] as Verdict;
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    expect(explain(v)).toBe('Continue.\nWarning [REPEATED_TOOL_CALL_WARNING] Tool "t" has been called 2 times in a row with identical arguments (the limit is 3): t("t").');
  });

  it('stay readable as in 0.2.0 (metric and value exist on every warning) and narrow by code', () => {
    const w = {} as GuardWarning;
    expectTypeOf(w.metric).toEqualTypeOf<'totalTokens' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'durationMs' | undefined>();
    expectTypeOf(w.value).toEqualTypeOf<number | undefined>();
    if (w.code === 'BUDGET_WARNING') expectTypeOf(w.ratio).toBeNumber();
    if (w.code === 'TOOL_CALL_CAP_WARNING') expectTypeOf(w.evidence.calls).toBeNumber();
    if (w.code === 'OSCILLATION_WARNING') expectTypeOf(w.evidence.cycle).toEqualTypeOf<string[]>();
    expectTypeOf(w.detail).toBeString();
  });
});
