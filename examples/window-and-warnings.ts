/**
 * Windowed repeat detection and early warnings in a simulated agent loop.
 * No network, no API keys: the "model" alternates between two tools and only changes course when a
 * warning tells it that one more identical call will end the run.
 *
 *   npm run example:warnings
 *
 * In your own project, import from '@osama.ansar/agent-loopguard' instead of '../src/index'.
 */
import { createGuard, isFault } from '../src/index';
import type { GuardToolCall } from '../src/index';

const guard = createGuard({
  warnings: true, // warn one step before each loop rule would stop the run
  repeatedToolCall: { window: { size: 10, maxRepeats: 3 } }, // the same call 3 times in the last 10, interleaved or not
  tools: { read_page: { maxCalls: 4 } },
});

// A fake model. It searches for the same thing between page reads, until it is told to stop.
function fakeModel(step: number, warned: boolean): GuardToolCall | undefined {
  if (warned) return undefined; // the final answer: no tool call
  return step % 2 === 0
    ? { name: 'search', args: { query: 'agent loop detection' } }
    : { name: 'read_page', args: { url: `https://example.test/page/${step}` } };
}

let warned = false;
for (let step = 0; step < 12; step += 1) {
  const next = fakeModel(step, warned);
  const executed: GuardToolCall[] = next === undefined ? [] : [{ ...next, result: `result of ${next.name}` }];
  const verdict = guard.check({ text: next === undefined ? 'The answer.' : `Step ${step + 1}`, toolCalls: executed, finishReason: next === undefined ? 'stop' : 'tool-calls' });

  if (next !== undefined) console.log(`step ${step + 1}: ${next.name}(${JSON.stringify(next.args)})`);
  for (const warning of verdict.warnings ?? []) {
    // `feedback` is safe to send to the model: it names the tool but never repeats the arguments.
    console.log(`  warning [${warning.code}]: ${warning.detail}`);
    console.log(`  sent to the model: ${warning.feedback}`);
    warned = true;
  }
  if (verdict.stop) {
    console.log(`step ${step + 1}: the run is over (${isFault(verdict) ? verdict.code : 'the model finished normally'})`);
    break;
  }
}
