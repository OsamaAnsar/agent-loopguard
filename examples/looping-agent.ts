/**
 * A simulated agent that gets stuck, and the guard stopping it.
 * No network, no API keys: the "model" is a function that repeats itself.
 *
 *   npm run example:loop
 *
 * In your own project, import from '@osama.ansar/agent-loopguard' instead of '../src/index'.
 */
import { createGuard, explain, runAgentLoop } from '../src/index';
import type { LoopStep } from '../src/index';

// A fake model that has decided search("agent loop detection") is the answer to everything.
function stuckModel(index: number): LoopStep {
  return {
    text: `Step ${index + 1}: let me search for that again.`,
    finishReason: 'tool-calls',
    toolCalls: [
      {
        name: 'search',
        args: { query: 'agent loop detection' },
        result: ['Unrelated result #1', 'Unrelated result #2'],
      },
    ],
    usage: { inputTokens: 1500 + index * 300, outputTokens: 60 },
  };
}

const guard = createGuard({
  maxSteps: 12,
  budget: { maxTotalTokens: { limit: 50_000, warnAt: 0.8 } },
});

const result = await runAgentLoop({
  guard,
  step: stuckModel,
  onVerdict: (verdict, step, index) => {
    const call = step.toolCalls?.[0];
    console.log(`step ${index + 1}: ${call?.name}(${JSON.stringify(call?.args)}) -> ${verdict.stop ? 'STOP' : 'continue'}`);
  },
});

console.log('');
console.log(explain(result.verdict));
console.log('');
console.log(`ran ${result.steps.length} steps, completed normally: ${result.completed}`);
console.log('summary:', JSON.stringify(guard.summary().totals));
