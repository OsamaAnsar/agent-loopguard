import { truncate } from '../canonical';
import type { StepRecord } from '../record';
import type { NoProgressOptions } from '../types';
import type { Detector, DetectorResult } from './types';
import { assertInteger } from './types';

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
  private streakText = '';

  constructor(options: NoProgressOptions = {}) {
    this.threshold = assertInteger('noProgress.threshold', options.threshold ?? 3, 2);
  }

  observe(record: StepRecord): DetectorResult | undefined {
    let hasNew = false;
    for (const call of record.calls) {
      if (!this.seen.has(call.outcomeSig)) {
        hasNew = true;
        this.seen.add(call.outcomeSig);
      }
    }

    if (hasNew) {
      this.streak = 0;
    } else if (this.streak > 0 && record.text === this.streakText) {
      this.streak += 1;
    } else {
      this.streak = 1;
      this.streakText = record.text;
    }

    if (this.streak < this.threshold) return undefined;
    const preview = truncate(this.streakText, 80);
    return {
      stop: {
        stop: true,
        reason: 'no-progress',
        code: 'NO_PROGRESS',
        detail:
          this.streakText === ''
            ? `No progress: ${this.streak} consecutive steps produced no new tool results and no text.`
            : `No progress: ${this.streak} consecutive steps repeated the same text and produced no new tool results ("${preview}").`,
        evidence: { steps: this.streak, threshold: this.threshold, textPreview: preview },
      },
    };
  }

  state(): { threshold: number; streak: number } {
    return { threshold: this.threshold, streak: this.streak };
  }

  reset(): void {
    this.seen.clear();
    this.streak = 0;
    this.streakText = '';
  }
}
