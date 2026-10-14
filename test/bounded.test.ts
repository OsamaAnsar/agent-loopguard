/**
 * The detectors keep bounded state (a few counters and short rings, never the whole call history).
 * These tests pin down that this changed nothing observable, and the one deliberate limit.
 */
import { describe, expect, it } from 'vitest';
import { createGuard } from '../src/index';
import type { GuardOptions, GuardStep } from '../src/index';
import { call, feed, firstStop, mulberry32, step } from './helpers';

const ONLY: GuardOptions = {
  maxSteps: false,
  repeatedToolCall: false,
  oscillation: false,
  noProgress: false,
  finishReason: false,
};

/** The original, unbounded way of finding a cycle at the end of a call sequence. */
function referenceOscillation(sigs: readonly string[], maxPeriod: number, repeats: number) {
  const n = sigs.length;
  for (let period = 2; period <= maxPeriod; period += 1) {
    if (n < period * repeats) continue;
    let matching = 0;
    for (let i = n - 1; i >= period && sigs[i] === sigs[i - period]; i -= 1) matching += 1;
    const cycles = Math.floor(matching / period) + 1;
    if (cycles < repeats) continue;
    const cycle = sigs.slice(n - period);
    if (new Set(cycle).size < 2) continue;
    return { period, repeats: cycles, cycle };
  }
  return undefined;
}

describe('oscillation with bounded state', () => {
  it.each([
    { maxPeriod: 2, repeats: 2 },
    { maxPeriod: 3, repeats: 3 },
    { maxPeriod: 4, repeats: 2 },
    { maxPeriod: 5, repeats: 3 },
    { maxPeriod: 6, repeats: 4 },
  ])('agrees with the unbounded reference on random sequences (maxPeriod $maxPeriod, repeats $repeats)', (options) => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rand = mulberry32(seed * 104729);
      const alphabet = 2 + Math.floor(rand() * 3);
      const guard = createGuard({ ...ONLY, oscillation: options });
      const sigs: string[] = [];
      for (let i = 0; i < 160; i += 1) {
        // Bias towards repeating the call `period` back, so cycles actually occur.
        const back = 2 + Math.floor(rand() * options.maxPeriod);
        const name = rand() < 0.8 && sigs.length >= back ? (sigs[sigs.length - back] as string) : String(Math.floor(rand() * alphabet));
        sigs.push(name);
        const verdict = guard.check(step(call(name, 'x')));
        const expected = referenceOscillation(sigs, options.maxPeriod, options.repeats);
        if (expected === undefined) {
          expect(verdict.stop).toBe(false);
        } else {
          expect(verdict).toMatchObject({
            stop: true,
            reason: 'oscillation',
            evidence: {
              period: expected.period,
              repeats: expected.repeats,
              cycle: expected.cycle.map((n) => `${n}("x")`),
            },
          });
        }
      }
    }
  });

  it('keeps counting a cycle that runs on for thousands of calls', () => {
    const guard = createGuard({ ...ONLY, oscillation: {} });
    let last = guard.check({});
    for (let i = 0; i < 20_000; i += 1) last = guard.check(step(call(i % 2 === 0 ? 'a' : 'b')));
    expect(last).toMatchObject({ stop: true, evidence: { period: 2, repeats: 10_000 } });
  });
});

describe('noProgress memory', () => {
  const distinct = (i: number): GuardStep => step(call('t', i, { result: i }));

  it('remembers the 1024 newest distinct outcomes: an older one counts as new again', () => {
    // Outcome 0 is still remembered after 1024 distinct outcomes...
    const kept = createGuard({ ...ONLY, noProgress: { threshold: 2 } });
    feed(kept, Array.from({ length: 1024 }, (_, i) => distinct(i)));
    expect(kept.check(distinct(0)).stop).toBe(false); // seen before: a stalled step, streak 1
    expect(kept.check(distinct(0)).stop).toBe(true); // streak 2

    // ...and forgotten after 1025.
    const forgotten = createGuard({ ...ONLY, noProgress: { threshold: 2 } });
    feed(forgotten, Array.from({ length: 1025 }, (_, i) => distinct(i)));
    expect(forgotten.check(distinct(0)).stop).toBe(false); // new again: progress
    expect(forgotten.check(distinct(0)).stop).toBe(false); // seen: stalled, streak 1
    expect(forgotten.check(distinct(0)).stop).toBe(true); // streak 2
  });

  it('a long run of fresh outcomes never stops', () => {
    const guard = createGuard({ ...ONLY, noProgress: {} });
    expect(firstStop(feed(guard, Array.from({ length: 5000 }, (_, i) => distinct(i))))).toBe(-1);
  });

  it('compares text by hash but still reports it', () => {
    const guard = createGuard({ ...ONLY, noProgress: { threshold: 2 } });
    const long = `${'word '.repeat(100)}end`;
    guard.check({ text: long });
    const v = guard.check({ text: `  ${long.toUpperCase()}  ` });
    expect(v).toMatchObject({ stop: true, evidence: { steps: 2 } });
    const preview = v.stop ? (v.evidence as { textPreview: string }).textPreview : '';
    expect(preview).toHaveLength(80);
    expect(preview.startsWith('word word')).toBe(true);
  });
});
