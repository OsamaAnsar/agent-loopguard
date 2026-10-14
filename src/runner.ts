import type { AbortSignalLike } from './adapters/loop';
import type { Guard, GuardStep, GuardToolCall, PreflightCall, PreflightDeny, Verdict } from './types';

export interface ToolRunnerOptions {
  /**
   * What `run` does when the executor throws. Default `false`: the error comes back in the outcome
   * (`{ ran: true, ok: false, error }`), because a failed tool call is normal data in an agent loop and
   * usually goes back to the model as the tool's result. With `true`, `run` rejects with the original
   * error instead (the call is recorded as failed either way).
   */
  rethrow?: boolean;
  /**
   * Checked before each call starts: once `signal.aborted` is true, `run` starts nothing and answers
   * `{ ran: false, aborted: true }`. Calls already running are not cancelled and are recorded when they finish.
   */
  signal?: AbortSignalLike;
}

/** What `run` answers. Narrow on `ran`, then on `ok` or `denied`. */
export type ToolRunOutcome<T> =
  | { ran: true; ok: true; result: T }
  | { ran: true; ok: false; error: unknown }
  /** The guard refused the call before it ran; `denied.feedback` is the text for the model. Nothing was recorded. */
  | { ran: false; denied: PreflightDeny }
  /** The `signal` was already aborted. Nothing was started or recorded. */
  | { ran: false; aborted: true };

/** What a step carries besides its tool calls, which the runner collects itself. */
export type StepMeta = Omit<GuardStep, 'toolCalls'>;

export interface ToolRunner {
  /**
   * Ask the guard whether the call may run (`guard.preflight`, counting the calls already started in
   * this step), run `executor` if so, and remember the call with its result or error for `endStep`.
   * Never throws because of the executor unless `rethrow` is set.
   */
  run<T>(name: string, args: unknown, executor: () => T | PromiseLike<T>): Promise<ToolRunOutcome<T>>;
  /**
   * Close the step: hand the calls run since the last `endStep` (in the order they started), plus `meta`,
   * to `guard.check`, empty the buffer and return the verdict. Throws an `Error`, changing nothing, if a
   * call is still running: await the `run` promises first.
   */
  endStep(meta?: StepMeta): Verdict;
  /** How many calls have started in this step and not finished yet. */
  readonly inFlight: number;
}

/**
 * Wrap a guard's `preflight` and `check` around your tool executions, for the step-by-step loop most
 * agent frameworks have: several tool calls per model turn, then one `check` for the turn.
 *
 * ```ts
 * const runner = createToolRunner(guard);
 * const outcomes = await Promise.all(calls.map((c) => runner.run(c.name, c.args, () => tools[c.name](c.args))));
 * const verdict = runner.endStep({ text, finishReason, usage });
 * ```
 *
 * Calls refused by `preflight` never run and are never recorded, so a refusal cannot make a repeat rule
 * fire on itself. Calls in the same step are judged together, in the order `run` was called: when three
 * identical calls start at once with a threshold of three, the third is refused.
 */
export function createToolRunner(guard: Guard, options: ToolRunnerOptions = {}): ToolRunner {
  if (typeof guard !== 'object' || guard === null || typeof guard.preflight !== 'function' || typeof guard.check !== 'function') {
    throw new TypeError('agent-loopguard: createToolRunner needs a guard from createGuard()');
  }
  const rethrow = options.rethrow === true;
  const signal = options.signal;

  // Calls started in this step, in start order. A call's result or error is filled in when it finishes.
  let started: GuardToolCall[] = [];
  let inFlight = 0;

  async function run<T>(name: string, args: unknown, executor: () => T | PromiseLike<T>): Promise<ToolRunOutcome<T>> {
    if (signal?.aborted === true) return { ran: false, aborted: true };

    // Everything up to the executor call is synchronous, so parallel `run` calls see each other in order.
    const asked: PreflightCall[] = [...started.map((c) => ({ name: c.name, args: c.args })), { name, args }];
    const pre = guard.preflight(asked);
    if (!pre.allow) return { ran: false, denied: pre };

    const call: GuardToolCall = { name, args };
    started.push(call);
    inFlight += 1;
    try {
      const result = await executor();
      call.result = result;
      return { ran: true, ok: true, result };
    } catch (error) {
      // `check` treats a null or undefined error as "no error", so give such a throw something to record.
      call.error = error === undefined || error === null ? new Error(`the tool threw ${String(error)}`) : error;
      if (rethrow) throw error;
      return { ran: true, ok: false, error };
    } finally {
      inFlight -= 1;
    }
  }

  function endStep(meta?: StepMeta): Verdict {
    if (inFlight > 0) {
      throw new Error(
        `agent-loopguard: endStep() was called while ${inFlight} tool call${inFlight === 1 ? ' is' : 's are'} still running; await the run() promises first`,
      );
    }
    const toolCalls = started;
    started = [];
    let rest: Record<string, unknown> = {};
    try {
      if (typeof meta === 'object' && meta !== null) rest = { ...meta };
    } catch {
      // A revoked proxy or a getter that throws: record the calls without the metadata, as `check` would ignore it anyway.
    }
    delete rest['toolCalls']; // the runner owns the calls of a step
    return guard.check({ ...rest, toolCalls } as GuardStep);
  }

  return {
    run,
    endStep,
    get inFlight(): number {
      return inFlight;
    },
  };
}
