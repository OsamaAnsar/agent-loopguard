import { BudgetDetector } from './detectors/budget';
import { FinishReasonDetector } from './detectors/finishReason';
import { MaxStepsDetector } from './detectors/maxSteps';
import { NoProgressDetector } from './detectors/noProgress';
import { OscillationDetector } from './detectors/oscillation';
import { RepeatedToolCallDetector } from './detectors/repeatedToolCall';
import type { Detector, DetectorContext, DetectorResult } from './detectors/types';
import { buildRecord } from './record';
import type { StepRecord } from './record';
import type {
  CustomDetector,
  Guard,
  GuardOptions,
  GuardStep,
  GuardSummary,
  GuardTotals,
  GuardWarning,
  StopVerdict,
  Verdict,
} from './types';

/** Default for `maxSteps`: a backstop, not a tuned value. Raise it for long-running agents. */
export const DEFAULT_MAX_STEPS = 50;

/** Adapts a user-supplied function to the internal detector interface. */
class CustomRunner implements Detector {
  constructor(private readonly fn: CustomDetector) {}

  observe(_record: StepRecord, ctx: DetectorContext): DetectorResult | undefined {
    const out = this.fn(ctx.history, ctx.step);
    if (out === undefined || out === null || out.stop !== true) return undefined;
    const stop: StopVerdict = {
      stop: true,
      reason: 'custom',
      code: typeof out.code === 'string' && out.code !== '' ? out.code : 'CUSTOM',
      detail: typeof out.detail === 'string' ? out.detail : 'Stopped by a custom detector.',
      evidence: out.evidence === undefined ? null : out.evidence,
    };
    return { stop };
  }

  reset(): void {
    // Custom detectors read the history; they keep no state of ours.
  }
}

function zeroTotals(): GuardTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 };
}

/**
 * Create a guard. Feed it one step at a time with `check`; it answers `{ stop: false }` or a
 * typed verdict saying why the run should end.
 *
 * Detectors run in this order and the first stop wins: finish reason, budget, max steps,
 * repeated tool call, oscillation, no progress, then custom detectors. All of them see every step
 * even after one has stopped, so their state stays consistent.
 *
 * Invalid options throw a `TypeError` here, never later from `check`.
 */
export function createGuard(options: GuardOptions = {}): Guard {
  const now = options.now ?? Date.now;

  const maxSteps = options.maxSteps === false ? undefined : new MaxStepsDetector(options.maxSteps ?? DEFAULT_MAX_STEPS);
  const repeated = options.repeatedToolCall === false ? undefined : new RepeatedToolCallDetector(options.repeatedToolCall);
  const oscillation = options.oscillation === false ? undefined : new OscillationDetector(options.oscillation);
  const noProgress = options.noProgress === false ? undefined : new NoProgressDetector(options.noProgress);
  const finish = options.finishReason === false ? undefined : new FinishReasonDetector(options.finishReason);
  const budget = options.budget === undefined || options.budget === false ? undefined : new BudgetDetector(options.budget, now);

  const customFns: readonly CustomDetector[] =
    options.custom === undefined ? [] : typeof options.custom === 'function' ? [options.custom] : options.custom;
  const custom = customFns.map((fn) => new CustomRunner(fn));

  // Evaluation order = priority order.
  const optional: Array<Detector | undefined> = [finish, budget, maxSteps, repeated, oscillation, noProgress, ...custom];
  const detectors = optional.filter((d): d is Detector => d !== undefined);

  let history: GuardStep[] = [];
  let totals = zeroTotals();
  let toolCalls = 0;
  let failedToolCalls = 0;
  let lastVerdict: Verdict | null = null;

  function check(step: GuardStep): Verdict {
    // Steps often come straight from provider responses; tolerate non-objects.
    const safe: GuardStep = typeof step === 'object' && step !== null ? step : {};
    const record = buildRecord(safe, history.length);
    history.push(safe);

    totals.inputTokens += record.inputTokens ?? 0;
    totals.outputTokens += record.outputTokens ?? 0;
    totals.totalTokens += record.totalTokens ?? 0;
    totals.costUsd += record.costUsd ?? 0;
    totals.durationMs += record.durationMs ?? 0;
    toolCalls += record.calls.length;
    failedToolCalls += record.calls.filter((c) => c.failed).length;

    const ctx: DetectorContext = { totals, step: safe, history };
    let stop: StopVerdict | undefined;
    const warnings: GuardWarning[] = [];
    for (const detector of detectors) {
      const result = detector.observe(record, ctx);
      if (result === undefined) continue;
      if (result.stop !== undefined && stop === undefined) stop = result.stop;
      if (result.warnings !== undefined) warnings.push(...result.warnings);
    }

    let verdict: Verdict;
    if (stop !== undefined) verdict = warnings.length > 0 ? { ...stop, warnings } : stop;
    else verdict = warnings.length > 0 ? { stop: false, warnings } : { stop: false };
    lastVerdict = verdict;
    return verdict;
  }

  function reset(): void {
    history = [];
    totals = zeroTotals();
    toolCalls = 0;
    failedToolCalls = 0;
    lastVerdict = null;
    for (const detector of detectors) detector.reset();
  }

  function summary(): GuardSummary {
    return {
      steps: history.length,
      toolCalls,
      failedToolCalls,
      totals: { ...totals },
      detectors: {
        maxSteps: maxSteps ? { limit: maxSteps.limit, remaining: maxSteps.remaining() } : null,
        repeatedToolCall: repeated ? repeated.state() : null,
        oscillation: oscillation ? oscillation.state() : null,
        noProgress: noProgress ? noProgress.state() : null,
        finishReason: finish ? finish.state() : null,
        budget: budget ? budget.state() : null,
      },
      lastVerdict,
    };
  }

  return {
    check,
    reset,
    summary,
    get history(): readonly GuardStep[] {
      return Object.freeze([...history]);
    },
  };
}
