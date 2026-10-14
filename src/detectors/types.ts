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

/** Like `assertInteger`, with an upper bound as well. */
export function assertIntegerBetween(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`agent-loopguard: ${name} must be an integer from ${min} to ${max}, got ${String(value)}`);
  }
  return value;
}

/** When a rule starts to warn: `at` is the count at which the warning begins, `undefined` for one short of the stop. */
export interface WarnRule {
  readonly enabled: boolean;
  readonly at: number | undefined;
}

/**
 * Resolve a `warnAt` option. `undefined` follows `onByDefault` (the guard's `warnings` option); `false`
 * turns the rule's warning off; a number turns it on at that count, which must be an integer from `min`
 * to `max`. Throws a `TypeError` naming the option otherwise.
 */
export function resolveWarnAt(name: string, own: unknown, onByDefault: boolean, min: number, max: number): WarnRule {
  if (own === undefined) return { enabled: onByDefault, at: undefined };
  if (own === false) return { enabled: false, at: undefined };
  if (typeof own !== 'number' || !Number.isInteger(own) || own < min || own > max) {
    const range =
      max < min
        ? `omitted: the rule already stops at ${max + 1}, so there is no earlier step to warn at`
        : `an integer from ${min} to ${max}`;
    throw new TypeError(`agent-loopguard: ${name} must be false or ${range}, got ${String(own)}`);
  }
  return { enabled: true, at: own };
}

/** True when `count` has reached the level at which a rule warns but not yet the count at which it stops. */
export function inWarnZone(rule: WarnRule, count: number, level: number, stopAt: number): boolean {
  return rule.enabled && count >= level && count < stopAt;
}
