import type { CallRecord, StepRecord } from '../record';
import type { ToolPolicies } from '../toolPolicy';
import type { RepeatedToolCallEvidence, RepeatedToolCallOptions } from '../types';
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
      this.extendRun(call, record.index);
      // Capture as soon as the threshold is reached: a later call in the same step may end the run.
      if (this.run.length >= this.run.threshold) hit = this.evidence();
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

  /** The threshold and result-matching mode that apply to calls of `tool`. */
  private ruleFor(tool: string): { threshold: number; identicalResults: boolean } {
    const policy = this.policies?.get(tool);
    if (policy?.polling === true) {
      return { threshold: policy.pollingThreshold ?? policy.repeatThreshold ?? this.threshold, identicalResults: true };
    }
    return { threshold: policy?.repeatThreshold ?? this.threshold, identicalResults: this.requireIdenticalResults };
  }

  private extendRun(call: CallRecord, stepIndex: number): void {
    const rule = this.ruleFor(call.name);
    const key = rule.identicalResults ? call.outcomeSig : call.callSig;
    const run = this.run;
    if (key === run.key) {
      run.length += 1;
      if (run.steps[run.steps.length - 1] !== stepIndex) {
        run.steps.push(stepIndex);
        if (run.steps.length > MAX_STEP_INDEXES) run.steps.shift();
      }
    } else {
      this.run = { key, tool: call.name, preview: call.argsPreview, length: 1, steps: [stepIndex], ...rule };
    }
    if (this.run.length > this.longest) this.longest = this.run.length;
  }

  private evidence(): RepeatedToolCallEvidence {
    const run = this.run;
    return {
      tool: run.tool,
      argsPreview: run.preview,
      count: run.length,
      threshold: run.threshold,
      stepIndexes: [...run.steps],
      identicalResults: run.identicalResults,
    };
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
