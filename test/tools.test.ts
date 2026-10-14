import { describe, expect, it } from 'vitest';
import { createGuard, explain, isFault } from '../src/index';
import type { GuardOptions, GuardStep, ToolPolicy, Verdict } from '../src/index';
import { call, feed, firstStop, step } from './helpers';

/** Options that switch every detector off, so a test can enable exactly one. */
const ONLY: GuardOptions = {
  maxSteps: false,
  repeatedToolCall: false,
  oscillation: false,
  noProgress: false,
  finishReason: false,
};

function stopOf(verdict: Verdict | undefined) {
  if (verdict === undefined || !verdict.stop) throw new Error('expected a stop verdict');
  return verdict;
}

const tools = (map: Record<string, ToolPolicy>, extra: GuardOptions = {}): GuardOptions => ({ ...extra, tools: map });

// ---------------------------------------------------------------------------
describe('tools: validation', () => {
  it.each([
    { name: 'maxCalls: -1', policy: { maxCalls: -1 }, message: /maxCalls must be an integer >= 0/ },
    { name: 'maxCalls: 1.5', policy: { maxCalls: 1.5 }, message: /maxCalls/ },
    { name: 'maxCalls: "3"', policy: { maxCalls: '3' }, message: /maxCalls/ },
    { name: 'maxCalls: NaN', policy: { maxCalls: NaN }, message: /maxCalls/ },
    { name: 'repeatThreshold: 1', policy: { repeatThreshold: 1 }, message: /repeatThreshold must be an integer >= 2/ },
    { name: 'repeatThreshold: 2.5', policy: { repeatThreshold: 2.5 }, message: /repeatThreshold/ },
    { name: 'polling.maxIdenticalResults: 1', policy: { polling: { maxIdenticalResults: 1 } }, message: /maxIdenticalResults must be an integer >= 2/ },
    { name: 'polling: "yes"', policy: { polling: 'yes' }, message: /polling must be a boolean or an object/ },
    { name: 'polling: null', policy: { polling: null }, message: /polling must be a boolean or an object/ },
    { name: 'polling with an unknown key', policy: { polling: { every: 2 } }, message: /polling has an unknown option "every"/ },
    { name: 'ignore: "true"', policy: { ignore: 'true' }, message: /ignore must be a boolean/ },
    { name: 'a misspelt option', policy: { maxcalls: 3 }, message: /unknown option "maxcalls"/ },
    { name: 'a null policy', policy: null, message: /must be an object/ },
    { name: 'a number as the policy', policy: 5, message: /must be an object/ },
    { name: 'an array as the policy', policy: [], message: /must be an object/ },
  ])('rejects $name', ({ policy, message }) => {
    const options = { tools: { search: policy } } as unknown as GuardOptions;
    expect(() => createGuard(options)).toThrow(TypeError);
    expect(() => createGuard(options)).toThrow(message);
    expect(() => createGuard(options)).toThrow(/tools\["search"\]/);
  });

  it.each([null, 7, 'search', []])('rejects %j as the tools option', (value) => {
    expect(() => createGuard({ tools: value } as unknown as GuardOptions)).toThrow(/tools must be an object/);
  });

  it('accepts an empty policy, an empty map, unknown tool names and explicit undefined fields', () => {
    expect(() => createGuard({ tools: {} })).not.toThrow();
    expect(() => createGuard({ tools: { anything: {} } })).not.toThrow();
    expect(() => createGuard({ tools: { a: { polling: undefined, maxCalls: undefined, repeatThreshold: undefined, ignore: undefined } } })).not.toThrow();
    expect(() => createGuard({ tools: { a: { polling: false, ignore: false } } })).not.toThrow();
  });

  it('treats prototype-ish tool names as ordinary names', () => {
    const map: Record<string, ToolPolicy> = {};
    Object.defineProperty(map, '__proto__', { value: { maxCalls: 1 }, enumerable: true });
    const guard = createGuard({ ...ONLY, tools: map });
    expect(guard.check(step(call('__proto__'))).stop).toBe(false);
    expect(guard.check(step(call('__proto__')))).toMatchObject({ stop: true, code: 'TOOL_CALL_CAP', evidence: { tool: '__proto__' } });
    // Tools that merely share a name with an Object.prototype member are not affected by any policy.
    const plain = createGuard({ ...ONLY, tools: { search: { maxCalls: 0 } } });
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(plain.check(step(call(name))).stop).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('tools: maxCalls', () => {
  const only = (maxCalls: number, extra: GuardOptions = {}): GuardOptions => tools({ search: { maxCalls } }, { ...ONLY, ...extra });
  const search = (i: number) => step(call('search', { q: i }));

  it.each([0, 1, 2, 5])('maxCalls %i: %i calls pass, the next one stops', (limit) => {
    const verdicts = feed(createGuard(only(limit)), Array.from({ length: limit + 3 }, (_, i) => search(i)));
    expect(firstStop(verdicts)).toBe(limit);
    const v = stopOf(verdicts[limit]);
    expect(v.reason).toBe('tool-limit');
    expect(v.code).toBe('TOOL_CALL_CAP');
    expect(v.evidence).toEqual({ tool: 'search', calls: limit + 1, limit });
    expect(v.detail).toBe(`Tool "search" was called ${limit + 1} times; its limit is ${limit}.`);
    expect(isFault(v)).toBe(true);
  });

  it('keeps stopping, with a growing count, if the caller carries on', () => {
    const verdicts = feed(createGuard(only(2)), Array.from({ length: 5 }, (_, i) => search(i)));
    expect(verdicts.map((v) => v.stop)).toEqual([false, false, true, true, true]);
    expect(stopOf(verdicts[4]).evidence).toMatchObject({ calls: 5, limit: 2 });
  });

  it('counts calls across steps, regardless of arguments or results, and not other tools', () => {
    const guard = createGuard(only(3));
    const verdicts = feed(guard, [
      step(call('search', 'a', { result: 1 })),
      step(call('read', 'x')),
      step(call('search', 'b', { error: 'boom' })),
      step(call('read', 'x'), call('read', 'x')),
      step(call('search', 'a', { result: 1 })),
      step(call('search', 'c')),
    ]);
    expect(verdicts.map((v) => v.stop)).toEqual([false, false, false, false, false, true]);
    expect(guard.summary().detectors.toolLimits).toEqual([{ tool: 'search', limit: 3, calls: 4 }]);
  });

  it('counts parallel calls inside one step one by one and reports the first one over the limit', () => {
    const v = createGuard(only(2)).check(step(call('search', 1), call('search', 2), call('search', 3), call('search', 4)));
    expect(stopOf(v).evidence).toEqual({ tool: 'search', calls: 3, limit: 2 });
  });

  it('with several capped tools, the first call over its limit is reported', () => {
    const guard = createGuard(tools({ a: { maxCalls: 1 }, b: { maxCalls: 1 } }, ONLY));
    const v = guard.check(step(call('a'), call('b'), call('b'), call('a')));
    expect(stopOf(v).evidence).toMatchObject({ tool: 'b', calls: 2 });
    expect(guard.summary().detectors.toolLimits).toEqual([
      { tool: 'a', limit: 1, calls: 2 },
      { tool: 'b', limit: 1, calls: 2 },
    ]);
  });

  it('is independent of the repeated-call detector: different arguments still count', () => {
    const verdicts = feed(createGuard(only(2, { repeatedToolCall: { threshold: 2 } })), [search(1), search(2), search(3)]);
    expect(stopOf(verdicts[2]).reason).toBe('tool-limit');
  });

  it('summary shows toolLimits only when a cap is configured, and reset() clears the counts', () => {
    expect('toolLimits' in createGuard().summary().detectors).toBe(false);
    expect('toolLimits' in createGuard(tools({ x: { polling: true } })).summary().detectors).toBe(false);
    const guard = createGuard(only(1));
    expect(guard.summary().detectors.toolLimits).toEqual([{ tool: 'search', limit: 1, calls: 0 }]);
    feed(guard, [search(1), search(2)]);
    guard.reset();
    expect(guard.summary().detectors.toolLimits).toEqual([{ tool: 'search', limit: 1, calls: 0 }]);
    expect(guard.check(search(1)).stop).toBe(false);
  });

  it('explain() has a hint for it', () => {
    expect(explain(createGuard(only(0)).check(search(1)))).toMatch(
      /^Stop \[TOOL_CALL_CAP\] Tool "search" was called 1 times; its limit is 0\.\nHint: .+/,
    );
  });

  describe('priority', () => {
    it('a normal finish wins over it', () => {
      const v = createGuard(tools({ search: { maxCalls: 0 } }, { ...ONLY, finishReason: {} })).check({ ...search(1), finishReason: 'stop' });
      expect(v).toMatchObject({ reason: 'finish-reason' });
    });

    it('budget and maxSteps win over it', () => {
      expect(
        createGuard(tools({ search: { maxCalls: 0 } }, { ...ONLY, budget: { maxTotalTokens: 1 } })).check({ ...search(1), usage: { totalTokens: 1 } }),
      ).toMatchObject({ reason: 'budget' });
      expect(createGuard(tools({ search: { maxCalls: 0 } }, { ...ONLY, maxSteps: 1 })).check(search(1))).toMatchObject({ reason: 'max-steps' });
    });

    it('it wins over repeated calls, oscillation and no progress, and all of them still keep counting', () => {
      const guard = createGuard(
        tools(
          { t: { maxCalls: 0 } },
          { ...ONLY, repeatedToolCall: { threshold: 2 }, oscillation: { repeats: 2 }, noProgress: { threshold: 2 } },
        ),
      );
      expect(guard.check(step(call('t'), call('t')))).toMatchObject({ reason: 'tool-limit' });
      expect(guard.summary().detectors.repeatedToolCall?.currentRun).toEqual({ tool: 't', length: 2 });
    });

    it('custom detectors come after it', () => {
      const guard = createGuard(tools({ search: { maxCalls: 0 } }, { ...ONLY, custom: () => ({ stop: true, code: 'MINE' }) }));
      expect(guard.check(search(1))).toMatchObject({ reason: 'tool-limit' });
    });
  });
});

// ---------------------------------------------------------------------------
describe('tools: repeatThreshold', () => {
  const only = (map: Record<string, ToolPolicy>, repeated: GuardOptions['repeatedToolCall'] = {}): GuardOptions =>
    tools(map, { ...ONLY, repeatedToolCall: repeated });
  const same = (name: string, n: number): GuardStep[] => Array.from({ length: n }, () => step(call(name, { q: 1 })));

  it.each([
    { name: 'a lower threshold than the global one', policy: 2, global: 3, n: 2 },
    { name: 'a higher threshold than the global one', policy: 5, global: 3, n: 5 },
    { name: 'the same as the global one', policy: 3, global: 3, n: 3 },
  ])('$name: N-1 identical calls continue, N stop', ({ policy, global, n }) => {
    const options = only({ slow: { repeatThreshold: policy } }, { threshold: global });
    const verdicts = feed(createGuard(options), same('slow', n + 1));
    expect(firstStop(verdicts)).toBe(n - 1);
    expect(stopOf(verdicts[n - 1]).evidence).toMatchObject({ tool: 'slow', count: n, threshold: n, identicalResults: false });
  });

  it('other tools keep the global threshold', () => {
    const options = only({ slow: { repeatThreshold: 6 } });
    expect(firstStop(feed(createGuard(options), same('other', 5)))).toBe(2);
    expect(stopOf(feed(createGuard(options), same('other', 5))[2]).evidence).toMatchObject({ threshold: 3 });
    expect(firstStop(feed(createGuard(options), same('slow', 8)))).toBe(5);
  });

  it('a run is judged by the rule of its own tool, also when tools alternate', () => {
    const options = only({ a: { repeatThreshold: 2 } });
    const verdicts = feed(createGuard(options), [
      step(call('b', 1)),
      step(call('b', 1)),
      step(call('a', 1)),
      step(call('a', 1)),
    ]);
    expect(firstStop(verdicts)).toBe(3);
    expect(stopOf(verdicts[3]).evidence).toMatchObject({ tool: 'a', threshold: 2 });
  });

  it('has no effect when repeatedToolCall is disabled', () => {
    const options = tools({ slow: { repeatThreshold: 2, polling: true } }, ONLY);
    expect(firstStop(feed(createGuard(options), same('slow', 20)))).toBe(-1);
  });

  it('the summary still reports the global threshold', () => {
    const guard = createGuard(only({ slow: { repeatThreshold: 6 } }, { threshold: 4 }));
    expect(guard.summary().detectors.repeatedToolCall).toMatchObject({ threshold: 4 });
  });
});

// ---------------------------------------------------------------------------
describe('tools: polling', () => {
  const only = (policy: ToolPolicy, repeated: GuardOptions['repeatedToolCall'] = {}): GuardOptions =>
    tools({ poll: policy }, { ...ONLY, repeatedToolCall: repeated });
  const poll = (result: unknown) => step(call('poll', { job: 7 }, { result }));

  it('identical arguments with changing results are never a repeat', () => {
    const verdicts = feed(createGuard(only({ polling: true })), Array.from({ length: 30 }, (_, i) => poll({ progress: i })));
    expect(firstStop(verdicts)).toBe(-1);
  });

  it('without the policy the same sequence is stopped as a repeat', () => {
    const plain = createGuard({ ...ONLY, repeatedToolCall: {} });
    expect(firstStop(feed(plain, Array.from({ length: 5 }, (_, i) => poll({ progress: i }))))).toBe(2);
  });

  it.each([
    { name: 'polling: true (global threshold 3)', policy: { polling: true }, repeated: {}, n: 3 },
    { name: 'polling: {} (global threshold 3)', policy: { polling: {} }, repeated: {}, n: 3 },
    { name: 'polling: true with the global threshold 2', policy: { polling: true }, repeated: { threshold: 2 }, n: 2 },
    { name: 'polling: true with the tool repeatThreshold 4', policy: { polling: true, repeatThreshold: 4 }, repeated: {}, n: 4 },
    { name: 'maxIdenticalResults 5', policy: { polling: { maxIdenticalResults: 5 } }, repeated: {}, n: 5 },
    { name: 'maxIdenticalResults 2 beats repeatThreshold 6', policy: { polling: { maxIdenticalResults: 2 }, repeatThreshold: 6 }, repeated: {}, n: 2 },
    { name: 'maxIdenticalResults 8 beats repeatThreshold 2', policy: { polling: { maxIdenticalResults: 8 }, repeatThreshold: 2 }, repeated: {}, n: 8 },
  ] as Array<{ name: string; policy: ToolPolicy; repeated: GuardOptions['repeatedToolCall']; n: number }>)(
    '$name: N-1 identical outcomes continue, N stop',
    ({ policy, repeated, n }) => {
      const verdicts = feed(createGuard(only(policy, repeated)), Array.from({ length: n + 1 }, () => poll('pending')));
      expect(firstStop(verdicts)).toBe(n - 1);
      expect(stopOf(verdicts[n - 1]).evidence).toMatchObject({ tool: 'poll', count: n, threshold: n, identicalResults: true });
      expect(stopOf(verdicts[n - 1]).detail).toContain('identical results');
    },
  );

  it('a changed result restarts the count', () => {
    const results = ['pending', 'pending', 'running', 'running', 'pending', 'pending', 'done'];
    expect(firstStop(feed(createGuard(only({ polling: true })), results.map(poll)))).toBe(-1);
    const more = ['pending', 'pending', 'running', 'running', 'running'];
    expect(firstStop(feed(createGuard(only({ polling: true })), more.map(poll)))).toBe(4);
  });

  it('errors count as results: the same error repeatedly is a repeat, a different one is not', () => {
    const fail = (message: string) => step(call('poll', { job: 7 }, { error: new Error(message) }));
    expect(firstStop(feed(createGuard(only({ polling: true })), [fail('a'), fail('a'), fail('a')]))).toBe(2);
    expect(firstStop(feed(createGuard(only({ polling: true })), [fail('a'), fail('b'), fail('c'), fail('d')]))).toBe(-1);
  });

  it('calls without a result compare equal, so they are repeats', () => {
    const bare = () => step(call('poll', { job: 7 }));
    expect(firstStop(feed(createGuard(only({ polling: true })), [bare(), bare(), bare()]))).toBe(2);
  });

  it('different arguments are never a repeat', () => {
    const verdicts = feed(
      createGuard(only({ polling: true })),
      Array.from({ length: 10 }, (_, i) => step(call('poll', { job: i }, { result: 'pending' }))),
    );
    expect(firstStop(verdicts)).toBe(-1);
  });

  it('other tools are still judged by the global rule', () => {
    const options = tools({ poll: { polling: true } }, { ...ONLY, repeatedToolCall: {} });
    const verdicts = feed(createGuard(options), Array.from({ length: 4 }, (_, i) => step(call('search', 'x', { result: i }))));
    expect(firstStop(verdicts)).toBe(2);
    expect(stopOf(verdicts[2]).evidence).toMatchObject({ tool: 'search', identicalResults: false });
  });

  it('a polling tool and a result-aware global rule agree; a non-polling tool follows the global flag', () => {
    const options = tools({ poll: { polling: true, repeatThreshold: 2 } }, { ...ONLY, repeatedToolCall: { requireIdenticalResults: true } });
    expect(firstStop(feed(createGuard(options), [poll('a'), poll('a')]))).toBe(1);
    const other = (r: unknown) => step(call('other', 1, { result: r }));
    expect(firstStop(feed(createGuard(options), [other(1), other(2), other(3), other(4)]))).toBe(-1);
    expect(firstStop(feed(createGuard(options), [other(1), other(1), other(1)]))).toBe(2);
  });

  it('polling: false is the same as no policy', () => {
    const verdicts = feed(createGuard(only({ polling: false })), Array.from({ length: 4 }, (_, i) => poll(i)));
    expect(firstStop(verdicts)).toBe(2);
  });

  it('ignoreErrors still drops failed polls from the sequence', () => {
    const options = only({ polling: true }, { ignoreErrors: true });
    const bad = () => step(call('poll', { job: 7 }, { error: 'x' }));
    expect(firstStop(feed(createGuard(options), [poll('p'), bad(), poll('p'), bad(), poll('p')]))).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('tools: ignore', () => {
  const think = (i: number) => call('think', { thought: `idea ${i}` });

  it('an ignored call neither extends nor breaks a run of repeated calls', () => {
    const trace = [step(call('search', 1)), step(think(1)), step(call('search', 1)), step(think(2)), step(call('search', 1))];
    const base: GuardOptions = { ...ONLY, repeatedToolCall: {} };
    expect(firstStop(feed(createGuard(base), trace))).toBe(-1);
    expect(firstStop(feed(createGuard(tools({ think: { ignore: true } }, base)), trace))).toBe(4);
  });

  it('an ignored call does not hide an oscillation', () => {
    // Without ignore the sequence is a, think, b, think, ...: a cycle of 4 calls, beyond maxPeriod 3.
    const trace = ['a', 'b', 'a', 'b', 'a', 'b'].flatMap((n, i) => [step(call(n, n)), step(think(i))]);
    const base: GuardOptions = { ...ONLY, oscillation: {} };
    expect(firstStop(feed(createGuard(base), trace))).toBe(-1);
    const verdicts = feed(createGuard(tools({ think: { ignore: true } }, base)), trace);
    expect(firstStop(verdicts)).toBe(10);
    expect(stopOf(verdicts[10]).evidence).toMatchObject({ period: 2, repeats: 3, cycle: ['a("a")', 'b("b")'] });
  });

  it('a step of only ignored calls is a stalled step for noProgress', () => {
    const trace = Array.from({ length: 4 }, (_, i) => ({ text: 'Thinking.', toolCalls: [think(i)] }));
    const base: GuardOptions = { ...ONLY, noProgress: { threshold: 3 } };
    expect(firstStop(feed(createGuard(base), trace))).toBe(-1); // every thought is a new outcome
    expect(firstStop(feed(createGuard(tools({ think: { ignore: true } }, base)), trace))).toBe(2);
  });

  it('a real call in the same step still counts as progress', () => {
    const trace = Array.from({ length: 4 }, (_, i) => ({ text: 'Thinking.', toolCalls: [think(i), call('read', i)] }));
    const options = tools({ think: { ignore: true } }, { ...ONLY, noProgress: { threshold: 2 } });
    expect(firstStop(feed(createGuard(options), trace))).toBe(-1);
  });

  it('an ignored tool is not capped, and ignore takes precedence over maxCalls, polling and repeatThreshold', () => {
    const options = tools(
      { think: { ignore: true, maxCalls: 1, polling: true, repeatThreshold: 2 } },
      { ...ONLY, repeatedToolCall: { threshold: 2 }, oscillation: { repeats: 2 } },
    );
    const verdicts = feed(createGuard(options), Array.from({ length: 8 }, (_, i) => step(think(i % 2))));
    expect(firstStop(verdicts)).toBe(-1);
    expect('toolLimits' in createGuard(options).summary().detectors).toBe(false);
  });

  it('is still counted in the totals and seen by the finish-reason rule', () => {
    const guard = createGuard(tools({ think: { ignore: true } }));
    expect(guard.check({ text: 'hmm', toolCalls: [think(1)], finishReason: 'other' }).stop).toBe(false); // not text-only
    expect(guard.summary().toolCalls).toBe(1);
  });

  it('does not affect maxSteps or budgets', () => {
    const guard = createGuard(tools({ think: { ignore: true } }, { maxSteps: 2 }));
    expect(guard.check(step(think(1))).stop).toBe(false);
    expect(guard.check(step(think(2)))).toMatchObject({ reason: 'max-steps' });
  });
});

// ---------------------------------------------------------------------------
describe('tools: policies together with the global detectors', () => {
  it('each tool follows its own policy in one run', () => {
    const options = tools(
      {
        poll: { polling: { maxIdenticalResults: 4 } },
        search: { maxCalls: 4 },
        think: { ignore: true },
        slow: { repeatThreshold: 5 },
      },
      { ...ONLY, repeatedToolCall: {} },
    );
    const guard = createGuard(options);
    const trace: GuardStep[] = [
      step(call('poll', 1, { result: 'p' })),
      step(call('think', 1)),
      step(call('poll', 1, { result: 'p' })),
      step(call('slow', 'x')),
      step(call('slow', 'x')),
      step(call('search', 'a')),
      step(call('search', 'b')),
      step(call('search', 'c')),
      step(call('search', 'd')),
      step(call('search', 'e')), // fifth search: over its cap of four
    ];
    const verdicts = feed(guard, trace);
    expect(firstStop(verdicts)).toBe(9);
    expect(stopOf(verdicts[9]).evidence).toEqual({ tool: 'search', calls: 5, limit: 4 });
    // ...while poll saw two identical outcomes with the think call in between ignored.
    expect(guard.summary().detectors.repeatedToolCall).toMatchObject({ longestRun: 2 });
  });

  it('summary() and verdicts stay JSON-serialisable', () => {
    const guard = createGuard(tools({ search: { maxCalls: 1 }, poll: { polling: true } }));
    const verdicts = feed(guard, [step(call('search', 1)), step(call('search', 1))]);
    expect(JSON.parse(JSON.stringify(verdicts[1]))).toEqual(verdicts[1]);
    expect(JSON.parse(JSON.stringify(guard.summary()))).toEqual(guard.summary());
  });

  it('reset() keeps the policies', () => {
    const guard = createGuard(tools({ search: { maxCalls: 1 } }, ONLY));
    expect(guard.check(step(call('search'), call('search'))).stop).toBe(true);
    guard.reset();
    expect(guard.check(step(call('search'))).stop).toBe(false);
    expect(guard.check(step(call('search'))).stop).toBe(true);
  });
});
