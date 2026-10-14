import { describe, expect, expectTypeOf, it } from 'vitest';
import { createGuard } from '../src/index';
import type { Guard, GuardOptions, GuardStep, GuardToolCall, Preflight, PreflightDeny } from '../src/index';
import { call, feed, mulberry32, step } from './helpers';

/** Options that switch every detector off, so a test can enable exactly one. */
const ONLY: GuardOptions = {
  maxSteps: false,
  repeatedToolCall: false,
  oscillation: false,
  noProgress: false,
  finishReason: false,
};

function denied(result: Preflight): PreflightDeny {
  if (result.allow) throw new Error('expected a denial');
  return result;
}

const same = (name: string, n: number, args: unknown = { q: 1 }): GuardStep[] => Array.from({ length: n }, () => step(call(name, args)));

// ---------------------------------------------------------------------------
describe('preflight: repeated calls', () => {
  const only = (threshold?: number): GuardOptions => ({ ...ONLY, repeatedToolCall: threshold === undefined ? {} : { threshold } });

  it.each([2, 3, 4, 6])('threshold %i: allowed after N-2 identical calls, denied after N-1', (n) => {
    const guard = createGuard(only(n));
    feed(guard, same('search', n - 2));
    expect(guard.preflight({ name: 'search', args: { q: 1 } })).toEqual({ allow: true });
    feed(guard, same('search', 1));
    const deny = denied(guard.preflight({ name: 'search', args: { q: 1 } }));
    expect(deny.reason).toBe('repeated-tool-call');
    expect(deny.code).toBe('REPEATED_TOOL_CALL');
    expect(deny.evidence).toMatchObject({ tool: 'search', count: n, threshold: n, identicalResults: false });
    expect(deny.detail).toContain(`call ${n} in a row`);
  });

  it('is about the same call: other arguments or another tool are fine', () => {
    const guard = createGuard(only());
    feed(guard, same('search', 2));
    expect(guard.preflight({ name: 'search', args: { q: 2 } }).allow).toBe(true);
    expect(guard.preflight({ name: 'read', args: { q: 1 } }).allow).toBe(true);
    expect(guard.preflight({ name: 'search' }).allow).toBe(true);
    expect(guard.preflight({ name: 'search', args: { q: 1 } }).allow).toBe(false);
  });

  it('ignores argument key order, like check', () => {
    const guard = createGuard(only());
    feed(guard, [step(call('t', { a: 1, b: 2 })), step(call('t', { b: 2, a: 1 }))]);
    expect(guard.preflight({ name: 't', args: { a: 1, b: 2 } }).allow).toBe(false);
  });

  it('counts a run made of calls that came back with results (the key is the call, not the outcome)', () => {
    const guard = createGuard(only());
    feed(guard, [step(call('t', 1, { result: 'a' })), step(call('t', 1, { result: 'b' }))]);
    expect(guard.preflight({ name: 't', args: 1 }).allow).toBe(false);
  });

  it('a different call in between resets the run', () => {
    const guard = createGuard(only());
    feed(guard, [...same('t', 2), step(call('other', 1))]);
    expect(guard.preflight({ name: 't', args: { q: 1 } }).allow).toBe(true);
  });

  it('honours ignoreErrors: failed calls are not part of the run', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { ignoreErrors: true } });
    feed(guard, [step(call('t', 1)), step(call('t', 1, { error: 'x' })), step(call('t', 1, { error: 'x' }))]);
    expect(guard.preflight({ name: 't', args: 1 }).allow).toBe(true); // only one successful call so far
    feed(guard, [step(call('t', 1))]);
    expect(guard.preflight({ name: 't', args: 1 }).allow).toBe(false);
  });

  it('uses a tool\'s own repeatThreshold', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: {}, tools: { slow: { repeatThreshold: 5 }, fast: { repeatThreshold: 2 } } });
    feed(guard, [...same('slow', 3), ...same('fast', 1)]);
    expect(guard.preflight({ name: 'fast', args: { q: 1 } }).allow).toBe(false);
    const slow = createGuard({ ...ONLY, repeatedToolCall: {}, tools: { slow: { repeatThreshold: 5 } } });
    feed(slow, same('slow', 3));
    expect(slow.preflight({ name: 'slow', args: { q: 1 } }).allow).toBe(true);
    feed(slow, same('slow', 1));
    expect(denied(slow.preflight({ name: 'slow', args: { q: 1 } })).evidence).toMatchObject({ count: 5, threshold: 5 });
  });

  it('is off when repeatedToolCall is disabled', () => {
    const guard = createGuard(ONLY);
    feed(guard, same('t', 10));
    expect(guard.preflight({ name: 't', args: { q: 1 } }).allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('preflight: rules that need results are never judged before the call runs', () => {
  it('requireIdenticalResults: even a long run of identical outcomes is allowed (the call might return something new)', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { requireIdenticalResults: true } });
    feed(guard, Array.from({ length: 2 }, () => step(call('t', 1, { result: 'same' }))));
    expect(guard.preflight({ name: 't', args: 1 }).allow).toBe(true);
    // ...and check() does still stop it once the third identical outcome is in.
    expect(guard.check(step(call('t', 1, { result: 'same' }))).stop).toBe(true);
    expect(guard.preflight({ name: 't', args: 1 }).allow).toBe(true);
  });

  it('a polling tool: same', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: {}, tools: { poll: { polling: true } } });
    feed(guard, Array.from({ length: 5 }, () => step(call('poll', 1, { result: 'pending' }))));
    expect(guard.preflight({ name: 'poll', args: 1 }).allow).toBe(true);
    expect(guard.preflight([{ name: 'poll', args: 1 }, { name: 'poll', args: 1 }, { name: 'poll', args: 1 }]).allow).toBe(true);
  });

  it('other tools in the same guard are still judged', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: {}, tools: { poll: { polling: true } } });
    feed(guard, same('search', 2));
    expect(guard.preflight({ name: 'search', args: { q: 1 } }).allow).toBe(false);
  });

  it('a result-aware pending call breaks the run it would have joined', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 2 }, tools: { poll: { polling: true } } });
    feed(guard, same('x', 1));
    // poll is unknowable, so it counts as a fresh run of one; the x after it is a run of one as well.
    expect(guard.preflight([{ name: 'poll', args: 1 }, { name: 'x', args: { q: 1 } }]).allow).toBe(true);
    expect(guard.preflight([{ name: 'x', args: { q: 1 } }]).allow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('preflight: oscillation', () => {
  const only = (options: GuardOptions['oscillation'] = {}): GuardOptions => ({ ...ONLY, oscillation: options });
  const run = (names: string): GuardStep[] => [...names].map((n) => step(call(n, n)));

  it('allows the call that leaves a cycle at two repeats and denies the one that completes the third', () => {
    const guard = createGuard(only());
    feed(guard, run('ababa'));
    expect(guard.preflight({ name: 'a', args: 'a' }).allow).toBe(true); // a b a b a a: broken
    expect(guard.preflight({ name: 'c', args: 'c' }).allow).toBe(true);
    const deny = denied(guard.preflight({ name: 'b', args: 'b' }));
    expect(deny.reason).toBe('oscillation');
    expect(deny.code).toBe('OSCILLATION');
    expect(deny.evidence).toMatchObject({ period: 2, repeats: 3, threshold: 3, cycle: ['a("a")', 'b("b")'], tools: ['a', 'b'] });
    expect(deny.detail).toContain('a("a") -> b("b")');
  });

  it('is allowed one call earlier (A,B,A,B has only two cycles so far, A makes 2.5)', () => {
    const guard = createGuard(only());
    feed(guard, run('abab'));
    expect(guard.preflight({ name: 'a', args: 'a' }).allow).toBe(true);
  });

  it.each([
    { name: 'period 3', history: 'abcabcab', next: 'c', options: {}, deny: true },
    { name: 'period 3, one short', history: 'abcabca', next: 'b', options: {}, deny: false },
    { name: 'period 4 within maxPeriod 4', history: 'abcdabcdabc', next: 'd', options: { maxPeriod: 4 }, deny: true },
    { name: 'period 4 beyond the default maxPeriod', history: 'abcdabcdabc', next: 'd', options: {}, deny: false },
    { name: 'repeats: 2', history: 'aba', next: 'b', options: { repeats: 2 }, deny: true },
    { name: 'repeats: 4', history: 'abababa', next: 'b', options: { repeats: 4 }, deny: true },
    { name: 'repeats: 4, one short', history: 'ababab', next: 'a', options: { repeats: 4 }, deny: false },
    { name: 'a single repeated call is not an oscillation', history: 'aaaaa', next: 'a', options: {}, deny: false },
  ])('$name', ({ history, next, options, deny }) => {
    const guard = createGuard(only(options));
    feed(guard, run(history));
    expect(guard.preflight({ name: next, args: next }).allow).toBe(!deny);
  });

  it('sees a cycle completed by parallel calls', () => {
    const guard = createGuard(only());
    feed(guard, run('abab'));
    expect(guard.preflight([{ name: 'a', args: 'a' }, { name: 'b', args: 'b' }]).allow).toBe(false);
  });

  it('is off when oscillation is disabled', () => {
    const guard = createGuard(ONLY);
    feed(guard, run('ababab'));
    expect(guard.preflight({ name: 'a', args: 'a' }).allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('preflight: per-tool call caps', () => {
  const only = (maxCalls: number, extra: GuardOptions = {}): GuardOptions => ({ ...ONLY, ...extra, tools: { search: { maxCalls } } });
  const search = (i: number) => step(call('search', i));

  it.each([0, 1, 3])('maxCalls %i: allowed while calls < limit, denied once the limit is used up', (limit) => {
    const guard = createGuard(only(limit));
    for (let used = 0; used < limit; used += 1) {
      expect(guard.preflight({ name: 'search', args: used }).allow).toBe(true);
      guard.check(search(used));
    }
    const deny = denied(guard.preflight({ name: 'search', args: 99 }));
    expect(deny.reason).toBe('tool-limit');
    expect(deny.code).toBe('TOOL_CALL_CAP');
    expect(deny.evidence).toEqual({ tool: 'search', calls: limit + 1, limit });
    expect(deny.detail).toBe(`Calling tool "search" now would be call ${limit + 1}; its limit is ${limit}.`);
  });

  it('other tools are unaffected', () => {
    const guard = createGuard(only(0));
    expect(guard.preflight({ name: 'read', args: 1 }).allow).toBe(true);
    expect(guard.preflight({ name: 'search', args: 1 }).allow).toBe(false);
  });

  it('parallel calls count against the cap together', () => {
    const guard = createGuard(only(3));
    feed(guard, [search(1)]);
    expect(guard.preflight([{ name: 'search', args: 2 }, { name: 'search', args: 3 }]).allow).toBe(true);
    const deny = denied(guard.preflight([{ name: 'search', args: 2 }, { name: 'search', args: 3 }, { name: 'search', args: 4 }]));
    expect(deny.evidence).toEqual({ tool: 'search', calls: 4, limit: 3 });
  });

  it('an ignored tool is never capped', () => {
    const guard = createGuard({ ...ONLY, tools: { think: { ignore: true, maxCalls: 0 } } });
    expect(guard.preflight({ name: 'think', args: 1 }).allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('preflight: step and budget limits that are already used up', () => {
  it.each([1, 2, 5])('maxSteps %i: allowed with %i-1 steps recorded, denied once the limit is reached', (limit) => {
    const guard = createGuard({ ...ONLY, maxSteps: limit });
    feed(guard, Array.from({ length: limit - 1 }, () => ({})));
    expect(guard.preflight({ name: 't' }).allow).toBe(true);
    guard.check({});
    const deny = denied(guard.preflight({ name: 't' }));
    expect(deny.reason).toBe('max-steps');
    expect(deny.code).toBe('MAX_STEPS');
    expect(deny.evidence).toEqual({ steps: limit, limit });
  });

  it.each([
    { name: 'total tokens', budget: { maxTotalTokens: 100 }, usage: { totalTokens: 100 }, code: 'BUDGET_TOTAL_TOKENS' },
    { name: 'input tokens', budget: { maxInputTokens: 100 }, usage: { inputTokens: 100 }, code: 'BUDGET_INPUT_TOKENS' },
    { name: 'output tokens', budget: { maxOutputTokens: 100 }, usage: { outputTokens: 100 }, code: 'BUDGET_OUTPUT_TOKENS' },
    { name: 'cost', budget: { maxCostUsd: 1 }, usage: { costUsd: 1 }, code: 'BUDGET_COST_USD' },
  ])('$name: allowed one short of the limit, denied at it', ({ budget, usage, code }) => {
    const [metric, value] = Object.entries(usage)[0] as [string, number];
    const short = createGuard({ ...ONLY, budget, now: () => 0 });
    short.check({ usage: { [metric]: value - 1 } });
    expect(short.preflight({ name: 't' }).allow).toBe(true);
    const spent = createGuard({ ...ONLY, budget, now: () => 0 });
    spent.check({ usage });
    const deny = denied(spent.preflight({ name: 't' }));
    expect(deny.reason).toBe('budget');
    expect(deny.code).toBe(code);
    expect(deny.evidence).toMatchObject({ limit: Object.values(budget)[0], value });
  });

  it('reports budget warnings on an allowed call', () => {
    const guard = createGuard({ ...ONLY, budget: { maxTotalTokens: { limit: 100, warnAt: 0.5 } } });
    expect(guard.preflight({ name: 't' })).toEqual({ allow: true });
    guard.check({ usage: { totalTokens: 60 } });
    const result = guard.preflight({ name: 't' });
    expect(result).toMatchObject({ allow: true, warnings: [{ code: 'BUDGET_WARNING', metric: 'totalTokens', value: 60, limit: 100 }] });
  });

  it('reads the wall clock for a duration budget, but does not touch the guard', () => {
    let clock = 1000;
    const guard = createGuard({ ...ONLY, budget: { maxDurationMs: 500 }, now: () => clock });
    expect(guard.preflight({ name: 't' }).allow).toBe(true);
    clock += 499;
    expect(guard.preflight({ name: 't' }).allow).toBe(true);
    clock += 1;
    const deny = denied(guard.preflight({ name: 't' }));
    expect(deny.code).toBe('BUDGET_DURATION_MS');
    expect(deny.evidence).toEqual({ metric: 'durationMs', value: 500, limit: 500 });
    expect(guard.summary().detectors.budget?.used.durationMs).toBe(0);
  });

  it('does not read the clock when there is no duration limit', () => {
    let reads = 0;
    const guard = createGuard({ ...ONLY, budget: { maxTotalTokens: 10 }, now: () => (reads += 1) });
    const before = reads;
    guard.preflight({ name: 't' });
    expect(reads).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('preflight: what it cannot see', () => {
  it('does not evaluate no-progress, finish reasons or custom detectors', () => {
    let customRuns = 0;
    const guard = createGuard({
      custom: () => {
        customRuns += 1;
        return { stop: true, code: 'ALWAYS' };
      },
    });
    // Three stalled, identical text-only steps: check() stops on noProgress.
    guard.check({ text: 'same' });
    guard.check({ text: 'same' });
    expect(guard.check({ text: 'same', finishReason: 'length' }).stop).toBe(true);
    const runsBefore = customRuns;
    expect(guard.preflight({ name: 't', args: 1 })).toEqual({ allow: true });
    expect(customRuns).toBe(runsBefore);
  });

  it('says nothing about a guard whose last verdict was already a stop', () => {
    const guard = createGuard({ finishReason: {} });
    expect(guard.check({ finishReason: 'stop' }).stop).toBe(true);
    expect(guard.preflight({ name: 't' }).allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('preflight: priority', () => {
  it('budget wins over max steps, max steps over tool caps, tool caps over repeats, repeats over oscillation', () => {
    const base: GuardOptions = {
      ...ONLY,
      budget: { maxTotalTokens: 10 },
      maxSteps: 1,
      repeatedToolCall: { threshold: 2 },
      oscillation: { maxPeriod: 3, repeats: 2 },
      tools: { b: { maxCalls: 1 } },
    };
    const trace: GuardStep[] = [step(call('a')), step(call('b')), step(call('b')), step(call('a')), step(call('b'))];
    const at = (options: GuardOptions) => {
      const guard = createGuard(options);
      feed(guard, trace);
      return denied(guard.preflight({ name: 'b' })).reason;
    };
    // Spend the budget with one more recorded step; the other rules would all trip too.
    const withBudgetSpent = (options: GuardOptions) => {
      const guard = createGuard(options);
      feed(guard, trace);
      guard.check({ usage: { totalTokens: 10 } });
      return denied(guard.preflight({ name: 'b' })).reason;
    };
    expect(withBudgetSpent(base)).toBe('budget');
    expect(at(base)).toBe('max-steps');
    expect(at({ ...base, maxSteps: false })).toBe('tool-limit');
    expect(at({ ...base, maxSteps: false, tools: {} })).toBe('repeated-tool-call');
    expect(at({ ...base, maxSteps: false, tools: {}, repeatedToolCall: false })).toBe('oscillation');
  });
});

// ---------------------------------------------------------------------------
describe('preflight: input handling', () => {
  it('accepts an array of parallel calls, and an empty array', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: {} });
    expect(guard.preflight([])).toEqual({ allow: true });
    const deny = denied(guard.preflight([{ name: 't', args: 1 }, { name: 't', args: 1 }, { name: 't', args: 1 }]));
    expect(deny.evidence).toMatchObject({ count: 3, stepIndexes: [0] });
  });

  it('reports the index the step would get', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 2 } });
    feed(guard, [{}, {}, step(call('t', 1))]);
    expect(denied(guard.preflight({ name: 't', args: 1 })).evidence).toMatchObject({ stepIndexes: [2, 3] });
  });

  it('only reads name and args: a result or error on the object changes nothing', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 2 } });
    feed(guard, [step(call('t', 1))]);
    const withExtras = { name: 't', args: 1, result: 'whatever', error: new Error('x') } as GuardToolCall;
    expect(guard.preflight(withExtras).allow).toBe(false);
  });

  it('does not throw on odd input, and has nothing to object to', () => {
    const guard = createGuard();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwing = {
      get name(): string {
        throw new Error('getter');
      },
      args: 1,
    };
    const inputs: unknown[] = [
      undefined,
      null,
      7,
      'search',
      true,
      {},
      { name: 5 },
      { name: null, args: undefined },
      { name: { nested: true }, args: () => 1 },
      [null, 1, 'x', {}, [], { name: 'ok' }],
      revoked.proxy,
      [revoked.proxy],
      throwing,
      [throwing, { name: 'fine', args: 1 }],
      new Proxy([], { get() { throw new Error('hostile iterator'); } }),
      { name: 'circular', args: (() => { const o: Record<string, unknown> = {}; o['self'] = o; return o; })() },
      { name: 'x'.repeat(10_000), args: 'y'.repeat(10_000) },
    ];
    for (const input of inputs) {
      expect(() => guard.preflight(input as never)).not.toThrow();
      expect(guard.preflight(input as never).allow).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe('preflight: denials carry feedback for the model', () => {
  const SECRET = 'SENTINEL-token-123';

  it('has the documented shape and is JSON-serialisable', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 2 } });
    feed(guard, same('search', 1));
    const deny = denied(guard.preflight({ name: 'search', args: { q: 1 } }));
    expect(Object.keys(deny).sort()).toEqual(['allow', 'code', 'detail', 'evidence', 'feedback', 'reason']);
    expect(deny.feedback).toBe(
      'That call was not run: you have already called `search` 1 time in a row with the same arguments, and repeating it is unlikely to give you anything new. Try a different tool or different arguments, or answer with what you have.',
    );
    expect(JSON.parse(JSON.stringify(deny))).toEqual(deny);
  });

  it.each([
    { name: 'repeat', options: { ...ONLY, repeatedToolCall: { threshold: 2 } } as GuardOptions, pending: ['u'] },
    { name: 'oscillation', options: { ...ONLY, oscillation: { repeats: 2 } } as GuardOptions, pending: ['t', 'u', 't'] },
    { name: 'tool cap', options: { ...ONLY, tools: { t: { maxCalls: 1 } } } as GuardOptions, pending: ['t'] },
    { name: 'max steps', options: { ...ONLY, maxSteps: 1 } as GuardOptions, pending: ['t'] },
    { name: 'budget', options: { ...ONLY, budget: { maxTotalTokens: 1 } } as GuardOptions, pending: ['t'] },
  ])('$name: feedback never contains the arguments', ({ options, pending }) => {
    const guard = createGuard(options);
    const secretCall = (name: string) => ({ name, args: { secret: SECRET } });
    // History: t t u u u, with token usage so the budget is spent.
    guard.check({ toolCalls: [secretCall('t'), secretCall('t'), secretCall('u'), secretCall('u'), secretCall('u')], usage: { totalTokens: 5 } });
    const deny = denied(guard.preflight(pending.map(secretCall)));
    expect(deny.feedback.toLowerCase()).not.toContain('sentinel');
    expect(deny.feedback.length).toBeGreaterThan(20);
  });

  it('the developer-facing detail does show the argument preview (so the test above is meaningful)', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 2 } });
    feed(guard, [step(call('t', { secret: SECRET }))]);
    const deny = denied(guard.preflight({ name: 't', args: { secret: SECRET } }));
    expect(deny.detail).toContain(SECRET);
    expect(deny.feedback).not.toContain(SECRET);
  });

  it('options.feedback can replace it, and is told the phase', () => {
    const phases: string[] = [];
    const guard = createGuard({
      ...ONLY,
      maxSteps: 1,
      feedback: (verdict, { phase }) => {
        phases.push(phase);
        return phase === 'preflight' ? `no more steps (${verdict.code})` : undefined;
      },
    });
    guard.check({});
    expect(denied(guard.preflight({ name: 't' })).feedback).toBe('no more steps (MAX_STEPS)');
    expect(phases).toEqual(['check', 'preflight']);
  });

  it('falls back to the default when the override returns undefined', () => {
    const guard = createGuard({ ...ONLY, maxSteps: 1, feedback: () => undefined });
    guard.check({});
    expect(denied(guard.preflight({ name: 't' })).feedback).toContain('step limit');
  });

  it('narrows by reason in TypeScript', () => {
    const guard = createGuard({ ...ONLY, maxSteps: 1 });
    guard.check({});
    const result = guard.preflight({ name: 't' });
    if (!result.allow && result.reason === 'max-steps') {
      expectTypeOf(result.evidence.limit).toBeNumber();
      expectTypeOf(result.feedback).toBeString();
      expect(result.evidence.limit).toBe(1);
    } else {
      throw new Error('expected a max-steps denial');
    }
    expectTypeOf(guard.preflight).parameter(0).toMatchTypeOf<{ name: string; args?: unknown } | ReadonlyArray<{ name: string; args?: unknown }>>();
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

type Rand = () => number;
const pick = <T>(rand: Rand, items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

const NAMES = ['a', 'b', 'c', 'think', 'search'];
const randomCall = (rand: Rand, withOutcome: boolean): GuardToolCall => {
  const c: GuardToolCall = { name: pick(rand, NAMES), args: pick(rand, [1, 2, { q: 'x' }]) };
  if (withOutcome && rand() < 0.5) c.result = pick(rand, ['r1', 'r2']);
  if (withOutcome && rand() < 0.15) c.error = 'boom';
  return c;
};
const randomStep = (rand: Rand): GuardStep => ({
  toolCalls: Array.from({ length: Math.floor(rand() * 3) }, () => randomCall(rand, true)),
  ...(rand() < 0.5 ? { usage: { totalTokens: pick(rand, [0, 5, 20]) } } : {}),
});

/** Configurations in which every rule preflight evaluates can fire, without result-aware repeat rules. */
const CALL_PATTERN_CONFIGS: Array<[string, () => GuardOptions]> = [
  ['defaults for the call-pattern rules', () => ({ ...ONLY, repeatedToolCall: {}, oscillation: {} })],
  ['tight', () => ({ ...ONLY, repeatedToolCall: { threshold: 2 }, oscillation: { maxPeriod: 4, repeats: 2 } })],
  ['ignoreErrors', () => ({ ...ONLY, repeatedToolCall: { threshold: 2, ignoreErrors: true }, oscillation: { repeats: 2 } })],
  [
    'per-tool policies',
    () => ({
      ...ONLY,
      repeatedToolCall: {},
      oscillation: { repeats: 2 },
      tools: { search: { maxCalls: 4 }, think: { ignore: true }, a: { repeatThreshold: 2 }, c: { maxCalls: 0 } },
    }),
  ],
];

describe('preflight: purity (property)', () => {
  const all: Array<[string, () => GuardOptions]> = [
    ...CALL_PATTERN_CONFIGS,
    ['budgets and steps', () => ({ maxSteps: 40, budget: { maxTotalTokens: 200, maxDurationMs: 1e9, warnAt: 0.5 }, now: () => 0 })],
    ['result-aware', () => ({ repeatedToolCall: { requireIdenticalResults: true }, tools: { search: { polling: true } } })],
  ];

  it.each(all)('%s: summary, history and later verdicts are untouched by any number of preflights', (_name, makeOptions) => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const rand = mulberry32(seed * 2749);
      const probed = createGuard(makeOptions());
      const control = createGuard(makeOptions());
      for (let i = 0; i < 40; i += 1) {
        const before = JSON.stringify(probed.summary());
        const historyBefore = probed.history;
        for (let k = 0; k < 3; k += 1) {
          const input = rand() < 0.5 ? randomCall(rand, false) : Array.from({ length: Math.floor(rand() * 4) }, () => randomCall(rand, false));
          probed.preflight(input);
        }
        expect(JSON.stringify(probed.summary())).toBe(before);
        expect(probed.history).toEqual(historyBefore);
        expect(probed.history.length).toBe(historyBefore.length);
        const s = randomStep(rand);
        expect(probed.check(s)).toEqual(control.check(s));
      }
      expect(probed.summary()).toEqual(control.summary());
    }
  });
});

describe('preflight agrees with check (property)', () => {
  const RELEVANT = ['tool-limit', 'repeated-tool-call', 'oscillation'];

  /** Replay `trace` into a fresh guard and then run `calls` as one more step with no results. */
  function twinVerdict(makeOptions: () => GuardOptions, trace: readonly GuardStep[], calls: GuardToolCall[]) {
    const twin = createGuard(makeOptions());
    feed(twin, trace);
    return twin.check({ toolCalls: calls });
  }

  it.each(CALL_PATTERN_CONFIGS)('%s: a call is denied exactly when running it would trip a call-pattern rule', (_name, makeOptions) => {
    let denials = 0;
    let checked = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const rand = mulberry32(seed * 7919);
      const guard: Guard = createGuard(makeOptions());
      const trace: GuardStep[] = [];
      for (let i = 0; i < 40; i += 1) {
        // Bias towards repeating recent calls so that the rules actually fire.
        const last = trace.flatMap((s) => s.toolCalls ?? []);
        const calls = Array.from({ length: 1 + Math.floor(rand() * 2) }, () => {
          const recent = last[last.length - 1 - Math.floor(rand() * 3)];
          return rand() < 0.6 && recent !== undefined ? { name: recent.name, args: recent.args } : randomCall(rand, false);
        });
        const pre = guard.preflight(calls);
        const v = twinVerdict(makeOptions, trace, calls);
        const trips = v.stop && RELEVANT.includes(v.reason);
        expect(pre.allow).toBe(!trips);
        if (!pre.allow && v.stop) {
          expect(pre.reason).toBe(v.reason);
          expect(pre.code).toBe(v.code);
          expect(pre.evidence).toEqual(v.evidence);
          expect(pre.feedback).not.toBe(v.feedback); // worded for a call that did not run
          denials += 1;
        }
        checked += 1;
        // Carry on with a mix of the proposed call and an unrelated step so runs continue.
        const next: GuardStep = rand() < 0.8 ? { toolCalls: calls.map((c) => ({ ...c })) } : randomStep(rand);
        trace.push(next);
        guard.check(next);
      }
    }
    expect(checked).toBe(60 * 40);
    expect(denials).toBeGreaterThan(20); // the property is not vacuous
  });
});
