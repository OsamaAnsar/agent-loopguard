import type { StepRecord } from '../record';
import { MAX_NAME_LENGTH, asInt, asList, asRecord, asString, fail, field } from '../snapshot';
import type { ToolPolicies } from '../toolPolicy';
import type { GuardWarning, ToolLimitEvidence, ToolLimitVerdict } from '../types';
import { toolLimitWarning } from '../warnings';
import type { Detector, DetectorResult, WarnRule } from './types';
import { inWarnZone, resolveWarnAt } from './types';

/** What `peek` found: the stop the calls would cause, and the warnings they would carry. */
export interface ToolLimitPeek {
  stop?: ToolLimitVerdict;
  warnings: GuardWarning[];
}

/**
 * Stops when a tool is called more often than its `maxCalls` allows. `maxCalls: 3` allows three
 * calls; the fourth is the one that trips (so `maxCalls: 0` forbids the tool outright).
 *
 * Only tools with a `maxCalls` are counted. Ignored tools never are: the guard hands this
 * detector a record without them.
 *
 * With early warnings on, a step that calls a capped tool carries a warning while its calls so far are
 * between `warnAt` (default `maxCalls - 1`, at least 1) and `maxCalls`.
 */
export class ToolLimitDetector implements Detector {
  private readonly limits = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  private readonly warn = new Map<string, WarnRule>();

  constructor(policies: ToolPolicies, warnByDefault: boolean) {
    for (const { tool, limit } of policies.capped) {
      this.limits.set(tool, limit);
      this.warn.set(tool, resolveWarnAt(`tools[${JSON.stringify(tool)}].warnAt`, policies.warnAt(tool), warnByDefault, 1, limit));
    }
  }

  observe(record: StepRecord): DetectorResult | undefined {
    let evidence: ToolLimitEvidence | undefined;
    const touched = new Set<string>();
    for (const call of record.calls) {
      const limit = this.limits.get(call.name);
      if (limit === undefined) continue;
      const calls = (this.counts.get(call.name) ?? 0) + 1;
      this.counts.set(call.name, calls);
      touched.add(call.name);
      // Count every call, but report the first one that went over.
      if (calls > limit && evidence === undefined) evidence = { tool: call.name, calls, limit };
    }
    const warnings = this.warningsFor(touched, this.counts);

    const result: DetectorResult = {};
    if (evidence !== undefined) {
      result.stop = {
        stop: true,
        reason: 'tool-limit',
        code: 'TOOL_CALL_CAP',
        detail: `Tool "${evidence.tool}" was called ${evidence.calls} times; its limit is ${evidence.limit}.`,
        evidence,
      };
    }
    if (warnings.length > 0) result.warnings = warnings;
    return result.stop === undefined && result.warnings === undefined ? undefined : result;
  }

  /**
   * What `observe` would report if these calls ran next, without counting them. `calls` in the
   * evidence is the number the first over-limit call would be.
   */
  peek(calls: readonly { name: string }[]): ToolLimitPeek {
    const pending = new Map<string, number>();
    const touched = new Set<string>();
    let stop: ToolLimitVerdict | undefined;
    for (const call of calls) {
      const limit = this.limits.get(call.name);
      if (limit === undefined) continue;
      const n = (pending.get(call.name) ?? this.counts.get(call.name) ?? 0) + 1;
      pending.set(call.name, n);
      touched.add(call.name);
      if (n > limit && stop === undefined) {
        stop = {
          stop: true,
          reason: 'tool-limit',
          code: 'TOOL_CALL_CAP',
          detail: `Calling tool "${call.name}" now would be call ${n}; its limit is ${limit}.`,
          evidence: { tool: call.name, calls: n, limit },
        };
      }
    }
    return stop === undefined ? { warnings: this.warningsFor(touched, pending) } : { stop, warnings: this.warningsFor(touched, pending) };
  }

  /** A warning for each touched tool whose calls are in its warning range, in the order they were touched. */
  private warningsFor(touched: ReadonlySet<string>, counts: ReadonlyMap<string, number>): GuardWarning[] {
    const out: GuardWarning[] = [];
    for (const tool of touched) {
      const limit = this.limits.get(tool) as number;
      const rule = this.warn.get(tool) as WarnRule;
      const calls = counts.get(tool) as number;
      if (inWarnZone(rule, calls, rule.at ?? Math.max(1, limit - 1), limit + 1)) out.push(toolLimitWarning({ tool, calls, limit }));
    }
    return out;
  }

  snapshot(): Array<{ tool: string; calls: number }> {
    return [...this.limits.keys()].map((tool) => ({ tool, calls: this.counts.get(tool) ?? 0 }));
  }

  restore(raw: unknown): void {
    const path = 'detectors.toolLimits';
    const tools = [...this.limits.keys()];
    const entries = asList(raw, path, tools.length);
    if (entries.length !== tools.length) fail(path, `must have one entry for each of the ${tools.length} capped tools`);
    const counts = new Map<string, number>();
    entries.forEach((entry, i) => {
      const where = `${path}[${i}]`;
      const record = asRecord(entry, where);
      const tool = asString(field(record, 'tool', where), `${where}.tool`, MAX_NAME_LENGTH);
      if (tool !== tools[i]) fail(`${where}.tool`, 'is not the tool capped at that position in the options');
      counts.set(tool, asInt(field(record, 'calls', where), `${where}.calls`));
    });
    this.counts.clear();
    for (const [tool, calls] of counts) this.counts.set(tool, calls);
  }

  state(): Array<{ tool: string; limit: number; calls: number }> {
    return [...this.limits].map(([tool, limit]) => ({ tool, limit, calls: this.counts.get(tool) ?? 0 }));
  }

  reset(): void {
    this.counts.clear();
  }
}
