/**
 * Public types for agent-loopguard.
 *
 * Everything here is plain data: steps go in, serialisable verdicts come out.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One tool invocation made during a step. */
export interface GuardToolCall {
  /** Tool name as the model called it. */
  name: string;
  /** Arguments the model supplied. Any JSON-ish (or not-so-JSON-ish) value. */
  args?: unknown;
  /** Value the tool returned, if you have it. Used by result-aware rules. */
  result?: unknown;
  /** Error the tool raised, if any. A non-null `error` marks the call as failed. */
  error?: unknown;
}

/** Token and cost numbers for one step. All supplied by the caller; nothing is estimated. */
export interface GuardUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  /** Cost in USD as computed by the caller. The package contains no price table. */
  costUsd?: number | undefined;
}

/**
 * One model step: what the model produced and what happened as a result.
 * Every field is optional; supply what you have.
 */
export interface GuardStep {
  toolCalls?: readonly GuardToolCall[] | undefined;
  /** Assistant text produced in this step. */
  text?: string | undefined;
  /**
   * Why the model stopped generating. Provider-agnostic: `'stop' | 'length' | 'tool-calls' |
   * 'content-filter' | 'error' | 'other' | 'unknown'` or any other string. Compared after
   * lower-casing and turning `_` into `-`.
   */
  finishReason?: string | undefined;
  usage?: GuardUsage | undefined;
  /** How long the step took, in milliseconds. Summed by the `maxDurationMs` budget. */
  durationMs?: number | undefined;
  /** When the step happened (epoch ms). Informational: recorded in history, not used by detectors. */
  timestamp?: number | undefined;
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type StopReason =
  | 'max-steps'
  | 'tool-limit'
  | 'repeated-tool-call'
  | 'oscillation'
  | 'no-progress'
  | 'finish-reason'
  | 'budget'
  | 'custom';

export type BudgetMetric = 'totalTokens' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'durationMs';

/** Stable machine-readable codes. Safe to switch on; new codes are only added in minor versions. */
export type BuiltinStopCode =
  | 'MAX_STEPS'
  | 'TOOL_CALL_CAP'
  | 'REPEATED_TOOL_CALL'
  | 'OSCILLATION'
  | 'NO_PROGRESS'
  | 'FINISH_TERMINAL'
  | 'FINISH_OTHER'
  | 'FINISH_OTHER_TEXT_ONLY'
  | 'BUDGET_TOTAL_TOKENS'
  | 'BUDGET_INPUT_TOKENS'
  | 'BUDGET_OUTPUT_TOKENS'
  | 'BUDGET_COST_USD'
  | 'BUDGET_DURATION_MS';

export interface MaxStepsEvidence {
  steps: number;
  limit: number;
}

export interface ToolLimitEvidence {
  tool: string;
  /** Calls to the tool in this run, counting the one that went over. */
  calls: number;
  /** The tool's `maxCalls`. */
  limit: number;
}

export interface RepeatedToolCallEvidence {
  tool: string;
  /** Canonical form of the arguments, truncated for display. */
  argsPreview: string;
  /** Length of the run of identical calls. */
  count: number;
  /** The threshold that applied to this tool (the global one unless the tool's policy changes it). */
  threshold: number;
  /** Indexes (0-based) of the steps that contain the run; at most the last 10. */
  stepIndexes: number[];
  /** True when identical results were required too (the global option, or a `polling` tool). */
  identicalResults: boolean;
}

export interface OscillationEvidence {
  /** Number of tool calls in one cycle. */
  period: number;
  /** How many consecutive times the cycle was observed. */
  repeats: number;
  threshold: number;
  /** One cycle, as `tool(args)` labels. */
  cycle: string[];
  /** The tool name of each call in the cycle (no arguments), in the same order as `cycle`. */
  tools: string[];
}

export interface NoProgressEvidence {
  /** Consecutive stalled steps with identical text. */
  steps: number;
  threshold: number;
  /** The repeated text (normalised), truncated for display. */
  textPreview: string;
}

export interface FinishReasonEvidence {
  /** The finish reason exactly as supplied. */
  finishReason: string;
  /** Lower-cased, `_` replaced by `-`. */
  normalized: string;
  policy: 'terminal' | 'other-stop' | 'other-text-only';
  hasText: boolean;
  toolCallCount: number;
}

export interface BudgetEvidence {
  metric: BudgetMetric;
  value: number;
  limit: number;
}

interface StopBase<R extends StopReason, C extends string, E> {
  stop: true;
  reason: R;
  /** Stable machine-readable code. */
  code: C;
  /** One human-readable sentence. */
  detail: string;
  /** Structured, JSON-serialisable facts behind the decision. */
  evidence: E;
  /**
   * Plain-English text meant to be pasted into the model's next turn or tool result, present on
   * every stop that is a fault (see `isFault`). It names the tool but never repeats arguments or
   * results, so it is safe to send to the model. Absent on a normal `stop` finish and, for a
   * `custom` stop, unless the detector (or `options.feedback`) supplies it. See `feedbackFor`.
   */
  feedback?: string;
  /** Non-fatal warnings raised in the same step, if any. */
  warnings?: GuardWarning[];
}

export type MaxStepsVerdict = StopBase<'max-steps', 'MAX_STEPS', MaxStepsEvidence>;
export type ToolLimitVerdict = StopBase<'tool-limit', 'TOOL_CALL_CAP', ToolLimitEvidence>;
export type RepeatedToolCallVerdict = StopBase<
  'repeated-tool-call',
  'REPEATED_TOOL_CALL',
  RepeatedToolCallEvidence
>;
export type OscillationVerdict = StopBase<'oscillation', 'OSCILLATION', OscillationEvidence>;
export type NoProgressVerdict = StopBase<'no-progress', 'NO_PROGRESS', NoProgressEvidence>;
export type FinishReasonVerdict = StopBase<
  'finish-reason',
  'FINISH_TERMINAL' | 'FINISH_OTHER' | 'FINISH_OTHER_TEXT_ONLY',
  FinishReasonEvidence
>;
export type BudgetVerdict = StopBase<
  'budget',
  | 'BUDGET_TOTAL_TOKENS'
  | 'BUDGET_INPUT_TOKENS'
  | 'BUDGET_OUTPUT_TOKENS'
  | 'BUDGET_COST_USD'
  | 'BUDGET_DURATION_MS',
  BudgetEvidence
>;
/** Verdict produced by a user-supplied `custom` detector. */
export type CustomVerdict = StopBase<'custom', string, unknown>;

export type StopVerdict =
  | MaxStepsVerdict
  | ToolLimitVerdict
  | RepeatedToolCallVerdict
  | OscillationVerdict
  | NoProgressVerdict
  | FinishReasonVerdict
  | BudgetVerdict
  | CustomVerdict;

export interface GuardWarning {
  code: 'BUDGET_WARNING';
  metric: BudgetMetric;
  value: number;
  limit: number;
  /** `value / limit`. */
  ratio: number;
  detail: string;
}

export interface ContinueVerdict {
  stop: false;
  /** Present only when at least one warning is active. */
  warnings?: GuardWarning[];
}

export type Verdict = ContinueVerdict | StopVerdict;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RepeatedToolCallOptions {
  /** Stop when the same call occurs this many times in a row. Integer >= 2. Default 3. */
  threshold?: number;
  /**
   * Count a repeat only when the call also returned an identical result (calls without a result
   * compare equal). Use for polling-style tools. Default false.
   */
  requireIdenticalResults?: boolean;
  /** Drop failed calls (non-null `error`) from the sequence before counting. Default false. */
  ignoreErrors?: boolean;
}

export interface OscillationOptions {
  /** Longest cycle to look for (cycles of length 2..maxPeriod). Integer >= 2. Default 3. */
  maxPeriod?: number;
  /** Stop when a cycle was seen this many times in a row. Integer >= 2. Default 3. */
  repeats?: number;
}

export interface NoProgressOptions {
  /** Consecutive stalled steps with identical text. Integer >= 2. Default 3. */
  threshold?: number;
}

export type OtherFinishPolicy = 'stop' | 'continue' | 'stop-if-text-only';

export interface FinishReasonOptions {
  /** Finish reasons that end the run. Default `['stop', 'length', 'content-filter', 'error']`. */
  terminal?: readonly string[];
  /**
   * What to do with a finish reason that is neither terminal nor `tool-calls` (`other`, `unknown`,
   * or anything unfamiliar). Default `'stop-if-text-only'`.
   */
  otherPolicy?: OtherFinishPolicy;
}

/** A limit, optionally with a warning threshold. */
export type BudgetLimit = number | { limit: number; warnAt?: number };

export interface BudgetOptions {
  maxTotalTokens?: BudgetLimit;
  maxInputTokens?: BudgetLimit;
  maxOutputTokens?: BudgetLimit;
  maxCostUsd?: BudgetLimit;
  maxDurationMs?: BudgetLimit;
  /** Default warning ratio (0 < r < 1) for limits that do not set their own `warnAt`. */
  warnAt?: number;
}

/** What a custom detector returns to stop the run. */
export interface CustomStop {
  stop: true;
  /** Stable machine-readable code of your own. Default `'CUSTOM'`. */
  code?: string;
  /** One human-readable sentence. */
  detail?: string;
  /** Anything JSON-serialisable that explains the decision. */
  evidence?: unknown;
  /** Text for the model, becomes `verdict.feedback`. Default: none. Must not contain secrets. */
  feedback?: string;
}

/**
 * User-supplied detector. Receives the full history (including `step`, last) and may return a
 * stop verdict. Return `undefined` (or `{ stop: false }`) to let the run continue. Errors it
 * throws propagate out of `guard.check`.
 */
export type CustomDetector = (
  history: readonly GuardStep[],
  step: GuardStep,
) => CustomStop | { stop: false } | undefined;

/**
 * Rules for one tool, keyed by tool name in `GuardOptions.tools`. Every field is optional. See the
 * README ("Per-tool policies") for how they combine with the global detectors.
 */
export interface ToolPolicy {
  /**
   * Identical arguments are legitimate for this tool as long as the results keep changing (a job
   * status poll, a paginated read). The repeated-call rule then applies only when the results are
   * identical too, after `maxIdenticalResults` identical outcomes in a row (default: the tool's
   * `repeatThreshold`, else the global threshold). `true` is the same as `{}`.
   */
  polling?: boolean | { maxIdenticalResults?: number };
  /**
   * At most this many calls to the tool in one run (integer >= 0; `0` forbids the tool). The call
   * after the limit stops the run with `TOOL_CALL_CAP` (and `guard.preflight` denies it before it runs).
   */
  maxCalls?: number;
  /** Stop after this many identical calls in a row to this tool. Integer >= 2. Overrides the global threshold. */
  repeatThreshold?: number;
  /**
   * Leave the tool out of repeat, oscillation and no-progress detection and out of `maxCalls`
   * (for bookkeeping tools such as `think` or `todo`). Takes precedence over the other fields.
   */
  ignore?: boolean;
}

/** Where a piece of feedback is going: after a step was recorded, or in place of a call that was not run. */
export type FeedbackPhase = 'check' | 'preflight';

export interface GuardOptions {
  /** Stop after this many steps. Integer >= 1. Default 50. `false` disables. */
  maxSteps?: number | false;
  /** Default: enabled with default options. `false` disables. */
  repeatedToolCall?: RepeatedToolCallOptions | false;
  /** Default: enabled with default options. `false` disables. */
  oscillation?: OscillationOptions | false;
  /** Default: enabled with default options. `false` disables. */
  noProgress?: NoProgressOptions | false;
  /** Default: enabled with default options. `false` disables. */
  finishReason?: FinishReasonOptions | false;
  /** Default: no limits. */
  budget?: BudgetOptions | false;
  /** Per-tool rules by tool name; tools that are not listed follow the global options. */
  tools?: Readonly<Record<string, ToolPolicy>>;
  /** Extra detectors, run after the built-in ones. */
  custom?: CustomDetector | readonly CustomDetector[];
  /**
   * Replace the model-facing text of a fault verdict (and of a `preflight` denial). Return a string
   * to use it, or `undefined` to keep the default (`feedbackFor`). Errors it throws propagate out of
   * `guard.check` / `guard.preflight`. The text is yours to keep free of secrets.
   */
  feedback?: (verdict: StopVerdict, info: { phase: FeedbackPhase }) => string | undefined;
  /** Clock used for wall-clock duration budgets. Default `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export interface GuardTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Sum of the `durationMs` values supplied on steps. */
  durationMs: number;
}

export interface GuardSummary {
  steps: number;
  toolCalls: number;
  failedToolCalls: number;
  totals: GuardTotals;
  /** `null` for a detector that is disabled. */
  detectors: {
    maxSteps: { limit: number; remaining: number } | null;
    repeatedToolCall: {
      /** The global threshold; tools with their own `repeatThreshold` or `polling` policy can differ. */
      threshold: number;
      currentRun: { tool: string; length: number } | null;
      longestRun: number;
    } | null;
    oscillation: { maxPeriod: number; repeats: number; current: { period: number; repeats: number } | null } | null;
    noProgress: { threshold: number; streak: number } | null;
    finishReason: { lastFinishReason: string | null } | null;
    budget: { limits: Partial<Record<BudgetMetric, number>>; used: Record<BudgetMetric, number> } | null;
    /** Calls so far against each tool's `maxCalls`. Present only when at least one tool has a cap. */
    toolLimits?: Array<{ tool: string; limit: number; calls: number }>;
  };
  /** The verdict returned by the most recent `check`, or `null` before the first one. */
  lastVerdict: Verdict | null;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** A tool call that has not run yet: all `preflight` needs is the name and the arguments. */
export interface PreflightCall {
  name: string;
  args?: unknown;
}

/** The call may go ahead (as far as the rules `preflight` can evaluate are concerned). */
export interface PreflightAllow {
  allow: true;
  /** Budget warnings that apply right now, if any. */
  warnings?: GuardWarning[];
}

interface DenyBase<R extends StopReason, C extends string, E> {
  allow: false;
  /** Same vocabulary as `StopVerdict.reason`. */
  reason: R;
  /** Same vocabulary as `StopVerdict.code`. */
  code: C;
  /** One developer-facing sentence. May contain argument previews, like `StopVerdict.detail`. */
  detail: string;
  /** Structured, JSON-serialisable facts behind the decision. */
  evidence: E;
  /** Text to give the model in place of the tool's result. Never repeats arguments or results. */
  feedback: string;
}

/**
 * The call should not run. Only the rules that can be judged before a call runs appear here:
 * `max-steps`, `budget`, `tool-limit`, `repeated-tool-call` and `oscillation`.
 */
export type PreflightDeny =
  | DenyBase<'max-steps', 'MAX_STEPS', MaxStepsEvidence>
  | DenyBase<'budget', BudgetVerdict['code'], BudgetEvidence>
  | DenyBase<'tool-limit', 'TOOL_CALL_CAP', ToolLimitEvidence>
  | DenyBase<'repeated-tool-call', 'REPEATED_TOOL_CALL', RepeatedToolCallEvidence>
  | DenyBase<'oscillation', 'OSCILLATION', OscillationEvidence>;

export type Preflight = PreflightAllow | PreflightDeny;

/** The stop verdicts a `preflight` denial is made from. */
export type PreflightStopVerdict =
  | MaxStepsVerdict
  | BudgetVerdict
  | ToolLimitVerdict
  | RepeatedToolCallVerdict
  | OscillationVerdict;

export interface Guard {
  /** Record a step and decide whether the run should continue. Never throws on odd step data. */
  check(step: GuardStep): Verdict;
  /**
   * Would this call (or these parallel calls) trip a rule if it ran now? Records nothing and does
   * not change the guard: call it as often as you like, then still `check` the finished step.
   * Evaluates only the rules that need no results, text, finish reason or usage; see the README
   * ("Preflight") for the exact list. Never throws on odd call data.
   */
  preflight(call: PreflightCall | readonly PreflightCall[]): Preflight;
  /** Forget everything and start a fresh run (options are kept). */
  reset(): void;
  /** Counts, totals and per-detector state. Contains nothing time-dependent. */
  summary(): GuardSummary;
  /** Frozen shallow copy of the steps recorded so far. */
  readonly history: readonly GuardStep[];
}
