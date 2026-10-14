import type { Guard, GuardStep, Verdict } from '../types';

/** An async iterable of steps that ends itself when the guard says stop. */
export interface GuardedSteps<S extends GuardStep> extends AsyncIterable<S> {
  /** The verdict for the most recent step yielded, or `undefined` before the first one. */
  readonly verdict: Verdict | undefined;
}

/**
 * Wrap a (sync or async) iterable of steps. Each step is passed to `guard.check` and then yielded
 * to you; if the verdict says stop, the step that triggered it is still yielded (it already
 * happened) and iteration ends right after, closing the source. Read `.verdict` afterwards to find out why:
 *
 * ```ts
 * const steps = withGuard(agentSteps(), guard);
 * for await (const step of steps) render(step);
 * if (steps.verdict?.stop) console.log(explain(steps.verdict));
 * ```
 */
export function withGuard<S extends GuardStep>(source: AsyncIterable<S> | Iterable<S>, guard: Guard): GuardedSteps<S> {
  let verdict: Verdict | undefined;

  async function* run(): AsyncGenerator<S, void, undefined> {
    // Leaving a `for await` early (our `return`) closes the source iterator for us.
    for await (const step of source) {
      verdict = guard.check(step);
      yield step;
      if (verdict.stop) return;
    }
  }

  return {
    [Symbol.asyncIterator]() {
      verdict = undefined; // a generator body runs lazily, so reset here, when iteration starts
      return run();
    },
    get verdict(): Verdict | undefined {
      return verdict;
    },
  };
}
