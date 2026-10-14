import type { StepRecord } from '../record';
import type { MaxStepsVerdict } from '../types';
import type { Detector, DetectorResult } from './types';
import { assertInteger } from './types';

/** Stops once `limit` steps have been recorded. */
export class MaxStepsDetector implements Detector {
  readonly limit: number;
  private steps = 0;

  constructor(limit: number) {
    this.limit = assertInteger('maxSteps', limit, 1);
  }

  observe(_record: StepRecord): DetectorResult | undefined {
    this.steps += 1;
    if (this.steps < this.limit) return undefined;
    return {
      stop: {
        stop: true,
        reason: 'max-steps',
        code: 'MAX_STEPS',
        detail: `Reached the limit of ${this.limit} steps.`,
        evidence: { steps: this.steps, limit: this.limit },
      },
    };
  }

  /** What a call made now would run into: the verdict if the limit has already been reached. */
  peek(): MaxStepsVerdict | undefined {
    if (this.steps < this.limit) return undefined;
    return {
      stop: true,
      reason: 'max-steps',
      code: 'MAX_STEPS',
      detail: `The limit of ${this.limit} steps has already been reached.`,
      evidence: { steps: this.steps, limit: this.limit },
    };
  }

  /** The resolved options, for the snapshot fingerprint. */
  config(): { limit: number } {
    return { limit: this.limit };
  }

  /** Continue from a run that had already recorded `steps` steps. */
  restore(steps: number): void {
    this.steps = steps;
  }

  remaining(): number {
    return Math.max(0, this.limit - this.steps);
  }

  reset(): void {
    this.steps = 0;
  }
}
