import type { StepRecord } from '../record';
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

  remaining(): number {
    return Math.max(0, this.limit - this.steps);
  }

  reset(): void {
    this.steps = 0;
  }
}
