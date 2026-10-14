/**
 * The differential property for the 0.3.0 features (the 0.2.0 configurations are in
 * `snapshot.test.ts`): snapshot a run at a random cut, restore it, and every later verdict, summary and
 * snapshot must equal the uninterrupted run's. Done directly, through `structuredClone` and through a JSON
 * round trip of plain generated data.
 */
import { describe, expect, it } from 'vitest';
import { createGuard, restoreGuard } from '../src/index';
import type { Guard, GuardOptions, GuardReport, GuardStep, Verdict } from '../src/index';
import { plainStep } from './generators';
import { mulberry32 } from './helpers';

interface Clock {
  t: number;
}

const STEPS = 70;

/** The report minus what a restore legitimately does not carry: the last verdict's warnings and the last stop. */
function portableReport(guard: Guard): Omit<GuardReport, 'warnings' | 'lastStop'> {
  const { warnings: _warnings, lastStop: _lastStop, ...rest } = guard.report({ format: 'json' });
  return rest;
}

/** One configuration the property is checked under. */
interface Config {
  name: string;
  options: (clock: Clock) => GuardOptions;
}

const CONFIGS: Config[] = [
  {
    name: 'windowed repeats, default-ish values',
    options: () => ({ repeatedToolCall: { window: { size: 8, maxRepeats: 3 } } }),
  },
  {
    name: 'windowed repeats, tight values, other rules loosened so the window decides',
    options: () => ({
      maxSteps: 60,
      repeatedToolCall: { threshold: 5, window: { size: 5, maxRepeats: 2 } },
      oscillation: { repeats: 4 },
      noProgress: { threshold: 5 },
    }),
  },
  {
    name: 'windowed repeats, result-aware, errors ignored',
    options: () => ({ repeatedToolCall: { requireIdenticalResults: true, ignoreErrors: true, window: { size: 12, maxRepeats: 3 } } }),
  },
  {
    name: 'windowed repeats with per-tool policies',
    options: () => ({
      repeatedToolCall: { window: { size: 10, maxRepeats: 3 } },
      tools: {
        search: { maxCalls: 9 },
        poll: { polling: { maxIdenticalResults: 4 } },
        think: { ignore: true },
        a: { repeatThreshold: 2 },
        c: { repeatThreshold: 5 },
      },
    }),
  },
  {
    name: 'early warnings on for every rule',
    options: () => ({
      warnings: true,
      repeatedToolCall: { threshold: 4, window: { size: 9, maxRepeats: 3 } },
      oscillation: { repeats: 4 },
      noProgress: { threshold: 4 },
      tools: { search: { maxCalls: 7 }, poll: { polling: true }, think: { ignore: true } },
    }),
  },
  {
    name: 'early warnings with explicit levels, budgets and the wall clock',
    options: (clock) => ({
      repeatedToolCall: { threshold: 6, warnAt: 3, window: { size: 12, maxRepeats: 5, warnAt: 2 } },
      oscillation: { repeats: 5, warnAt: 2 },
      noProgress: { threshold: 5, warnAt: 2 },
      tools: { search: { maxCalls: 8, warnAt: 5 }, c: { maxCalls: 3, warnAt: false } },
      budget: { maxTotalTokens: 900, maxCostUsd: 2, maxDurationMs: 600, warnAt: 0.5 },
      now: () => clock.t,
    }),
  },
  {
    name: 'custom signature functions (pure), with a window, polling and the no-progress rule',
    options: () => ({
      repeatedToolCall: { window: { size: 8, maxRepeats: 3 }, requireIdenticalResults: true },
      noProgress: { threshold: 3 },
      tools: { poll: { polling: true } },
      signature: (tool, args) => `${tool}:${typeof args === 'object' && args !== null ? JSON.stringify(Object.keys(args).sort()) : String(args)}`,
      resultSignature: (result) => (typeof result === 'string' ? result.toUpperCase() : typeof result),
      errorSignature: () => 'any error',
    }),
  },
  {
    name: 'oscillation that compares results, with warnings',
    options: () => ({ warnings: true, oscillation: { includeResults: true, repeats: 3, maxPeriod: 4 }, repeatedToolCall: { threshold: 6 }, noProgress: { threshold: 6 } }),
  },
  {
    name: 'the largest window',
    options: () => ({ maxSteps: false, repeatedToolCall: { window: { size: 1000, maxRepeats: 6 } } }),
  },
];

function runDifferential(config: Config, seeds = 14): { stops: number; restoredRuns: number; warned: number } {
  let stops = 0;
  let warned = 0;
  let restoredRuns = 0;
  for (let seed = 1; seed <= seeds; seed += 1) {
    const rand = mulberry32(seed * 104729);
    const trace = Array.from({ length: STEPS }, () => plainStep(rand));
    const clockA: Clock = { t: 0 };

    // The reference run, with a snapshot (and summary) recorded after every step.
    const a = createGuard(config.options(clockA));
    const clockControl: Clock = { t: 0 };
    const control = createGuard(config.options(clockControl));
    const verdicts: Verdict[] = [];
    const summaries = [a.summary()];
    const reports = [portableReport(a)];
    const referenceWarnings = [a.report({ format: 'json' }).warnings];
    const snapshots = [a.toJSON()];
    trace.forEach((s, i) => {
      clockA.t = i * 7;
      clockControl.t = i * 7;
      const verdict = a.check(s);
      // Snapshotting after every step must not disturb the run: compare with one that never does.
      expect(control.check(s)).toEqual(verdict);
      verdicts.push(verdict);
      summaries.push(a.summary());
      reports.push(portableReport(a));
      referenceWarnings.push(a.report({ format: 'json' }).warnings);
      snapshots.push(a.toJSON());
    });
    expect(snapshots[STEPS]).toEqual(control.toJSON());

    const cuts = [0, 1, STEPS, STEPS - 1, ...Array.from({ length: 4 }, () => Math.floor(rand() * (STEPS + 1)))];
    for (const k of cuts) {
      const carriers: Array<[string, unknown]> = [
        ['direct', snapshots[k]],
        ['structuredClone', structuredClone(snapshots[k])],
        ['JSON', JSON.parse(JSON.stringify(snapshots[k]))],
      ];
      for (const [carrier, snapshot] of carriers) {
        const clockB: Clock = { t: k === 0 ? 0 : (k - 1) * 7 };
        const b = restoreGuard(snapshot, config.options(clockB));
        restoredRuns += 1;
        const label = `${config.name}: seed ${seed}, cut ${k}, ${carrier}`;

        // Right after the restore: the same state (the last verdict is not carried over).
        expect(b.toJSON(), label).toEqual(snapshots[k]);
        expect({ ...b.summary(), lastVerdict: null }, label).toEqual({ ...summaries[k], lastVerdict: null });
        expect(portableReport(b), label).toEqual(reports[k]);

        for (let j = k; j < STEPS; j += 1) {
          clockB.t = j * 7;
          const got = b.check(trace[j] as GuardStep);
          expect(got, `${label}, step ${j}`).toEqual(verdicts[j]);
          expect(b.summary(), `${label}, step ${j}`).toEqual(summaries[j + 1]);
          expect(portableReport(b), `${label}, step ${j}`).toEqual(reports[j + 1]);
          // The warnings of the last verdict are there again after the first step of the restored guard.
          expect(b.report({ format: 'json' }).warnings, `${label}, step ${j}`).toEqual(referenceWarnings[j + 1]);
          if (got.stop) stops += 1;
          if (got.warnings?.some((w) => w.code !== 'BUDGET_WARNING')) warned += 1;
        }
        expect(b.toJSON(), label).toEqual(snapshots[STEPS]);
      }
    }
  }
  return { stops, restoredRuns, warned };
}

describe('restore == carry on, for the 0.3.0 rules (differential property)', () => {
  it.each(CONFIGS.map((c) => [c.name, c] as const))('%s', (_name, config) => {
    const { stops, restoredRuns, warned } = runDifferential(config);
    expect(restoredRuns).toBe(14 * 8 * 3);
    expect(stops).toBeGreaterThan(0); // the property is not vacuous
    if (config.name.startsWith('early warnings')) expect(warned).toBeGreaterThan(50);
  });

  it('chains: restoring a restored guard, repeatedly, still matches the uninterrupted run', () => {
    let windowStops = 0;
    for (let seed = 1; seed <= 10; seed += 1) {
      const rand = mulberry32(seed * 31337);
      const trace = Array.from({ length: 90 }, () => plainStep(rand));
      const makeOptions = (): GuardOptions => ({
        repeatedToolCall: { threshold: 6, window: { size: 9, maxRepeats: 3 } },
        oscillation: { repeats: 6 },
        noProgress: { threshold: 6 },
        tools: { search: { maxCalls: 8 }, think: { ignore: true } },
        maxSteps: 200,
      });
      const uninterrupted = createGuard(makeOptions());
      const expected = trace.map((s) => uninterrupted.check(s));

      let guard = createGuard(makeOptions());
      const got: Verdict[] = [];
      trace.forEach((s, i) => {
        got.push(guard.check(s));
        if (i % 7 === 3) guard = restoreGuard(JSON.parse(JSON.stringify(guard.toJSON())), makeOptions());
      });
      expect(got).toEqual(expected);
      expect(guard.toJSON()).toEqual(uninterrupted.toJSON());
      windowStops += got.filter((v) => v.stop && v.reason === 'repeated-tool-call-window').length;
    }
    expect(windowStops).toBeGreaterThan(0);
  });
});
