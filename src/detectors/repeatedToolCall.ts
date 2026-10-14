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
  RepeatedToolCallWindowEvidence,
  RepeatedToolCallWindowOptions,
  RepeatedToolCallWindowVerdict,
} from '../types';
import { CallWindow } from './callWindow';
import type { Detector, DetectorResult } from './types';
import { assertInteger, assertIntegerBetween } from './types';

/** How many step indexes to keep in the evidence. */
const MAX_STEP_INDEXES = 10;

/**
 * Largest `window.size`. The window holds one 28-character hash per call, so this bounds both memory
 * and the size of a snapshot (about 30 KB at the limit).
 */
export const MAX_WINDOW_SIZE = 1000;

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

/** Check `options.window` and return it resolved, or `undefined` when there is no window. */
function resolveWindow(raw: RepeatedToolCallWindowOptions | false | undefined): RepeatedToolCallWindowOptions | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError(`agent-loopguard: repeatedToolCall.window must be an object with size and maxRepeats, or false, got ${String(raw)}`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'size' && key !== 'maxRepeats') {
      throw new TypeError(`agent-loopguard: repeatedToolCall.window has an unknown option "${key}" (known: size, maxRepeats)`);
    }
  }
  const size = assertIntegerBetween('repeatedToolCall.window.size', raw.size, 2, MAX_WINDOW_SIZE);
  const maxRepeats = assertIntegerBetween('repeatedToolCall.window.maxRepeats', raw.maxRepeats, 2, size);
  return { size, maxRepeats };
}

/**
 * Stops when the same tool is called with canonically-equal arguments `threshold` times in a
 * row. "In a row" is measured over the flattened sequence of tool calls, so parallel calls in one
 * step count one by one, and steps without tool calls neither extend nor break a run.
 *
 * Per-tool policies adjust the rule for one tool: its own `repeatThreshold`, or `polling`, which
 * counts a repeat only when the result is identical too.
 *
 * With `window`, it also stops when the same call occurs `maxRepeats` times among the newest `size`
 * calls, however many other calls came in between. Both checks read the same calls (ignored tools
 * and, with `ignoreErrors`, failed calls are left out) and compare them the same way. The
 * consecutive check is reported first when both would stop.
 */
export class RepeatedToolCallDetector implements Detector {
  readonly threshold: number;
  readonly requireIdenticalResults: boolean;
  readonly ignoreErrors: boolean;
  readonly window: RepeatedToolCallWindowOptions | undefined;

  private run: Run = emptyRun();
  private longest = 0;
  private readonly calls: CallWindow | undefined;

  constructor(
    options: RepeatedToolCallOptions = {},
    private readonly policies?: ToolPolicies,
  ) {
    this.threshold = assertInteger('repeatedToolCall.threshold', options.threshold ?? 3, 2);
    this.requireIdenticalResults = options.requireIdenticalResults ?? false;
    this.ignoreErrors = options.ignoreErrors ?? false;
    this.window = resolveWindow(options.window);
    this.calls = this.window === undefined ? undefined : new CallWindow(this.window.size);
  }

  observe(record: StepRecord): DetectorResult | undefined {
    let hit: RepeatedToolCallEvidence | undefined;
    let windowHit: RepeatedToolCallWindowEvidence | undefined;

    for (const call of record.calls) {
      if (this.ignoreErrors && call.failed) continue;
      const rule = this.ruleFor(call.name, this.threshold);
      const key = rule.identicalResults ? call.outcomeSig : call.callSig;
      this.run = advance(this.run, key, call, record.index, rule);
      if (this.run.length > this.longest) this.longest = this.run.length;
      // Capture as soon as the threshold is reached: a later call in the same step may end the run.
      if (this.run.length >= this.run.threshold) hit = evidenceOf(this.run);

      if (this.calls !== undefined && this.window !== undefined) {
        const windowRule = this.ruleFor(call.name, this.window.maxRepeats);
        const count = this.calls.add(key);
        if (count >= windowRule.threshold) windowHit = windowEvidenceOf(call, count, windowRule, this.window, this.calls.length);
      }
    }

    if (hit !== undefined) {
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
    if (windowHit === undefined) return undefined;
    const results = windowHit.identicalResults ? ' and identical results' : '';
    return {
      stop: {
        stop: true,
        reason: 'repeated-tool-call-window',
        code: 'REPEATED_TOOL_CALL_WINDOW',
        detail: `Tool "${windowHit.tool}" was called ${windowHit.count} times with identical arguments${results} within the last ${windowHit.windowSize} calls: ${windowHit.tool}(${windowHit.argsPreview}).`,
        evidence: windowHit,
      },
    };
  }

  /**
   * What `observe` would report if these calls (not yet made, so without results) were the next
   * ones, without recording them. `stepIndex` is the index the step would get.
   *
   * A rule that needs results to call two calls identical (`requireIdenticalResults`, a `polling`
   * tool) cannot be judged before the call runs, so such a call never trips it here; it counts as
   * a run of one, and as a call of its own in the window.
   */
  peek(calls: readonly CallRecord[], stepIndex: number): RepeatedToolCallVerdict | RepeatedToolCallWindowVerdict | undefined {
    let run: Run = { ...this.run, steps: [...this.run.steps] };
    const window = this.calls?.clone();
    let hit: RepeatedToolCallEvidence | undefined;
    let windowHit: RepeatedToolCallWindowEvidence | undefined;

    for (const [i, call] of calls.entries()) {
      const rule = this.ruleFor(call.name, this.threshold);
      // The outcome is unknown, so give a result-aware call a key nothing else can match.
      const key = rule.identicalResults ? `pending#${i}` : call.callSig;
      run = advance(run, key, call, stepIndex, rule);
      if (run.length >= run.threshold) hit = evidenceOf(run);

      if (window !== undefined && this.window !== undefined) {
        const windowRule = this.ruleFor(call.name, this.window.maxRepeats);
        const count = window.add(key);
        if (count >= windowRule.threshold) windowHit = windowEvidenceOf(call, count, windowRule, this.window, window.length);
      }
    }

    if (hit !== undefined) {
      return {
        stop: true,
        reason: 'repeated-tool-call',
        code: 'REPEATED_TOOL_CALL',
        detail: `Calling tool "${hit.tool}" now would be call ${hit.count} in a row with identical arguments (the limit is ${hit.threshold}): ${hit.tool}(${hit.argsPreview}).`,
        evidence: hit,
      };
    }
    if (windowHit === undefined) return undefined;
    return {
      stop: true,
      reason: 'repeated-tool-call-window',
      code: 'REPEATED_TOOL_CALL_WINDOW',
      detail: `Calling tool "${windowHit.tool}" now would be call ${windowHit.count} with identical arguments within the last ${windowHit.windowSize} calls (the limit is ${windowHit.threshold}): ${windowHit.tool}(${windowHit.argsPreview}).`,
      evidence: windowHit,
    };
  }

  /**
   * The threshold and result-matching mode that apply to calls of `tool`. `fallback` is the number
   * used when the tool's policy names none: the consecutive `threshold`, or the window's `maxRepeats`.
   */
  private ruleFor(tool: string, fallback: number): Rule {
    const policy = this.policies?.get(tool);
    if (policy?.polling === true) {
      return { threshold: policy.pollingThreshold ?? policy.repeatThreshold ?? fallback, identicalResults: true };
    }
    return { threshold: policy?.repeatThreshold ?? fallback, identicalResults: this.requireIdenticalResults };
  }

  /** The resolved options, for the snapshot fingerprint. The `window` entry exists only when a window is set. */
  config(): {
    threshold: number;
    requireIdenticalResults: boolean;
    ignoreErrors: boolean;
    window?: { size: number; maxRepeats: number };
  } {
    return {
      threshold: this.threshold,
      requireIdenticalResults: this.requireIdenticalResults,
      ignoreErrors: this.ignoreErrors,
      ...(this.window === undefined ? {} : { window: { size: this.window.size, maxRepeats: this.window.maxRepeats } }),
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
      ...(this.calls === undefined ? {} : { window: { keys: this.calls.keys() } }),
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

    // Read the window before changing anything, so a bad snapshot leaves this detector as it was.
    let windowKeys: string[] | undefined;
    if (this.calls !== undefined) {
      const where = `${path}.window`;
      const window = asRecord(field(state, 'window', path), where);
      windowKeys = asList(field(window, 'keys', where), `${where}.keys`, this.calls.size).map((v, i) =>
        asHash(v, `${where}.keys[${i}]`),
      );
    }

    this.run = length === 0 || key === null ? emptyRun() : { key, tool, preview, length, steps, ...this.ruleFor(tool, this.threshold) };
    this.longest = longest;
    if (windowKeys !== undefined) this.calls?.load(windowKeys);
  }

  state(): {
    threshold: number;
    currentRun: { tool: string; length: number } | null;
    longestRun: number;
    window?: { size: number; maxRepeats: number; calls: number; highestCount: number };
  } {
    return {
      threshold: this.threshold,
      currentRun: this.run.length > 0 ? { tool: this.run.tool, length: this.run.length } : null,
      longestRun: this.longest,
      ...(this.calls === undefined || this.window === undefined
        ? {}
        : {
            window: {
              size: this.window.size,
              maxRepeats: this.window.maxRepeats,
              calls: this.calls.length,
              highestCount: this.calls.highest(),
            },
          }),
    };
  }

  reset(): void {
    this.run = emptyRun();
    this.longest = 0;
    this.calls?.clear();
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

function windowEvidenceOf(
  call: CallRecord,
  count: number,
  rule: Rule,
  window: RepeatedToolCallWindowOptions,
  windowCalls: number,
): RepeatedToolCallWindowEvidence {
  return {
    tool: call.name,
    argsPreview: call.argsPreview,
    count,
    threshold: rule.threshold,
    windowSize: window.size,
    windowCalls,
    identicalResults: rule.identicalResults,
  };
}
