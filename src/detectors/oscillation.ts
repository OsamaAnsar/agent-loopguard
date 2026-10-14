import type { StepRecord } from '../record';
import type { OscillationEvidence, OscillationOptions } from '../types';
import type { Detector, DetectorResult } from './types';
import { assertInteger } from './types';

/**
 * Stops when the tail of the tool-call sequence is a cycle of length 2..`maxPeriod` that has
 * repeated at least `repeats` times in a row (A,B,A,B,A,B is period 2, three repeats).
 *
 * The sequence is the flattened list of call signatures (tool name + canonical arguments;
 * results are ignored). A cycle made of a single distinct call (A,A,A,A,A,A) is not an
 * oscillation, that is `repeatedToolCall`'s job.
 *
 * Only the newest `maxPeriod` calls are kept, plus one counter per period: how many trailing
 * calls equal the call `period` positions earlier. That is all the rule needs, so memory and the
 * work per call are bounded by `maxPeriod`, however long the run is.
 */
export class OscillationDetector implements Detector {
  readonly maxPeriod: number;
  readonly repeats: number;

  private sigs: string[] = [];
  private labels: string[] = [];
  private names: string[] = [];
  /** `matches[p - 2]`: trailing calls equal to the call `p` positions earlier. */
  private matches: number[];
  private current: { period: number; repeats: number } | null = null;

  constructor(options: OscillationOptions = {}) {
    this.maxPeriod = assertInteger('oscillation.maxPeriod', options.maxPeriod ?? 3, 2);
    this.repeats = assertInteger('oscillation.repeats', options.repeats ?? 3, 2);
    this.matches = new Array<number>(this.maxPeriod - 1).fill(0);
  }

  observe(record: StepRecord): DetectorResult | undefined {
    let found: OscillationEvidence | undefined;

    for (const call of record.calls) {
      this.push(call.callSig, call.label, call.name);
      // Check after every call (not just at the end of the step) so a pattern that completes
      // mid-step is not lost if a later call in the same step breaks it.
      found = this.detect() ?? found;
    }

    this.current = found ? { period: found.period, repeats: found.repeats } : null;
    if (!found) return undefined;

    return {
      stop: {
        stop: true,
        reason: 'oscillation',
        code: 'OSCILLATION',
        detail: `The agent is oscillating: a cycle of ${found.period} calls (${found.cycle.join(' -> ')}) repeated ${found.repeats} times in a row.`,
        evidence: found,
      },
    };
  }

  private push(sig: string, label: string, name: string): void {
    const n = this.sigs.length;
    for (let period = 2; period <= this.maxPeriod; period += 1) {
      const slot = period - 2;
      const matched = n >= period && sig === this.sigs[n - period];
      this.matches[slot] = matched ? (this.matches[slot] as number) + 1 : 0;
    }
    this.sigs.push(sig);
    this.labels.push(label);
    this.names.push(name);
    if (n >= this.maxPeriod) {
      this.sigs.shift();
      this.labels.shift();
      this.names.shift();
    }
  }

  /** Look for a repeating cycle at the very end of the sequence. */
  private detect(): OscillationEvidence | undefined {
    const n = this.sigs.length;
    for (let period = 2; period <= this.maxPeriod; period += 1) {
      // A tail of `period` calls followed by L matching positions contains floor(L / period) + 1
      // complete cycles.
      const cycles = Math.floor((this.matches[period - 2] as number) / period) + 1;
      if (cycles < this.repeats) continue;

      const cycle = this.sigs.slice(n - period);
      if (new Set(cycle).size < 2) continue; // all the same call: not an oscillation

      return {
        period,
        repeats: cycles,
        threshold: this.repeats,
        cycle: this.labels.slice(n - period),
        tools: this.names.slice(n - period),
      };
    }
    return undefined;
  }

  state(): { maxPeriod: number; repeats: number; current: { period: number; repeats: number } | null } {
    return { maxPeriod: this.maxPeriod, repeats: this.repeats, current: this.current };
  }

  reset(): void {
    this.sigs = [];
    this.labels = [];
    this.names = [];
    this.matches.fill(0);
    this.current = null;
  }
}
