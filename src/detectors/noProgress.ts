import { hashString, truncate } from '../canonical';
import type { StepRecord } from '../record';
import {
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
import type { NoProgressOptions, NoProgressSnapshot } from '../types';
import type { Detector, DetectorResult } from './types';
import { assertInteger } from './types';

/**
 * How many distinct outcomes are remembered. The oldest is forgotten first, so in a run with more
 * distinct outcomes than this, an outcome that old counts as new again. Bounds memory (and the size
 * of a snapshot) on very long runs.
 */
export const MAX_REMEMBERED_OUTCOMES = 1024;

/** Longest text excerpt kept for messages. */
const PREVIEW_LIMIT = 80;

/**
 * Stops after `threshold` consecutive "stalled" steps that all carry the same normalised text.
 *
 * A step is stalled when it produced no new outcome. An outcome is a tool call together with
 * what came back (or just the call, if no result was supplied) and it is "new" the first time it
 * is seen in the run. A step without tool calls is always stalled. Text is compared after
 * lower-casing and collapsing whitespace; an empty string counts as text, so tool-only steps
 * (which usually have no text) are judged on outcomes alone.
 */
export class NoProgressDetector implements Detector {
  readonly threshold: number;

  private seen = new Set<string>();
  private streak = 0;
  /** Hash of the normalised text the current streak shares. */
  private streakKey = '';
  /** Shortened text of the current streak, for messages. Empty exactly when the text is empty. */
  private streakPreview = '';

  constructor(options: NoProgressOptions = {}) {
    this.threshold = assertInteger('noProgress.threshold', options.threshold ?? 3, 2);
  }

  observe(record: StepRecord): DetectorResult | undefined {
    let hasNew = false;
    for (const call of record.calls) {
      if (!this.seen.has(call.outcomeSig)) {
        hasNew = true;
        this.remember(call.outcomeSig);
      }
    }

    const textKey = hashString(record.text);
    if (hasNew) {
      this.streak = 0;
    } else if (this.streak > 0 && textKey === this.streakKey) {
      this.streak += 1;
    } else {
      this.streak = 1;
      this.streakKey = textKey;
      this.streakPreview = truncate(record.text, PREVIEW_LIMIT);
    }

    if (this.streak < this.threshold) return undefined;
    const preview = this.streakPreview;
    return {
      stop: {
        stop: true,
        reason: 'no-progress',
        code: 'NO_PROGRESS',
        detail:
          preview === ''
            ? `No progress: ${this.streak} consecutive steps produced no new tool results and no text.`
            : `No progress: ${this.streak} consecutive steps repeated the same text and produced no new tool results ("${preview}").`,
        evidence: { steps: this.streak, threshold: this.threshold, textPreview: preview },
      },
    };
  }

  private remember(outcome: string): void {
    this.seen.add(outcome);
    if (this.seen.size > MAX_REMEMBERED_OUTCOMES) {
      for (const oldest of this.seen) {
        this.seen.delete(oldest);
        break;
      }
    }
  }

  /** The resolved options, for the snapshot fingerprint. */
  config(): { threshold: number } {
    return { threshold: this.threshold };
  }

  snapshot(redact: boolean): NoProgressSnapshot {
    const idle = this.streak === 0; // the text of a finished streak is never read again
    const preview = redact && this.streakPreview !== '' ? REDACTED : clip(this.streakPreview, MAX_PREVIEW_LENGTH);
    return {
      seen: [...this.seen],
      streak: this.streak,
      textKey: idle ? null : this.streakKey,
      textPreview: idle ? '' : preview,
    };
  }

  restore(raw: unknown): void {
    const path = 'detectors.noProgress';
    const state = asRecord(raw, path);
    const seen = asList(field(state, 'seen', path), `${path}.seen`, MAX_REMEMBERED_OUTCOMES).map((v, i) =>
      asHash(v, `${path}.seen[${i}]`),
    );
    const streak = asInt(field(state, 'streak', path), `${path}.streak`);
    const textKey = asNullable(field(state, 'textKey', path), (v) => asHash(v, `${path}.textKey`));
    const textPreview = asString(field(state, 'textPreview', path), `${path}.textPreview`, MAX_PREVIEW_LENGTH);

    const outcomes = new Set(seen);
    if (outcomes.size !== seen.length) fail(`${path}.seen`, 'must not repeat an outcome');
    if (streak === 0 ? textKey !== null || textPreview !== '' : textKey === null) {
      fail(path, 'has a streak and a text that disagree');
    }

    this.seen = outcomes;
    this.streak = streak;
    this.streakKey = textKey ?? '';
    this.streakPreview = textPreview;
  }

  state(): { threshold: number; streak: number } {
    return { threshold: this.threshold, streak: this.streak };
  }

  reset(): void {
    this.seen.clear();
    this.streak = 0;
    this.streakKey = '';
    this.streakPreview = '';
  }
}
