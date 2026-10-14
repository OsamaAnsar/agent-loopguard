import { describe, expect, expectTypeOf, it } from 'vitest';
import { createGuard, createToolRunner, restoreGuard } from '../src/index';
import type { DecisionEvent, Guard, GuardOptions, ToolRunOutcome } from '../src/index';

/** Options that switch every detector off, so a test can enable exactly one. */
const ONLY: GuardOptions = {
  maxSteps: false,
  repeatedToolCall: false,
  oscillation: false,
  noProgress: false,
  finishReason: false,
};

const SECRET = 'SENTINEL-sk-live-6107';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
describe('runner: running a call', () => {
  it('runs a sync or async executor and returns its result', async () => {
    const runner = createToolRunner(createGuard());
    expect(await runner.run('sync', { a: 1 }, () => 42)).toEqual({ ran: true, ok: true, result: 42 });
    expect(await runner.run('async', { a: 1 }, async () => 'later')).toEqual({ ran: true, ok: true, result: 'later' });
    expect(await runner.run('thenable', 1, () => ({ then: (ok: (v: string) => void) => ok('thenable result') }) as PromiseLike<string>)).toMatchObject({
      ok: true,
      result: 'thenable result',
    });
    expect(await runner.run('nothing', 1, () => undefined)).toEqual({ ran: true, ok: true, result: undefined });
  });

  it('records the calls, with results and errors, for the step, in the order they started', async () => {
    const guard = createGuard();
    const runner = createToolRunner(guard);
    await runner.run('search', { q: 'a' }, () => ['hit']);
    await runner.run('read', { path: 'x' }, () => {
      throw new Error('ENOENT');
    });
    const verdict = runner.endStep({ text: 'done', finishReason: 'tool-calls', usage: { totalTokens: 7 }, durationMs: 12, timestamp: 5 });
    expect(verdict).toEqual({ stop: false });
    expect(guard.history).toEqual([
      {
        text: 'done',
        finishReason: 'tool-calls',
        usage: { totalTokens: 7 },
        durationMs: 12,
        timestamp: 5,
        toolCalls: [
          { name: 'search', args: { q: 'a' }, result: ['hit'] },
          { name: 'read', args: { path: 'x' }, error: expect.any(Error) as unknown },
        ],
      },
    ]);
    expect(guard.summary()).toMatchObject({ steps: 1, toolCalls: 2, failedToolCalls: 1, totals: { totalTokens: 7, durationMs: 12 } });
  });

  it('endStep returns the verdict of the step, and the buffer starts empty again', async () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 2 } });
    const runner = createToolRunner(guard);
    await runner.run('t', 1, () => 'r');
    expect(runner.endStep().stop).toBe(false);
    await runner.run('t', 1, () => 'r'); // refused: would be the second identical call in a row
    expect(runner.endStep()).toEqual({ stop: false });
    expect(guard.summary().steps).toBe(2);
    expect(guard.history.map((s) => s.toolCalls?.length)).toEqual([1, 0]);
  });

  it('a step can carry the meta alone, and meta cannot smuggle in tool calls', async () => {
    const guard = createGuard();
    const runner = createToolRunner(guard);
    expect(runner.endStep({ text: 'just text' })).toEqual({ stop: false });
    await runner.run('t', 1, () => 'r');
    runner.endStep({ toolCalls: [{ name: 'fake' }] } as never);
    expect(guard.history[1]?.toolCalls).toEqual([{ name: 't', args: 1, result: 'r' }]);
    expect(() => runner.endStep(null as never)).not.toThrow();
    expect(() => runner.endStep(7 as never)).not.toThrow();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => runner.endStep(revoked.proxy as never)).not.toThrow();
    const hostile = { get text(): string { throw new Error('getter'); } };
    expect(() => runner.endStep(hostile as never)).not.toThrow();
  });

  it('is typed: the result type flows through, and the outcome narrows', async () => {
    const runner = createToolRunner(createGuard());
    const outcome = await runner.run('t', 1, async () => ({ n: 1 }));
    expectTypeOf(outcome).toEqualTypeOf<ToolRunOutcome<{ n: number }>>();
    if (outcome.ran) {
      if (outcome.ok) expectTypeOf(outcome.result).toEqualTypeOf<{ n: number }>();
      else expectTypeOf(outcome.error).toBeUnknown();
    } else if ('denied' in outcome) {
      expectTypeOf(outcome.denied.feedback).toBeString();
    } else {
      expectTypeOf(outcome.aborted).toEqualTypeOf<true>();
    }
    expectTypeOf(runner.inFlight).toBeNumber();
  });
});

// ---------------------------------------------------------------------------
describe('runner: errors', () => {
  it('returns the original error instead of throwing it', async () => {
    const guard = createGuard();
    const runner = createToolRunner(guard);
    const failure = new Error('boom');
    const outcome = await runner.run('t', 1, () => {
      throw failure;
    });
    expect(outcome).toEqual({ ran: true, ok: false, error: failure });
    expect(outcome.ran && !outcome.ok && outcome.error).toBe(failure);
    const rejected = await runner.run('t', 2, async () => Promise.reject(failure));
    expect(rejected.ran && !rejected.ok && rejected.error).toBe(failure);
    runner.endStep();
    expect(guard.summary().failedToolCalls).toBe(2);
    expect(guard.history[0]?.toolCalls?.[0]?.error).toBe(failure);
  });

  it('an executor that throws synchronously is handled like one that rejects', async () => {
    const runner = createToolRunner(createGuard());
    const promise = runner.run('t', 1, () => {
      throw new TypeError('sync');
    });
    expect(promise).toBeInstanceOf(Promise);
    expect(await promise).toMatchObject({ ran: true, ok: false, error: { message: 'sync' } });
    expect(runner.inFlight).toBe(0);
  });

  it('records a throw of null or undefined as a failed call, and returns what was thrown', async () => {
    const guard = createGuard();
    const runner = createToolRunner(guard);
    const a = await runner.run('t', 1, () => {
      throw undefined;
    });
    const b = await runner.run('t', 2, () => Promise.reject(null));
    const c = await runner.run('t', 3, () => {
      throw 'a string';
    });
    expect([a, b, c]).toEqual([
      { ran: true, ok: false, error: undefined },
      { ran: true, ok: false, error: null },
      { ran: true, ok: false, error: 'a string' },
    ]);
    runner.endStep();
    expect(guard.summary().failedToolCalls).toBe(3);
  });

  it('rethrow: true rejects with the original error and still records the failed call', async () => {
    const guard = createGuard();
    const runner = createToolRunner(guard, { rethrow: true });
    const failure = new Error('boom');
    await expect(
      runner.run('t', 1, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(runner.run('t', 2, async () => 'fine')).resolves.toMatchObject({ ok: true });
    expect(runner.inFlight).toBe(0);
    runner.endStep();
    expect(guard.summary()).toMatchObject({ toolCalls: 2, failedToolCalls: 1 });
  });

  it('identical failures are a repeat for the guard, like any identical calls', async () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 3, requireIdenticalResults: true } });
    const runner = createToolRunner(guard);
    const verdicts = [];
    for (let i = 0; i < 3; i += 1) {
      await runner.run('flaky', { id: 1 }, () => {
        throw new Error('timeout');
      });
      verdicts.push(runner.endStep());
    }
    expect(verdicts.map((v) => v.stop)).toEqual([false, false, true]);
  });
});

// ---------------------------------------------------------------------------
describe('runner: denied calls', () => {
  it('does not run the executor, says why, and has model-safe feedback', async () => {
    const guard = createGuard({ ...ONLY, tools: { rm: { maxCalls: 0 } } });
    const runner = createToolRunner(guard);
    let ran = false;
    const outcome = await runner.run('rm', { path: SECRET }, () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(outcome.ran).toBe(false);
    if (outcome.ran || !('denied' in outcome)) throw new Error('expected a denial');
    expect(outcome.denied).toMatchObject({ allow: false, reason: 'tool-limit', code: 'TOOL_CALL_CAP' });
    expect(outcome.denied.feedback).toBe('That call was not run: you may not use `rm` in this task. Use a different tool, or answer with what you have.');
    expect(outcome.denied.feedback).not.toContain('SENTINEL');
  });

  it('a refused call is not recorded: it adds nothing to the step, the counts or the repeat rule', async () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 3 } });
    const runner = createToolRunner(guard);
    for (let i = 0; i < 2; i += 1) {
      await runner.run('search', { q: 1 }, () => 'r');
      runner.endStep();
    }
    // The third would trip the rule. The model keeps asking; every ask is refused and none is recorded.
    for (let i = 0; i < 5; i += 1) {
      const outcome = await runner.run('search', { q: 1 }, () => 'r');
      expect(outcome).toMatchObject({ ran: false, denied: { code: 'REPEATED_TOOL_CALL' } });
      expect(runner.endStep()).toEqual({ stop: false }); // the refusal itself never makes the rule fire
    }
    expect(guard.summary()).toMatchObject({ steps: 7, toolCalls: 2, detectors: { repeatedToolCall: { currentRun: { tool: 'search', length: 2 } } } });
  });

  it('a different call after a refusal goes through and breaks the run', async () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 2 } });
    const runner = createToolRunner(guard);
    await runner.run('a', 1, () => 1);
    runner.endStep();
    expect((await runner.run('a', 1, () => 1)).ran).toBe(false);
    expect((await runner.run('b', 1, () => 1)).ran).toBe(true);
    expect(runner.endStep().stop).toBe(false);
    expect((await runner.run('a', 1, () => 1)).ran).toBe(true);
  });

  it('is decided by every rule preflight judges: caps, windows, cycles, steps and budgets', async () => {
    const guard = createGuard({ ...ONLY, maxSteps: 2 });
    const runner = createToolRunner(guard);
    runner.endStep();
    runner.endStep();
    expect(await runner.run('t', 1, () => 1)).toMatchObject({ ran: false, denied: { reason: 'max-steps' } });

    const cycle = createToolRunner(createGuard({ ...ONLY, oscillation: { repeats: 2 } }));
    const outcomes = [];
    for (const n of ['a', 'b', 'a', 'b']) {
      outcomes.push((await cycle.run(n, n, () => n)).ran);
      cycle.endStep();
    }
    expect(outcomes).toEqual([true, true, true, false]);
  });
});

// ---------------------------------------------------------------------------
describe('runner: parallel calls in one step', () => {
  it('judges calls that start together as one step: the third identical one is refused', async () => {
    const guard = createGuard({ ...ONLY, repeatedToolCall: { threshold: 3 } });
    const runner = createToolRunner(guard);
    const outcomes = await Promise.all([1, 2, 3].map(() => runner.run('search', { q: 1 }, async () => 'r')));
    expect(outcomes.map((o) => o.ran)).toEqual([true, true, false]);
    expect(runner.endStep()).toEqual({ stop: false });
    expect(guard.history[0]?.toolCalls).toHaveLength(2);
  });

  it('runs executors concurrently, and records them in the order they started, not the order they finished', async () => {
    const guard = createGuard();
    const runner = createToolRunner(guard);
    const log: string[] = [];
    const slow = runner.run('slow', 1, async () => {
      log.push('slow start');
      await delay(30);
      log.push('slow end');
      return 'S';
    });
    const fast = runner.run('fast', 1, async () => {
      log.push('fast start');
      await delay(1);
      log.push('fast end');
      return 'F';
    });
    expect(runner.inFlight).toBe(2);
    await Promise.all([slow, fast]);
    expect(log).toEqual(['slow start', 'fast start', 'fast end', 'slow end']);
    runner.endStep();
    expect(guard.history[0]?.toolCalls?.map((c) => c.name)).toEqual(['slow', 'fast']);
    expect(guard.history[0]?.toolCalls?.map((c) => c.result)).toEqual(['S', 'F']);
  });

  it('a refusal in the middle of a batch leaves the others untouched', async () => {
    const guard = createGuard({ ...ONLY, tools: { search: { maxCalls: 1 } } });
    const runner = createToolRunner(guard);
    const outcomes = await Promise.all([
      runner.run('search', 1, async () => 'a'),
      runner.run('search', 2, async () => 'b'),
      runner.run('read', 1, async () => 'c'),
    ]);
    expect(outcomes.map((o) => o.ran)).toEqual([true, false, true]);
    runner.endStep();
    expect(guard.history[0]?.toolCalls?.map((c) => c.name)).toEqual(['search', 'read']);
  });

  it('endStep while a call is still running throws, changes nothing, and works after the call finishes', async () => {
    const guard = createGuard();
    const runner = createToolRunner(guard);
    const pending = runner.run('slow', 1, async () => {
      await delay(10);
      return 'done';
    });
    expect(() => runner.endStep()).toThrow('endStep() was called while 1 tool call is still running; await the run() promises first');
    const second = runner.run('slow2', 1, () => delay(10));
    expect(() => runner.endStep()).toThrow('while 2 tool calls are still running');
    expect(guard.summary().steps).toBe(0);
    await Promise.all([pending, second]);
    expect(runner.endStep()).toEqual({ stop: false });
    expect(guard.history[0]?.toolCalls).toHaveLength(2);
  });

  it('a call that fails while others run is recorded as failed and does not disturb them', async () => {
    const guard = createGuard();
    const runner = createToolRunner(guard);
    const [a, b] = await Promise.all([
      runner.run('a', 1, async () => {
        await delay(2);
        throw new Error('a failed');
      }),
      runner.run('b', 1, async () => 'b ok'),
    ]);
    expect([a.ran && a.ok, b.ran && b.ok]).toEqual([false, true]);
    runner.endStep();
    expect(guard.summary()).toMatchObject({ toolCalls: 2, failedToolCalls: 1 });
  });
});

// ---------------------------------------------------------------------------
describe('runner: abort signal', () => {
  it('starts nothing once the signal is aborted, records nothing, and does not even ask the guard', async () => {
    const events: DecisionEvent[] = [];
    const guard = createGuard({ onDecision: (e) => void events.push(e) });
    const signal = { aborted: false };
    const runner = createToolRunner(guard, { signal });
    expect((await runner.run('t', 1, () => 1)).ran).toBe(true);
    signal.aborted = true;
    let ran = false;
    const outcome = await runner.run('t', 2, () => {
      ran = true;
    });
    expect(outcome).toEqual({ ran: false, aborted: true });
    expect(ran).toBe(false);
    expect(events.map((e) => e.phase)).toEqual(['preflight']);
    runner.endStep();
    expect(guard.history[0]?.toolCalls).toHaveLength(1);
  });

  it('a call already running when the signal is aborted still finishes and is recorded', async () => {
    const guard = createGuard();
    const signal = { aborted: false };
    const runner = createToolRunner(guard, { signal });
    const running = runner.run('slow', 1, async () => {
      await delay(5);
      return 'finished';
    });
    signal.aborted = true;
    expect(await running).toMatchObject({ ran: true, ok: true, result: 'finished' });
    runner.endStep();
    expect(guard.history[0]?.toolCalls).toEqual([{ name: 'slow', args: 1, result: 'finished' }]);
  });

  it('works with a real AbortSignal', async () => {
    const controller = new AbortController();
    const runner = createToolRunner(createGuard(), { signal: controller.signal });
    controller.abort();
    expect(await runner.run('t', 1, () => 1)).toEqual({ ran: false, aborted: true });
  });
});

// ---------------------------------------------------------------------------
describe('runner: with the rest of the guard', () => {
  it('carries warnings, feedback and the stop of the step', async () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: { threshold: 3, requireIdenticalResults: true } });
    const runner = createToolRunner(guard);
    const verdicts = [];
    for (let i = 0; i < 3; i += 1) {
      await runner.run('poll', 1, () => 'pending');
      verdicts.push(runner.endStep());
    }
    expect(verdicts[1]).toMatchObject({ stop: false, warnings: [{ code: 'REPEATED_TOOL_CALL_WARNING' }] });
    expect(verdicts[2]).toMatchObject({ stop: true, code: 'REPEATED_TOOL_CALL', feedback: expect.stringContaining('`poll`') as string });
  });

  it('works on a restored guard, with custom signature functions, and with a hook that watches', async () => {
    const options = (): GuardOptions => ({ ...ONLY, repeatedToolCall: { threshold: 3 }, signature: (_t, a) => JSON.stringify((a as { q: string }).q) });
    const first = createGuard(options());
    const runner1 = createToolRunner(first);
    await runner1.run('search', { q: 'x', ts: 1 }, () => 1);
    runner1.endStep();
    await runner1.run('search', { q: 'x', ts: 2 }, () => 1);
    runner1.endStep();
    const restored: Guard = restoreGuard(JSON.parse(JSON.stringify(first.toJSON())), options());
    const runner2 = createToolRunner(restored);
    expect(await runner2.run('search', { q: 'x', ts: 3 }, () => 1)).toMatchObject({ ran: false, denied: { code: 'REPEATED_TOOL_CALL' } });
  });

  it('a preflight that throws (a failing feedback option) rejects the run and buffers nothing', async () => {
    const guard = createGuard({
      ...ONLY,
      maxSteps: 1,
      feedback: (_verdict, { phase }) => {
        if (phase === 'preflight') throw new Error('feedback bug');
        return undefined;
      },
    });
    guard.check({});
    const runner = createToolRunner(guard);
    await expect(runner.run('t', 1, () => 1)).rejects.toThrow('feedback bug');
    expect(runner.inFlight).toBe(0);
  });

  it('survives hostile arguments and names', async () => {
    const guard = createGuard();
    const runner = createToolRunner(guard);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const [name, args] of [['x'.repeat(10_000), circular], ['', revoked.proxy], [`odd ${SECRET}`, 10n]] as Array<[string, unknown]>) {
      await expect(runner.run(name, args, () => 1)).resolves.toBeDefined();
    }
    expect(() => runner.endStep()).not.toThrow();
  });

  it('createToolRunner wants a guard', () => {
    for (const bad of [null, undefined, {}, 'guard', { check: () => 1 }]) {
      expect(() => createToolRunner(bad as never)).toThrow(/needs a guard from createGuard\(\)/);
    }
  });
});
