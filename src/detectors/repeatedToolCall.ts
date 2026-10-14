import type { CallRecord, StepRecord } from '../record';
import {
  MAX_NAME_LENGTH,
  MAX_PREVIEW_LENGTH,
  REDACTED,
  asHash,
  asInt,
  asList,
  asNullable,
  asRecord,
  asString,
  clip,
  fail,
  field,
} from '../snapshot';
import type { ToolPolicies } from '../toolPolicy';
import type {
  RepeatedToolCallEvidence,
  RepeatedToolCallOptions,
  RepeatedToolCallSnapshot,
  RepeatedToolCallVerdict,
} from '../types';
import type { Detector, DetectorResult } from './types';
import { assertInteger } from './types';

/** How many step indexes to keep in the evidence. */
const MAX_STEP_INDEXES = 10;

/** The run of identical calls at the end of the sequence. */
interface Run {
  /** Equality key of every call in the run; `undefined` before the first call. */
  key: string | undefined;
  tool: string;
  preview: string;
  length: number;
  steps: number[];
  /** The rule that applies to this run's tool, fixed when the run starts. */
  threshold: number;
  identicalResults: boolean;
}

interface Rule {
  threshold: number;
  identicalResults: boolean;
}

function emptyRun(): Run {
  return { key: undefined, tool: '', preview: '', length: 0, steps: [], threshold: 0, identicalResults: false };
}

/**
 * Stops when the same tool is called with canonically-equal arguments `threshold` times in a
 * row. "In a row" is measured over the flattened sequence of tool calls, so parallel calls in one
 * step count one by one, and steps without tool calls neither extend nor break a run.
 *
 * Per-tool policies adjust the rule for one tool: its own `repeatThreshold`, or `polling`, which
 * counts a repeat only when the result is identical too.
 */
export class RepeatedToolCallDetector implements Detector {
  readonly threshold: number;
  readonly requireIdenticalResults: boolean;
  readonly ignoreErrors: boolean;

  private run: Run = emptyRun();
  private longest = 0;

  constructor(
    options: RepeatedToolCallOptions = {},
    private readonly policies?: ToolPolicies,
  ) {
    this.threshold = assertInteger('repeatedToolCall.threshold', options.threshold ?? 3, 2);
    this.requireIdenticalResults = options.requireIdenticalResults ?? false;
    this.ignoreErrors = options.ignoreErrors ?? false;
  }

  observe(record: StepRecord): DetectorResult | undefined {
    let hit: RepeatedToolCallEvidence | undefined;

    for (const call of record.calls) {
      if (this.ignoreErrors && call.failed) continue;
      const rule = this.ruleFor(call.name);
      const key = rule.identicalResults ? call.outcomeSig : call.callSig;
      this.run = advance(this.run, key, call, record.index, rule);
      if (this.run.length > this.longest) this.longest = this.run.length;
      // Capture as soon as the threshold is reached: a later call in the same step may end the run.
      if (this.run.length >= this.run.threshold) hit = evidenceOf(this.run);
    }

    if (hit === undefined) return undefined;
    const results = hit.identicalResults ? ' and identical results' : '';
    return {
      stop: {
        stop: true,
        reason: 'repeated-tool-call',
        code: 'REPEATED_TOOL_CALL',
        detail: `Tool "${hit.tool}" was called ${hit.count} times in a row with identical arguments${results}: ${hit.tool}(${hit.argsPreview}).`,
        evidence: hit,
      },
    };
  }

  /**
   * What `observe` would report if these calls (not yet made, so without results) were the next
   * ones, without recording them. `stepIndex` is the index the step would get.
   *
   * A rule that needs results to call two calls identical (`requireIdenticalResults`, a `polling`
   * tool) cannot be judged before the call runs, so such a call never trips it here; it counts as
   * a run of one.
   */
  peek(calls: readonly CallRecord[], stepIndex: number): RepeatedToolCallVerdict | undefined {
    let run: Run = { ...this.run, steps: [...this.run.steps] };
    let hit: RepeatedToolCallEvidence | undefined;

    for (const [i, call] of calls.entries()) {
      const rule = this.ruleFor(call.name);
      // The outcome is unknown, so give a result-aware call a key nothing else can match.
      const key = rule.identicalResults ? `pending#${i}` : call.callSig;
      run = advance(run, key, call, stepIndex, rule);
      if (run.length >= run.threshold) hit = evidenceOf(run);
    }

    if (hit === undefined) return undefined;
    return {
      stop: true,
      reason: 'repeated-tool-call',
      code: 'REPEATED_TOOL_CALL',
      detail: `Calling tool "${hit.tool}" now would be call ${hit.count} in a row with identical arguments (the limit is ${hit.threshold}): ${hit.tool}(${hit.argsPreview}).`,
      evidence: hit,
    };
  }

  /** The threshold and result-matching mode that apply to calls of `tool`. */
  private ruleFor(tool: string): Rule {
    const policy = this.policies?.get(tool);
    if (policy?.polling === true) {
      return { threshold: policy.pollingThreshold ?? policy.repeatThreshold ?? this.threshold, identicalResults: true };
    }
    return { threshold: policy?.repeatThreshold ?? this.threshold, identicalResults: this.requireIdenticalResults };
  }

  /** The resolved options, for the snapshot fingerprint. */
  config(): { threshold: number; requireIdenticalResults: boolean; ignoreErrors: boolean } {
    return {
      threshold: this.threshold,
      requireIdenticalResults: this.requireIdenticalResults,
      ignoreErrors: this.ignoreErrors,
    };
  }

  snapshot(redact: boolean): RepeatedToolCallSnapshot {
    const run = this.run;
    return {
      key: run.length === 0 ? null : (run.key ?? null),
      tool: clip(run.tool, MAX_NAME_LENGTH),
      preview: redact && run.preview !== '' ? REDACTED : clip(run.preview, MAX_PREVIEW_LENGTH),
      length: run.length,
      steps: [...run.steps],
      longest: this.longest,
    };
  }

  restore(raw: unknown): void {
    const path = 'detectors.repeatedToolCall';
    const state = asRecord(raw, path);
    const key = asNullable(field(state, 'key', path), (v) => asHash(v, `${path}.key`));
    const tool = asString(field(state, 'tool', path), `${path}.tool`, MAX_NAME_LENGTH);
    const preview = asString(field(state, 'preview', path), `${path}.preview`, MAX_PREVIEW_LENGTH);
    const length = asInt(field(state, 'length', path), `${path}.length`);
    const steps = asList(field(state, 'steps', path), `${path}.steps`, MAX_STEP_INDEXES).map((v, i) =>
      asInt(v, `${path}.steps[${i}]`),
    );
    const longest = asInt(field(state, 'longest', path), `${path}.longest`);

    if (length === 0 ? key !== null || steps.length !== 0 : key === null || steps.length === 0 || steps.length > length) {
      fail(path, 'has a run whose key, length and steps disagree');
    }
    if (steps.some((v, i) => i > 0 && v <= (steps[i - 1] as number))) {
      fail(`${path}.steps`, 'must be strictly increasing');
    }
    if (longest < length) fail(`${path}.longest`, 'must be at least the length of the current run');

    this.run = length === 0 || key === null ? emptyRun() : { key, tool, preview, length, steps, ...this.ruleFor(tool) };
    this.longest = longest;
  }

  state(): { threshold: number; currentRun: { tool: string; length: number } | null; longestRun: number } {
    return {
      threshold: this.threshold,
      currentRun: this.run.length > 0 ? { tool: this.run.tool, length: this.run.length } : null,
      longestRun: this.longest,
    };
  }

  reset(): void {
    this.run = emptyRun();
    this.longest = 0;
  }
}

/** Extend `run` by one call with equality key `key`, or start a new run. May update `run` in place. */
function advance(run: Run, key: string, call: CallRecord, stepIndex: number, rule: Rule): Run {
  if (key !== run.key) {
    return { key, tool: call.name, preview: call.argsPreview, length: 1, steps: [stepIndex], ...rule };
  }
  run.length += 1;
  if (run.steps[run.steps.length - 1] !== stepIndex) {
    run.steps.push(stepIndex);
    if (run.steps.length > MAX_STEP_INDEXES) run.steps.shift();
  }
  return run;
}

function evidenceOf(run: Run): RepeatedToolCallEvidence {
  return {
    tool: run.tool,
    argsPreview: run.preview,
    count: run.length,
    threshold: run.threshold,
    stepIndexes: [...run.steps],
    identicalResults: run.identicalResults,
  };
}
