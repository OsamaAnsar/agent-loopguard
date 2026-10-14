import type { StepRecord } from '../record';
import type { GuardStep, GuardTotals, GuardWarning, StopVerdict } from '../types';

/** Read-only context the guard hands to every detector on each step. */
export interface DetectorContext {
  /** Running totals, already including the current step. */
  totals: Readonly<GuardTotals>;
  /** The raw step as supplied by the caller. */
  step: GuardStep;
  /** All raw steps so far, the current one last. */
  history: readonly GuardStep[];
}

export interface DetectorResult {
  stop?: StopVerdict;
  warnings?: GuardWarning[];
}

/**
 * Every detector sees every step (so its state stays consistent even when an earlier detector
 * already stopped the run) and returns at most one stop verdict for it.
 */
export interface Detector {
  observe(record: StepRecord, ctx: DetectorContext): DetectorResult | undefined;
  reset(): void;
}

/** Throw a `TypeError` for an invalid option, naming it. Used at `createGuard` time only. */
export function assertInteger(name: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new TypeError(`agent-loopguard: ${name} must be an integer >= ${min}, got ${String(value)}`);
  }
  return value;
}
