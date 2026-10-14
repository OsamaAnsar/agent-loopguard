import { describe, expect, it } from 'vitest';
import { createGuard, restoreGuard } from '../src/index';
import type { GuardOptions, GuardStep } from '../src/index';
import { call, feed, firstStop, step } from './helpers';

/** Options that switch every detector off, so a test can enable exactly one. */
const ONLY: GuardOptions = {
  maxSteps: false,
  repeatedToolCall: false,
  oscillation: false,
  noProgress: false,
  finishReason: false,
};

const withResults = (options: NonNullable<GuardOptions['oscillation']> = {}): GuardOptions => ({ ...ONLY, oscillation: { includeResults: true, ...options } });

/** a b a b a b, each call returning `result(i)`. */
const cycle = (result: (i: number, name: string) => unknown, names = 'ababab'): GuardStep[] =>
  [...names].map((n, i) => step(call(n, n, { result: result(i, n) })));

describe('oscillation.includeResults', () => {
  it('is off by default: the same calls are a cycle whatever came back', () => {
    const trace = cycle((i) => i);
    expect(firstStop(feed(createGuard({ ...ONLY, oscillation: {} }), trace))).toBe(5);
    expect(firstStop(feed(createGuard({ ...ONLY, oscillation: { includeResults: false } }), trace))).toBe(5);
  });

  it('with it, a cycle whose calls come back with something new each time is not a cycle', () => {
    expect(firstStop(feed(createGuard(withResults()), cycle((i) => i)))).toBe(-1);
    // Only one of the two calls changing is enough to break it.
    expect(firstStop(feed(createGuard(withResults()), cycle((i, n) => (n === 'a' ? 'same' : i))))).toBe(-1);
  });

  it('with it, a cycle that brings back the same outcomes stops where the default would', () => {
    const trace = cycle((_i, n) => `result of ${n}`);
    const verdicts = feed(createGuard(withResults()), trace);
    expect(firstStop(verdicts)).toBe(5);
    expect(verdicts[5]).toMatchObject({
      stop: true,
      reason: 'oscillation',
      code: 'OSCILLATION',
      evidence: { period: 2, repeats: 3, threshold: 3, cycle: ['a("a")', 'b("b")'], tools: ['a', 'b'] },
    });
    expect(verdicts[5]?.stop && verdicts[5].detail).toBe(
      'The agent is oscillating: a cycle of 2 calls (a("a") -> b("b")) repeated 3 times in a row, with the same results each time.',
    );
  });

  it('errors count as outcomes: the same error each time is a cycle, a different one is not', () => {
    const failing = (message: (i: number) => string): GuardStep[] => [...'ababab'].map((n, i) => step(call(n, n, { error: { message: message(i) } })));
    expect(firstStop(feed(createGuard(withResults()), failing(() => 'timeout')))).toBe(5);
    expect(firstStop(feed(createGuard(withResults()), failing((i) => `timeout ${i}`)))).toBe(-1);
  });

  it('calls without a result compare by the call, as everywhere else', () => {
    const bare = [...'ababab'].map((n) => step(call(n, n)));
    expect(firstStop(feed(createGuard(withResults()), bare))).toBe(5);
  });

  it('works with longer periods, custom repeats and a custom resultSignature', () => {
    const trace = cycle((i) => ({ at: i, status: 'ok' }), 'abcabcabc');
    expect(firstStop(feed(createGuard(withResults()), trace))).toBe(-1);
    expect(firstStop(feed(createGuard({ ...withResults(), resultSignature: (r) => (r as { status: string }).status }), trace))).toBe(8);
    expect(firstStop(feed(createGuard(withResults({ repeats: 2, maxPeriod: 3 })), cycle(() => 'x', 'abcabc')))).toBe(5);
  });

  it('preflight cannot judge it before the results exist, so it never refuses on it', () => {
    const same = cycle(() => 'same', 'ababa');
    const guard = createGuard(withResults());
    feed(guard, same);
    expect(guard.preflight({ name: 'b', args: 'b' }).allow).toBe(true);
    expect(guard.check(step(call('b', 'b', { result: 'same' }))).stop).toBe(true);
    const plain = createGuard({ ...ONLY, oscillation: {} });
    feed(plain, same);
    expect(plain.preflight({ name: 'b', args: 'b' }).allow).toBe(false);
  });

  it('early warnings follow the same comparison', () => {
    const options: GuardOptions = { ...withResults(), warnings: true };
    const steady = feed(createGuard(options), cycle(() => 'same'));
    expect(steady.map((v) => (v.warnings ?? []).length)).toEqual([0, 0, 0, 1, 1, 0]);
    expect(feed(createGuard(options), cycle((i) => i)).every((v) => v.warnings === undefined)).toBe(true);
  });

  it('must be a boolean, and is part of the snapshot fingerprint only when it is on', () => {
    for (const bad of [1, 'yes', {}, null]) {
      expect(() => createGuard({ oscillation: { includeResults: bad as never } })).toThrow(/oscillation\.includeResults must be a boolean/);
    }
    const off = createGuard({ oscillation: {} }).toJSON().options.oscillation;
    expect(createGuard({ oscillation: { includeResults: false } }).toJSON().options.oscillation).toBe(off);
    const snapshot = createGuard(withResults()).toJSON();
    expect(snapshot.options.oscillation).not.toBe(off);
    expect(() => restoreGuard(snapshot, { ...ONLY, oscillation: {} })).toThrow(/different options \(.*oscillation.*\)/);
    expect(() => restoreGuard(createGuard({ ...ONLY, oscillation: {} }).toJSON(), withResults())).toThrow(/different options \(.*oscillation.*\)/);
  });

  it('a restored guard carries on: the snapshot holds outcome hashes, not results', () => {
    const original = createGuard(withResults());
    feed(original, cycle(() => 'SENTINEL-secret-result', 'ababa'));
    const snapshot = original.toJSON();
    expect(JSON.stringify(snapshot)).not.toContain('SENTINEL');
    const restored = restoreGuard(JSON.parse(JSON.stringify(snapshot)), withResults());
    const next = step(call('b', 'b', { result: 'SENTINEL-secret-result' }));
    expect(restored.check(next)).toEqual(original.check(next));
    expect(restored.check(step(call('a', 'a', { result: 'different' }))).stop).toBe(false);
  });
});
