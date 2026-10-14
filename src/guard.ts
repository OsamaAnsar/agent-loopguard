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
import { SNAPSHOT_VERSION, asAmount, asInt, asNullable, asRecord, asString, fail, field, fingerprint, section } from './snapshot';
import { ToolPolicies } from './toolPolicy';
import type {
  CustomDetector,
  Guard,
  GuardOptions,
  GuardOptionsFingerprint,
  GuardSnapshot,
  GuardStep,
  GuardSummary,
  GuardTotals,
  GuardWarning,
  Preflight,
  PreflightCall,
  PreflightStopVerdict,
  RestoreOptions,
  SnapshotOptions,
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

/** A snapshot waiting to be loaded into a new guard. */
interface Restore {
  snapshot: unknown;
  allowLimitChanges: boolean;
}

function buildGuard(options: GuardOptions, restored: Restore | undefined): Guard {
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

  // Raw steps recorded by this guard object. `stepCount` is the run's step count: it also covers
  // steps recorded before a restore, which are no longer available as raw steps.
  let history: GuardStep[] = [];
  let stepCount = 0;
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
    const record = buildRecord(safe, stepCount);
    stepCount += 1;
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
      repeated?.peek(scoped, stepCount) ??
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
    stepCount = 0;
    totals = zeroTotals();
    toolCalls = 0;
    failedToolCalls = 0;
    lastVerdict = null;
    for (const { detector } of detectors) detector.reset();
  }

  function summary(): GuardSummary {
    return {
      steps: stepCount,
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

  /** One fingerprint per option group; a snapshot is only restored under the options it was taken with. */
  function fingerprints(): GuardOptionsFingerprint {
    return {
      maxSteps: fingerprint(maxSteps ? maxSteps.config() : false),
      repeatedToolCall: fingerprint(repeated ? repeated.config() : false),
      oscillation: fingerprint(oscillation ? oscillation.config() : false),
      noProgress: fingerprint(noProgress ? noProgress.config() : false),
      finishReason: fingerprint(finish ? finish.config() : false),
      budget: fingerprint(budget ? budget.config() : false),
      tools: fingerprint(policies.config()),
      custom: fingerprint(customFns.length),
    };
  }

  function snapshot(snapshotOptions?: SnapshotOptions): GuardSnapshot {
    // `JSON.stringify(guard)` calls `toJSON` with a key, so tolerate anything here.
    const redact = typeof snapshotOptions === 'object' && snapshotOptions !== null && snapshotOptions.redact === true;
    return {
      version: SNAPSHOT_VERSION,
      steps: stepCount,
      toolCalls,
      failedToolCalls,
      totals: { ...totals },
      wallClockMs: budget ? budget.elapsedMs() : null,
      options: fingerprints(),
      detectors: {
        repeatedToolCall: repeated ? repeated.snapshot(redact) : null,
        oscillation: oscillation ? oscillation.snapshot(redact) : null,
        noProgress: noProgress ? noProgress.snapshot(redact) : null,
        finishReason: finish ? finish.snapshot() : null,
        toolLimits: toolLimit ? toolLimit.snapshot() : null,
      },
    };
  }

  /** Load a snapshot into this (fresh) guard. Throws a `TypeError` if it cannot be trusted. */
  function applySnapshot(raw: unknown, allowLimitChanges: boolean): void {
    const top = asRecord(raw, 'snapshot');
    const version = field(top, 'version', 'snapshot');
    if (version !== SNAPSHOT_VERSION) {
      const shown = typeof version === 'number' || typeof version === 'string' ? JSON.stringify(version) : typeof version;
      fail('snapshot.version', `is ${shown}, but this version of agent-loopguard reads version ${SNAPSHOT_VERSION}`);
    }

    const steps = asInt(field(top, 'steps', 'snapshot'), 'snapshot.steps');
    const calls = asInt(field(top, 'toolCalls', 'snapshot'), 'snapshot.toolCalls');
    const failed = asInt(field(top, 'failedToolCalls', 'snapshot'), 'snapshot.failedToolCalls');
    if (failed > calls) fail('snapshot.failedToolCalls', 'cannot exceed toolCalls');
    const rawTotals = asRecord(field(top, 'totals', 'snapshot'), 'snapshot.totals');
    const restoredTotals: GuardTotals = {
      inputTokens: asAmount(field(rawTotals, 'inputTokens', 'snapshot.totals'), 'snapshot.totals.inputTokens'),
      outputTokens: asAmount(field(rawTotals, 'outputTokens', 'snapshot.totals'), 'snapshot.totals.outputTokens'),
      totalTokens: asAmount(field(rawTotals, 'totalTokens', 'snapshot.totals'), 'snapshot.totals.totalTokens'),
      costUsd: asAmount(field(rawTotals, 'costUsd', 'snapshot.totals'), 'snapshot.totals.costUsd'),
      durationMs: asAmount(field(rawTotals, 'durationMs', 'snapshot.totals'), 'snapshot.totals.durationMs'),
    };
    const wallClockMs = asNullable(field(top, 'wallClockMs', 'snapshot'), (v) => asAmount(v, 'snapshot.wallClockMs'));

    // The options are not stored, only their fingerprints: refuse to continue under different rules.
    const stored = asRecord(field(top, 'options', 'snapshot'), 'snapshot.options');
    const current = fingerprints();
    const relaxed: ReadonlyArray<keyof GuardOptionsFingerprint> = allowLimitChanges ? ['maxSteps', 'budget'] : [];
    const changed = (Object.keys(current) as Array<keyof GuardOptionsFingerprint>).filter(
      (key) => !relaxed.includes(key) && asString(field(stored, key, 'snapshot.options'), `snapshot.options.${key}`, 64) !== current[key],
    );
    if (changed.length > 0) {
      throw new TypeError(
        `agent-loopguard: this snapshot was taken with different options (${changed.join(', ')}); restore it with the options it was taken with`,
      );
    }

    // Each detector that is on gets its section; the section of one that is off must be null.
    const states = asRecord(field(top, 'detectors', 'snapshot'), 'snapshot.detectors');
    const load = (key: string, detector: { restore(raw: unknown): void } | undefined): void => {
      const state = section(states, key, detector !== undefined);
      detector?.restore(state);
    };
    load('repeatedToolCall', repeated);
    load('oscillation', oscillation);
    load('noProgress', noProgress);
    load('finishReason', finish);
    load('toolLimits', toolLimit);

    stepCount = steps;
    toolCalls = calls;
    failedToolCalls = failed;
    totals = restoredTotals;
    maxSteps?.restore(steps);
    budget?.restore(restoredTotals, wallClockMs);
  }

  if (restored !== undefined) {
    try {
      applySnapshot(restored.snapshot, restored.allowLimitChanges);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new TypeError('agent-loopguard: invalid snapshot: it could not be read');
    }
  }

  return {
    check,
    preflight,
    reset,
    toJSON: () => snapshot(),
    snapshot,
    summary,
    get history(): readonly GuardStep[] {
      return Object.freeze([...history]);
    },
  };
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
 *
 * `createGuard.fromJSON(snapshot, options)` (also exported as `restoreGuard`) continues a run from
 * `guard.toJSON()`.
 */
export function createGuard(options: GuardOptions = {}): Guard {
  return buildGuard(options, undefined);
}

/**
 * Rebuild a guard from a snapshot (`guard.toJSON()`), so that it goes on exactly where the original
 * stopped: given the same steps, it gives the same verdicts.
 *
 * Pass the same `options` the snapshot was taken with. They are not stored (functions cannot
 * be), only fingerprinted, so a mismatch throws a `TypeError` naming the option groups that differ
 * instead of silently behaving differently. `restoreOptions.allowLimitChanges` relaxes that for
 * `maxSteps` and `budget` only. `now`, `feedback` and the code of custom detectors are not checked.
 *
 * Anything wrong with the snapshot (unknown version, wrong shape, hostile values) throws a
 * `TypeError` here, never later from `check`. `snapshot` may be the result of `JSON.parse`.
 */
export function restoreGuard(snapshot: unknown, options: GuardOptions = {}, restoreOptions: RestoreOptions = {}): Guard {
  return buildGuard(options, { snapshot, allowLimitChanges: restoreOptions?.allowLimitChanges === true });
}

createGuard.fromJSON = restoreGuard;
