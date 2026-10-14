import { createGuard } from '../guard';
import { isFault } from '../explain';
import type { Guard, GuardStep, Verdict } from '../types';

/** The one thing we need from an `AbortSignal`; keeps the package free of DOM/Node type deps. */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

/** A step as returned by your `step` function: a `GuardStep` plus an optional end-of-run flag. */
export interface LoopStep extends GuardStep {
  /**
   * `true` when the agent has finished. `false` forces the loop to continue. When omitted, a step
   * with no tool calls counts as final (there is nothing left to execute).
   */
  done?: boolean | undefined;
}

export interface RunAgentLoopOptions<S extends LoopStep> {
  /** Perform step `index` (call the model, run its tools) and describe what happened. */
  step: (index: number) => S | Promise<S>;
  /** Defaults to `createGuard()`. */
  guard?: Guard;
  /** Checked before every step and after a step that throws; an in-flight step is not cancelled. */
  signal?: AbortSignalLike;
  /** Called after every step with that step's verdict, including non-stopping ones with warnings. */
  onVerdict?: (verdict: Verdict, step: S, index: number) => void;
}

export interface LoopResult<S extends LoopStep> {
  /** Every step that ran, in order. */
  steps: S[];
  /** The last verdict: the stop verdict that ended the loop, or `{ stop: false }`. */
  verdict: Verdict;
  /**
   * True when the agent ended the run itself: the step was final and no fault was raised, or the
   * finish reason was a normal `stop`. False when the guard cut it short, the finish reason
   * was something like `length` or `error`, or the signal aborted.
   */
  completed: boolean;
  /** True when the loop ended because the signal was aborted. */
  aborted: boolean;
}

function isFinal(step: LoopStep): boolean {
  if (step.done !== undefined) return step.done;
  return !Array.isArray(step.toolCalls) || step.toolCalls.length === 0;
}

/**
 * A tiny agent loop: call `step(0)`, `step(1)`, ... until the agent is done or the guard says stop.
 * Throws whatever `step` throws (unless the signal was aborted, in which case it returns).
 *
 * If you disable `maxSteps` and your `step` never finishes, this loop never ends; that is on you.
 */
export async function runAgentLoop<S extends LoopStep>(options: RunAgentLoopOptions<S>): Promise<LoopResult<S>> {
  const guard = options.guard ?? createGuard();
  const { signal } = options;
  const steps: S[] = [];
  let verdict: Verdict = { stop: false };

  for (let index = 0; ; index += 1) {
    if (signal?.aborted) return { steps, verdict, completed: false, aborted: true };

    let result: S;
    try {
      result = await options.step(index);
    } catch (error) {
      if (signal?.aborted) return { steps, verdict, completed: false, aborted: true };
      throw error;
    }

    steps.push(result);
    verdict = guard.check(result);
    options.onVerdict?.(verdict, result, index);

    if (verdict.stop) {
      return { steps, verdict, completed: !isFault(verdict), aborted: false };
    }
    if (isFinal(result)) return { steps, verdict, completed: true, aborted: false };
  }
}
