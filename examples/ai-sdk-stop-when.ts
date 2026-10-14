/**
 * agent-loopguard as a Vercel AI SDK `stopWhen` condition.
 *
 * Runs fully offline: the model is the AI SDK's own mock model, scripted to call the same tool
 * forever. Swap it for a real provider model (for example `openai('...')`) in your own code.
 * Needs a Node version the `ai` package supports (>= 22).
 *
 *   npm run example:ai-sdk
 *
 * In your own project, import from 'agent-loopguard' instead of '../src/index'.
 */
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createGuard, explain, toStopWhen } from '../src/index';

let modelCalls = 0;
const model = new MockLanguageModelV4({
  doGenerate: async () => {
    modelCalls += 1;
    return {
      content: [
        {
          type: 'tool-call' as const,
          toolCallId: `call-${modelCalls}`,
          toolName: 'lookup',
          input: JSON.stringify({ id: 42 }),
        },
      ],
      finishReason: { unified: 'tool-calls' as const, raw: undefined },
      usage: {
        inputTokens: { total: 800, noCache: 800, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 40, text: 40, reasoning: undefined },
      },
      warnings: [],
    };
  },
});

const lookup = tool({
  description: 'Look up a record by id',
  inputSchema: z.object({ id: z.number() }),
  execute: async ({ id }) => ({ id, status: 'pending' }),
});

const { steps } = await generateText({
  model,
  prompt: 'Find out whether record 42 is ready.',
  tools: { lookup },
  stopWhen: [
    toStopWhen(() => createGuard(), {
      onStop: (verdict) => console.log(explain(verdict)),
    }),
    stepCountIs(20), // the SDK-level safety net; the guard should stop it long before this
  ],
});

console.log(`\nThe model was called ${modelCalls} times (the step cap was 20); ${steps.length} steps ran.`);
