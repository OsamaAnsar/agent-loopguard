import { BudgetDetector } from './detectors/budget';
import { FinishReasonDetector } from './detectors/finishReason';
import { MaxStepsDetector } from './detectors/maxSteps';
import { NoProgressDetector } from './detectors/noProgress';
import { OscillationDetector } from './detectors/oscillation';
import { RepeatedToolCallDetector } from './detectors/repeatedToolCall';
import { ToolLimitDetector } from './detectors/toolLimit';
import type { Detector, DetectorContext, DetectorResult } from './detectors/types';
import { isFault } from './explain';
import { feedbackFor } from './feedback';
import { buildPendingCalls, buildRecord } from './record';
import type { StepRecord } from './record';
import { ToolPolicies } from './toolPolicy';
import type {
  CustomDetector,
  Guard,
  GuardOptions,
  GuardStep,
  GuardSummary,
  GuardTotals,
  GuardWarning,
  Preflight,
  PreflightCall,
  PreflightStopVerdict,
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
    if (typeof out.feedback === 'string' && out.feedback !== '') stop.feedback = out.feedback;
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
 * Detectors run in this order and the first stop wins: finish reason, budget, max steps, tool
 * limit, repeated tool call, oscillation, no progress, then custom detectors. All of them see
 * every step even after one has stopped, so their state stays consistent.
 *
 * Tools with `ignore: true` in `options.tools` are removed from the calls the tool-limit,
 * repeated-call, oscillation and no-progress detectors see.
 *
 * Invalid options throw a `TypeError` here, never later from `check`.
 */
export function createGuard(options: GuardOptions = {}): Guard {
  const now = options.now ?? Date.now;

  const policies = new ToolPolicies(options.tools);
  const maxSteps = options.maxSteps === false ? undefined : new MaxStepsDetector(options.maxSteps ?? DEFAULT_MAX_STEPS);
  const repeated = options.repeatedToolCall === false ? undefined : new RepeatedToolCallDetector(options.repeatedToolCall, policies);
  const oscillation = options.oscillation === false ? undefined : new OscillationDetector(options.oscillation);
  const noProgress = options.noProgress === false ? undefined : new NoProgressDetector(options.noProgress);
  const finish = options.finishReason === false ? undefined : new FinishReasonDetector(options.finishReason);
  const toolLimit = policies.capped.length > 0 ? new ToolLimitDetector(policies) : undefined;
  const budget = options.budget === undefined || options.budget === false ? undefined : new BudgetDetector(options.budget, now);

  const customFns: readonly CustomDetector[] =
    options.custom === undefined ? [] : typeof options.custom === 'function' ? [options.custom] : options.custom;
  const custom = customFns.map((fn) => new CustomRunner(fn));

  // Evaluation order = priority order. `scoped` detectors judge tool calls, so they do not see
  // the calls of ignored tools.
  const optional: Array<{ detector: Detector | undefined; scoped: boolean }> = [
    { detector: finish, scoped: false },
    { detector: budget, scoped: false },
    { detector: maxSteps, scoped: false },
    { detector: toolLimit, scoped: true },
    { detector: repeated, scoped: true },
    { detector: oscillation, scoped: true },
    { detector: noProgress, scoped: true },
    ...custom.map((detector) => ({ detector, scoped: false })),
  ];
  const detectors = optional.filter((d): d is { detector: Detector; scoped: boolean } => d.detector !== undefined);

  let history: GuardStep[] = [];
  let totals = zeroTotals();
  let toolCalls = 0;
  let failedToolCalls = 0;
  let lastVerdict: Verdict | null = null;

  /** Add the model-facing text to a fault verdict: the `feedback` option's answer, else the default. */
  function withFeedback(stop: StopVerdict): StopVerdict {
    if (!isFault(stop)) return stop;
    const override = options.feedback?.(stop, { phase: 'check' });
    const text = typeof override === 'string' ? override : feedbackFor(stop, 'check');
    return text === undefined ? stop : { ...stop, feedback: text };
  }

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

    const scopedRecord: StepRecord = policies.hasIgnored
      ? { ...record, calls: record.calls.filter((c) => !policies.isIgnored(c.name)) }
      : record;
    const ctx: DetectorContext = { totals, step: safe, history };
    let stop: StopVerdict | undefined;
    const warnings: GuardWarning[] = [];
    for (const { detector, scoped } of detectors) {
      const result = detector.observe(scoped ? scopedRecord : record, ctx);
      if (result === undefined) continue;
      if (result.stop !== undefined && stop === undefined) stop = result.stop;
      if (result.warnings !== undefined) warnings.push(...result.warnings);
    }

    let verdict: Verdict;
    if (stop !== undefined) {
      const full = withFeedback(stop);
      verdict = warnings.length > 0 ? { ...full, warnings } : full;
    } else {
      verdict = warnings.length > 0 ? { stop: false, warnings } : { stop: false };
    }
    lastVerdict = verdict;
    return verdict;
  }

  function preflight(input: PreflightCall | readonly PreflightCall[]): Preflight {
    const pending = buildPendingCalls(input);
    const scoped = policies.hasIgnored ? pending.filter((c) => !policies.isIgnored(c.name)) : pending;
    const budgetNow = budget?.peek(totals);

    // Same priority as `check`, minus the rules that need a finished step.
    const found: PreflightStopVerdict | undefined =
      budgetNow?.stop ??
      maxSteps?.peek() ??
      toolLimit?.peek(scoped) ??
      repeated?.peek(scoped, history.length) ??
      oscillation?.peek(scoped);

    if (found === undefined) {
      const warnings = budgetNow?.warnings;
      return warnings === undefined ? { allow: true } : { allow: true, warnings };
    }
    const override = options.feedback?.(found, { phase: 'preflight' });
    const feedback = typeof override === 'string' ? override : feedbackFor(found, 'preflight');
    const { stop: _stop, feedback: _feedback, warnings: _warnings, ...rest } = found;
    return { allow: false, ...rest, feedback };
  }

  function reset(): void {
    history = [];
    totals = zeroTotals();
    toolCalls = 0;
    failedToolCalls = 0;
    lastVerdict = null;
    for (const { detector } of detectors) detector.reset();
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
        ...(toolLimit ? { toolLimits: toolLimit.state() } : {}),
      },
      lastVerdict,
    };
  }

  return {
    check,
    preflight,
    reset,
    summary,
    get history(): readonly GuardStep[] {
      return Object.freeze([...history]);
    },
  };
}
