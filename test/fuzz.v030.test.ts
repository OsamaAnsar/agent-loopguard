/**
 * Deterministic fuzzing of the 0.3.0 APIs (the 0.2.0 ones are in `fuzz.test.ts`): seeded random steps full
 * of hostile values must never make the guard throw, and every verdict must be well-formed and
 * JSON-serialisable.
 */
import { describe, expect, it } from 'vitest';
import { createGuard, explain, feedbackFor, restoreGuard } from '../src/index';
import type { Guard, GuardOptions, Preflight, Verdict } from '../src/index';
import { randomPreflightInput, randomStep } from './generators';
import { mulberry32 } from './helpers';

const CONFIGS: Array<[string, () => GuardOptions]> = [
  ['windowed repeats', () => ({ repeatedToolCall: { window: { size: 8, maxRepeats: 3 } } })],
  [
    'windowed repeats with per-tool policies and result-aware rules',
    () => ({
      repeatedToolCall: { requireIdenticalResults: true, ignoreErrors: true, window: { size: 12, maxRepeats: 2 } },
      tools: { search: { maxCalls: 6 }, read: { polling: { maxIdenticalResults: 3 } }, write: { ignore: true }, x: { repeatThreshold: 2 } },
    }),
  ],
  [
    'early warnings everywhere, with budgets',
    () => ({
      warnings: true,
      repeatedToolCall: { threshold: 3, window: { size: 10, maxRepeats: 3 } },
      oscillation: { repeats: 3 },
      noProgress: { threshold: 3 },
      budget: { maxTotalTokens: 5000, maxCostUsd: 1, maxDurationMs: 2000, warnAt: 0.5 },
      tools: { search: { maxCalls: 6 }, x: { maxCalls: 2, warnAt: 1 }, write: { ignore: true } },
      now: () => 0,
    }),
  ],
  ['warnings explicitly off', () => ({ warnings: false, repeatedToolCall: { window: { size: 5, maxRepeats: 2 } }, oscillation: { warnAt: 2, repeats: 3 } })],
  ['the largest window', () => ({ maxSteps: false, repeatedToolCall: { window: { size: 1000, maxRepeats: 4 } } })],
];

function assertWellFormed(verdict: Verdict): void {
  expect(typeof verdict.stop).toBe('boolean');
  if (verdict.stop) {
    expect(typeof verdict.reason).toBe('string');
    expect(verdict.code).toMatch(/^[A-Z0-9_]+$/);
    expect(verdict.detail.length).toBeGreaterThan(0);
    expect(verdict.evidence).toBeDefined();
    if (verdict.feedback !== undefined) expect(typeof verdict.feedback).toBe('string');
    expect(feedbackFor(verdict) === undefined || typeof feedbackFor(verdict) === 'string').toBe(true);
  }
  for (const warning of verdict.warnings ?? []) {
    expect(warning.code).toMatch(/^[A-Z0-9_]+$/);
    expect(warning.detail.length).toBeGreaterThan(0);
  }
  expect(JSON.parse(JSON.stringify(verdict))).toEqual(JSON.parse(JSON.stringify(verdict)));
  expect(typeof explain(verdict)).toBe('string');
}

function assertPreflightWellFormed(result: Preflight): void {
  expect(typeof result.allow).toBe('boolean');
  if (!result.allow) {
    expect(result.code).toMatch(/^[A-Z0-9_]+$/);
    expect(result.detail.length).toBeGreaterThan(0);
    expect(typeof result.feedback).toBe('string');
    expect(result.evidence).toBeDefined();
  } else {
    for (const warning of result.warnings ?? []) expect(warning.detail.length).toBeGreaterThan(0);
  }
  expect(() => JSON.stringify(result)).not.toThrow();
}

describe('fuzz (0.3.0): the guard never throws on arbitrary steps', () => {
  it.each(CONFIGS)('%s', (_name, makeOptions) => {
    let checked = 0;
    for (let seed = 1; seed <= 25; seed += 1) {
      const rand = mulberry32(seed * 7919);
      const guard = createGuard(makeOptions());
      for (let i = 0; i < 120; i += 1) {
        assertWellFormed(guard.check(randomStep(rand)));
        checked += 1;
        if (i % 40 === 39) expect(() => JSON.stringify(guard.summary())).not.toThrow();
        if (i === 79) guard.reset();
      }
    }
    expect(checked).toBe(25 * 120);
  });
});

describe('fuzz (0.3.0): preflight, snapshots and restores never throw on hostile data', () => {
  it.each(CONFIGS)('%s', (_name, makeOptions) => {
    let probes = 0;
    let restores = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const rand = mulberry32(seed * 6151);
      let guard: Guard = createGuard(makeOptions());
      for (let i = 0; i < 90; i += 1) {
        for (let k = 0; k < 2; k += 1) {
          assertPreflightWellFormed(guard.preflight(randomPreflightInput(rand) as never));
          probes += 1;
        }
        assertWellFormed(guard.check(randomStep(rand)));

        if (i % 15 === 14) {
          const snapshot = guard.snapshot({ redact: rand() < 0.3 });
          const json = JSON.stringify(snapshot);
          expect(JSON.parse(json)).toEqual(snapshot);
          expect(structuredClone(snapshot)).toEqual(snapshot);
          const restored = restoreGuard(rand() < 0.5 ? snapshot : JSON.parse(json), makeOptions());
          restores += 1;
          expect(restored.toJSON()).toEqual(snapshot);
          guard = restored;
        }
        if (i === 60) guard.reset();
      }
    }
    expect(probes).toBe(12 * 90 * 2);
    expect(restores).toBe(12 * 6);
  });
});
