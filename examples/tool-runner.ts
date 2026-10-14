/**
 * The tool runner in a simulated agent loop: several tool calls per model turn, run in parallel,
 * guarded before they run and checked once per turn. No network, no API keys.
 *
 *   npm run example:runner
 *
 * In your own project, import from '@osama.ansar/agent-loopguard' instead of '../src/index'.
 */
import { createGuard, createToolRunner, isFault } from '../src/index';

const guard = createGuard({
  warnings: true,
  tools: { search: { maxCalls: 3 } }, // at most three searches in the whole run
});
const runner = createToolRunner(guard);

// The fake tools. `search` is slow, `read_page` sometimes fails.
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tools: Record<string, (args: { q?: string; page?: number }) => Promise<string>> = {
  search: async (args) => {
    await delay(5);
    return `results for ${args.q ?? ''}`;
  },
  read_page: async (args) => {
    await delay(1);
    if (args.page === 2) throw new Error('404');
    return `page ${args.page ?? 0}`;
  },
};

// A fake model: every turn it asks for the same search and two page reads, in parallel, until told it may not.
function fakeModel(turn: number, told: string | undefined): Array<{ name: string; args: { q?: string; page?: number } }> {
  if (turn >= 4 || told?.includes('may not') === true) return []; // the final answer
  return [
    { name: 'search', args: { q: `agent loops ${turn % 2}` } },
    { name: 'read_page', args: { page: turn } },
    { name: 'read_page', args: { page: turn + 1 } },
  ];
}

let told: string | undefined;
for (let turn = 0; turn < 8; turn += 1) {
  const requested = fakeModel(turn, told);

  // Run the whole turn at once. A refused call is not run and not recorded; its feedback goes to the model.
  const outcomes = await Promise.all(
    requested.map((call) => runner.run(call.name, call.args, () => (tools[call.name] as (a: typeof call.args) => Promise<string>)(call.args))),
  );
  requested.forEach((call, i) => {
    const outcome = outcomes[i];
    if (outcome === undefined) return;
    if (!outcome.ran) {
      if ('denied' in outcome) {
        console.log(`turn ${turn + 1}: ${call.name} REFUSED [${outcome.denied.code}]`);
        console.log(`  sent to the model: ${outcome.denied.feedback}`);
        told = outcome.denied.feedback;
      }
    } else if (outcome.ok) {
      console.log(`turn ${turn + 1}: ${call.name} -> ${outcome.result}`);
    } else {
      console.log(`turn ${turn + 1}: ${call.name} failed: ${(outcome.error as Error).message}`);
    }
  });

  const verdict = runner.endStep({ text: `turn ${turn + 1}`, finishReason: requested.length > 0 ? 'tool-calls' : 'stop' });
  for (const warning of verdict.warnings ?? []) console.log(`  warning: ${warning.detail}`);
  if (verdict.stop) {
    console.log(`turn ${turn + 1}: the run is over (${isFault(verdict) ? verdict.code : 'the model finished normally'})`);
    break;
  }
}

console.log('');
console.log(guard.report());
