import type { StepRecord } from '../record';
import type { OscillationEvidence, OscillationOptions } from '../types';
import type { Detector, DetectorResult } from './types';
import { assertInteger } from './types';

/** Keep memory bounded on very long runs: trim to the newest half once the window overflows. */
const WINDOW = 4096;

/**
 * Stops when the tail of the tool-call sequence is a cycle of length 2..`maxPeriod` that has
 * repeated at least `repeats` times in a row (A,B,A,B,A,B is period 2, three repeats).
 *
 * The sequence is the flattened list of call signatures (tool name + canonical arguments;
 * results are ignored). A cycle made of a single distinct call (A,A,A,A,A,A) is not an
 * oscillation, that is `repeatedToolCall`'s job.
 */
export class OscillationDetector implements Detector {
  readonly maxPeriod: number;
  readonly repeats: number;

  private sigs: string[] = [];
  private labels: string[] = [];
  private current: { period: number; repeats: number } | null = null;

  constructor(options: OscillationOptions = {}) {
    this.maxPeriod = assertInteger('oscillation.maxPeriod', options.maxPeriod ?? 3, 2);
    this.repeats = assertInteger('oscillation.repeats', options.repeats ?? 3, 2);
  }

  observe(record: StepRecord): DetectorResult | undefined {
    let found: OscillationEvidence | undefined;

    for (const call of record.calls) {
      this.sigs.push(call.callSig);
      this.labels.push(call.label);
      if (this.sigs.length > WINDOW) {
        this.sigs.splice(0, WINDOW / 2);
        this.labels.splice(0, WINDOW / 2);
      }
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

  /** Look for a repeating cycle at the very end of the sequence. */
  private detect(): OscillationEvidence | undefined {
    const n = this.sigs.length;
    for (let period = 2; period <= this.maxPeriod; period += 1) {
      if (n < period * this.repeats) continue;

      // L = how many trailing positions i satisfy sigs[i] === sigs[i - period].
      // A tail of `period` calls followed by L matching positions contains
      // floor(L / period) + 1 complete cycles.
      let matching = 0;
      for (let i = n - 1; i >= period && this.sigs[i] === this.sigs[i - period]; i -= 1) matching += 1;
      const cycles = Math.floor(matching / period) + 1;
      if (cycles < this.repeats) continue;

      const cycle = this.sigs.slice(n - period);
      if (new Set(cycle).size < 2) continue; // all the same call: not an oscillation

      return {
        period,
        repeats: cycles,
        threshold: this.repeats,
        cycle: this.labels.slice(n - period),
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
    this.current = null;
  }
}
