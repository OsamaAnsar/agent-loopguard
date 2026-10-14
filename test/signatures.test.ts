import { describe, expect, it } from 'vitest';
import { createGuard, restoreGuard } from '../src/index';
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

const SECRET = 'SENTINEL-sk-live-8842';

/** `search` calls that differ only in a timestamp and a request id. */
const fetchAt = (q: string, ts: number): GuardStep => step(call('fetch', { q, ts, requestId: `req-${ts}` }, { result: { status: 'ok', at: ts } }));

/** Ignore the volatile fields. */
const stable = (_tool: string, args: unknown): string => {
  const { q } = args as { q: string };
  return JSON.stringify({ q });
};

// ---------------------------------------------------------------------------
describe('signature: what makes two calls the same', () => {
  const trace = [fetchAt('cats', 1), fetchAt('cats', 2), fetchAt('cats', 3)];

  it('without it, calls that differ in a timestamp are different calls (as before)', () => {
    expect(firstStop(feed(createGuard({ ...ONLY, repeatedToolCall: {} }), trace))).toBe(-1);
  });

  it('with it, they are the same call, for the repeat, the window and the oscillation rules', () => {
    const verdicts = feed(createGuard({ ...ONLY, repeatedToolCall: {}, signature: stable }), trace);
    expect(firstStop(verdicts)).toBe(2);
    expect(verdicts[2]).toMatchObject({ reason: 'repeated-tool-call', evidence: { tool: 'fetch', argsPreview: '{"q":"cats"}', count: 3 } });

    const spaced = [fetchAt('cats', 1), step(call('other', 1)), fetchAt('cats', 2), step(call('other', 2)), fetchAt('cats', 3)];
    const windowed = feed(createGuard({ ...ONLY, repeatedToolCall: { window: { size: 6, maxRepeats: 3 } }, signature: stable }), spaced);
    expect(firstStop(windowed)).toBe(4);

    const cycle = ['a', 'b', 'a', 'b', 'a', 'b'].map((n, i) => step(call(n, { q: n, ts: i })));
    expect(firstStop(feed(createGuard({ ...ONLY, oscillation: {} }), cycle))).toBe(-1);
    expect(firstStop(feed(createGuard({ ...ONLY, oscillation: {}, signature: stable }), cycle))).toBe(5);
  });

  it('still tells different calls apart, and the tool name is always part of the comparison', () => {
    const different = [fetchAt('cats', 1), fetchAt('dogs', 2), fetchAt('cats', 3)];
    expect(firstStop(feed(createGuard({ ...ONLY, repeatedToolCall: {}, signature: stable }), different))).toBe(-1);
    const sameArgsOtherTools = ['a', 'b', 'c'].map((n) => step(call(n, { q: 'cats' })));
    expect(firstStop(feed(createGuard({ ...ONLY, repeatedToolCall: {}, signature: stable }), sameArgsOtherTools))).toBe(-1);
  });

  it('is called with the tool name and the arguments, once per call, and never for results', () => {
    const seen: Array<[string, unknown]> = [];
    const guard = createGuard({ signature: (tool, args) => (seen.push([tool, args]), `${tool}:${JSON.stringify(args)}`) });
    guard.check(step(call('t', { a: 1 }, { result: 'r' }), call('u')));
    expect(seen).toEqual([['t', { a: 1 }], ['u', undefined]]);
  });

  it('is used by preflight too, so a call is refused exactly when check would stop it', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 3 }, signature: stable });
    feed(guard, [fetchAt('cats', 1), fetchAt('cats', 2)]);
    expect(guard.preflight({ name: 'fetch', args: { q: 'cats', ts: 99 } })).toMatchObject({ allow: false, code: 'REPEATED_TOOL_CALL' });
    expect(guard.preflight({ name: 'fetch', args: { q: 'dogs', ts: 99 } }).allow).toBe(true);
  });

  it('keeps the preview short and never walks the arguments itself', () => {
    let reads = 0;
    const heavy = { get blob(): string { reads += 1; return 'x'.repeat(1000); }, id: 7 };
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 2 }, signature: (_t, a) => `id:${(a as { id: number }).id}:${'p'.repeat(200)}` });
    guard.check(step(call('t', heavy)));
    const v = guard.check(step(call('t', heavy)));
    expect(reads).toBe(0); // the default canonicalisation would have read it
    expect(v.stop && (v.evidence as { argsPreview: string }).argsPreview).toHaveLength(80);
  });
});

// ---------------------------------------------------------------------------
describe('resultSignature and errorSignature', () => {
  const poll = (at: number, status: string): GuardStep => step(call('poll', { job: 1 }, { result: { status, at } }));
  const statusOnly = (r: unknown): string => (r as { status: string }).status;

  it('resultSignature decides when results are identical (requireIdenticalResults)', () => {
    const trace = [poll(1, 'pending'), poll(2, 'pending'), poll(3, 'pending')];
    const base: GuardOptions = { ...ONLY, repeatedToolCall: { requireIdenticalResults: true } };
    expect(firstStop(feed(createGuard(base), trace))).toBe(-1);
    expect(firstStop(feed(createGuard({ ...base, resultSignature: statusOnly }), trace))).toBe(2);
    expect(firstStop(feed(createGuard({ ...base, resultSignature: statusOnly }), [poll(1, 'pending'), poll(2, 'running'), poll(3, 'pending')]))).toBe(-1);
  });

  it('resultSignature works for polling tools and for no-progress outcomes', () => {
    const polling = createGuard({ ...ONLY, repeatedToolCall: {}, tools: { poll: { polling: true } }, resultSignature: statusOnly });
    expect(firstStop(feed(polling, [poll(1, 'pending'), poll(2, 'pending'), poll(3, 'pending')]))).toBe(2);
    const progress = createGuard({ ...ONLY, noProgress: { threshold: 2 }, resultSignature: statusOnly });
    expect(progress.check({ text: 'same', toolCalls: [call('poll', 1, { result: { status: 'x', at: 1 } })] }).stop).toBe(false);
    expect(progress.check({ text: 'same', toolCalls: [call('poll', 1, { result: { status: 'x', at: 2 } })] }).stop).toBe(false); // stalled, streak 1
    expect(progress.check({ text: 'same', toolCalls: [call('poll', 1, { result: { status: 'x', at: 3 } })] }).stop).toBe(true);
  });

  it('errorSignature decides when two errors are the same, and is used only for failed calls', () => {
    const seen: unknown[] = [];
    const failing = (message: string, id: number): GuardStep => step(call('run', 1, { error: { message, id } }));
    const options: GuardOptions = {
      ...ONLY,
      repeatedToolCall: { requireIdenticalResults: true },
      errorSignature: (e) => (seen.push(e), (e as { message: string }).message),
      resultSignature: () => {
        throw new Error('not for errors');
      },
    };
    const guard = createGuard(options);
    expect(firstStop(feed(guard, [failing('timeout', 1), failing('timeout', 2), failing('timeout', 3)]))).toBe(2);
    expect(seen).toHaveLength(3);
    expect(guard.summary().signatures).toEqual({ failures: 0, lastFailure: null });
    expect(firstStop(feed(createGuard({ ...options }), [failing('a', 1), failing('b', 1), failing('a', 1)]))).toBe(-1);
    // Without it, errors are compared by their canonical form, which includes the id.
    const plain = createGuard({ ...ONLY, repeatedToolCall: { requireIdenticalResults: true } });
    expect(firstStop(feed(plain, [failing('timeout', 1), failing('timeout', 2), failing('timeout', 3)]))).toBe(-1);
  });

  it('the result function is not called when there is no result', () => {
    let calls = 0;
    const guard = createGuard({ resultSignature: () => (calls += 1, 'r') });
    guard.check(step(call('t', 1)));
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('signature functions that misbehave', () => {
  const repeats = (n: number): GuardStep[] => Array.from({ length: n }, () => step(call('t', { q: 1 }, { result: 'r' })));

  it.each([
    ['throws an Error', () => { throw new Error('bad field'); }, 'bad field'],
    ['throws a string', () => { throw 'oops'; }, 'oops'],
    ['throws something that cannot be printed', () => { throw Object.create(null) as unknown; }, 'an error that could not be read'],
    ['returns a number', () => 5 as unknown as string, 'returned number instead of a string'],
    ['returns undefined', () => undefined as unknown as string, 'returned undefined instead of a string'],
    ['returns null', () => null as unknown as string, 'returned null instead of a string'],
    ['returns an object', () => ({}) as unknown as string, 'returned object instead of a string'],
  ])('a signature function that %s falls back to the default form, never throws, and is counted', (_name, fn, message) => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: {}, signature: fn, resultSignature: fn, errorSignature: fn });
    let verdicts: Verdict[] = [];
    expect(() => {
      verdicts = feed(guard, repeats(3));
    }).not.toThrow();
    expect(firstStop(verdicts)).toBe(2); // detection still works, on the default canonical form
    const state = guard.summary().signatures;
    expect(state?.failures).toBe(6); // three calls, each with a failed signature and a failed result signature
    expect(state?.lastFailure).toBe(message);
    expect(JSON.parse(JSON.stringify(guard.summary()))).toEqual(guard.summary());
    guard.reset();
    expect(guard.summary().signatures).toEqual({ failures: 0, lastFailure: null });
  });

  it('a call whose function fails is compared by the default form, so it does not match a call that worked', () => {
    let first = true;
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 2 }, signature: () => { if (first) { first = false; throw new Error('once'); } return 'same'; } });
    expect(guard.check(step(call('t', 1))).stop).toBe(false);
    expect(guard.check(step(call('t', 1))).stop).toBe(false); // default form vs custom form
    expect(guard.check(step(call('t', 1))).stop).toBe(true);
    expect(guard.summary().signatures?.failures).toBe(1);
  });

  it('truncates a long failure message', () => {
    const guard = createGuard({ signature: () => { throw new Error('x'.repeat(500)); } });
    guard.check(step(call('t', 1)));
    expect(guard.summary().signatures?.lastFailure).toHaveLength(200);
  });

  it('summary has no signatures entry unless a function is set', () => {
    expect(createGuard().summary()).not.toHaveProperty('signatures');
    expect(createGuard({ signature: () => 'x' }).summary().signatures).toEqual({ failures: 0, lastFailure: null });
  });

  it.each(['signature', 'resultSignature', 'errorSignature'])('%s must be a function', (name) => {
    for (const bad of [5, 'x', {}, null]) {
      expect(() => createGuard({ [name]: bad } as GuardOptions)).toThrow(TypeError);
      expect(() => createGuard({ [name]: bad } as GuardOptions)).toThrow(new RegExp(`${name} must be a function`));
    }
    expect(() => createGuard({ [name]: undefined })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('signature functions and snapshots', () => {
  const trace = [fetchAt('cats', 1), fetchAt('cats', 2)];
  const options = (): GuardOptions => ({ repeatedToolCall: {}, signature: stable });

  it('the fingerprint has a signatures entry only when a function is set', () => {
    expect(createGuard().toJSON().options).not.toHaveProperty('signatures');
    const a = createGuard({ signature: stable }).toJSON().options.signatures;
    const b = createGuard({ resultSignature: () => 'x' }).toJSON().options.signatures;
    const c = createGuard({ signature: stable, errorSignature: () => 'x' }).toJSON().options.signatures;
    expect(new Set([a, b, c]).size).toBe(3);
    expect(createGuard({ signature: () => 'other function' }).toJSON().options.signatures).toBe(a); // only presence is checked
  });

  it('a restored guard with the same functions carries on exactly where the original was', () => {
    const original = createGuard(options());
    feed(original, trace);
    const restored = restoreGuard(JSON.parse(JSON.stringify(original.toJSON())), options());
    const next = fetchAt('cats', 3);
    const expected = original.check(next);
    expect(restored.check(next)).toEqual(expected);
    expect(expected).toMatchObject({ stop: true, reason: 'repeated-tool-call' });
    expect(restored.toJSON()).toEqual(original.toJSON());
  });

  it('refuses to restore without the functions, with others, or with them when the snapshot had none', () => {
    const original = createGuard(options());
    feed(original, trace);
    const snapshot = original.toJSON();
    expect(() => restoreGuard(snapshot, { repeatedToolCall: {} })).toThrow(/taken with different options \(signatures\)/);
    expect(() => restoreGuard(snapshot, { ...options(), resultSignature: () => 'x' })).toThrow(/different options \(signatures\)/);
    expect(() => restoreGuard(snapshot, { repeatedToolCall: {}, resultSignature: () => 'x' })).toThrow(/different options \(signatures\)/);
    const plain = createGuard({ repeatedToolCall: {} });
    feed(plain, trace);
    expect(() => restoreGuard(plain.toJSON(), options())).toThrow(/different options \(signatures\)/);
    expect(() => restoreGuard(plain.toJSON(), { repeatedToolCall: {} })).not.toThrow();
    // Named together with other differences, signatures last.
    expect(() => restoreGuard(snapshot, { repeatedToolCall: { threshold: 5 } })).toThrow('(repeatedToolCall, signatures)');
  });

  it('allowLimitChanges does not relax it, and a bad fingerprint value is rejected', () => {
    const snapshot = createGuard(options()).toJSON();
    expect(() => restoreGuard(snapshot, { repeatedToolCall: {} }, { allowLimitChanges: true })).toThrow(/signatures/);
    const bad = structuredClone(snapshot) as unknown as { options: Record<string, unknown> };
    bad.options['signatures'] = 5;
    expect(() => restoreGuard(bad, options())).toThrow(/snapshot\.options\.signatures must be a string/);
    bad.options['signatures'] = 'x'.repeat(65);
    expect(() => restoreGuard(bad, options())).toThrow(/at most 64 characters/);
  });

  it('a snapshot never holds the raw arguments, and a redacted one hides the preview made from the signature', () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: {}, signature: (_t, a) => `q=${(a as { q: string }).q}` });
    guard.check(step(call('fetch', { q: SECRET, blob: `${SECRET}${'x'.repeat(300)}` })));
    expect(JSON.stringify(guard.toJSON())).toContain(`q=${SECRET}`);
    expect(JSON.stringify(guard.toJSON())).not.toContain('xxxxxxxx');
    expect(JSON.stringify(guard.snapshot({ redact: true }))).not.toContain('SENTINEL');
  });
});
