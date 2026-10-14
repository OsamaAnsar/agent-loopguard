import { describe, expect, it } from 'vitest';
import { createGuard } from '../src/index';
import type { GuardOptions, GuardStep, Verdict } from '../src/index';
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

// ---------------------------------------------------------------------------
describe('maxSteps', () => {
  it.each([1, 2, 3, 10])('stops exactly on step %i and not before', (limit) => {
    const guard = createGuard({ ...ONLY, maxSteps: limit });
    const verdicts = feed(guard, Array.from({ length: limit + 2 }, () => ({})));
    expect(firstStop(verdicts)).toBe(limit - 1);
    const v = stopOf(verdicts[limit - 1]);
    expect(v.reason).toBe('max-steps');
    expect(v.code).toBe('MAX_STEPS');
    expect(v.evidence).toEqual({ steps: limit, limit });
  });

  it('defaults to 50 steps', () => {
    const guard = createGuard({ ...ONLY, maxSteps: undefined });
    const verdicts = feed(guard, Array.from({ length: 50 }, () => ({})));
    expect(firstStop(verdicts)).toBe(49);
  });

  it('can be disabled', () => {
    const guard = createGuard({ ...ONLY });
    const verdicts = feed(guard, Array.from({ length: 500 }, () => ({})));
    expect(firstStop(verdicts)).toBe(-1);
  });

  it.each([0, -1, 1.5, NaN])('rejects the invalid limit %s', (limit) => {
    expect(() => createGuard({ maxSteps: limit })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
describe('repeatedToolCall', () => {
  const only = (opts: GuardOptions['repeatedToolCall'] = {}): GuardOptions => ({ ...ONLY, repeatedToolCall: opts });
  const search = (q: string) => step(call('search', { q }));

  it.each([
    { threshold: undefined, n: 3 },
    { threshold: 2, n: 2 },
    { threshold: 3, n: 3 },
    { threshold: 5, n: 5 },
  ])('threshold $threshold: N-1 identical calls continue, N stop', ({ threshold, n }) => {
    const options = threshold === undefined ? only() : only({ threshold });
    const verdicts = feed(createGuard(options), Array.from({ length: n + 1 }, () => search('x')));
    expect(firstStop(verdicts)).toBe(n - 1);
    const v = stopOf(verdicts[n - 1]);
    expect(v.reason).toBe('repeated-tool-call');
    expect(v.code).toBe('REPEATED_TOOL_CALL');
    expect(v.evidence).toMatchObject({ tool: 'search', count: n, threshold: n, identicalResults: false });
    expect(v.detail).toContain('search');
  });

  it('keeps stopping (with a growing count) if the caller carries on', () => {
    const verdicts = feed(createGuard(only()), Array.from({ length: 5 }, () => search('x')));
    expect(verdicts.slice(2).every((v) => v.stop)).toBe(true);
    expect(stopOf(verdicts[4]).evidence).toMatchObject({ count: 5 });
  });

  it('ignores argument key order', () => {
    const verdicts = feed(createGuard(only()), [
      step(call('t', { a: 1, b: { c: 2, d: 3 } })),
      step(call('t', { b: { d: 3, c: 2 }, a: 1 })),
      step(call('t', { a: 1, b: { c: 2, d: 3 } })),
    ]);
    expect(firstStop(verdicts)).toBe(2);
  });

  it('does not stop when the arguments differ', () => {
    const verdicts = feed(createGuard(only()), [search('a'), search('b'), search('c'), search('d')]);
    expect(firstStop(verdicts)).toBe(-1);
  });

  it('does not stop when only the tool name differs', () => {
    const verdicts = feed(createGuard(only()), [
      step(call('a', { q: 1 })),
      step(call('b', { q: 1 })),
      step(call('c', { q: 1 })),
    ]);
    expect(firstStop(verdicts)).toBe(-1);
  });

  it('a different call in between restarts the count', () => {
    const verdicts = feed(createGuard(only()), [search('x'), search('x'), search('y'), search('x'), search('x')]);
    expect(firstStop(verdicts)).toBe(-1);
  });

  it('steps with no tool calls neither extend nor break a run', () => {
    const verdicts = feed(createGuard(only()), [search('x'), { text: 'hmm' }, search('x'), {}, search('x')]);
    expect(firstStop(verdicts)).toBe(4);
  });

  it('counts parallel identical calls inside one step one by one', () => {
    const v = feed(createGuard(only()), [step(call('t', 1), call('t', 1), call('t', 1))]);
    expect(firstStop(v)).toBe(0);
  });

  it('notices a run that reaches the threshold mid-step even if a later call ends it', () => {
    const v = feed(createGuard(only()), [step(call('t', 1), call('t', 1), call('t', 1), call('u', 2))]);
    expect(firstStop(v)).toBe(0);
  });

  it('treats undefined, null and missing args consistently', () => {
    const noArgs = feed(createGuard(only()), [step(call('t')), step(call('t', undefined)), step(call('t', undefined))]);
    expect(firstStop(noArgs)).toBe(2);
    const nullVsUndefined = feed(createGuard(only()), [step(call('t', null)), step(call('t')), step(call('t', null))]);
    expect(firstStop(nullVsUndefined)).toBe(-1);
  });

  it('handles awkward argument values without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['me'] = circular;
    const awkward = { n: NaN, big: 10n, d: new Date(0), m: new Map([[1, 2]]), s: new Set([1]), circular };
    const v = feed(createGuard(only()), [step(call('t', awkward)), step(call('t', awkward)), step(call('t', awkward))]);
    expect(firstStop(v)).toBe(2);
  });

  it('compares very large arguments by hash', () => {
    const big = (last: number) => ({ rows: Array.from({ length: 20_000 }, (_, i) => (i === 19_999 ? last : i)) });
    const same = feed(createGuard(only()), [step(call('t', big(1))), step(call('t', big(1))), step(call('t', big(1)))]);
    expect(firstStop(same)).toBe(2);
    const differ = feed(createGuard(only()), [step(call('t', big(1))), step(call('t', big(2))), step(call('t', big(3)))]);
    expect(firstStop(differ)).toBe(-1);
  });

  describe('requireIdenticalResults', () => {
    const poll = (result: unknown) => step(call('status', { job: 7 }, { result }));

    it('is off by default: identical calls stop even when results change', () => {
      const v = feed(createGuard(only()), [poll('queued'), poll('running'), poll('done')]);
      expect(firstStop(v)).toBe(2);
    });

    it('lets polling with changing results through', () => {
      const v = feed(createGuard(only({ requireIdenticalResults: true })), [
        poll('queued'),
        poll('running'),
        poll('running 50%'),
        poll('done'),
      ]);
      expect(firstStop(v)).toBe(-1);
    });

    it('still stops when the results are identical too', () => {
      const v = feed(createGuard(only({ requireIdenticalResults: true })), [poll('queued'), poll('queued'), poll('queued')]);
      expect(firstStop(v)).toBe(2);
      expect(stopOf(v[2]).evidence).toMatchObject({ identicalResults: true });
      expect(stopOf(v[2]).detail).toContain('identical results');
    });

    it('a change of result restarts the run', () => {
      const v = feed(createGuard(only({ requireIdenticalResults: true })), [
        poll('a'),
        poll('a'),
        poll('b'),
        poll('b'),
        poll('b'),
      ]);
      expect(firstStop(v)).toBe(4);
    });
  });

  describe('ignoreErrors', () => {
    const failing = () => step(call('fetch', { url: 'u' }, { error: new Error('503') }));
    it('counts failed calls by default (a stuck retry loop stops)', () => {
      expect(firstStop(feed(createGuard(only()), [failing(), failing(), failing()]))).toBe(2);
    });
    it('drops failed calls from the sequence when set', () => {
      expect(firstStop(feed(createGuard(only({ ignoreErrors: true })), [failing(), failing(), failing(), failing()]))).toBe(-1);
    });
    it('failed calls do not break a run of successful ones', () => {
      const ok = () => step(call('fetch', { url: 'u' }, { result: 'ok' }));
      const v = feed(createGuard(only({ ignoreErrors: true })), [ok(), failing(), ok(), failing(), ok()]);
      expect(firstStop(v)).toBe(4);
    });
  });

  it('can be disabled', () => {
    const v = feed(createGuard({ ...ONLY }), Array.from({ length: 20 }, () => search('x')));
    expect(firstStop(v)).toBe(-1);
  });

  it.each([1, 0, 2.5, -3])('rejects threshold %s', (threshold) => {
    expect(() => createGuard({ repeatedToolCall: { threshold } })).toThrow(/repeatedToolCall.threshold/);
  });
});

// ---------------------------------------------------------------------------
describe('oscillation', () => {
  const only = (opts: GuardOptions['oscillation'] = {}): GuardOptions => ({ ...ONLY, oscillation: opts });
  const A = () => step(call('a', 1));
  const B = () => step(call('b', 2));
  const C = () => step(call('c', 3));
  const seq = (pattern: string, repeats: number): GuardStep[] =>
    Array.from({ length: repeats }, () => [...pattern].map((ch) => step(call(ch, ch)))).flat();

  it('A,B,A,B has only two repeats: continue; A,B,A,B,A,B stops', () => {
    expect(firstStop(feed(createGuard(only()), [A(), B(), A(), B()]))).toBe(-1);
    const v = feed(createGuard(only()), [A(), B(), A(), B(), A(), B()]);
    expect(firstStop(v)).toBe(5);
    const stop = stopOf(v[5]);
    expect(stop.reason).toBe('oscillation');
    expect(stop.code).toBe('OSCILLATION');
    expect(stop.evidence).toMatchObject({ period: 2, repeats: 3, threshold: 3 });
  });

  it('also fires when the cycle is entered mid-way (B,A,B,A,B,A)', () => {
    expect(firstStop(feed(createGuard(only()), [B(), A(), B(), A(), B(), A()]))).toBe(5);
  });

  it.each([
    { name: 'period 3 (A,B,C x3)', pattern: 'abc', repeats: 3, options: {}, expected: 8 },
    { name: 'period 3 x2 only', pattern: 'abc', repeats: 2, options: {}, expected: -1 },
    { name: 'period 3 ignored when maxPeriod is 2', pattern: 'abc', repeats: 5, options: { maxPeriod: 2 }, expected: -1 },
    { name: 'period 4 found with maxPeriod 4', pattern: 'abcd', repeats: 3, options: { maxPeriod: 4 }, expected: 11 },
    { name: 'period 4 missed with the default maxPeriod', pattern: 'abcd', repeats: 3, options: {}, expected: -1 },
    { name: 'repeats: 2', pattern: 'ab', repeats: 2, options: { repeats: 2 }, expected: 3 },
    { name: 'repeats: 5 needs five', pattern: 'ab', repeats: 4, options: { repeats: 5 }, expected: -1 },
    { name: 'repeats: 5 fires on the fifth', pattern: 'ab', repeats: 5, options: { repeats: 5 }, expected: 9 },
    { name: 'a cycle with a repeated member (A,A,B x3)', pattern: 'aab', repeats: 3, options: {}, expected: 8 },
  ])('$name', ({ pattern, repeats, options, expected }) => {
    expect(firstStop(feed(createGuard(only(options)), seq(pattern, repeats)))).toBe(expected);
  });

  it('is not triggered by one call repeated (that is repeatedToolCall)', () => {
    expect(firstStop(feed(createGuard(only()), Array.from({ length: 12 }, () => A())))).toBe(-1);
  });

  it('is not triggered when the arguments change within the pattern', () => {
    const v = feed(
      createGuard(only()),
      [1, 2, 3, 4, 5, 6].map((i) => step(call(i % 2 === 0 ? 'a' : 'b', i))),
    );
    expect(firstStop(v)).toBe(-1);
  });

  it('is not triggered by a near miss (A,B,A,B,A,C)', () => {
    expect(firstStop(feed(createGuard(only()), [A(), B(), A(), B(), A(), C()]))).toBe(-1);
  });

  it('works across parallel calls inside steps', () => {
    const v = feed(createGuard(only()), [step(call('a', 1), call('b', 2)), step(call('a', 1), call('b', 2)), step(call('a', 1), call('b', 2))]);
    expect(firstStop(v)).toBe(2);
  });

  it('reports the cycle as readable labels', () => {
    const v = feed(createGuard(only()), seq('ab', 3));
    const evidence = stopOf(v[5]).evidence as { cycle: string[] };
    expect(evidence.cycle).toEqual(['a("a")', 'b("b")']);
    expect(stopOf(v[5]).detail).toContain('a("a") -> b("b")');
  });

  it('still works after the history window has been trimmed', () => {
    const noise = Array.from({ length: 5000 }, (_, i) => step(call('n', i)));
    const v = feed(createGuard(only()), [...noise, ...seq('ab', 3)]);
    expect(firstStop(v)).toBe(5000 + 5);
  });

  it('can be disabled and validates its options', () => {
    expect(firstStop(feed(createGuard({ ...ONLY }), seq('ab', 10)))).toBe(-1);
    expect(() => createGuard({ oscillation: { maxPeriod: 1 } })).toThrow(/oscillation.maxPeriod/);
    expect(() => createGuard({ oscillation: { repeats: 1 } })).toThrow(/oscillation.repeats/);
  });
});

// ---------------------------------------------------------------------------
describe('noProgress', () => {
  const only = (opts: GuardOptions['noProgress'] = {}): GuardOptions => ({ ...ONLY, noProgress: opts });
  const say = (text: string): GuardStep => ({ text });

  it.each([
    { threshold: undefined, n: 3 },
    { threshold: 2, n: 2 },
    { threshold: 4, n: 4 },
  ])('threshold $threshold: N-1 identical text-only steps continue, N stop', ({ threshold, n }) => {
    const options = threshold === undefined ? only() : only({ threshold });
    const v = feed(createGuard(options), Array.from({ length: n + 1 }, () => say('I will keep trying.')));
    expect(firstStop(v)).toBe(n - 1);
    const stop = stopOf(v[n - 1]);
    expect(stop.reason).toBe('no-progress');
    expect(stop.code).toBe('NO_PROGRESS');
    expect(stop.evidence).toMatchObject({ steps: n, threshold: n, textPreview: 'i will keep trying.' });
  });

  it('normalises whitespace and case', () => {
    const v = feed(createGuard(only()), [say('Hello   World'), say('hello world '), say('\nHELLO\tWORLD')]);
    expect(firstStop(v)).toBe(2);
  });

  it('different text resets the streak', () => {
    const v = feed(createGuard(only()), [say('a'), say('a'), say('b'), say('b'), say('a')]);
    expect(firstStop(v)).toBe(-1);
  });

  it('new tool results are progress even if the text is identical', () => {
    const v = feed(
      createGuard(only()),
      [1, 2, 3, 4, 5].map((i) => ({ text: 'working', toolCalls: [call('read', { page: i }, { result: `page ${i}` })] })),
    );
    expect(firstStop(v)).toBe(-1);
  });

  it('a new result for the same call is progress', () => {
    const v = feed(
      createGuard(only()),
      ['queued', 'running', 'done'].map((r) => ({ text: 'waiting', toolCalls: [call('status', { id: 1 }, { result: r })] })),
    );
    expect(firstStop(v)).toBe(-1);
  });

  it('the same call returning the same result again is no progress', () => {
    const same = (): GuardStep => ({ text: 'waiting', toolCalls: [call('status', { id: 1 }, { result: 'queued' })] });
    // First occurrence is new (progress); the next three are stalled.
    const v = feed(createGuard(only()), [same(), same(), same(), same()]);
    expect(firstStop(v)).toBe(3);
  });

  it('without results, a call with new arguments counts as progress', () => {
    const v = feed(
      createGuard(only()),
      [1, 2, 3, 4].map((i) => ({ text: '', toolCalls: [call('search', { q: i })] })),
    );
    expect(firstStop(v)).toBe(-1);
  });

  it('empty text with no new outcomes still counts as no progress', () => {
    const v = feed(createGuard(only()), [{}, {}, {}]);
    expect(firstStop(v)).toBe(2);
    expect(stopOf(v[2]).detail).toContain('no text');
  });

  it('errors are results too', () => {
    const failed = (msg: string): GuardStep => ({ text: 'retrying', toolCalls: [call('t', 1, { error: new Error(msg) })] });
    expect(firstStop(feed(createGuard(only()), [failed('a'), failed('b'), failed('c'), failed('d')]))).toBe(-1);
    expect(firstStop(feed(createGuard(only()), [failed('a'), failed('a'), failed('a'), failed('a')]))).toBe(3);
  });

  it('can be disabled and validates its options', () => {
    expect(firstStop(feed(createGuard({ ...ONLY }), Array.from({ length: 10 }, () => say('x'))))).toBe(-1);
    expect(() => createGuard({ noProgress: { threshold: 1 } })).toThrow(/noProgress.threshold/);
  });
});

// ---------------------------------------------------------------------------
describe('finishReason', () => {
  const only = (opts: GuardOptions['finishReason'] = {}): GuardOptions => ({ ...ONLY, finishReason: opts });
  const verdictFor = (options: GuardOptions['finishReason'], s: GuardStep) => createGuard(only(options)).check(s);

  describe('terminal reasons always stop', () => {
    it.each(['stop', 'length', 'content-filter', 'error', 'STOP', 'content_filter', ' Error '])('%s', (finishReason) => {
      const v = stopOf(verdictFor({}, { finishReason }));
      expect(v.reason).toBe('finish-reason');
      expect(v.code).toBe('FINISH_TERMINAL');
      expect(v.evidence).toMatchObject({ finishReason, policy: 'terminal' });
    });

    it('even with tool calls present', () => {
      expect(verdictFor({}, { finishReason: 'length', toolCalls: [call('t')] }).stop).toBe(true);
    });
  });

  describe('tool-calls and a missing finish reason never stop', () => {
    it.each([undefined, '', '   ', 'tool-calls', 'tool_calls', 'TOOL-CALLS'])('%j', (finishReason) => {
      for (const policy of ['stop', 'continue', 'stop-if-text-only'] as const) {
        const v = verdictFor({ otherPolicy: policy }, { finishReason, text: 'hi' });
        expect(v.stop).toBe(false);
      }
    });
  });

  describe('otherPolicy matrix', () => {
    // [description, step, expected stop for 'stop', 'continue', 'stop-if-text-only']
    const cases: Array<[string, GuardStep, [boolean, boolean, boolean]]> = [
      ['text only', { text: 'final answer' }, [true, false, true]],
      ['text and tool calls', { text: 'calling', toolCalls: [call('t')] }, [true, false, false]],
      ['tool calls only', { toolCalls: [call('t')] }, [true, false, false]],
      ['nothing at all', {}, [true, false, false]],
      ['whitespace-only text', { text: '  \n ' }, [true, false, false]],
    ];
    for (const reason of ['other', 'unknown', 'end_turn', 'something-new']) {
      describe(`finishReason "${reason}"`, () => {
        it.each(cases)('%s', (_name, base, [stopP, continueP, textOnlyP]) => {
          const s: GuardStep = { ...base, finishReason: reason };
          expect(verdictFor({ otherPolicy: 'stop' }, s).stop).toBe(stopP);
          expect(verdictFor({ otherPolicy: 'continue' }, s).stop).toBe(continueP);
          expect(verdictFor({ otherPolicy: 'stop-if-text-only' }, s).stop).toBe(textOnlyP);
          expect(verdictFor({}, s).stop).toBe(textOnlyP); // the default policy
        });
      });
    }

    it('reports distinct codes for each rule', () => {
      const textOnly = { finishReason: 'other', text: 'hello' };
      expect(stopOf(verdictFor({ otherPolicy: 'stop' }, textOnly)).code).toBe('FINISH_OTHER');
      const v = stopOf(verdictFor({}, textOnly));
      expect(v.code).toBe('FINISH_OTHER_TEXT_ONLY');
      expect(v.evidence).toEqual({
        finishReason: 'other',
        normalized: 'other',
        policy: 'other-text-only',
        hasText: true,
        toolCallCount: 0,
      });
    });
  });

  describe('custom terminal list', () => {
    it('replaces the default list', () => {
      const options = { terminal: ['end_turn'] };
      expect(verdictFor(options, { finishReason: 'end_turn' }).stop).toBe(true);
      expect(verdictFor(options, { finishReason: 'END-TURN' }).stop).toBe(true);
      // 'stop' is no longer terminal; it falls under otherPolicy (text-only default).
      expect(verdictFor(options, { finishReason: 'stop', toolCalls: [call('t')] }).stop).toBe(false);
      expect(verdictFor(options, { finishReason: 'stop', text: 'x' }).stop).toBe(true);
    });

    it('an empty list leaves only otherPolicy and tool-calls', () => {
      expect(verdictFor({ terminal: [], otherPolicy: 'continue' }, { finishReason: 'stop', text: 'x' }).stop).toBe(false);
    });
  });

  it('can be disabled and validates otherPolicy', () => {
    expect(createGuard({ ...ONLY }).check({ finishReason: 'error' }).stop).toBe(false);
    expect(() => createGuard({ finishReason: { otherPolicy: 'bogus' as never } })).toThrow(/otherPolicy/);
  });
});
