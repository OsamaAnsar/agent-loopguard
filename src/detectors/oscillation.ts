import type { CallRecord, StepRecord } from '../record';
import {
  MAX_LABEL_LENGTH,
  MAX_NAME_LENGTH,
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
import type {
  GuardWarning,
  OscillationEvidence,
  OscillationOptions,
  OscillationSnapshot,
  OscillationVerdict,
} from '../types';
import { oscillationWarning } from '../warnings';
import type { Detector, DetectorResult, WarnRule } from './types';
import { assertInteger, resolveWarnAt } from './types';

/** The newest calls (at most `maxPeriod`) and the per-period match counters. */
interface Ring {
  sigs: string[];
  labels: string[];
  names: string[];
  /** `matches[p - 2]`: trailing calls equal to the call `p` positions earlier. */
  matches: number[];
}

/** What `peek` found: the stop the calls would cause, and the warnings they would carry. */
export interface OscillationPeek {
  stop?: OscillationVerdict;
  warnings: GuardWarning[];
}

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
 *
 * With early warnings on, a step that adds calls carries a warning while the cycle at the end of
 * the sequence has been seen between `warnAt` (default `repeats - 1`, at least 2) and `repeats` times.
 */
export class OscillationDetector implements Detector {
  readonly maxPeriod: number;
  readonly repeats: number;

  private ring: Ring;
  private current: { period: number; repeats: number } | null = null;
  private readonly warn: WarnRule;

  constructor(options: OscillationOptions = {}, warnByDefault = false) {
    this.maxPeriod = assertInteger('oscillation.maxPeriod', options.maxPeriod ?? 3, 2);
    this.repeats = assertInteger('oscillation.repeats', options.repeats ?? 3, 2);
    this.warn = resolveWarnAt('oscillation.warnAt', options.warnAt, warnByDefault, 2, this.repeats - 1);
    this.ring = this.emptyRing();
  }

  observe(record: StepRecord): DetectorResult | undefined {
    let found: OscillationEvidence | undefined;

    for (const call of record.calls) {
      this.push(this.ring, call);
      // Check after every call (not just at the end of the step) so a pattern that completes
      // mid-step is not lost if a later call in the same step breaks it.
      found = this.detect(this.ring) ?? found;
    }

    this.current = found ? { period: found.period, repeats: found.repeats } : null;
    if (!found) {
      const warning = record.calls.length > 0 ? this.warningFor(this.ring) : undefined;
      return warning === undefined ? undefined : { warnings: [warning] };
    }

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

  /**
   * What `observe` would report if these calls (not yet made) were the next ones, without recording
   * them. Results are not part of the rule, so nothing is lost by not having them yet.
   */
  peek(calls: readonly CallRecord[]): OscillationPeek {
    const ring: Ring = {
      sigs: [...this.ring.sigs],
      labels: [...this.ring.labels],
      names: [...this.ring.names],
      matches: [...this.ring.matches],
    };
    let found: OscillationEvidence | undefined;
    for (const call of calls) {
      this.push(ring, call);
      found = this.detect(ring) ?? found;
    }
    if (found === undefined) {
      const warning = calls.length > 0 ? this.warningFor(ring) : undefined;
      return { warnings: warning === undefined ? [] : [warning] };
    }
    return {
      stop: {
        stop: true,
        reason: 'oscillation',
        code: 'OSCILLATION',
        detail: `Calling now would complete a cycle of ${found.period} calls (${found.cycle.join(' -> ')}) repeated ${found.repeats} times in a row.`,
        evidence: found,
      },
      warnings: [],
    };
  }

  private emptyRing(): Ring {
    return { sigs: [], labels: [], names: [], matches: new Array<number>(this.maxPeriod - 1).fill(0) };
  }

  private push(ring: Ring, call: CallRecord): void {
    const n = ring.sigs.length;
    for (let period = 2; period <= this.maxPeriod; period += 1) {
      const slot = period - 2;
      const matched = n >= period && call.callSig === ring.sigs[n - period];
      ring.matches[slot] = matched ? (ring.matches[slot] as number) + 1 : 0;
    }
    ring.sigs.push(call.callSig);
    ring.labels.push(call.label);
    ring.names.push(call.name);
    if (n >= this.maxPeriod) {
      ring.sigs.shift();
      ring.labels.shift();
      ring.names.shift();
    }
  }

  /** The warning for the cycle at the end of `ring`, when it has been seen often enough but not yet `repeats` times. */
  private warningFor(ring: Ring): GuardWarning | undefined {
    if (!this.warn.enabled) return undefined;
    const found = this.detect(ring, Math.max(2, this.warn.at ?? this.repeats - 1));
    return found !== undefined && found.repeats < this.repeats ? oscillationWarning(found) : undefined;
  }

  /** Look for a repeating cycle at the very end of the sequence that has been seen at least `minCycles` times. */
  private detect(ring: Ring, minCycles: number = this.repeats): OscillationEvidence | undefined {
    const n = ring.sigs.length;
    for (let period = 2; period <= this.maxPeriod; period += 1) {
      // A tail of `period` calls followed by L matching positions contains floor(L / period) + 1
      // complete cycles.
      const cycles = Math.floor((ring.matches[period - 2] as number) / period) + 1;
      if (cycles < minCycles) continue;

      const cycle = ring.sigs.slice(n - period);
      if (new Set(cycle).size < 2) continue; // all the same call: not an oscillation

      return {
        period,
        repeats: cycles,
        threshold: this.repeats,
        cycle: ring.labels.slice(n - period),
        tools: ring.names.slice(n - period),
      };
    }
    return undefined;
  }

  /** The resolved options, for the snapshot fingerprint. */
  config(): { maxPeriod: number; repeats: number } {
    return { maxPeriod: this.maxPeriod, repeats: this.repeats };
  }

  snapshot(redact: boolean): OscillationSnapshot {
    const ring = this.ring;
    return {
      sigs: [...ring.sigs],
      labels: ring.labels.map((label, i) =>
        redact ? `${ring.names[i] as string}(${REDACTED})` : clip(label, MAX_LABEL_LENGTH),
      ),
      names: ring.names.map((name) => clip(name, MAX_NAME_LENGTH)),
      matches: [...ring.matches],
      current: this.current === null ? null : { ...this.current },
    };
  }

  restore(raw: unknown): void {
    const path = 'detectors.oscillation';
    const state = asRecord(raw, path);
    const sigs = asList(field(state, 'sigs', path), `${path}.sigs`, this.maxPeriod).map((v, i) =>
      asHash(v, `${path}.sigs[${i}]`),
    );
    const labels = asList(field(state, 'labels', path), `${path}.labels`, this.maxPeriod).map((v, i) =>
      asString(v, `${path}.labels[${i}]`, MAX_LABEL_LENGTH),
    );
    const names = asList(field(state, 'names', path), `${path}.names`, this.maxPeriod).map((v, i) =>
      asString(v, `${path}.names[${i}]`, MAX_NAME_LENGTH),
    );
    const matches = asList(field(state, 'matches', path), `${path}.matches`, this.maxPeriod - 1).map((v, i) =>
      asInt(v, `${path}.matches[${i}]`),
    );
    const current = asNullable(field(state, 'current', path), (v) => {
      const where = `${path}.current`;
      const c = asRecord(v, where);
      const period = asInt(field(c, 'period', where), `${where}.period`);
      const repeats = asInt(field(c, 'repeats', where), `${where}.repeats`);
      if (period < 2 || period > this.maxPeriod) fail(`${where}.period`, 'must be between 2 and maxPeriod');
      return { period, repeats };
    });

    if (labels.length !== sigs.length || names.length !== sigs.length) fail(path, 'has rings of different lengths');
    if (matches.length !== this.maxPeriod - 1) {
      fail(`${path}.matches`, `must have exactly ${this.maxPeriod - 1} entries`);
    }
    // A counter above zero means that many calls matched the call `period` places earlier.
    if (matches.some((m, i) => m > 0 && sigs.length < i + 2)) {
      fail(`${path}.matches`, 'counts calls that are not in the ring');
    }

    this.ring = { sigs, labels, names, matches };
    this.current = current;
  }

  state(): { maxPeriod: number; repeats: number; current: { period: number; repeats: number } | null } {
    return { maxPeriod: this.maxPeriod, repeats: this.repeats, current: this.current };
  }

  reset(): void {
    this.ring = this.emptyRing();
    this.current = null;
  }
}
