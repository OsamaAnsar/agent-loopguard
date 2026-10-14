import { describe, expect, expectTypeOf, it } from 'vitest';
import { MAX_WINDOW_SIZE, createGuard, explain, feedbackFor, isFault, restoreGuard } from '../src/index';
import type { Guard, GuardOptions, GuardStep, GuardToolCall, Preflight, PreflightDeny, ToolPolicy, Verdict } from '../src/index';
import { call, feed, firstStop, mulberry32, step } from './helpers';

/** Options that switch every detector off, so a test can enable exactly one. */
const ONLY: GuardOptions = {
  maxSteps: false,
  repeatedToolCall: false,
  oscillation: false,
  noProgress: false,
  finishReason: false,
};

const windowed = (size: number, maxRepeats: number, extra: Partial<NonNullable<GuardOptions['repeatedToolCall'] & object>> = {}): GuardOptions => ({
  ...ONLY,
  repeatedToolCall: { window: { size, maxRepeats }, ...extra },
});

/** One step per call name; arguments are the name itself, so equal names are equal calls. */
const named = (names: string): GuardStep[] => [...names].map((n) => step(call(n, n)));

function stopOf(verdict: Verdict | undefined) {
  if (verdict === undefined || !verdict.stop) throw new Error('expected a stop verdict');
  return verdict;
}

function denied(result: Preflight): PreflightDeny {
  if (result.allow) throw new Error('expected a denial');
  return result;
}

// ---------------------------------------------------------------------------
describe('window: validation', () => {
  it.each([
    { name: 'size: 1', window: { size: 1, maxRepeats: 2 }, message: /window\.size must be an integer from 2 to 1000, got 1/ },
    { name: 'size: 1001', window: { size: 1001, maxRepeats: 2 }, message: /window\.size must be an integer from 2 to 1000, got 1001/ },
    { name: 'size: 1.5', window: { size: 1.5, maxRepeats: 2 }, message: /window\.size/ },
    { name: 'size: "10"', window: { size: '10', maxRepeats: 2 }, message: /window\.size/ },
    { name: 'size missing', window: { maxRepeats: 2 }, message: /window\.size must be an integer from 2 to 1000, got undefined/ },
    { name: 'maxRepeats: 1', window: { size: 10, maxRepeats: 1 }, message: /window\.maxRepeats must be an integer from 2 to 10, got 1/ },
    { name: 'maxRepeats above size', window: { size: 4, maxRepeats: 5 }, message: /window\.maxRepeats must be an integer from 2 to 4, got 5/ },
    { name: 'maxRepeats: NaN', window: { size: 10, maxRepeats: NaN }, message: /window\.maxRepeats/ },
    { name: 'maxRepeats missing', window: { size: 10 }, message: /window\.maxRepeats/ },
    { name: 'a misspelt option', window: { size: 10, maxRepeats: 3, maxrepeats: 4 }, message: /unknown option "maxrepeats" \(known: size, maxRepeats, warnAt\)/ },
    { name: 'a number', window: 5, message: /window must be an object with size and maxRepeats, or false/ },
    { name: 'null', window: null, message: /window must be an object/ },
    { name: 'an array', window: [10, 3], message: /window must be an object/ },
  ])('rejects $name', ({ window, message }) => {
    const options = { repeatedToolCall: { window } } as unknown as GuardOptions;
    expect(() => createGuard(options)).toThrow(TypeError);
    expect(() => createGuard(options)).toThrow(message);
    expect(() => createGuard(options)).toThrow(/^agent-loopguard: /);
  });

  it('accepts the largest size, the smallest window, window: false and no window', () => {
    expect(MAX_WINDOW_SIZE).toBe(1000);
    expect(() => createGuard(windowed(MAX_WINDOW_SIZE, MAX_WINDOW_SIZE))).not.toThrow();
    expect(() => createGuard(windowed(2, 2))).not.toThrow();
    expect(() => createGuard({ repeatedToolCall: { window: false } })).not.toThrow();
    expect(() => createGuard({ repeatedToolCall: { window: undefined } })).not.toThrow();
  });

  it('is off by default: the same trace that the window stops runs on without it', () => {
    const trace = named('xaxbx');
    expect(firstStop(feed(createGuard({ ...ONLY, repeatedToolCall: {} }), trace))).toBe(-1);
    expect(firstStop(feed(createGuard({ ...ONLY, repeatedToolCall: { window: false } }), trace))).toBe(-1);
    expect(firstStop(feed(createGuard(windowed(5, 3)), trace))).toBe(4);
  });

  it('has no effect when repeatedToolCall is disabled', () => {
    expect(firstStop(feed(createGuard({ ...ONLY }), named('xaxbxcxdx')))).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
describe('window: detection', () => {
  it('stops a loop whose repeats are not consecutive', () => {
    const verdicts = feed(createGuard(windowed(8, 3)), [
      step(call('search', { q: 'x' })),
      step(call('read', { path: 'a' })),
      step(call('search', { q: 'x' })),
      step(call('read', { path: 'b' })),
      step(call('search', { q: 'x' })),
    ]);
    expect(firstStop(verdicts)).toBe(4);
    const v = stopOf(verdicts[4]);
    expect(v.reason).toBe('repeated-tool-call-window');
    expect(v.code).toBe('REPEATED_TOOL_CALL_WINDOW');
    expect(v.evidence).toEqual({
      tool: 'search',
      argsPreview: '{"q":"x"}',
      count: 3,
      threshold: 3,
      windowSize: 8,
      windowCalls: 5,
      identicalResults: false,
    });
    expect(v.detail).toBe('Tool "search" was called 3 times with identical arguments within the last 8 calls: search({"q":"x"}).');
    expect(isFault(v)).toBe(true);
  });

  it.each([2, 3, 4, 6])('maxRepeats %i: N-1 occurrences continue, the Nth stops', (n) => {
    const names = Array.from({ length: n }, () => 'x').join('o'); // x o x o x ...
    const verdicts = feed(createGuard(windowed(20, n)), named(names));
    expect(firstStop(verdicts)).toBe(names.length - 1);
    expect(stopOf(verdicts[names.length - 1]).evidence).toMatchObject({ count: n, threshold: n });
  });

  it('only looks at the newest `size` calls: a repeat that has slid out no longer counts', () => {
    // x at calls 0, 3 and 5. Looking at six calls sees all three; five calls miss the first one.
    const trace = named('xabxcx');
    expect(firstStop(feed(createGuard(windowed(6, 3)), trace))).toBe(5);
    expect(firstStop(feed(createGuard(windowed(5, 3)), trace))).toBe(-1);
    // Exactly at the edge: the oldest call in a full window still counts.
    expect(firstStop(feed(createGuard(windowed(5, 3)), named('xabxx')))).toBe(4);
    expect(firstStop(feed(createGuard(windowed(5, 3)), named('xabcxx')))).toBe(-1);
  });

  it('forgets: a call that was frequent long ago is not held against the agent', () => {
    const trace = named(`xx${'abcdefgh'.repeat(3)}x`);
    expect(firstStop(feed(createGuard(windowed(10, 3)), trace))).toBe(-1);
  });

  it('counts different arguments and different tools separately, and ignores key order', () => {
    expect(firstStop(feed(createGuard(windowed(10, 3)), [1, 2, 3, 4, 5, 6].map((i) => step(call('search', { q: i })))))).toBe(-1);
    const mixed = [step(call('a', 1)), step(call('b', 1)), step(call('a', 1)), step(call('b', 1))];
    expect(firstStop(feed(createGuard(windowed(10, 3)), mixed))).toBe(-1);
    const reordered = [step(call('t', { a: 1, b: 2 })), step(call('o')), step(call('t', { b: 2, a: 1 })), step(call('o', 2)), step(call('t', { a: 1, b: 2 }))];
    expect(firstStop(feed(createGuard(windowed(10, 3)), reordered))).toBe(4);
  });

  it('counts parallel calls in one step one by one, and steps without calls do not matter', () => {
    const verdict = createGuard(windowed(10, 3)).check(step(call('t', 1), call('o', 1), call('t', 1), call('o', 2), call('t', 1)));
    expect(stopOf(verdict).evidence).toMatchObject({ tool: 't', count: 3, windowCalls: 5 });
    const guard = createGuard(windowed(10, 3));
    const verdicts = feed(guard, [step(call('t', 1)), { text: 'thinking' }, step(call('t', 1)), {}, step(call('t', 1))]);
    expect(firstStop(verdicts)).toBe(4);
  });

  it('keeps stopping while the window still holds enough repeats', () => {
    const verdicts = feed(createGuard(windowed(6, 3)), named('xaxbxcxdx'));
    expect(verdicts.map((v) => v.stop)).toEqual([false, false, false, false, true, false, true, false, true]);
  });

  it('the consecutive rule is reported first when both would stop, the window when it stops first', () => {
    const both = feed(createGuard({ ...ONLY, repeatedToolCall: { threshold: 3, window: { size: 10, maxRepeats: 3 } } }), named('xxx'));
    expect(stopOf(both[2]).reason).toBe('repeated-tool-call');
    const earlier = feed(createGuard({ ...ONLY, repeatedToolCall: { threshold: 3, window: { size: 10, maxRepeats: 2 } } }), named('xax'));
    expect(stopOf(earlier[2]).reason).toBe('repeated-tool-call-window');
    // ...and consecutive repeats count towards the window as well.
    const run = feed(createGuard({ ...ONLY, repeatedToolCall: { threshold: 5, window: { size: 10, maxRepeats: 2 } } }), named('xx'));
    expect(stopOf(run[1]).reason).toBe('repeated-tool-call-window');
  });

  it('both rules keep their own state even when the other one stops', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 3, window: { size: 10, maxRepeats: 4 } } });
    feed(guard, named('xxx'));
    expect(guard.summary().detectors.repeatedToolCall).toMatchObject({
      currentRun: { tool: 'x', length: 3 },
      window: { size: 10, maxRepeats: 4, calls: 3, highestCount: 3 },
    });
  });
});

// ---------------------------------------------------------------------------
describe('window: per-tool policies and options', () => {
  const tools = (map: Record<string, ToolPolicy>, size = 10, maxRepeats = 3, extra: GuardOptions['repeatedToolCall'] = {}): GuardOptions => ({
    ...ONLY,
    tools: map,
    repeatedToolCall: { window: { size, maxRepeats }, ...extra },
  });
  const poll = (result: unknown): GuardStep => step(call('poll', { job: 7 }, { result }));
  const other = (i: number): GuardStep => step(call('other', i));

  it('ignore: an ignored tool is invisible to the window, in either direction', () => {
    const trace = [1, 2, 3, 4, 5].map((i) => step(call('think', 'same'), call('other', i)));
    expect(firstStop(feed(createGuard(windowed(10, 3)), trace))).toBe(2);
    expect(firstStop(feed(createGuard(tools({ think: { ignore: true } })), trace))).toBe(-1);
    // Ignored calls do not push real calls out of the window either.
    const crowded = [step(call('x', 1)), ...Array.from({ length: 8 }, (_, i) => step(call('think', i))), step(call('x', 1)), step(call('x', 1))];
    expect(firstStop(feed(createGuard(tools({ think: { ignore: true } }, 3, 3)), crowded))).toBe(10);
  });

  it('polling: the window counts identical outcomes, so a changing result is never a repeat', () => {
    const changing = [0, 1, 2, 3, 4, 5].flatMap((i) => [poll(`r${i}`), other(i)]);
    expect(firstStop(feed(createGuard(tools({ poll: { polling: true } })), changing))).toBe(-1);
    expect(firstStop(feed(createGuard(tools({})), changing))).toBe(4); // without the policy, three polls in ten calls
    const stuck = [0, 1, 2, 3].flatMap((i) => [poll('pending'), other(i)]);
    const verdicts = feed(createGuard(tools({ poll: { polling: true } })), stuck);
    expect(firstStop(verdicts)).toBe(4);
    expect(stopOf(verdicts[4]).evidence).toMatchObject({ tool: 'poll', count: 3, identicalResults: true });
    expect(stopOf(verdicts[4]).detail).toContain('identical results');
  });

  it('a tool\'s polling.maxIdenticalResults and repeatThreshold replace maxRepeats for that tool', () => {
    const stuck = (n: number) => Array.from({ length: n }, (_, i) => [poll('pending'), other(i)]).flat();
    expect(firstStop(feed(createGuard(tools({ poll: { polling: { maxIdenticalResults: 5 } } })), stuck(6)))).toBe(8);
    expect(firstStop(feed(createGuard(tools({ poll: { polling: true, repeatThreshold: 2 } })), stuck(4)))).toBe(2);
    expect(firstStop(feed(createGuard(tools({ poll: { polling: { maxIdenticalResults: 2 }, repeatThreshold: 6 } })), stuck(4)))).toBe(2);

    const slow = [0, 1, 2, 3, 4].flatMap((i) => [step(call('x', 'x')), other(i)]);
    expect(firstStop(feed(createGuard(tools({ x: { repeatThreshold: 5 } }, 12, 3)), slow))).toBe(8); // five x in nine calls
    expect(firstStop(feed(createGuard(tools({ x: { repeatThreshold: 2 } }, 12, 4)), slow))).toBe(2);
    expect(firstStop(feed(createGuard(tools({ y: { repeatThreshold: 2 } }, 12, 4)), slow))).toBe(6);
  });

  it('requireIdenticalResults applies to the window too', () => {
    const options = tools({}, 10, 3, { requireIdenticalResults: true });
    const changing = [0, 1, 2, 3].flatMap((i) => [step(call('t', 1, { result: i })), other(i)]);
    expect(firstStop(feed(createGuard(options), changing))).toBe(-1);
    const same = [0, 1, 2].flatMap((i) => [step(call('t', 1, { result: 'same' })), other(i)]);
    expect(firstStop(feed(createGuard(options), same))).toBe(4);
  });

  it('ignoreErrors: failed calls are left out of the window', () => {
    const failing = (): GuardStep => step(call('t', 1, { error: 'boom' }));
    const trace = [step(call('t', 1)), failing(), other(1), failing(), step(call('t', 1)), other(2), failing()];
    expect(firstStop(feed(createGuard(tools({}, 10, 3, { ignoreErrors: true })), trace))).toBe(-1);
    expect(firstStop(feed(createGuard(tools({}, 10, 3)), trace))).toBe(3);
  });

  it('maxCalls, tool caps and the other rules are independent of it', () => {
    const options: GuardOptions = { ...windowed(10, 3), tools: { t: { maxCalls: 2 } } };
    const verdicts = feed(createGuard(options), named('tot').concat(named('t')));
    expect(stopOf(verdicts[3]).reason).toBe('tool-limit'); // the cap comes first
  });
});

// ---------------------------------------------------------------------------
describe('window: verdicts and text', () => {
  const trip = (options = windowed(8, 3)): Verdict => stopOf(feed(createGuard(options), named('xaxbx')).pop());

  it('carries model-facing feedback that names the tool but never the arguments', () => {
    const guard = createGuard(windowed(8, 3));
    const secret = 'SENTINEL-sk-live-77';
    const verdicts = feed(guard, [1, 2, 3].flatMap((i) => [step(call('search', { token: secret })), step(call('read', i))]));
    const v = stopOf(verdicts[4]);
    expect(v.feedback).toBe(
      'You have called `search` 3 times with the same arguments within your last 8 calls, even with other calls in between. Repeating it is unlikely to give you anything new. Try a different tool or different arguments, or answer with what you have.',
    );
    expect(v.feedback).not.toContain(secret);
    expect(v.detail).toContain(secret); // the developer-facing text does show the preview
    expect(feedbackFor(v)).toBe(v.feedback);
  });

  it('mentions identical results when the rule needed them', () => {
    const guard = createGuard({ ...windowed(10, 3), tools: { poll: { polling: true } } });
    const verdicts = feed(guard, [0, 1, 2].flatMap((i) => [step(call('poll', 1, { result: 'pending' })), step(call('o', i))]));
    expect(stopOf(verdicts[4]).feedback).toContain('with the same arguments and got the same result each time within your last 10 calls');
  });

  it('is JSON-serialisable, and explain() has a hint for it', () => {
    const v = trip();
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    expect(explain(v)).toMatch(/^Stop \[REPEATED_TOOL_CALL_WINDOW\] .+\nHint: .+/);
  });

  it('narrows by reason in TypeScript, and the consecutive reason keeps its own evidence', () => {
    const v = trip();
    if (v.stop && v.reason === 'repeated-tool-call-window') {
      expectTypeOf(v.evidence.windowSize).toBeNumber();
      expectTypeOf(v.evidence.windowCalls).toBeNumber();
    } else {
      throw new Error('expected a window stop');
    }
    const w: Verdict = createGuard({ repeatedToolCall: { threshold: 2 } }).check(step(call('t'), call('t')));
    if (w.stop && w.reason === 'repeated-tool-call') expectTypeOf(w.evidence.stepIndexes).toEqualTypeOf<number[]>();
  });

  it('options.feedback can replace the text', () => {
    const guard = createGuard({ ...windowed(8, 3), feedback: (verdict) => (verdict.code === 'REPEATED_TOOL_CALL_WINDOW' ? 'Stop circling.' : undefined) });
    expect(stopOf(feed(guard, named('xaxbx')).pop()).feedback).toBe('Stop circling.');
  });
});

// ---------------------------------------------------------------------------
describe('window: preflight', () => {
  const call_ = (name: string): { name: string; args: string } => ({ name, args: name });

  it('allows a call that is the (maxRepeats-1)th occurrence and denies the one that would be the maxRepeats-th', () => {
    const guard = createGuard(windowed(8, 3));
    feed(guard, named('xa'));
    expect(guard.preflight(call_('x'))).toEqual({ allow: true }); // the second x
    feed(guard, named('xb'));
    const deny = denied(guard.preflight(call_('x')));
    expect(deny.reason).toBe('repeated-tool-call-window');
    expect(deny.code).toBe('REPEATED_TOOL_CALL_WINDOW');
    expect(deny.evidence).toMatchObject({ tool: 'x', count: 3, threshold: 3, windowSize: 8, windowCalls: 5 });
    expect(deny.detail).toContain('now would be call 3');
    expect(deny.feedback).toBe(
      'That call was not run: you have already called `x` 2 times with the same arguments within your last 8 calls, even with other calls in between, and repeating it is unlikely to give you anything new. Try a different tool or different arguments, or answer with what you have.',
    );
    expect(guard.preflight(call_('y')).allow).toBe(true);
  });

  it('records nothing: the window is the same after any number of preflights', () => {
    const guard = createGuard(windowed(8, 3));
    feed(guard, named('xaxb'));
    const before = JSON.stringify(guard.toJSON());
    for (let i = 0; i < 5; i += 1) guard.preflight([call_('x'), call_('y')]);
    expect(JSON.stringify(guard.toJSON())).toBe(before);
    expect(guard.check(step(call('x', 'x'))).stop).toBe(true); // check still sees the same state
  });

  it('judges parallel calls as one step, with the window sliding as the calls are added', () => {
    const guard = createGuard(windowed(4, 3));
    feed(guard, named('xax'));
    expect(guard.preflight([call_('x')]).allow).toBe(false); // x a x x: three in a window of four
    expect(guard.preflight([call_('b'), call_('x')]).allow).toBe(true); // x a x b x: the first x has slid out
    expect(guard.preflight([call_('x'), call_('x')]).allow).toBe(false);
  });

  it('never denies on a result-aware rule, because the result is not known yet', () => {
    const guard = createGuard({ ...windowed(10, 3), tools: { poll: { polling: true } } });
    feed(guard, [0, 1, 2, 3].flatMap((i) => [step(call('poll', 1, { result: 'pending' })), step(call('o', i))]));
    expect(guard.preflight({ name: 'poll', args: 1 }).allow).toBe(true);
    expect(guard.preflight([{ name: 'poll', args: 1 }, { name: 'poll', args: 1 }, { name: 'poll', args: 1 }]).allow).toBe(true);
    expect(guard.check(step(call('poll', 1, { result: 'pending' }))).stop).toBe(true);
  });

  it('does nothing when the window is off', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: {} });
    feed(guard, named('xaxbx'));
    expect(guard.preflight(call_('x')).allow).toBe(true);
  });

  it('agrees with check (property): a call is denied exactly when running it would trip a repeat rule', () => {
    const configs: Array<[string, () => GuardOptions]> = [
      ['window only', () => windowed(8, 3)],
      ['tight window with a longer run threshold', () => ({ ...ONLY, repeatedToolCall: { threshold: 4, window: { size: 5, maxRepeats: 2 } } })],
      [
        'per-tool policies',
        () => ({ ...windowed(10, 3), tools: { think: { ignore: true }, a: { repeatThreshold: 2 }, c: { maxCalls: 6 } } }),
      ],
    ];
    const names = ['a', 'b', 'c', 'think'];
    const randomCall = (rand: () => number): GuardToolCall => ({ name: names[Math.floor(rand() * names.length)] as string, args: Math.floor(rand() * 2) });
    let denials = 0;
    for (const [, makeOptions] of configs) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const rand = mulberry32(seed * 4421);
        const guard: Guard = createGuard(makeOptions());
        const trace: GuardStep[] = [];
        for (let i = 0; i < 40; i += 1) {
          const calls = Array.from({ length: 1 + Math.floor(rand() * 2) }, () => randomCall(rand));
          const pre = guard.preflight(calls);
          const twin = createGuard(makeOptions());
          feed(twin, trace);
          const v = twin.check({ toolCalls: calls });
          const trips = v.stop && (v.reason === 'repeated-tool-call' || v.reason === 'repeated-tool-call-window' || v.reason === 'tool-limit');
          expect(pre.allow).toBe(!trips);
          if (!pre.allow && v.stop) {
            expect(pre.reason).toBe(v.reason);
            expect(pre.evidence).toEqual(v.evidence);
            denials += 1;
          }
          const next: GuardStep = { toolCalls: calls };
          trace.push(next);
          guard.check(next);
        }
      }
    }
    expect(denials).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
describe('window: snapshots', () => {
  const options = (): GuardOptions => windowed(6, 3);

  it('holds the newest call hashes, oldest first, never more than `size` of them', () => {
    const guard = createGuard(options());
    expect(guard.toJSON().detectors.repeatedToolCall?.window).toEqual({ keys: [] });
    feed(guard, named('xaxbxcxdxexfxg'));
    const keys = guard.toJSON().detectors.repeatedToolCall?.window?.keys ?? [];
    expect(keys).toHaveLength(6);
    expect(keys.every((k) => /^[0-9a-f]{28}$/.test(k))).toBe(true);
    // Only the newest six calls matter: a fresh guard that saw just those has the same window.
    const fresh = createGuard(options());
    feed(fresh, named('xexfxg'));
    expect(fresh.toJSON().detectors.repeatedToolCall?.window?.keys).toEqual(keys);
  });

  it('has no window entry, and the same fingerprint as 0.2.0, when the window is off', () => {
    const snapshot = createGuard({ repeatedToolCall: {} }).toJSON();
    expect(snapshot.detectors.repeatedToolCall).not.toHaveProperty('window');
    expect(snapshot.options.repeatedToolCall).toBe(createGuard({ repeatedToolCall: { window: false } }).toJSON().options.repeatedToolCall);
    expect(snapshot.options.repeatedToolCall).not.toBe(createGuard(options()).toJSON().options.repeatedToolCall);
  });

  it('a restored guard counts the calls made before the snapshot', () => {
    const original = createGuard(options());
    feed(original, named('xaxb'));
    const restored = restoreGuard(JSON.parse(JSON.stringify(original.toJSON())), options());
    expect(restored.summary().detectors).toEqual(original.summary().detectors);
    const expected = original.check(step(call('x', 'x')));
    const actual = restored.check(step(call('x', 'x')));
    expect(actual).toEqual(expected);
    expect(actual).toMatchObject({ stop: true, reason: 'repeated-tool-call-window', evidence: { count: 3, windowCalls: 5 } });
    expect(restored.toJSON()).toEqual(original.toJSON());
  });

  it('a restored guard slides old calls out just like the original', () => {
    const original = createGuard(options());
    feed(original, named('xabcde')); // the x is the oldest of six
    const restored = restoreGuard(original.toJSON(), options());
    const tail = named('xx');
    expect(feed(restored, tail)).toEqual(feed(original, tail));
    expect(firstStop(feed(restored, named('x')))).toBe(0); // by now another x makes three in the window
  });

  it('refuses to restore under a different window, or with a window added or removed', () => {
    const snapshot = createGuard(options()).toJSON();
    for (const changed of [windowed(7, 3), windowed(6, 4), { ...ONLY, repeatedToolCall: {} }, { ...ONLY, repeatedToolCall: { window: false as const } }]) {
      expect(() => restoreGuard(snapshot, changed)).toThrow(/taken with different options \(.*repeatedToolCall.*\)/);
    }
    const plain = createGuard({ ...ONLY, repeatedToolCall: {} }).toJSON();
    expect(() => restoreGuard(plain, options())).toThrow(/different options \(.*repeatedToolCall.*\)/);
  });

  it.each([
    ['a missing window', (r: Record<string, unknown>) => delete r['window'], /repeatedToolCall\.window is missing/],
    ['a window that is not an object', (r: Record<string, unknown>) => (r['window'] = []), /window must be an object/],
    ['keys that are not an array', (r: Record<string, unknown>) => (r['window'] = { keys: 'abc' }), /window\.keys must be an array/],
    ['keys that are missing', (r: Record<string, unknown>) => (r['window'] = {}), /window\.keys is missing/],
    ['a key that is not a hash', (r: Record<string, unknown>) => (r['window'] = { keys: ['nope'] }), /window\.keys\[0\] must be a 28-character hex hash/],
    ['more keys than the window holds', (r: Record<string, unknown>) => (r['window'] = { keys: Array.from({ length: 7 }, () => 'a'.repeat(28)) }), /at most 6 entries/],
  ])('rejects %s', (_name, damage, message) => {
    const snapshot = structuredClone(createGuard(options()).toJSON()) as unknown as { detectors: { repeatedToolCall: Record<string, unknown> } };
    damage(snapshot.detectors.repeatedToolCall);
    expect(() => restoreGuard(snapshot, options())).toThrow(TypeError);
    expect(() => restoreGuard(snapshot, options())).toThrow(message);
  });

  it('leaves nothing half-restored when the window is bad: the error comes before any state changes', () => {
    const snapshot = structuredClone(createGuard(options()).toJSON()) as unknown as { detectors: { repeatedToolCall: Record<string, unknown> } };
    snapshot.detectors.repeatedToolCall['window'] = { keys: ['nope'] };
    expect(() => restoreGuard(snapshot, options())).toThrow(TypeError);
  });

  it('is bounded by the window, not by the run: memory and snapshot size stay put over thousands of distinct calls', () => {
    const run = (calls: number): number => {
      const guard = createGuard({ ...ONLY, maxSteps: false, repeatedToolCall: { window: { size: 50, maxRepeats: 5 } } });
      for (let i = 0; i < calls; i += 1) guard.check(step(call('tool', { n: i, blob: 'x'.repeat(500) })));
      const snapshot = guard.toJSON();
      expect(snapshot.detectors.repeatedToolCall?.window?.keys).toHaveLength(50);
      expect(guard.summary().detectors.repeatedToolCall?.window).toMatchObject({ calls: 50, highestCount: 1 });
      return JSON.stringify(snapshot).length;
    };
    expect(Math.abs(run(5000) - run(500))).toBeLessThan(64); // only the counters grow, by a digit or two
  });

  it('the largest window stays near 30 KB', () => {
    const guard = createGuard({ ...ONLY, maxSteps: false, repeatedToolCall: { window: { size: MAX_WINDOW_SIZE, maxRepeats: 3 } } });
    for (let i = 0; i < 2500; i += 1) guard.check(step(call('tool', i)));
    const size = JSON.stringify(guard.toJSON()).length;
    expect(size).toBeGreaterThan(29_000);
    expect(size).toBeLessThan(33_000);
  });

  it('reset() empties the window', () => {
    const guard = createGuard(options());
    feed(guard, named('xaxb'));
    guard.reset();
    expect(guard.toJSON()).toEqual(createGuard(options()).toJSON());
    expect(firstStop(feed(guard, named('xaxb')))).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
describe('window: summary', () => {
  it('shows the window only when there is one', () => {
    expect(createGuard({ repeatedToolCall: {} }).summary().detectors.repeatedToolCall).toEqual({ threshold: 3, currentRun: null, longestRun: 0 });
    const guard = createGuard(windowed(6, 3));
    feed(guard, named('xaxb'));
    expect(guard.summary().detectors.repeatedToolCall).toEqual({
      threshold: 3,
      currentRun: { tool: 'b', length: 1 },
      longestRun: 1,
      window: { size: 6, maxRepeats: 3, calls: 4, highestCount: 2 },
    });
    expect(JSON.parse(JSON.stringify(guard.summary()))).toEqual(guard.summary());
  });
});
