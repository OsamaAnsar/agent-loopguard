import { describe, expect, it, vi } from 'vitest';
import { createGuard, runAgentLoop, toGuardStep, toStopWhen, withGuard } from '../src/index';
import type { AiSdkStepLike, GuardStep, LoopStep, Verdict } from '../src/index';
import { call, step } from './helpers';

// ---------------------------------------------------------------------------
describe('runAgentLoop', () => {
  /** A scripted agent: step(i) returns script[i]. */
  const scripted = (script: LoopStep[]) => {
    const calls: number[] = [];
    return {
      calls,
      step: (i: number): LoopStep => {
        calls.push(i);
        const s = script[i];
        if (!s) throw new Error(`script exhausted at step ${i}`);
        return s;
      },
    };
  };

  it('runs until a step with no tool calls and reports completion', async () => {
    const agent = scripted([
      { toolCalls: [call('search', { q: 'a' })] },
      { toolCalls: [call('read', { id: 1 })] },
      { text: 'All done.' },
    ]);
    const result = await runAgentLoop({ step: agent.step });
    expect(agent.calls).toEqual([0, 1, 2]);
    expect(result.steps).toHaveLength(3);
    expect(result.completed).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.verdict).toEqual({ stop: false });
  });

  it('an explicit done flag overrides the tool-call heuristic', async () => {
    const finishedWithCalls = await runAgentLoop({ step: () => ({ toolCalls: [call('t')], done: true }) });
    expect(finishedWithCalls.steps).toHaveLength(1);
    expect(finishedWithCalls.completed).toBe(true);

    let n = 0;
    const notDone = await runAgentLoop({
      step: (): LoopStep => ({ text: `thinking ${(n += 1)}`, done: n >= 3 }),
    });
    expect(notDone.steps).toHaveLength(3);
  });

  it('stops when the guard says so, with the verdict', async () => {
    const result = await runAgentLoop({ step: () => ({ toolCalls: [call('search', { q: 'x' })] }) });
    expect(result.steps).toHaveLength(3);
    expect(result.completed).toBe(false);
    expect(result.verdict).toMatchObject({ stop: true, reason: 'repeated-tool-call' });
  });

  it('uses the guard you pass in, and leaves it holding the history', async () => {
    const guard = createGuard({ maxSteps: 2, repeatedToolCall: false });
    const result = await runAgentLoop({ guard, step: (i) => ({ toolCalls: [call('t', i)] }) });
    expect(result.verdict).toMatchObject({ reason: 'max-steps' });
    expect(guard.history).toHaveLength(2);
  });

  it('treats a normal finish as completion but length/error/other as not', async () => {
    const stopped = await runAgentLoop({ step: () => ({ text: 'ok', finishReason: 'stop', toolCalls: [call('t')] }) });
    expect(stopped.verdict).toMatchObject({ stop: true, reason: 'finish-reason' });
    expect(stopped.completed).toBe(true);

    for (const finishReason of ['length', 'error', 'content-filter']) {
      const r = await runAgentLoop({ step: () => ({ text: 'cut off', finishReason, toolCalls: [call('t')] }) });
      expect(r.completed).toBe(false);
    }
  });

  it('stops text-only runs that end with an unfamiliar finish reason, even if the harness says not done', async () => {
    let n = 0;
    const result = await runAgentLoop({
      step: (): LoopStep => ({ text: `answer ${(n += 1)}`, finishReason: 'other', done: false }),
    });
    expect(result.steps).toHaveLength(1);
    expect(result.verdict).toMatchObject({ stop: true, code: 'FINISH_OTHER_TEXT_ONLY' });
    expect(result.completed).toBe(false);
  });

  it('calls onVerdict for every step, including non-stopping ones', async () => {
    const seen: Array<[number, boolean]> = [];
    await runAgentLoop({
      step: (i): LoopStep => (i < 2 ? { toolCalls: [call('t', i)] } : { text: 'end' }),
      onVerdict: (verdict, _step, index) => seen.push([index, verdict.stop]),
    });
    expect(seen).toEqual([
      [0, false],
      [1, false],
      [2, false],
    ]);
  });

  it('surfaces budget warnings through onVerdict', async () => {
    const warnings: Verdict[] = [];
    await runAgentLoop({
      guard: createGuard({ budget: { maxTotalTokens: { limit: 100, warnAt: 0.5 } } }),
      step: (i): LoopStep => (i < 3 ? { toolCalls: [call('t', i)], usage: { totalTokens: 30 } } : { text: 'done' }),
      onVerdict: (v) => {
        if (!v.stop && v.warnings) warnings.push(v);
      },
    });
    // 30, 60, 90 tokens: warnings from the second step on (>= 50 of 100), and the final text-only step.
    expect(warnings.map((v) => (!v.stop ? v.warnings?.[0]?.value : undefined))).toEqual([60, 90, 90]);
  });

  it('awaits async steps', async () => {
    const result = await runAgentLoop({
      step: async (i): Promise<LoopStep> => {
        await Promise.resolve();
        return i < 1 ? { toolCalls: [call('t')] } : { text: 'done' };
      },
    });
    expect(result.steps).toHaveLength(2);
  });

  describe('AbortSignal', () => {
    it('returns immediately if already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const stepFn = vi.fn((): LoopStep => ({ text: 'x' }));
      const result = await runAgentLoop({ step: stepFn, signal: controller.signal });
      expect(stepFn).not.toHaveBeenCalled();
      expect(result).toEqual({ steps: [], verdict: { stop: false }, completed: false, aborted: true });
    });

    it('stops between steps when aborted mid-run', async () => {
      const controller = new AbortController();
      const result = await runAgentLoop({
        signal: controller.signal,
        step: (i): LoopStep => {
          if (i === 1) controller.abort();
          return { toolCalls: [call('t', i)] };
        },
      });
      expect(result.steps).toHaveLength(2);
      expect(result.aborted).toBe(true);
      expect(result.completed).toBe(false);
    });

    it('turns an error thrown after abort into a clean aborted result', async () => {
      const controller = new AbortController();
      const result = await runAgentLoop({
        signal: controller.signal,
        step: (i): LoopStep => {
          if (i === 1) {
            controller.abort();
            throw new Error('AbortError');
          }
          return { toolCalls: [call('t', i)] };
        },
      });
      expect(result.aborted).toBe(true);
      expect(result.steps).toHaveLength(1);
    });

    it('lets errors through when the signal was not aborted', async () => {
      await expect(
        runAgentLoop({
          signal: new AbortController().signal,
          step: () => {
            throw new Error('model exploded');
          },
        }),
      ).rejects.toThrow('model exploded');
    });
  });
});

// ---------------------------------------------------------------------------
describe('withGuard', () => {
  async function* source(steps: GuardStep[], closed?: { value: boolean }): AsyncGenerator<GuardStep> {
    try {
      for (const s of steps) yield s;
    } finally {
      if (closed) closed.value = true;
    }
  }
  const same = (): GuardStep => step(call('search', { q: 'x' }));

  it('yields every step of a healthy stream and attaches a non-stop verdict', async () => {
    const guarded = withGuard(source([step(call('a', 1)), step(call('b', 2)), { text: 'done' }]), createGuard());
    const got: GuardStep[] = [];
    for await (const s of guarded) got.push(s);
    expect(got).toHaveLength(3);
    expect(guarded.verdict).toEqual({ stop: false });
  });

  it('yields the step that triggered the stop, then ends, with the verdict attached', async () => {
    const closed = { value: false };
    const guarded = withGuard(source([same(), same(), same(), same(), same()], closed), createGuard());
    expect(guarded.verdict).toBeUndefined();
    let count = 0;
    for await (const _ of guarded) count += 1;
    expect(count).toBe(3);
    expect(guarded.verdict).toMatchObject({ stop: true, reason: 'repeated-tool-call' });
    expect(closed.value).toBe(true); // the source was closed, not left dangling
  });

  it('accepts a plain synchronous iterable', async () => {
    const guarded = withGuard([same(), same(), same(), same()], createGuard());
    const got: GuardStep[] = [];
    for await (const s of guarded) got.push(s);
    expect(got).toHaveLength(3);
    expect(guarded.verdict?.stop).toBe(true);
  });

  it('resets its verdict at the start of each iteration', async () => {
    const guard = createGuard({ maxSteps: 1 });
    const guarded = withGuard([{}, {}], guard);
    for await (const _ of guarded) break;
    expect(guarded.verdict?.stop).toBe(true);
    const it = guarded[Symbol.asyncIterator]();
    expect(guarded.verdict).toBeUndefined();
    await it.return?.();
  });

  it('stops early when the consumer breaks, and closes the source', async () => {
    const closed = { value: false };
    const guarded = withGuard(source([step(call('a', 1)), step(call('b', 2))], closed), createGuard());
    for await (const _ of guarded) break;
    expect(closed.value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('toGuardStep', () => {
  it('maps AI SDK v5+ style steps (input / output / tool-error content)', () => {
    const aiStep: AiSdkStepLike = {
      text: 'Searching.',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'c1', toolName: 'search', input: { q: 'x' } },
        { toolCallId: 'c2', toolName: 'fetch', input: { url: 'u' } },
      ],
      toolResults: [{ toolCallId: 'c1', toolName: 'search', output: ['hit'] }],
      content: [
        { type: 'text' },
        { type: 'tool-error', toolCallId: 'c2', error: new Error('404') } as { type: string },
      ],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      performance: { stepTimeMs: 123 },
    };
    expect(toGuardStep(aiStep)).toEqual({
      text: 'Searching.',
      finishReason: 'tool-calls',
      toolCalls: [
        { name: 'search', args: { q: 'x' }, result: ['hit'] },
        { name: 'fetch', args: { url: 'u' }, error: new Error('404') },
      ],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      durationMs: 123,
    });
  });

  it('also reads the older args / result field names (hand-written fake, not a real SDK object)', () => {
    const mapped = toGuardStep({
      toolCalls: [{ toolCallId: 'a', toolName: 't', args: { x: 1 } }],
      toolResults: [{ toolCallId: 'a', result: 'r' }],
    });
    expect(mapped.toolCalls).toEqual([{ name: 't', args: { x: 1 }, result: 'r' }]);
  });

  it('matches results to calls by position when there are no ids', () => {
    const mapped = toGuardStep({
      toolCalls: [{ toolName: 'a', input: 1 }, { toolName: 'b', input: 2 }],
      toolResults: [{ output: 'ra' }, { output: 'rb' }],
    });
    expect(mapped.toolCalls).toEqual([
      { name: 'a', args: 1, result: 'ra' },
      { name: 'b', args: 2, result: 'rb' },
    ]);
  });

  it('copes with a bare step and with a tool-error that has no error payload', () => {
    expect(toGuardStep({})).toEqual({ toolCalls: [] });
    const mapped = toGuardStep({
      toolCalls: [{ toolCallId: 'x', toolName: 't', input: 1 }],
      content: [{ type: 'tool-error', toolCallId: 'x' } as { type: string }],
    });
    expect(mapped.toolCalls?.[0]?.error).toBe('tool-error');
  });

  it('ignores non-object content parts and malformed tool-error parts', () => {
    const mapped = toGuardStep({
      toolCalls: [{ toolCallId: 'x', toolName: 't', input: 1 }],
      content: [null, 'str', { type: 'tool-error' }] as unknown as Array<{ type: string }>,
    });
    expect(mapped.toolCalls?.[0]?.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('toStopWhen', () => {
  const aiLoop = (n: number): AiSdkStepLike[] =>
    Array.from({ length: n }, (_, i) => ({
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: `c${i}`, toolName: 'search', input: { q: 'x' } }],
      toolResults: [{ toolCallId: `c${i}`, toolName: 'search', output: 'same results' }],
    }));

  it('returns false until the loop is detected, then true', () => {
    const stopWhen = toStopWhen(() => createGuard());
    expect(stopWhen({ steps: aiLoop(1) })).toBe(false);
    expect(stopWhen({ steps: aiLoop(2) })).toBe(false);
    expect(stopWhen({ steps: aiLoop(3) })).toBe(true);
  });

  it('is idempotent: same steps, same answer, however often it is called', () => {
    const stopWhen = toStopWhen(() => createGuard());
    for (const n of [1, 2, 3, 4, 3, 2, 1, 3]) {
      const expected = n >= 3;
      expect(stopWhen({ steps: aiLoop(n) })).toBe(expected);
      expect(stopWhen({ steps: aiLoop(n) })).toBe(expected);
    }
  });

  it('keeps no state between calls or between runs', () => {
    const stopWhen = toStopWhen(() => createGuard({ maxSteps: 3 }));
    const healthy = (n: number) => aiLoop(n).map((s, i) => ({ ...s, toolCalls: [{ toolName: 'search', input: { q: i } }] }));
    expect(stopWhen({ steps: healthy(3) })).toBe(true);
    // A new, shorter run is judged on its own, not on the previous one.
    expect(stopWhen({ steps: healthy(2) })).toBe(false);
  });

  it('builds a fresh guard from a factory on every call', () => {
    const factory = vi.fn(() => createGuard());
    const stopWhen = toStopWhen(factory);
    stopWhen({ steps: aiLoop(1) });
    stopWhen({ steps: aiLoop(1) });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('accepts GuardOptions instead of a factory', () => {
    const stopWhen = toStopWhen({ repeatedToolCall: { threshold: 2 } });
    expect(stopWhen({ steps: aiLoop(2) })).toBe(true);
  });

  it('works with no arguments', () => {
    expect(toStopWhen()({ steps: aiLoop(3) })).toBe(true);
  });

  it('does not stop a healthy multi-step run', () => {
    const steps: AiSdkStepLike[] = [1, 2, 3, 4, 5].map((i) => ({
      finishReason: 'tool-calls',
      text: `step ${i}`,
      toolCalls: [{ toolCallId: String(i), toolName: i % 2 ? 'search' : 'read', input: { n: i } }],
      toolResults: [{ toolCallId: String(i), output: `result ${i}` }],
    }));
    const stopWhen = toStopWhen();
    for (let n = 1; n <= steps.length; n += 1) expect(stopWhen({ steps: steps.slice(0, n) })).toBe(false);
  });

  it('reports why through onStop', () => {
    const onStop = vi.fn();
    toStopWhen(() => createGuard(), { onStop })({ steps: aiLoop(3) });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop.mock.calls[0]?.[0]).toMatchObject({ reason: 'repeated-tool-call' });
    onStop.mockClear();
    toStopWhen(() => createGuard(), { onStop })({ steps: aiLoop(1) });
    expect(onStop).not.toHaveBeenCalled();
  });

  it('enforces token budgets from step usage', () => {
    const steps: AiSdkStepLike[] = [1, 2, 3].map((i) => ({
      toolCalls: [{ toolName: 't', input: i }],
      usage: { inputTokens: 600, outputTokens: 100, totalTokens: 700 },
    }));
    const stopWhen = toStopWhen({ budget: { maxTotalTokens: 1500 } });
    expect(stopWhen({ steps: steps.slice(0, 2) })).toBe(false); // 1400
    expect(stopWhen({ steps })).toBe(true); // 2100
  });

  it('enforces duration budgets from performance.stepTimeMs', () => {
    const steps: AiSdkStepLike[] = [1, 2, 3].map((i) => ({
      toolCalls: [{ toolName: 't', input: i }],
      performance: { stepTimeMs: 400 },
    }));
    expect(toStopWhen({ budget: { maxDurationMs: 1000 } })({ steps })).toBe(true);
    expect(toStopWhen({ budget: { maxDurationMs: 1000 } })({ steps: steps.slice(0, 2) })).toBe(false);
  });

  it('only the latest step decides (an earlier stop that the loop already passed is ignored)', () => {
    // 3 identical calls then a different one: the run was "stopped" at step 3, but at step 4 it is not.
    const steps = [...aiLoop(3), { toolCalls: [{ toolName: 'other', input: 1 }] }];
    expect(toStopWhen({ maxSteps: false })({ steps })).toBe(false);
  });
});
