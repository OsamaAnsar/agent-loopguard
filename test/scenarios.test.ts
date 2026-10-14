/**
 * Realistic, scripted traces: the failures the package exists to catch, and (just as important)
 * runs that look suspicious but are healthy and must NOT be stopped.
 */
import { describe, expect, it } from 'vitest';
import { createGuard, explain, isFault } from '../src/index';
import type { GuardOptions, GuardStep, Verdict } from '../src/index';
import { call, feed, firstStop } from './helpers';

const toolStep = (text: string, ...calls: ReturnType<typeof call>[]): GuardStep => ({
  text,
  toolCalls: calls,
  finishReason: 'tool-calls',
  usage: { inputTokens: 1200, outputTokens: 80 },
});

describe('failures that must be caught', () => {
  it('a looping agent repeats search("x") three times', () => {
    const guard = createGuard();
    const search = () =>
      toolStep('Let me search for that.', call('search', { query: 'x' }, { result: [{ title: 'Unrelated page' }] }));
    const verdicts = feed(guard, [search(), search(), search(), search()]);
    expect(firstStop(verdicts)).toBe(2);
    expect(verdicts[2]).toMatchObject({
      stop: true,
      reason: 'repeated-tool-call',
      code: 'REPEATED_TOOL_CALL',
      evidence: { tool: 'search', argsPreview: '{"query":"x"}', count: 3, threshold: 3, stepIndexes: [0, 1, 2] },
    });
    expect(explain(verdicts[2] as Verdict)).toContain('Tool "search" was called 3 times in a row');
  });

  it('A,B,A,B oscillation: list_files <-> read_file never converges', () => {
    // A model that words each step differently, so only the call pattern gives it away.
    const list = (i: number) => toolStep(`Attempt ${i}: check the directory.`, call('list_files', { dir: 'src' }, { result: ['a.ts'] }));
    const read = (i: number) => toolStep(`Attempt ${i}: open the file.`, call('read_file', { path: 'src/a.ts' }, { result: 'export {}' }));
    const verdicts = feed(createGuard(), [list(1), read(2), list(3), read(4), list(5), read(6)]);
    // The sixth call completes the third repetition of the two-call cycle.
    expect(firstStop(verdicts)).toBe(5);
    expect(verdicts[5]).toMatchObject({ stop: true, reason: 'oscillation', evidence: { period: 2, repeats: 3 } });
  });

  it('...and when the text is identical too, the no-progress detector gets there one step earlier', () => {
    const list = () => toolStep('', call('list_files', { dir: 'src' }, { result: ['a.ts'] }));
    const read = () => toolStep('', call('read_file', { path: 'src/a.ts' }, { result: 'export {}' }));
    const trace = [list(), read(), list(), read(), list(), read()];
    const verdicts = feed(createGuard(), trace);
    expect(firstStop(verdicts)).toBe(4);
    expect(verdicts[4]).toMatchObject({ reason: 'no-progress' });
    // With that detector off, the oscillation detector reports it on the sixth call.
    expect(firstStop(feed(createGuard({ noProgress: false }), trace))).toBe(5);
  });

  it('text-only step with an unfamiliar finish reason ends the run (the re-send bug class)', () => {
    const guard = createGuard();
    const verdict = guard.check({
      text: 'The capital of France is Paris.',
      finishReason: 'other',
      usage: { inputTokens: 40, outputTokens: 9 },
    });
    expect(verdict).toMatchObject({ stop: true, reason: 'finish-reason', code: 'FINISH_OTHER_TEXT_ONLY' });
    expect(isFault(verdict)).toBe(true);
  });

  it('if such a framework re-sends anyway, the repeat is also caught by the other detectors', () => {
    // Same answer, finishReason "unknown" each time, and the caller (wrongly) keeps going: with the
    // finish-reason rule off, the no-progress detector still ends it after three identical steps.
    const guard = createGuard({ finishReason: false });
    const resend = () => ({ text: 'The capital of France is Paris.', finishReason: 'unknown' });
    expect(firstStop(feed(guard, [resend(), resend(), resend()]))).toBe(2);
  });

  it('a budget blow-out: warning at 75%, stop at 100%', () => {
    const guard = createGuard({
      budget: { maxTotalTokens: { limit: 20_000, warnAt: 0.75 }, maxCostUsd: 0.5 },
    });
    const turn = (i: number): GuardStep => ({
      toolCalls: [call('read_file', { path: `file-${i}.ts` })],
      usage: { inputTokens: 4000, outputTokens: 1000, costUsd: 0.1 },
    });
    const verdicts = feed(guard, [0, 1, 2, 3, 4, 5].map(turn));
    // 5k per step: 5k, 10k, 15k (warn), 20k (stop)
    expect(verdicts.slice(0, 2).every((v) => !v.stop && v.warnings === undefined)).toBe(true);
    expect(verdicts[2]).toMatchObject({ stop: false, warnings: [{ metric: 'totalTokens', value: 15_000, ratio: 0.75 }] });
    expect(verdicts[3]).toMatchObject({ stop: true, reason: 'budget', code: 'BUDGET_TOTAL_TOKENS' });
    expect(guard.summary().totals).toMatchObject({ totalTokens: 30_000, inputTokens: 24_000, outputTokens: 6000 });
  });

  it('a tool that keeps failing the same way is caught even though every call "returns"', () => {
    const guard = createGuard();
    const failing = () => toolStep('Retrying.', call('http_get', { url: 'https://example.invalid' }, { error: new Error('ECONNREFUSED') }));
    expect(firstStop(feed(guard, [failing(), failing(), failing()]))).toBe(2);
  });
});

describe('healthy runs that must not trigger anything', () => {
  it('a healthy six-step research run', () => {
    const guard = createGuard({ budget: { maxTotalTokens: { limit: 100_000, warnAt: 0.9 }, maxCostUsd: 5 } });
    const steps: GuardStep[] = [
      toolStep('I will start by searching.', call('search', { query: 'agent loop detection' }, { result: ['r1', 'r2'] })),
      toolStep('Let me open the first result.', call('fetch', { url: 'https://a.example' }, { result: '<html>A</html>' })),
      toolStep('Now the second.', call('fetch', { url: 'https://b.example' }, { result: '<html>B</html>' })),
      toolStep('Refining the search.', call('search', { query: 'loop detection circuit breaker' }, { result: ['r3'] })),
      toolStep('Reading the notes file.', call('read_file', { path: 'notes.md' }, { result: '# notes' })),
      { text: 'Here is the summary of what I found.', finishReason: 'stop', usage: { inputTokens: 3000, outputTokens: 400 } },
    ];
    const verdicts = feed(guard, steps);
    // The first five steps carry on; the last is the model finishing normally, which is not a fault.
    expect(verdicts.slice(0, 5).every((v) => !v.stop && v.warnings === undefined)).toBe(true);
    expect(verdicts[5]).toMatchObject({ stop: true, reason: 'finish-reason', code: 'FINISH_TERMINAL' });
    expect(isFault(verdicts[5] as Verdict)).toBe(false);
  });

  it('a long varied run never trips the default detectors', () => {
    const guard = createGuard();
    const tools = ['search', 'read_file', 'write_file', 'run_tests'];
    const steps = Array.from({ length: 49 }, (_, i) =>
      toolStep(`Working on item ${i}.`, call(tools[i % tools.length] as string, { n: i }, { result: `result ${i}` })),
    );
    expect(firstStop(feed(guard, steps))).toBe(-1);
    // ...and step 50 hits the default step cap, as documented.
    expect(guard.check(toolStep('One more.', call('search', { n: 99 }, { result: 'x' })))).toMatchObject({ reason: 'max-steps' });
  });

  describe('false-positive guards', () => {
    const fresh = (options: GuardOptions = {}) => createGuard(options);

    it('the same tool three or more times with different arguments', () => {
      const steps = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((path) =>
        toolStep('', call('read_file', { path }, { result: `contents of ${path}` })),
      );
      expect(firstStop(feed(fresh(), steps))).toBe(-1);
    });

    it('repeated tool names with different arguments, interleaved', () => {
      const steps: GuardStep[] = [];
      for (let i = 0; i < 6; i += 1) {
        steps.push(toolStep('', call('search', { q: `q${i}` }, { result: `r${i}` })));
        steps.push(toolStep('', call('fetch', { url: `u${i}` }, { result: `p${i}` })));
      }
      expect(firstStop(feed(fresh(), steps))).toBe(-1);
    });

    it('polling with changing results (with requireIdenticalResults)', () => {
      const guard = fresh({ repeatedToolCall: { requireIdenticalResults: true } });
      const states = ['queued', 'queued 1/4', 'running 2/4', 'running 3/4', 'done'];
      const steps = states.map((status) => toolStep('Checking the job.', call('job_status', { id: 42 }, { result: { status } })));
      expect(firstStop(feed(guard, steps))).toBe(-1);
    });

    it('polling with changing results is also not "no progress", whatever the text says', () => {
      const guard = fresh({ repeatedToolCall: false });
      const states = ['queued', 'running', 'running 50%', 'running 90%', 'done'];
      const steps = states.map((status) => toolStep('Still waiting.', call('job_status', { id: 42 }, { result: { status } })));
      expect(firstStop(feed(guard, steps))).toBe(-1);
    });

    it('two identical calls then a different one then two more (below the threshold each time)', () => {
      // Results keep changing, so this is not a stall either.
      let n = 0;
      const a = () => toolStep('', call('t', 1, { result: `x${(n += 1)}` }));
      const b = () => toolStep('', call('u', 2, { result: `y${(n += 1)}` }));
      expect(firstStop(feed(fresh(), [a(), a(), b(), a(), a(), b()]))).toBe(-1);
    });

    it('a two-step back-and-forth (below the repeat count)', () => {
      const a = (n: number) => toolStep('', call('plan', { n }, { result: 'p' }));
      const b = (n: number) => toolStep('', call('act', { n }, { result: 'a' }));
      expect(firstStop(feed(fresh(), [a(1), b(1), a(2), b(2), a(3), b(3)]))).toBe(-1);
    });

    it('parallel calls with different arguments in one step', () => {
      const parallel = toolStep(
        '',
        call('get_weather', { city: 'Riyadh' }, { result: 41 }),
        call('get_weather', { city: 'Jeddah' }, { result: 36 }),
        call('get_weather', { city: 'Dammam' }, { result: 39 }),
        call('get_weather', { city: 'Mecca' }, { result: 40 }),
      );
      expect(fresh().check(parallel).stop).toBe(false);
    });

    it('the same text each step is fine when tool results keep changing', () => {
      const steps = [1, 2, 3, 4].map((i) => toolStep('Continuing.', call('next_page', { cursor: i }, { result: `page ${i}` })));
      expect(firstStop(feed(fresh(), steps))).toBe(-1);
    });

    it('an empty-text tool-only run with new results each step', () => {
      const steps = [1, 2, 3, 4, 5].map((i) => toolStep('', call('step', {}, { result: i })));
      // Identical calls would trip repeatedToolCall; give them distinct arguments instead.
      const distinct = [1, 2, 3, 4, 5].map((i) => toolStep('', call('step', { i }, { result: i })));
      expect(firstStop(feed(fresh({ repeatedToolCall: false }), steps))).toBe(-1); // new results: progress
      expect(firstStop(feed(fresh(), distinct))).toBe(-1);
    });

    it('a model that answers, gets a follow-up and answers again with a different text', () => {
      const steps: GuardStep[] = [
        { text: 'Paris.', finishReason: 'tool-calls', toolCalls: [call('log', 1, { result: 'ok' })] },
        { text: 'Also, Lyon is large.', finishReason: 'tool-calls', toolCalls: [call('log', 2, { result: 'ok' })] },
      ];
      expect(firstStop(feed(fresh(), steps))).toBe(-1);
    });

    it('an unfamiliar finish reason with tool calls is a normal step, not an end', () => {
      expect(fresh().check({ text: 'calling', finishReason: 'tool_use', toolCalls: [call('t', 1)] }).stop).toBe(false);
    });
  });
});
