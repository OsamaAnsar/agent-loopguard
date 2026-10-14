# agent-loopguard

[![npm](https://img.shields.io/npm/v/@osama.ansar/agent-loopguard)](https://www.npmjs.com/package/@osama.ansar/agent-loopguard) [![CI](https://github.com/OsamaAnsar/agent-loopguard/actions/workflows/ci.yml/badge.svg)](https://github.com/OsamaAnsar/agent-loopguard/actions/workflows/ci.yml)

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
| `tools.<name>.maxCalls` | a tool is called more often than its cap allows (the call after the Nth) | no caps unless you set them |
| `repeatedToolCall` | the same tool is called with canonically-equal arguments N times in a row | `threshold: 3`, `requireIdenticalResults: false`, `ignoreErrors: false`; per tool: `repeatThreshold`, `polling` |
| `repeatedToolCall.window` | the same call occurs N times among the newest K calls, even with other calls in between (off unless you set it) | no window unless you set `window: { size, maxRepeats }` |
| `oscillation` | the tail of the tool-call sequence is a cycle of 2..`maxPeriod` calls repeated `repeats` times | `maxPeriod: 3`, `repeats: 3` |
| `noProgress` | N consecutive steps have the same normalised text and no new tool outcome | `threshold: 3` |
| `finishReason` | the finish reason is terminal, or is an unfamiliar one under the `otherPolicy` | `terminal: ['stop', 'length', 'content-filter', 'error']`, `otherPolicy: 'stop-if-text-only'` |
| `budget` | a cumulative token, cost or duration total reaches its limit (and warns before that, if you set `warnAt`) | no limits unless you set them |

Plus per-tool policies (`tools`) and a `custom` hook for your own rules (both below). Three more things sit around the detectors: [`preflight`](#check-a-call-before-it-runs) asks whether a call would trip a rule before you run it, [feedback](#tell-the-model-what-went-wrong) gives every fault a short message that is safe to send to the model, and [`toJSON` / `fromJSON`](#save-and-resume-a-run) carry a run into another process.

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

A custom detector receives the full history (the current step last) and runs after the built-in ones. Return `undefined` or `{ stop: false }` to continue. Its verdicts have `reason: 'custom'`. If it throws, the error propagates out of `guard.check`. A custom detector can also return `feedback: '...'` (text for the model); without it, a custom verdict has no `feedback`.

### Per-tool policies

```ts
import { createGuard } from '@osama.ansar/agent-loopguard';

const guard = createGuard({
  tools: {
    search: { maxCalls: 8 },                              // at most 8 searches in a run
    job_status: { polling: { maxIdenticalResults: 6 } },  // same args are fine while the result changes
    deploy: { repeatThreshold: 2 },                       // two identical deploys in a row is already too many
    think: { ignore: true },                              // bookkeeping: never counts as a loop or as progress
    rm: { maxCalls: 0 },                                  // forbidden outright
  },
});
```

| Policy field | Meaning |
| --- | --- |
| `maxCalls` | An integer >= 0: the most calls to this tool in one run. `maxCalls: 3` allows three; the fourth stops the run with reason `tool-limit`, code `TOOL_CALL_CAP` (and `preflight` refuses it before it runs). `0` forbids the tool. |
| `repeatThreshold` | An integer >= 2 replacing the global `repeatedToolCall.threshold` for this tool. |
| `polling` | `true` (or `{ maxIdenticalResults?: number }`): identical arguments are legitimate while the results keep changing. The repeated-call rule applies to this tool only when the result is identical too, after `maxIdenticalResults` identical outcomes in a row (default: the tool's `repeatThreshold`, else the global threshold, so raise it for jobs that stay "pending" for a while). Calls without a result compare equal. |
| `warnAt` | With early warnings: the number of calls (1 to `maxCalls`) at which the warning about the cap starts, or `false` for none. Needs `maxCalls`. See [Early warnings](#early-warnings). |
| `ignore` | `true` leaves the tool out of repeat, oscillation and no-progress detection and out of `maxCalls`. Takes precedence over the other fields. |

Tool names that are not listed follow the global options; names that are never called do no harm. An option the policy does not know (`maxcalls`, a typo) throws a `TypeError` from `createGuard`, so a misspelt cap cannot quietly do nothing. `repeatThreshold` and `polling` have no effect when `repeatedToolCall` is `false`; `maxCalls` and `ignore` still work.

### Catch repeats that are not consecutive

```ts
import { createGuard } from '@osama.ansar/agent-loopguard';

const guard = createGuard({
  repeatedToolCall: { window: { size: 10, maxRepeats: 3 } }, // the same call 3 times among the last 10
});
// search(x), read(a), search(x), read(b), search(x)  ->  stops on the third search(x)
```

The default `repeatedToolCall` rule only sees a call repeated back to back, so an agent that goes `search(x)`, `read(a)`, `search(x)`, `read(b)`, `search(x)` is never stopped by it, and `oscillation` only finds fixed cycles of at most `maxPeriod` calls. `window` counts how often each call (tool plus canonically-equal arguments) occurs among the newest `size` tool calls and stops when one reaches `maxRepeats`. It is off unless you set it.

- **Values.** `size` is an integer from 2 to 1000 (`MAX_WINDOW_SIZE`; anything else throws a `TypeError` from `createGuard`), `maxRepeats` an integer from 2 to `size`. `{ size: 10, maxRepeats: 3 }` is a reasonable place to start, not a tuned value: a repeat that is `size` or more calls away from the others is not seen, and a small `maxRepeats` flags agents that legitimately re-read the same file. Count the calls of a normal step in your agent (parallel calls count one by one) before choosing `size`.
- **Counting.** The calls are the same ones the consecutive rule reads: flattened across steps and parallel calls, ignored tools left out, failed calls left out with `ignoreErrors`. Consecutive repeats count towards the window too, so `maxRepeats` below `threshold` makes the window the stricter rule. When both stop at once the consecutive rule is the one reported.
- **Per-tool policies.** `ignore` takes a tool out of the window. A `polling` tool (or `requireIdenticalResults`) is counted by call and result, so only identical results repeat. A tool's `repeatThreshold`, or a polling tool's `maxIdenticalResults`, replaces `maxRepeats` for that tool, exactly as it replaces `threshold` for the consecutive rule; a number above `size` can never be reached. `maxCalls` is independent.
- **The stop.** `reason: 'repeated-tool-call-window'`, `code: 'REPEATED_TOOL_CALL_WINDOW'`, evidence `{ tool, argsPreview, count, threshold, windowSize, windowCalls, identicalResults }`. It is a new reason rather than a new shape under `repeated-tool-call`, so code that narrows on `'repeated-tool-call'` keeps its types. It has `feedback` like every other fault.
- **Preflight.** A call that would be the `maxRepeats`-th occurrence in the window is refused before it runs (the window slides as parallel calls are added). As for the consecutive rule, result-aware cases cannot be judged before the result exists, so `preflight` never refuses on them.
- **Cost.** Memory is bounded by `size` (one 28-character hash per call) and each call costs O(1). A snapshot grows by about 31 bytes per slot: measured 30,690 extra bytes at `size: 1000` and about 300 at `size: 10`.

### Early warnings

```ts
import { createGuard } from '@osama.ansar/agent-loopguard';

const guard = createGuard({ warnings: true });

const verdict = guard.check(step);
if (!verdict.stop) {
  for (const warning of verdict.warnings ?? []) {
    messages.push({ role: 'user', content: warning.feedback }); // "...once more will stop this task..."
  }
}
```

A warning is a non-blocking note on a verdict (`{ stop: false, warnings: [...] }`, or next to a stop) raised one step before a rule would stop the run, so the model can change course while it still has room. Budgets have always had them (`budget.warnAt`); `warnings: true` adds them for the loop rules:

| `code` | Raised when | Default level | Option |
| --- | --- | --- | --- |
| `REPEATED_TOOL_CALL_WARNING` | the run of identical calls is one short of the limit that applies to the tool | `threshold - 1` | `repeatedToolCall.warnAt` |
| `REPEATED_TOOL_CALL_WINDOW_WARNING` | a call the step added is one short of `maxRepeats` in the window | `maxRepeats - 1` | `repeatedToolCall.window.warnAt` |
| `OSCILLATION_WARNING` | the cycle at the end of the sequence has been seen one time short of `repeats` | `repeats - 1` | `oscillation.warnAt` |
| `NO_PROGRESS_WARNING` | the stalled streak is one short of `threshold` | `threshold - 1` | `noProgress.warnAt` |
| `TOOL_CALL_CAP_WARNING` | a capped tool has been called `maxCalls - 1` or `maxCalls` times (the next call over the cap stops) | `maxCalls - 1`, at least 1 | `tools.<name>.warnAt` |

- **Default: off.** With default-on, 3 of the 682 assertions of 0.2.0 fail (they expect `preflight` to return exactly `{ allow: true }` on the call before a repeat is refused), and every verdict of code written against 0.2.0 could gain a `warnings` field it never saw. So `warnings: true` is opt-in. `warnings: false` is a kill switch for every warning, budget warnings included. A rule with its own `warnAt` number warns even without `warnings: true`; `warnAt: false` turns one rule off under `warnings: true`.
- **Levels.** `warnAt` is the count at which a rule starts warning: an integer from 2 (from 1 for caps) up to one below its limit (up to `maxCalls` for caps). A rule that has no step before its stop (`threshold: 2`) never warns, and a `warnAt` that cannot be reached throws a `TypeError` from `createGuard`. The warning is raised on every step from that level until the rule stops, not just once.
- **When.** A warning is raised on a step that adds to what it warns about: a counted call to that tool, a call that continues the cycle, one more stalled step. A text-only step after a warning carries none, and ignored tools never raise one.
- **Shape.** `{ code, detail, feedback, evidence }`. `evidence` has the shape of the matching stop's, with the counts still below the limit. `detail` is for developers and shows an argument preview; `feedback` follows the same privacy rule as stop feedback (fixed words, counts and a safe tool name, never arguments, results or text). `feedbackForWarning(warning)` returns the model-facing text for any warning, budget warnings included (those have no `feedback` field, to keep their 0.2.0 shape).
- **Preflight.** `guard.preflight(call)` returns the warnings the call would carry (`{ allow: true, warnings }`), in the same order as `check`, except `NO_PROGRESS_WARNING`, which needs a finished step.
- **Snapshots.** Warnings are derived from state that is already in the snapshot, and `warnAt` never changes a stop, so it is not part of the options fingerprint: a run may be restored with different warning settings.

### Check a call before it runs

```ts
import { createGuard } from '@osama.ansar/agent-loopguard';

const guard = createGuard({ tools: { search: { maxCalls: 5 } } });

const executed = [];
for (const call of modelToolCalls) {                        // [{ name, args }]
  const pre = guard.preflight(call);
  if (!pre.allow) {
    toolMessages.push({ toolCallId: call.id, content: pre.feedback }); // tell the model; do not run the tool
    continue;
  }
  executed.push({ name: call.name, args: call.args, result: await runTool(call) });
}

// After the step, record what really happened, exactly as before.
const verdict = guard.check({ text, toolCalls: executed, finishReason, usage });
```

`guard.preflight(call)` answers "if I run this call now, would it immediately trip a rule?". It records nothing and changes nothing, so you can ask as often as you like. It returns `{ allow: true, warnings? }` or `{ allow: false, reason, code, detail, evidence, feedback }`, using the same `reason` and `code` as a verdict. Pass an array to ask about parallel calls in one turn (`guard.preflight([a, b])`); an array is judged as one step, whereas asking about calls one at a time cannot see the calls of the same turn, which are not recorded yet.

What it can and cannot judge, because a call that has not run yet has no result, text, finish reason or usage:

| Rule | In `preflight`? |
| --- | --- |
| `budget` | Yes, when a limit is already reached (the totals so far; the wall clock for a duration limit). Budget warnings come back on an allowed call. |
| `maxSteps` | Yes, when the limit is already reached. |
| `tools.<name>.maxCalls` | Yes: the call after the Nth is refused. |
| `repeatedToolCall` | Yes, for the default rule: the call that would be the Nth identical one in a row. **No** for result-aware rules (`requireIdenticalResults`, `polling` tools): they cannot be judged before the result is known, so `preflight` never refuses on them (it may be right to run the call: the result might be new). `check` still stops them once the identical outcomes are in. |
| `repeatedToolCall.window` | Yes, by call: the call that would be the `maxRepeats`-th in the window. Not for result-aware cases, as above. |
| `oscillation` | Yes: the call that would complete the cycle. |
| `noProgress`, `finishReason`, `custom` | No. They need the finished step (or your code), so only `check` runs them. |

A tool with `ignore: true` skips the call-pattern rules in `preflight` too, but `budget` and `maxSteps` still apply to it. When several rules would refuse, the first in this order wins: budget, max steps, tool limit, repeated call, oscillation. `preflight` says nothing about a guard whose last verdict was already a stop; acting on that is up to you.

A refused call never ran, so leave it out of the step you pass to `check`. The step still counts towards `maxSteps`, and if the model keeps asking for the refused call, `maxSteps` ends the run (and `noProgress`, if its text repeats too). Recording a refused call as if it had run would make the repeat rule fire on the refusal itself.

### Tell the model what went wrong

```ts
const verdict = guard.check(step);
if (verdict.stop && verdict.feedback) {
  messages.push({ role: 'user', content: verdict.feedback }); // let the model change course or wrap up
}
```

Every stop verdict that is a fault (`isFault(verdict)`) has a `feedback` string: a few plain sentences, different for each `code`, the same every time, written to be pasted into the model's next turn or a tool result. For example, for `REPEATED_TOOL_CALL`:

> You have called `search` 3 times in a row with the same arguments. Repeating it is unlikely to give you anything new. Try a different tool or different arguments, or answer with what you have.

Those words are the whole message: it is built from fixed text, counts and limits, and the tool **name**. It never repeats arguments, results, model text or provider strings, because those can hold secrets or personal data and this text is meant to be sent to a model (and ends up in logs and transcripts). `explain()` and `verdict.detail` are the developer's view and do show an argument preview. A tool name is only used if it looks like an ordinary identifier (letters, digits, `_ . : / -`, up to 64 characters); the model chooses names, so anything else is replaced by "that tool". A normal `stop` finish has no `feedback`, and neither does a custom verdict unless the detector supplies one.

```ts
import { createGuard, feedbackFor } from '@osama.ansar/agent-loopguard';

const guard = createGuard({
  // Return a string to replace the text, or undefined to keep the default.
  feedback: (verdict, { phase }) =>
    verdict.code === 'MAX_STEPS' ? 'Out of steps. Summarise what you found.' : undefined,
});
// feedbackFor(verdict) returns the default text for any verdict (or undefined when there is none).
```

`phase` is `'check'` for a verdict from `check` and `'preflight'` for a refused call, whose default wording differs ("That call was not run: ..."). `feedback` is called only for faults; if it throws, the error propagates out of `check` / `preflight`. Keeping your own text free of secrets is up to you.

### Save and resume a run

```ts
import { createGuard } from '@osama.ansar/agent-loopguard';

const options = { maxSteps: 40, tools: { search: { maxCalls: 8 } } };

// In the first process: JSON.stringify(guard) is guard.toJSON().
await store.set(`run:${runId}`, JSON.stringify(guard));

// Later, in another process: pass the same options.
const guard = createGuard.fromJSON(JSON.parse(await store.get(`run:${runId}`)), options);
```

The restored guard goes on exactly where the original stopped: given the same steps it returns the same verdicts and the same summaries (this is checked by a differential test that cuts random runs at random points, through `structuredClone` and through a JSON round trip). `restoreGuard` is the same function as `createGuard.fromJSON`.

- **What a snapshot holds.** Version number, step and call counters, running totals, the wall-clock time used so far (only when there is a duration budget), tool names, hashes of recent calls and outcomes, and a few previews of at most 80 characters of recent arguments and text, kept so that evidence and messages read the same after a restore. **What it does not hold:** raw arguments, results, errors, model text, the step history, the options, the last verdict. Hashes are not cryptographic; a short, guessable value could be recovered by hashing candidates, so treat a snapshot as run data, not as public. `guard.snapshot({ redact: true })` replaces the previews with `[redacted]`: stop decisions stay the same, but evidence for calls made before the snapshot says `[redacted]`.
- **Size.** Bounded by the options, not by the length of the run: the oscillation detector keeps `maxPeriod` calls, the no-progress detector the newest 1024 distinct outcomes (about 31 bytes each), the repeat detector one run, plus `window.size` call hashes (about 31 bytes each) when you set a window. Measured with default options: 831 bytes for a fresh guard, and 33,088 bytes after 1,500 or 6,000 steps that each had a new 2 KB argument, a 3 KB result and 500 characters of text (it stops growing once 1024 outcomes are remembered); raising `oscillation.maxPeriod` to 50 made it 39,292 bytes. Tool names over 256 characters are cut in the snapshot.
- **Options are not stored; they are fingerprinted.** Functions cannot be saved, so you pass the options again. The snapshot records one fingerprint per group of options (`maxSteps`, `repeatedToolCall`, `oscillation`, `noProgress`, `finishReason`, `budget`, `tools`, and the number of `custom` detectors), and restoring under different options throws a `TypeError` that names the groups, instead of silently behaving differently. Not fingerprinted: `now`, `feedback` and what your custom detectors do. To give a run that hit its limit more room, pass `{ allowLimitChanges: true }` as the third argument: then `maxSteps` and `budget` may differ (and only those).
- **History.** The raw steps are not in a snapshot, so a restored guard starts with an empty `history`, and custom detectors see only the steps recorded since the restore. `summary().steps` and the detectors keep counting across the restore. `summary().lastVerdict` is `null` until the first `check`.
- **Wall-clock budgets.** The time used so far is stored as a duration, so the time between saving and restoring is not counted.
- **Bad snapshots.** An unknown version, a wrong shape, an impossible number or a hostile object (throwing getter, revoked proxy, `__proto__` keys) throws a `TypeError` from `fromJSON`, never a crash later from `check`. Unknown extra keys are ignored.

## What it does not do

- **No semantic loop detection.** It compares tool names, arguments, results and text after normalisation. A model that rewords its text and varies one argument slightly each time is not detected, and no embedding or LLM is involved.
- **No cost table.** It never estimates tokens or prices. Token and cost limits only work on the numbers you pass in `usage`; if you supply no `costUsd`, a `maxCostUsd` limit can never fire.
- **No LLM calls and no network.** It is plain, synchronous code.
- **It does not run your agent.** `runAgentLoop` is a ten-line convenience, not a framework.
- **It does not cancel in-flight work.** A verdict is advice; stopping is up to the caller (`runAgentLoop` and `toStopWhen` do it for you at step boundaries).
- **Defaults are not benchmarked.** Thresholds such as "3 in a row" are conventions, not measured optima. Check them against your own traces.
- **History is kept in memory** for the life of the guard (`reset()` clears it). It is cheap for a normal run but is not designed for unbounded sessions. The detectors themselves keep bounded state; only `guard.history` (the raw steps) grows.
- **`preflight` is not a full check.** It cannot see results, text, finish reasons or usage, so it never replaces `check`; see the table above for exactly what it judges. It does not cancel or wrap your tool calls either: it only answers, and you decide.
- **A snapshot is not a transcript.** It cannot rebuild `history`, and it does not store your options (only their fingerprints).

## How detection works

Steps are reduced to comparable facts once, when `check` is called. Anything unusable (a non-string finish reason, `NaN` token counts, a throwing getter) is ignored rather than thrown on.

**Canonical form.** Arguments and results are turned into a deterministic string so equal values compare equal: object keys are sorted; properties whose value is `undefined` are omitted (like JSON); array order is kept; `NaN`, `Infinity` and bigint (`10n`) stay distinct from strings and numbers that print alike; `-0` equals `0`; Dates are written as ISO strings; Maps and Sets are sorted by their entries; objects with `toJSON` (URL, ...) are written by calling it; a reference back to an ancestor is written `[Circular:<depth>]`; nesting deeper than 64 levels and inputs of more than 200,000 values are cut off with a marker (so two huge values that agree on everything before the cut compare equal). If reading a value throws (hostile getters, revoked proxies), it gets a unique placeholder and is never equal to anything. Equality is decided on a fixed-length hash of the canonical form (two independent 53-bit hashes, 28 hex characters; for forms longer than 256 characters the length is folded in first), so detector state and snapshots hold hashes, not raw values. The hash is non-cryptographic and meant for equality checks, not security.

**Call sequence.** "A call" is one entry of `toolCalls`. `repeatedToolCall` and `oscillation` read the flattened sequence of calls across steps, in order (calls of a tool with `ignore: true` are removed from it first, so they neither extend nor break a run). Parallel calls in one step count one by one; steps with no tool calls neither extend nor break a run. A call's signature is its tool name plus the canonical arguments. Its outcome signature adds the canonical result or error (or, if neither was supplied, is just the call).

**Early warnings.** Computed after the detectors have seen a step, from the same state they stop on: the run, the window counts, the cycle counters, the streak and the tool counts. A rule that stops in the step does not also warn.

**`maxSteps`.** Stops when `limit` steps have been recorded. With `maxSteps: 3` the third `check` stops.

**`tools.<name>.maxCalls`.** Counts every call to the tool in the run (across steps, whatever the arguments or results) and stops on the first call beyond the cap: with `maxCalls: 3` the fourth call stops, with `maxCalls: 0` the first does. With parallel calls in one step, the first call over the cap is the one reported. Ignored tools are never counted. It keeps stopping on every later step that calls the tool, like the other rules.

**`repeatedToolCall`.** Stops when the run of identical signatures at the end of the sequence reaches `threshold` (exactly N stops, N-1 does not). With `requireIdenticalResults`, identical means identical outcome signature, so polling a job whose status keeps changing is not a repeat. With `ignoreErrors`, calls with a non-null `error` are removed from the sequence before counting. A run that reaches the threshold in the middle of a step still counts if a later call in the same step ends it. A tool's `repeatThreshold` replaces the threshold for runs of that tool; a `polling` tool compares outcomes like `requireIdenticalResults` does, with its own threshold; the evidence reports the threshold and `identicalResults` that applied.

**`repeatedToolCall.window`.** Keeps the keys (call hashes) of the newest `size` counted calls in a ring buffer with a count per key. Each counted call is added, the oldest one drops out once the window is full, and the rule stops when the added call's key reaches its threshold (`maxRepeats`, or the tool's own number, see above). A run that reaches the threshold in the middle of a step still counts if a later call in the same step slides it out.

**`oscillation`.** For each period `p` from 2 to `maxPeriod`, looks at the end of the call-signature sequence: it stops when the last `p` calls repeat for `repeats` full cycles in a row (`a b a b a b` is period 2, three cycles). A cycle made of one distinct call (`a a a a a a`) is not an oscillation; that is `repeatedToolCall`'s case. Results are not considered.

**`noProgress`.** A step is *stalled* when none of its tool outcomes is new in this run (a step without tool calls is always stalled). It stops after `threshold` consecutive stalled steps that all have the same normalised text (lower-cased, whitespace collapsed; an empty string counts as text, so tool-only steps are judged on outcomes alone). A new outcome, or different text, restarts the count. Because outcomes include the result, the same call returning a new result is progress. Calls of `ignore` tools are not outcomes, so a step that only calls them is stalled. The detector remembers the newest 1024 distinct outcomes; in a run with more than that, an outcome older than the window counts as new again (this bounds memory and snapshot size).

**`finishReason`.** Finish reasons are normalised (trimmed, lower-cased, `_` becomes `-`). Then: a reason in `terminal` stops, even if tool calls are present; `tool-calls` continues; a missing reason says nothing; anything else (`other`, `unknown`, any unfamiliar string) follows `otherPolicy`: `'stop'` stops, `'continue'` continues, `'stop-if-text-only'` (default) stops when the step has non-blank text and no tool calls.

Why the default exists: some frameworks only treat `stop` as "finished". If a provider ends a final, text-only answer with an unfamiliar reason, those frameworks see "not finished" and re-send the same request until the step limit, paying for the same answer again and again. A text-only step that is not a clean stop is the signature of that, so the guard ends the run there. A normal `stop` also produces a stop verdict (the run is over); use `isFault(verdict)` to tell that apart from a problem.

**`budget`.** Totals are summed from the steps: input, output and total tokens (total falls back to input plus output when a step gives none), `costUsd`, and `durationMs`. Numbers that are not finite and non-negative are ignored. A limit is *spent when reached* (`value >= limit`): the guard runs after a step has happened, so waiting for "exceeded" would always overshoot by a step. `maxDurationMs` compares against the larger of the summed `durationMs` values and the wall-clock time since the guard was created or reset (read from the injectable `now()`, so tests can control it). With `warnAt` (a ratio between 0 and 1, per limit or shared), a step that is at or past that fraction but below the limit returns `{ stop: false, warnings: [...] }`; the warning repeats on every step while it applies.

**Priority.** All detectors see every step (so their state stays consistent), and the first stop wins in this order: finish reason, budget, max steps, tool limit, repeated tool call (the consecutive rule, then the window), oscillation, no progress, custom. The tool limit sits after the step and budget limits (all explicit caps) and before the pattern detectors, because a cap you set is a harder rule than a heuristic. `preflight` uses the same order for the rules it can judge. Detectors overlap: a perfectly repeating `a b a b a` with identical results and empty text is reported by `noProgress` a step before `oscillation` would fire.

## API reference

### `createGuard(options?: GuardOptions): Guard`

```ts
interface GuardOptions {
  maxSteps?: number | false;                          // default 50
  repeatedToolCall?: {
    threshold?: number; requireIdenticalResults?: boolean; ignoreErrors?: boolean; warnAt?: number | false;
    window?: { size: number; maxRepeats: number; warnAt?: number | false } | false;   // size 2..1000, maxRepeats 2..size; default off
  } | false;
  oscillation?: { maxPeriod?: number; repeats?: number; warnAt?: number | false } | false;
  noProgress?: { threshold?: number; warnAt?: number | false } | false;
  finishReason?: { terminal?: readonly string[]; otherPolicy?: 'stop' | 'continue' | 'stop-if-text-only' } | false;
  budget?: {
    maxTotalTokens?: BudgetLimit; maxInputTokens?: BudgetLimit; maxOutputTokens?: BudgetLimit;
    maxCostUsd?: BudgetLimit; maxDurationMs?: BudgetLimit;
    warnAt?: number;                                  // default warning ratio
  } | false;                                          // BudgetLimit = number | { limit: number; warnAt?: number }
  warnings?: boolean;                                 // early warnings for the loop rules; default off, false silences all
  tools?: Record<string, ToolPolicy>;                 // per-tool rules, below
  custom?: CustomDetector | readonly CustomDetector[];
  feedback?: (verdict: StopVerdict, info: { phase: 'check' | 'preflight' }) => string | undefined;
  now?: () => number;                                 // default Date.now
}

interface ToolPolicy {
  polling?: boolean | { maxIdenticalResults?: number };   // integer >= 2
  maxCalls?: number;                                      // integer >= 0
  warnAt?: number | false;                                // 1..maxCalls; needs maxCalls
  repeatThreshold?: number;                               // integer >= 2
  ignore?: boolean;
}

interface Guard {
  check(step: GuardStep): Verdict;
  preflight(call: PreflightCall | readonly PreflightCall[]): Preflight;   // would this call trip a rule? changes nothing
  reset(): void;                                      // forget the run, keep the options
  summary(): GuardSummary;                            // counts, totals, per-detector state; JSON-serialisable
  toJSON(): GuardSnapshot;                            // save the run; JSON.stringify(guard) uses it
  snapshot(options?: { redact?: boolean }): GuardSnapshot;
  readonly history: readonly GuardStep[];             // frozen shallow copy (empty after a restore)
}

// Rebuild a guard from a snapshot. `snapshot` may be the result of JSON.parse; `restoreGuard` is the same function.
createGuard.fromJSON(snapshot: unknown, options?: GuardOptions, restore?: { allowLimitChanges?: boolean }): Guard;
```

Invalid options (a threshold below 2, a non-positive limit, a `warnAt` outside 0 to 1, a misspelt tool policy, ...) throw a `TypeError` from `createGuard`. `check` and `preflight` do not throw on odd step or call data.

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
  | { stop: true; reason: StopReason; code: string; detail: string; evidence: /* depends on reason */; feedback?: string; warnings?: GuardWarning[] };

type StopReason = 'max-steps' | 'tool-limit' | 'repeated-tool-call' | 'repeated-tool-call-window' | 'oscillation' | 'no-progress' | 'finish-reason' | 'budget' | 'custom';
```

`verdict.reason` narrows `verdict.evidence` in TypeScript. Verdicts are plain JSON.

| `reason` | `code` | `evidence` |
| --- | --- | --- |
| `max-steps` | `MAX_STEPS` | `{ steps, limit }` |
| `tool-limit` | `TOOL_CALL_CAP` | `{ tool, calls, limit }` |
| `repeated-tool-call` | `REPEATED_TOOL_CALL` | `{ tool, argsPreview, count, threshold, stepIndexes, identicalResults }` |
| `repeated-tool-call-window` | `REPEATED_TOOL_CALL_WINDOW` | `{ tool, argsPreview, count, threshold, windowSize, windowCalls, identicalResults }` |
| `oscillation` | `OSCILLATION` | `{ period, repeats, threshold, cycle, tools }` |
| `no-progress` | `NO_PROGRESS` | `{ steps, threshold, textPreview }` |
| `finish-reason` | `FINISH_TERMINAL`, `FINISH_OTHER`, `FINISH_OTHER_TEXT_ONLY` | `{ finishReason, normalized, policy, hasText, toolCallCount }` |
| `budget` | `BUDGET_TOTAL_TOKENS`, `BUDGET_INPUT_TOKENS`, `BUDGET_OUTPUT_TOKENS`, `BUDGET_COST_USD`, `BUDGET_DURATION_MS` | `{ metric, value, limit }` |
| `custom` | your `code` (default `CUSTOM`) | whatever you return |

A budget warning is `{ code: 'BUDGET_WARNING', metric, value, limit, ratio, detail }`; the loop warnings (see [Early warnings](#early-warnings)) are `{ code, detail, feedback, evidence }`. `GuardWarning` is the union of them, discriminated by `code`; `metric`, `value`, `limit` and `ratio` are typed `undefined` on the loop warnings so that code reading them compiles as before. `feedback` is present on every fault verdict from a built-in detector (see [Tell the model what went wrong](#tell-the-model-what-went-wrong)).

### Helpers

- `explain(verdict): string`: readable text for logs, including a short hint and any warnings.
- `isFault(verdict): verdict is StopVerdict`: true for a stop that is not just the model finishing normally with `stop`.
- `feedbackForWarning(warning): string`: the model-facing text of any warning (the `feedback` of a loop warning, fixed wording for a budget warning).
- `feedbackFor(verdict, phase?: 'check' | 'preflight'): string | undefined`: the default model-facing text for a verdict (what `verdict.feedback` holds unless you override it). `undefined` for a normal `stop` finish and for a custom verdict that brings no text.
- `canonicalize(value): string` and `stableHash(value): string`: the comparison primitives, exported because they are useful on their own.
- `restoreGuard(snapshot, options?, { allowLimitChanges? }?): Guard`: the same function as `createGuard.fromJSON`.

### `Preflight`

```ts
type Preflight =
  | { allow: true; warnings?: GuardWarning[] }
  | { allow: false; reason: 'max-steps' | 'budget' | 'tool-limit' | 'repeated-tool-call' | 'repeated-tool-call-window' | 'oscillation';
      code: string; detail: string; evidence: /* as for the same reason in a verdict */; feedback: string };
```

`reason` narrows `evidence` as it does for a verdict. `detail` is for developers and may quote an argument preview; `feedback` is for the model and never does. The evidence of a refused repeat or cycle is what `check` would report for the same call (the counts include the call that was refused). See [Check a call before it runs](#check-a-call-before-it-runs) for what is judged.

### `GuardSnapshot`

```ts
interface GuardSnapshot {
  version: 1;
  steps: number; toolCalls: number; failedToolCalls: number;
  totals: GuardTotals;
  wallClockMs: number | null;       // only with a duration budget
  options: { maxSteps: string; repeatedToolCall: string; oscillation: string; noProgress: string;
             finishReason: string; budget: string; tools: string; custom: string };   // fingerprints
  detectors: { repeatedToolCall; oscillation; noProgress; finishReason; toolLimits };   // each null when that detector is off
}
```

Plain JSON-safe data. The shape of each detector's state is exported as a type (`RepeatedToolCallSnapshot`, `OscillationSnapshot`, `NoProgressSnapshot`) but is an implementation detail: treat a snapshot as opaque and only pass it to `createGuard.fromJSON`. See [Save and resume a run](#save-and-resume-a-run).

### Adapters

- `toStopWhen(guardFactory | options, { onStop }?)`: returns `({ steps }) => boolean`, usable as an AI SDK `stopWhen` condition. Idempotent (see above). Only the verdict for the latest step counts. Because it replays steps in a fresh guard, a wall-clock `maxDurationMs` is meaningless there; step durations (`performance.stepTimeMs`) are used instead.
- `toGuardStep(aiSdkStep): GuardStep`: the mapping `toStopWhen` uses (tool results and `tool-error` content parts are matched to calls by `toolCallId`).
- `runAgentLoop({ step, guard?, signal?, onVerdict? }): Promise<{ steps, verdict, completed, aborted }>`. `completed` is true when the agent ended the run itself (a final step with no fault, or a normal `stop`), false when the guard cut it short, the finish reason was something like `length` or `error`, or the signal aborted. The signal is checked before every step; an in-flight step is not cancelled.
- `withGuard(source, guard): AsyncIterable<step> & { verdict }`: wraps a sync or async iterable.

## Related work

[`agent-loop-guard`](https://www.npmjs.com/package/agent-loop-guard) (by Nextbridge) is a similar, independent library, and a good one to look at. Going by its 0.2.0 README, it wraps each tool call in `beforeCall()` / `afterCall()` (with `run()` to wrap your executor and `afterError()` for thrown errors), and offers a call budget with per-tool ceilings and a wall-clock limit, windowed repeat detection for repeats that are not consecutive, early warnings before a limit is hit, `toJSON()` / `fromJSON()` state, a `report()` text you can paste into the model's context, and blocked decisions that carry a suggestion phrased for the model.

Since 0.2.0 this package covers some of the same ground: `preflight` (a check before a call runs), per-tool call caps, save and resume, and model-facing `feedback`. What is still different, as far as the two READMEs say:

- **Shape.** Here you pass in each finished step to `check`. `preflight` is a read-only question about a call that has not run; there is no `beforeCall` / `afterCall` pairing and no `run()` wrapper, and `preflight` cannot judge rules that need the result (see above). In the other library the pair is the whole API.
- **What this one has that its README does not describe.** A finish-reason policy (for example, ending a run when a text-only step finishes with an unfamiliar reason), token, cost and duration budgets driven by the usage numbers you report (its README describes call-count and wall-clock budgets), a no-progress rule on repeated text, per-tool `polling` and `ignore` policies, a custom-detector hook, a `stopWhen` adapter for the Vercel AI SDK that is tested against the real SDK, and CommonJS as well as ESM builds (its README says it is ESM-only).
- **What the other one has that this one does not.** `run()`, `report()`, windowed repeat detection (here only consecutive repeats and short cycles are detected), early warnings before a repeat, stagnation or call-budget limit is reached (here only budgets warn), cycle detection that compares results as well as calls (here `oscillation` ignores results), custom signature functions, and an `onDecision` hook.
- **Saved state.** In both, options are not stored. Here a snapshot also carries a fingerprint of the options and restoring under different ones throws; it is bounded by the options rather than by the run (it remembers only the newest 1024 distinct outcomes), and it holds hashes plus a few short previews. Its README says its snapshot grows with the number of distinct calls in a run.

Both have zero runtime dependencies. Pick whichever fits how your loop is written; nothing stops you from using the other one's ideas.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test                  # npm run test:coverage for coverage
npm run build
npm run example:loop
npm run example:preflight # preflight, feedback, per-tool policies and save/resume, offline
npm run example:warnings  # windowed repeats and early warnings, offline
npm run example:ai-sdk    # Node >= 22 (needs the `ai` dev dependency)
```

The package supports Node 18 and newer. The development toolchain (vitest, tsup) and the AI SDK integration test need a newer Node; CI runs Node 20, 22 and 24.

### Releasing

Publishing is done from a GitHub Release by `.github/workflows/publish.yml`, which publishes with npm provenance. It needs a repository secret named `NPM_TOKEN` (an npm automation token for an account allowed to publish `@osama.ansar/agent-loopguard`). Bump the version in `package.json` and `CHANGELOG.md`, tag, and create a Release.

## License

MIT
