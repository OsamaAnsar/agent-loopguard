# agent-loopguard

<!-- Add after the first publish: [![npm](https://img.shields.io/npm/v/@osama.ansar/agent-loopguard)](https://www.npmjs.com/package/@osama.ansar/agent-loopguard) -->

Agent loops fail in a few boring, expensive ways. The model calls the same tool with the same arguments again and again. Two calls ping-pong (`search`, `read`, `search`, `read`). The model repeats itself while nothing new comes back. A provider ends a final, text-only step with a finish reason the loop does not recognise as "done", so some frameworks re-send the same request until the step limit. Or the run quietly burns through a token, time or cost budget.

`agent-loopguard` is a small, framework-agnostic guard. You feed it one step at a time; it tells you whether to continue or stop, and why, as a typed, serialisable verdict. Zero runtime dependencies, ESM and CommonJS, Node 18 or newer.

## Quickstart

```bash
npm install @osama.ansar/agent-loopguard
```

```ts
import { createGuard, explain } from '@osama.ansar/agent-loopguard';

const guard = createGuard();

for (let i = 0; ; i++) {
  const step = await runOneModelStep(); // your code: call the model, run its tools

  const verdict = guard.check({
    text: step.text,
    finishReason: step.finishReason,
    toolCalls: step.toolCalls.map((c) => ({ name: c.name, args: c.args, result: c.result })),
    usage: step.usage, // { inputTokens, outputTokens, totalTokens, costUsd } - whatever you have
  });

  if (verdict.stop) {
    console.log(explain(verdict));
    break;
  }
}
```

A stopped run looks like this (from `npm run example:loop`, a simulated agent that never changes its mind):

```
Stop [REPEATED_TOOL_CALL] Tool "search" was called 3 times in a row with identical arguments: search({"query":"agent loop detection"}).
Hint: The model keeps issuing the same call. Check that the tool result gives it something to act on, and that the prompt says what to do when a tool fails.
```

## What it checks

Every detector can be tuned or switched off with `false`. All defaults are listed here; none of them are tuned against real traffic, so treat them as sensible starting points.

| Detector (option) | Stops when | Defaults |
| --- | --- | --- |
| `maxSteps` | the number of steps recorded reaches the limit | `50` |
| `repeatedToolCall` | the same tool is called with canonically-equal arguments N times in a row | `threshold: 3`, `requireIdenticalResults: false`, `ignoreErrors: false` |
| `oscillation` | the tail of the tool-call sequence is a cycle of 2..`maxPeriod` calls repeated `repeats` times | `maxPeriod: 3`, `repeats: 3` |
| `noProgress` | N consecutive steps have the same normalised text and no new tool outcome | `threshold: 3` |
| `finishReason` | the finish reason is terminal, or is an unfamiliar one under the `otherPolicy` | `terminal: ['stop', 'length', 'content-filter', 'error']`, `otherPolicy: 'stop-if-text-only'` |
| `budget` | a cumulative token, cost or duration total reaches its limit (and warns before that, if you set `warnAt`) | no limits unless you set them |

Plus a `custom` hook for your own rules (below).

## Examples

### A plain loop

```ts
import { createGuard, explain, runAgentLoop } from '@osama.ansar/agent-loopguard';

const result = await runAgentLoop({
  guard: createGuard({ maxSteps: 25, budget: { maxCostUsd: { limit: 0.5, warnAt: 0.8 } } }),
  signal: controller.signal, // optional AbortSignal
  step: async (i) => {
    const response = await callModelAndRunTools(i); // your code
    return {
      text: response.text,
      finishReason: response.finishReason,
      toolCalls: response.toolCalls, // [{ name, args, result?, error? }]
      usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens, costUsd: response.costUsd },
    };
  },
  onVerdict: (verdict) => {
    if (!verdict.stop && verdict.warnings) console.warn(verdict.warnings.map((w) => w.detail));
  },
});

if (!result.completed) console.log(explain(result.verdict));
```

`runAgentLoop` calls `step(0)`, `step(1)`, ... until the agent is done or the guard says stop. A step is "done" when it sets `done: true`, or, if `done` is not set, when it has no tool calls. It returns `{ steps, verdict, completed, aborted }`.

### Vercel AI SDK `stopWhen`

```ts
import { generateText, stepCountIs } from 'ai';
import { createGuard, explain, toStopWhen } from '@osama.ansar/agent-loopguard';

const { text } = await generateText({
  model,
  tools,
  prompt,
  stopWhen: [
    toStopWhen(() => createGuard(), { onStop: (verdict) => console.log(explain(verdict)) }),
    stepCountIs(20), // keep your own cap too if you like
  ],
});
```

`toStopWhen` is idempotent: on every call it builds a fresh guard from your factory and replays the whole `steps` array, so the answer depends only on the steps it is given (not on how many times the SDK calls it) and nothing leaks between runs. You can pass `GuardOptions` instead of a factory.

**What was verified.** The adapter is type-checked against the real `StopCondition` type and exercised end to end in `generateText` with the AI SDK's own `MockLanguageModelV4` (offline, no provider involved), using `ai@7.0.140`: a repeating tool call is stopped after the third step, a healthy multi-step run is not stopped, token budgets are enforced from the usage the SDK reports, and tool results and errors are mapped onto the call that produced them. That test needs Node 22 or newer because `ai` does; it is skipped on older Node. **Not verified:** real providers, and AI SDK major versions other than 7. The adapter reads the field names `toolCalls[].input`, `toolResults[].output`, `usage` and `performance.stepTimeMs`, and also accepts the older `args` and `result` names; those older shapes are only tested against hand-written fakes, so treat that support as "structurally compatible; verified against the documented shape".

### Async stream of steps

```ts
import { createGuard, explain, withGuard } from '@osama.ansar/agent-loopguard';

const steps = withGuard(agentSteps(), createGuard()); // any (async) iterable of steps
for await (const step of steps) render(step);

if (steps.verdict?.stop) console.log(explain(steps.verdict));
```

The step that triggers the stop is still yielded (it already happened); iteration ends right after and the source iterator is closed.

### A custom detector

```ts
import { createGuard } from '@osama.ansar/agent-loopguard';

const guard = createGuard({
  custom: (history, step) => {
    const deletes = history.flatMap((s) => s.toolCalls ?? []).filter((c) => c.name === 'delete_file').length;
    return deletes > 5
      ? { stop: true, code: 'TOO_MANY_DELETES', detail: `${deletes} delete_file calls in one run.`, evidence: { deletes } }
      : undefined;
  },
});
```

A custom detector receives the full history (the current step last) and runs after the built-in ones. Return `undefined` or `{ stop: false }` to continue. Its verdicts have `reason: 'custom'`. If it throws, the error propagates out of `guard.check`.

## What it does not do

- **No semantic loop detection.** It compares tool names, arguments, results and text after normalisation. A model that rewords its text and varies one argument slightly each time is not detected, and no embedding or LLM is involved.
- **No cost table.** It never estimates tokens or prices. Token and cost limits only work on the numbers you pass in `usage`; if you supply no `costUsd`, a `maxCostUsd` limit can never fire.
- **No LLM calls and no network.** It is plain, synchronous code.
- **It does not run your agent.** `runAgentLoop` is a ten-line convenience, not a framework.
- **It does not cancel in-flight work.** A verdict is advice; stopping is up to the caller (`runAgentLoop` and `toStopWhen` do it for you at step boundaries).
- **Defaults are not benchmarked.** Thresholds such as "3 in a row" are conventions, not measured optima. Check them against your own traces.
- **History is kept in memory** for the life of the guard (`reset()` clears it). It is cheap for a normal run but is not designed for unbounded sessions.

## How detection works

Steps are reduced to comparable facts once, when `check` is called. Anything unusable (a non-string finish reason, `NaN` token counts, a throwing getter) is ignored rather than thrown on.

**Canonical form.** Arguments and results are turned into a deterministic string so equal values compare equal: object keys are sorted; properties whose value is `undefined` are omitted (like JSON); array order is kept; `NaN`, `Infinity` and bigint (`10n`) stay distinct from strings and numbers that print alike; `-0` equals `0`; Dates are written as ISO strings; Maps and Sets are sorted by their entries; objects with `toJSON` (URL, ...) are written by calling it; a reference back to an ancestor is written `[Circular:<depth>]`; nesting deeper than 64 levels and inputs of more than 200,000 values are cut off with a marker (so two huge values that agree on everything before the cut compare equal). If reading a value throws (hostile getters, revoked proxies), it gets a unique placeholder and is never equal to anything. Canonical forms longer than 256 characters are compared by length plus a 28-hex-character non-cryptographic hash; this is for equality checks, not security.

**Call sequence.** "A call" is one entry of `toolCalls`. `repeatedToolCall` and `oscillation` read the flattened sequence of calls across steps, in order. Parallel calls in one step count one by one; steps with no tool calls neither extend nor break a run. A call's signature is its tool name plus the canonical arguments. Its outcome signature adds the canonical result or error (or, if neither was supplied, is just the call).

**`maxSteps`.** Stops when `limit` steps have been recorded. With `maxSteps: 3` the third `check` stops.

**`repeatedToolCall`.** Stops when the run of identical signatures at the end of the sequence reaches `threshold` (exactly N stops, N-1 does not). With `requireIdenticalResults`, identical means identical outcome signature, so polling a job whose status keeps changing is not a repeat. With `ignoreErrors`, calls with a non-null `error` are removed from the sequence before counting. A run that reaches the threshold in the middle of a step still counts if a later call in the same step ends it.

**`oscillation`.** For each period `p` from 2 to `maxPeriod`, looks at the end of the call-signature sequence: it stops when the last `p` calls repeat for `repeats` full cycles in a row (`a b a b a b` is period 2, three cycles). A cycle made of one distinct call (`a a a a a a`) is not an oscillation; that is `repeatedToolCall`'s case. Results are not considered.

**`noProgress`.** A step is *stalled* when none of its tool outcomes is new in this run (a step without tool calls is always stalled). It stops after `threshold` consecutive stalled steps that all have the same normalised text (lower-cased, whitespace collapsed; an empty string counts as text, so tool-only steps are judged on outcomes alone). A new outcome, or different text, restarts the count. Because outcomes include the result, the same call returning a new result is progress.

**`finishReason`.** Finish reasons are normalised (trimmed, lower-cased, `_` becomes `-`). Then: a reason in `terminal` stops, even if tool calls are present; `tool-calls` continues; a missing reason says nothing; anything else (`other`, `unknown`, any unfamiliar string) follows `otherPolicy`: `'stop'` stops, `'continue'` continues, `'stop-if-text-only'` (default) stops when the step has non-blank text and no tool calls.

Why the default exists: some frameworks only treat `stop` as "finished". If a provider ends a final, text-only answer with an unfamiliar reason, those frameworks see "not finished" and re-send the same request until the step limit, paying for the same answer again and again. A text-only step that is not a clean stop is the signature of that, so the guard ends the run there. A normal `stop` also produces a stop verdict (the run is over); use `isFault(verdict)` to tell that apart from a problem.

**`budget`.** Totals are summed from the steps: input, output and total tokens (total falls back to input plus output when a step gives none), `costUsd`, and `durationMs`. Numbers that are not finite and non-negative are ignored. A limit is *spent when reached* (`value >= limit`): the guard runs after a step has happened, so waiting for "exceeded" would always overshoot by a step. `maxDurationMs` compares against the larger of the summed `durationMs` values and the wall-clock time since the guard was created or reset (read from the injectable `now()`, so tests can control it). With `warnAt` (a ratio between 0 and 1, per limit or shared), a step that is at or past that fraction but below the limit returns `{ stop: false, warnings: [...] }`; the warning repeats on every step while it applies.

**Priority.** All detectors see every step (so their state stays consistent), and the first stop wins in this order: finish reason, budget, max steps, repeated tool call, oscillation, no progress, custom. Detectors overlap: a perfectly repeating `a b a b a` with identical results and empty text is reported by `noProgress` a step before `oscillation` would fire.

## API reference

### `createGuard(options?: GuardOptions): Guard`

```ts
interface GuardOptions {
  maxSteps?: number | false;                          // default 50
  repeatedToolCall?: { threshold?: number; requireIdenticalResults?: boolean; ignoreErrors?: boolean } | false;
  oscillation?: { maxPeriod?: number; repeats?: number } | false;
  noProgress?: { threshold?: number } | false;
  finishReason?: { terminal?: readonly string[]; otherPolicy?: 'stop' | 'continue' | 'stop-if-text-only' } | false;
  budget?: {
    maxTotalTokens?: BudgetLimit; maxInputTokens?: BudgetLimit; maxOutputTokens?: BudgetLimit;
    maxCostUsd?: BudgetLimit; maxDurationMs?: BudgetLimit;
    warnAt?: number;                                  // default warning ratio
  } | false;                                          // BudgetLimit = number | { limit: number; warnAt?: number }
  custom?: CustomDetector | readonly CustomDetector[];
  now?: () => number;                                 // default Date.now
}

interface Guard {
  check(step: GuardStep): Verdict;
  reset(): void;                                      // forget the run, keep the options
  summary(): GuardSummary;                            // counts, totals, per-detector state; JSON-serialisable
  readonly history: readonly GuardStep[];             // frozen shallow copy
}
```

Invalid options (a threshold below 2, a non-positive limit, a `warnAt` outside 0 to 1, ...) throw a `TypeError` from `createGuard`. `check` does not throw on odd step data.

`summary()` contains nothing time-dependent: durations are the summed `durationMs` values, never wall-clock readings.

### `GuardStep`

```ts
interface GuardStep {
  toolCalls?: { name: string; args?: unknown; result?: unknown; error?: unknown }[];
  text?: string;
  finishReason?: string;   // 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other' | 'unknown' | any string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
  durationMs?: number;
  timestamp?: number;      // recorded in history; not used by any detector
}
```

### `Verdict`

```ts
type Verdict =
  | { stop: false; warnings?: GuardWarning[] }
  | { stop: true; reason: StopReason; code: string; detail: string; evidence: /* depends on reason */; warnings?: GuardWarning[] };

type StopReason = 'max-steps' | 'repeated-tool-call' | 'oscillation' | 'no-progress' | 'finish-reason' | 'budget' | 'custom';
```

`verdict.reason` narrows `verdict.evidence` in TypeScript. Verdicts are plain JSON.

| `reason` | `code` | `evidence` |
| --- | --- | --- |
| `max-steps` | `MAX_STEPS` | `{ steps, limit }` |
| `repeated-tool-call` | `REPEATED_TOOL_CALL` | `{ tool, argsPreview, count, threshold, stepIndexes, identicalResults }` |
| `oscillation` | `OSCILLATION` | `{ period, repeats, threshold, cycle }` |
| `no-progress` | `NO_PROGRESS` | `{ steps, threshold, textPreview }` |
| `finish-reason` | `FINISH_TERMINAL`, `FINISH_OTHER`, `FINISH_OTHER_TEXT_ONLY` | `{ finishReason, normalized, policy, hasText, toolCallCount }` |
| `budget` | `BUDGET_TOTAL_TOKENS`, `BUDGET_INPUT_TOKENS`, `BUDGET_OUTPUT_TOKENS`, `BUDGET_COST_USD`, `BUDGET_DURATION_MS` | `{ metric, value, limit }` |
| `custom` | your `code` (default `CUSTOM`) | whatever you return |

A warning is `{ code: 'BUDGET_WARNING', metric, value, limit, ratio, detail }`.

### Helpers

- `explain(verdict): string`: readable text for logs, including a short hint and any warnings.
- `isFault(verdict): verdict is StopVerdict`: true for a stop that is not just the model finishing normally with `stop`.
- `canonicalize(value): string` and `stableHash(value): string`: the comparison primitives, exported because they are useful on their own.

### Adapters

- `toStopWhen(guardFactory | options, { onStop }?)`: returns `({ steps }) => boolean`, usable as an AI SDK `stopWhen` condition. Idempotent (see above). Only the verdict for the latest step counts. Because it replays steps in a fresh guard, a wall-clock `maxDurationMs` is meaningless there; step durations (`performance.stepTimeMs`) are used instead.
- `toGuardStep(aiSdkStep): GuardStep`: the mapping `toStopWhen` uses (tool results and `tool-error` content parts are matched to calls by `toolCallId`).
- `runAgentLoop({ step, guard?, signal?, onVerdict? }): Promise<{ steps, verdict, completed, aborted }>`. `completed` is true when the agent ended the run itself (a final step with no fault, or a normal `stop`), false when the guard cut it short, the finish reason was something like `length` or `error`, or the signal aborted. The signal is checked before every step; an in-flight step is not cancelled.
- `withGuard(source, guard): AsyncIterable<step> & { verdict }`: wraps a sync or async iterable.

## Related work

[`agent-loop-guard`](https://www.npmjs.com/package/agent-loop-guard) (by Nextbridge) is a similar, independent library, and a good one to look at. Going by its 0.2.0 README, it wraps each tool call in `beforeCall()` / `afterCall()`, so it can block a call before it runs, and it offers per-tool call limits, saved and resumable state, and a text report you can paste into the model's context.

This package takes a different shape: you pass in each finished step, and it adds a finish-reason policy (for example, ending a run when a text-only step finishes with an unfamiliar reason), budgets driven by the token, cost and duration numbers you report, and a `stopWhen` adapter for the Vercel AI SDK that is tested against the real SDK. Both have zero runtime dependencies. Pick whichever fits how your loop is written; nothing stops you from using the other one's ideas.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test                  # npm run test:coverage for coverage
npm run build
npm run example:loop
npm run example:ai-sdk    # Node >= 22 (needs the `ai` dev dependency)
```

The package supports Node 18 and newer. The development toolchain (vitest, tsup) and the AI SDK integration test need a newer Node; CI runs Node 20, 22 and 24.

### Releasing

Publishing is done from a GitHub Release by `.github/workflows/publish.yml`, which publishes with npm provenance. It needs a repository secret named `NPM_TOKEN` (an npm automation token for an account allowed to publish `@osama.ansar/agent-loopguard`). Bump the version in `package.json` and `CHANGELOG.md`, tag, and create a Release.

## License

MIT
