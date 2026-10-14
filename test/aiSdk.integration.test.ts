/**
 * Runs the stopWhen adapter inside the real AI SDK (`ai`, a devDependency only) using its
 * own mock language model, fully offline.
 *
 * - The compile-time half (`StopCondition` assignability) is checked by `npm run typecheck`.
 * - The runtime half needs a Node version the installed `ai` supports (>= 22), so it is skipped
 *   on older Node. The package itself supports Node >= 18; only this dev-only test does not.
 */
import type * as AiModule from 'ai';
import type * as AiTestModule from 'ai/test';
import type { StopCondition, ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGuard, toGuardStep, toStopWhen } from '../src/index';

// --- compile-time checks ----------------------------------------------------
// The adapter's return value must be accepted wherever the SDK expects a StopCondition.
export const assignableToStopCondition: StopCondition<ToolSet> = toStopWhen(() => createGuard());
export const assignableWithOptions: StopCondition<ToolSet> = toStopWhen({ maxSteps: 10 }, { onStop: () => undefined });

const nodeMajor = Number(process.versions.node.split('.')[0]);

describe.skipIf(nodeMajor < 22)('toStopWhen inside the real AI SDK (offline, mock model)', () => {
  type Ai = typeof AiModule;
  type AiTest = typeof AiTestModule;
  const load = async (): Promise<{ ai: Ai; test: AiTest }> => ({
    ai: await import('ai'),
    test: await import('ai/test'),
  });

  const usage = (input: number, output: number) => ({
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  });

  /** A model that replies to each call with the next scripted response. */
  const scriptedModel = (
    test: AiTest,
    responses: Array<
      | { tool: string; input: unknown; tokens?: [number, number] }
      | { text: string; finish?: 'stop' | 'other'; tokens?: [number, number] }
    >,
  ) => {
    let calls = 0;
    return new test.MockLanguageModelV4({
      doGenerate: async () => {
        const index = Math.min(calls, responses.length - 1);
        calls += 1;
        const r = responses[index];
        if (!r) throw new Error('no scripted response');
        const [i, o] = r.tokens ?? [10, 5];
        if ('tool' in r) {
          return {
            content: [
              { type: 'tool-call' as const, toolCallId: `call-${index}`, toolName: r.tool, input: JSON.stringify(r.input) },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(i, o),
            warnings: [],
          };
        }
        return {
          content: [{ type: 'text' as const, text: r.text }],
          finishReason: { unified: r.finish ?? ('stop' as const), raw: undefined },
          usage: usage(i, o),
          warnings: [],
        };
      },
    });
  };

  const searchTool = (ai: Ai, executed: string[]) =>
    ai.tool({
      description: 'search the web',
      inputSchema: z.object({ q: z.string() }),
      execute: async ({ q }) => {
        executed.push(q);
        return `results for ${q}`;
      },
    });

  it('stops a model that keeps repeating the same tool call (and the SDK would otherwise run to the step cap)', async () => {
    const { ai, test } = await load();
    const executed: string[] = [];
    const model = scriptedModel(test, [{ tool: 'search', input: { q: 'x' } }]);
    const stops: string[] = [];

    const result = await ai.generateText({
      model,
      prompt: 'find x',
      tools: { search: searchTool(ai, executed) },
      stopWhen: [
        toStopWhen(() => createGuard(), { onStop: (v) => stops.push(v.code) }),
        ai.stepCountIs(20), // the safety net the guard should beat
      ],
    });

    expect(result.steps).toHaveLength(3);
    expect(executed).toEqual(['x', 'x', 'x']);
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(stops).toContain('REPEATED_TOOL_CALL');
  });

  it('lets a healthy multi-step run finish on its own', async () => {
    const { ai, test } = await load();
    const executed: string[] = [];
    const model = scriptedModel(test, [
      { tool: 'search', input: { q: 'a' } },
      { tool: 'search', input: { q: 'b' } },
      { tool: 'search', input: { q: 'c' } },
      { text: 'Here is the answer.' },
    ]);
    const result = await ai.generateText({
      model,
      prompt: 'research',
      tools: { search: searchTool(ai, executed) },
      stopWhen: toStopWhen(() => createGuard()),
    });
    expect(result.steps).toHaveLength(4);
    expect(result.text).toBe('Here is the answer.');
    expect(executed).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent on the SDK real steps array: repeated calls give the same answers', async () => {
    const { ai, test } = await load();
    const model = scriptedModel(test, [{ tool: 'search', input: { q: 'x' } }]);
    const result = await ai.generateText({
      model,
      prompt: 'find x',
      tools: { search: searchTool(ai, []) },
      stopWhen: [toStopWhen(() => createGuard()), ai.stepCountIs(20)],
    });
    const condition = toStopWhen(() => createGuard());
    for (let n = 1; n <= result.steps.length; n += 1) {
      const steps = result.steps.slice(0, n);
      const first = condition({ steps });
      expect(condition({ steps })).toBe(first);
      expect(first).toBe(n >= 3);
    }
  });

  it('enforces a token budget using the usage the SDK reports', async () => {
    const { ai, test } = await load();
    const model = scriptedModel(test, [
      { tool: 'search', input: { q: 'a' }, tokens: [400, 100] },
      { tool: 'search', input: { q: 'b' }, tokens: [400, 100] },
      { tool: 'search', input: { q: 'c' }, tokens: [400, 100] },
      { text: 'never reached', tokens: [400, 100] },
    ]);
    const result = await ai.generateText({
      model,
      prompt: 'research',
      tools: { search: searchTool(ai, []) },
      stopWhen: toStopWhen({ budget: { maxTotalTokens: 1200 } }), // 500 per step: reached after step 3 (1500)
    });
    expect(result.steps).toHaveLength(3);
    expect(result.usage.totalTokens).toBe(1500);
  });

  it('maps real tool errors and results onto the call that produced them', async () => {
    const { ai, test } = await load();
    const model = scriptedModel(test, [
      { tool: 'search', input: { q: 'ok' } },
      { tool: 'flaky', input: { n: 1 } },
      { text: 'done' },
    ]);
    const result = await ai.generateText({
      model,
      prompt: 'go',
      tools: {
        search: searchTool(ai, []),
        flaky: ai.tool({
          description: 'always fails',
          inputSchema: z.object({ n: z.number() }),
          execute: async (): Promise<string> => {
            throw new Error('upstream 503');
          },
        }),
      },
      stopWhen: toStopWhen(() => createGuard()),
    });
    const first = result.steps[0];
    const second = result.steps[1];
    expect(first && toGuardStep(first).toolCalls).toEqual([{ name: 'search', args: { q: 'ok' }, result: 'results for ok' }]);
    const failedCall = second && toGuardStep(second).toolCalls?.[0];
    expect(failedCall).toMatchObject({ name: 'flaky', args: { n: 1 } });
    expect(failedCall?.error).toBeDefined();
    expect(failedCall?.result).toBeUndefined();
  });
});
