import type { BudgetEvidence, BudgetLimit, BudgetMetric, BudgetOptions, BudgetVerdict, GuardWarning } from '../types';
import type { StepRecord } from '../record';
import type { Detector, DetectorContext, DetectorResult } from './types';

interface ResolvedLimit {
  metric: BudgetMetric;
  limit: number;
  /** Ratio in (0, 1) at which a warning starts, or `undefined` for none. */
  warnAt: number | undefined;
  code: BudgetVerdict['code'];
  label: string;
}

/** Order matters: it decides which limit is reported first when several are hit at once. */
const SPEC: ReadonlyArray<{
  option: keyof Omit<BudgetOptions, 'warnAt'>;
  metric: BudgetMetric;
  code: BudgetVerdict['code'];
  label: string;
}> = [
  { option: 'maxTotalTokens', metric: 'totalTokens', code: 'BUDGET_TOTAL_TOKENS', label: 'total tokens' },
  { option: 'maxInputTokens', metric: 'inputTokens', code: 'BUDGET_INPUT_TOKENS', label: 'input tokens' },
  { option: 'maxOutputTokens', metric: 'outputTokens', code: 'BUDGET_OUTPUT_TOKENS', label: 'output tokens' },
  { option: 'maxCostUsd', metric: 'costUsd', code: 'BUDGET_COST_USD', label: 'cost (USD)' },
  { option: 'maxDurationMs', metric: 'durationMs', code: 'BUDGET_DURATION_MS', label: 'duration (ms)' },
];

function checkRatio(name: string, ratio: number): number {
  if (typeof ratio !== 'number' || !(ratio > 0 && ratio < 1)) {
    throw new TypeError(`agent-loopguard: ${name} must be a number strictly between 0 and 1, got ${String(ratio)}`);
  }
  return ratio;
}

/**
 * Stops when a cumulative total reaches its limit; warns (without stopping) once it passes `warnAt`
 * of the limit. All numbers come from the steps you feed in. Nothing is estimated and there is no
 * price table, so a cost limit only works if you supply `usage.costUsd`.
 *
 * A budget counts as spent when it is *reached* (`value >= limit`): the guard runs after a step has
 * already happened, so waiting for the limit to be exceeded would always overshoot by a step.
 *
 * Duration is the larger of (a) the sum of the `durationMs` values you supply and (b) wall-clock time
 * since the guard was created or reset, read from the injectable `now()`.
 */
export class BudgetDetector implements Detector {
  readonly limits: readonly ResolvedLimit[];
  private startedAt: number;
  private lastUsed: Record<BudgetMetric, number> = zeroUsed();

  constructor(
    options: BudgetOptions,
    private readonly now: () => number,
  ) {
    const defaultWarn = options.warnAt === undefined ? undefined : checkRatio('budget.warnAt', options.warnAt);
    const limits: ResolvedLimit[] = [];
    for (const spec of SPEC) {
      const raw: BudgetLimit | undefined = options[spec.option];
      if (raw === undefined) continue;
      const limit = typeof raw === 'number' ? raw : raw.limit;
      if (typeof limit !== 'number' || !(limit > 0) || !Number.isFinite(limit)) {
        throw new TypeError(`agent-loopguard: budget.${spec.option} must be a positive finite number, got ${String(limit)}`);
      }
      const ownWarn = typeof raw === 'number' ? undefined : raw.warnAt;
      const warnAt = ownWarn === undefined ? defaultWarn : checkRatio(`budget.${spec.option}.warnAt`, ownWarn);
      limits.push({ metric: spec.metric, limit, warnAt, code: spec.code, label: spec.label });
    }
    this.limits = limits;
    this.startedAt = now();
  }

  observe(_record: StepRecord, ctx: DetectorContext): DetectorResult | undefined {
    // `recorded` is deterministic (summed from steps) and is what summary() shows;
    // `used` additionally folds in wall-clock time for the duration check.
    const recorded = this.recorded(ctx);
    this.lastUsed = recorded;
    const used = this.withWallClock(recorded);

    let stop: BudgetVerdict | undefined;
    const warnings: GuardWarning[] = [];

    for (const { metric, limit, warnAt, code, label } of this.limits) {
      const value = used[metric];
      if (value >= limit) {
        if (stop === undefined) {
          const evidence: BudgetEvidence = { metric, value, limit };
          stop = {
            stop: true,
            reason: 'budget',
            code,
            detail: `Budget exhausted: ${label} reached ${value} of the ${limit} allowed.`,
            evidence,
          };
        }
      } else if (warnAt !== undefined && value >= warnAt * limit) {
        const ratio = value / limit;
        warnings.push({
          code: 'BUDGET_WARNING',
          metric,
          value,
          limit,
          ratio,
          detail: `Budget warning: ${label} is at ${Math.round(ratio * 100)}% of the ${limit} allowed (${value} used).`,
        });
      }
    }

    if (stop === undefined && warnings.length === 0) return undefined;
    const result: DetectorResult = {};
    if (stop !== undefined) result.stop = stop;
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  private recorded(ctx: DetectorContext): Record<BudgetMetric, number> {
    return {
      totalTokens: ctx.totals.totalTokens,
      inputTokens: ctx.totals.inputTokens,
      outputTokens: ctx.totals.outputTokens,
      costUsd: ctx.totals.costUsd,
      durationMs: ctx.totals.durationMs,
    };
  }

  private withWallClock(recorded: Record<BudgetMetric, number>): Record<BudgetMetric, number> {
    // Only read the clock when a duration limit exists.
    if (!this.limits.some((l) => l.metric === 'durationMs')) return recorded;
    const elapsed = this.now() - this.startedAt;
    if (!Number.isFinite(elapsed) || elapsed <= recorded.durationMs) return recorded;
    return { ...recorded, durationMs: elapsed };
  }

  state(): { limits: Partial<Record<BudgetMetric, number>>; used: Record<BudgetMetric, number> } {
    const limits: Partial<Record<BudgetMetric, number>> = {};
    for (const l of this.limits) limits[l.metric] = l.limit;
    return { limits, used: { ...this.lastUsed } };
  }

  reset(): void {
    this.startedAt = this.now();
    this.lastUsed = zeroUsed();
  }
}

function zeroUsed(): Record<BudgetMetric, number> {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
}
