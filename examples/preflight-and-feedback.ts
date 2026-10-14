/**
 * Preflight, model-facing feedback, per-tool policies and save/resume in a simulated agent loop.
 * No network, no API keys: the "model" is a function that gets stuck, and listens to the guard.
 *
 *   npm run example:preflight
 *
 * In your own project, import from '@osama.ansar/agent-loopguard' instead of '../src/index'.
 */
import { createGuard, isFault } from '../src/index';
import type { GuardOptions, GuardToolCall } from '../src/index';

const options: GuardOptions = {
  maxSteps: 12,
  tools: {
    search: { maxCalls: 4 }, // never more than four searches in a run
    think: { ignore: true }, // a bookkeeping tool: not a loop however often it is called
  },
};

// The fake tools. `search` always returns the same unhelpful results.
const tools: Record<string, (args: unknown) => unknown> = {
  search: () => ['Unrelated result #1', 'Unrelated result #2'],
  read_page: () => 'agent-loopguard stops agent loops. It checks repeated calls, cycles and budgets.',
  think: () => 'noted',
};

interface Turn {
  text: string;
  call?: { name: string; args: unknown };
}

// A fake model. It keeps searching until a tool result tells it not to, then it changes approach.
function fakeModel(step: number, lastResult: string | undefined): Turn {
  if (lastResult?.startsWith('That call was not run')) {
    return { text: 'The guard says I am repeating myself. I will read a page instead.', call: { name: 'read_page', args: { url: 'https://example.test/loopguard' } } };
  }
  if (step === 4) return { text: 'Let me think about what I learned.', call: { name: 'think', args: { thought: 'The page answers it.' } } };
  if (step >= 5) return { text: 'agent-loopguard stops agent loops.' }; // no tool call: the final answer
  return { text: `Step ${step + 1}: let me search again.`, call: { name: 'search', args: { query: 'agent loop detection' } } };
}

let guard = createGuard(options);
let lastResult: string | undefined;

for (let step = 0; step < 12; step += 1) {
  const turn = fakeModel(step, lastResult);
  const executed: GuardToolCall[] = [];

  if (turn.call !== undefined) {
    // Ask first. Nothing is recorded and the guard does not change.
    const pre = guard.preflight(turn.call);
    if (pre.allow) {
      const result = tools[turn.call.name]?.(turn.call.args);
      executed.push({ name: turn.call.name, args: turn.call.args, result });
      lastResult = JSON.stringify(result);
      console.log(`step ${step + 1}: ${turn.call.name}(${JSON.stringify(turn.call.args)}) ran`);
    } else {
      // The call never ran, so it is left out of the step below. The model gets the feedback text
      // as the tool result: it names the tool but never repeats the arguments.
      lastResult = pre.feedback;
      console.log(`step ${step + 1}: ${turn.call.name}(...) REFUSED [${pre.code}]`);
      console.log(`  developer detail: ${pre.detail}`);
      console.log(`  sent to the model: ${pre.feedback}`);
    }
  }

  // After the step, record what happened. This is the same call the guard has always had.
  const verdict = guard.check({ text: turn.text, toolCalls: executed, finishReason: turn.call ? 'tool-calls' : 'stop' });
  if (verdict.stop) {
    console.log(`step ${step + 1}: the run is over (${isFault(verdict) ? verdict.code : 'the model finished normally'})`);
    break;
  }

  // Pretend the process was restarted here: only the snapshot is carried over.
  if (step === 2) {
    const saved = JSON.stringify(guard); // JSON.stringify(guard) is guard.toJSON()
    guard = createGuard.fromJSON(JSON.parse(saved) as unknown, options);
    console.log(`  (saved ${saved.length} bytes and restored: ${guard.summary().steps} steps, ${guard.summary().toolCalls} tool calls so far)`);
  }
}

console.log('');
console.log('summary:', JSON.stringify({ steps: guard.summary().steps, toolLimits: guard.summary().detectors.toolLimits }));
