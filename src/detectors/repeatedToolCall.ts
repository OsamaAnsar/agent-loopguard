import type { CallRecord, StepRecord } from '../record';
import type { RepeatedToolCallEvidence, RepeatedToolCallOptions } from '../types';
import type { Detector, DetectorResult } from './types';
import { assertInteger } from './types';

/** How many step indexes to keep in the evidence. */
const MAX_STEP_INDEXES = 10;

/**
 * Stops when the same tool is called with canonically-equal arguments `threshold` times in a
 * row. "In a row" is measured over the flattened sequence of tool calls, so parallel calls in one
 * step count one by one, and steps without tool calls neither extend nor break a run.
 */
export class RepeatedToolCallDetector implements Detector {
  readonly threshold: number;
  readonly requireIdenticalResults: boolean;
  readonly ignoreErrors: boolean;

  private runKey: string | undefined;
  private runTool = '';
  private runPreview = '';
  private runLength = 0;
  private runSteps: number[] = [];
  private longest = 0;

  constructor(options: RepeatedToolCallOptions = {}) {
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
      if (this.runLength >= this.threshold) hit = this.evidence();
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

  private extendRun(call: CallRecord, stepIndex: number): void {
    const key = this.requireIdenticalResults ? call.outcomeSig : call.callSig;
    if (key === this.runKey) {
      this.runLength += 1;
      if (this.runSteps[this.runSteps.length - 1] !== stepIndex) this.runSteps.push(stepIndex);
    } else {
      this.runKey = key;
      this.runTool = call.name;
      this.runPreview = call.argsPreview;
      this.runLength = 1;
      this.runSteps = [stepIndex];
    }
    if (this.runLength > this.longest) this.longest = this.runLength;
  }

  private evidence(): RepeatedToolCallEvidence {
    return {
      tool: this.runTool,
      argsPreview: this.runPreview,
      count: this.runLength,
      threshold: this.threshold,
      stepIndexes: this.runSteps.slice(-MAX_STEP_INDEXES),
      identicalResults: this.requireIdenticalResults,
    };
  }

  state(): { threshold: number; currentRun: { tool: string; length: number } | null; longestRun: number } {
    return {
      threshold: this.threshold,
      currentRun: this.runLength > 0 ? { tool: this.runTool, length: this.runLength } : null,
      longestRun: this.longest,
    };
  }

  reset(): void {
    this.runKey = undefined;
    this.runTool = '';
    this.runPreview = '';
    this.runLength = 0;
    this.runSteps = [];
    this.longest = 0;
  }
}
