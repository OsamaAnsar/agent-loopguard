import type { StepRecord } from '../record';
import type { ToolPolicies } from '../toolPolicy';
import type { ToolLimitEvidence, ToolLimitVerdict } from '../types';
import type { Detector, DetectorResult } from './types';

/**
 * Stops when a tool is called more often than its `maxCalls` allows. `maxCalls: 3` allows three
 * calls; the fourth is the one that trips (so `maxCalls: 0` forbids the tool outright).
 *
 * Only tools with a `maxCalls` are counted. Ignored tools never are: the guard hands this
 * detector a record without them.
 */
export class ToolLimitDetector implements Detector {
  private readonly limits = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  constructor(policies: ToolPolicies) {
    for (const { tool, limit } of policies.capped) this.limits.set(tool, limit);
  }

  observe(record: StepRecord): DetectorResult | undefined {
    let evidence: ToolLimitEvidence | undefined;
    for (const call of record.calls) {
      const limit = this.limits.get(call.name);
      if (limit === undefined) continue;
      const calls = (this.counts.get(call.name) ?? 0) + 1;
      this.counts.set(call.name, calls);
      // Count every call, but report the first one that went over.
      if (calls > limit && evidence === undefined) evidence = { tool: call.name, calls, limit };
    }
    if (evidence === undefined) return undefined;

    const stop: ToolLimitVerdict = {
      stop: true,
      reason: 'tool-limit',
      code: 'TOOL_CALL_CAP',
      detail: `Tool "${evidence.tool}" was called ${evidence.calls} times; its limit is ${evidence.limit}.`,
      evidence,
    };
    return { stop };
  }

  /**
   * What `observe` would report if these calls ran next, without counting them. `calls` in the
   * evidence is the number the first over-limit call would be.
   */
  peek(calls: readonly { name: string }[]): ToolLimitVerdict | undefined {
    const pending = new Map<string, number>();
    for (const call of calls) {
      const limit = this.limits.get(call.name);
      if (limit === undefined) continue;
      const n = (pending.get(call.name) ?? this.counts.get(call.name) ?? 0) + 1;
      pending.set(call.name, n);
      if (n > limit) {
        return {
          stop: true,
          reason: 'tool-limit',
          code: 'TOOL_CALL_CAP',
          detail: `Calling tool "${call.name}" now would be call ${n}; its limit is ${limit}.`,
          evidence: { tool: call.name, calls: n, limit },
        };
      }
    }
    return undefined;
  }

  state(): Array<{ tool: string; limit: number; calls: number }> {
    return [...this.limits].map(([tool, limit]) => ({ tool, limit, calls: this.counts.get(tool) ?? 0 }));
  }

  reset(): void {
    this.counts.clear();
  }
}
