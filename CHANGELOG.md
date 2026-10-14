# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-15

Backwards compatible for code that uses the package: with the 0.2.0 options, verdicts and summaries are what they were, and snapshots differ only by one new optional entry (see Notes). Every addition is opt-in. See Notes for the type-level changes.

### Added

- **Windowed repeat detection.** `repeatedToolCall: { window: { size, maxRepeats } }` stops when the same call (tool plus canonically-equal arguments) occurs `maxRepeats` times among the newest `size` calls, however many other calls came in between (`search(x)`, `read(a)`, `search(x)`, `read(b)`, `search(x)`). `size` is 2 to 1000 (`MAX_WINDOW_SIZE`), `maxRepeats` 2 to `size`. New stop reason `'repeated-tool-call-window'`, code `REPEATED_TOOL_CALL_WINDOW`, evidence `{ tool, argsPreview, count, threshold, windowSize, windowCalls, identicalResults }`. Honours `ignore`, `polling`, `requireIdenticalResults` and `ignoreErrors`; a tool's `repeatThreshold` or `polling.maxIdenticalResults` replaces `maxRepeats` for that tool. `preflight` refuses the call that would be the `maxRepeats`-th occurrence. Memory is bounded by `size`.
- **Early warnings** for the loop rules, one step before they stop the run: `REPEATED_TOOL_CALL_WARNING`, `REPEATED_TOOL_CALL_WINDOW_WARNING`, `OSCILLATION_WARNING`, `NO_PROGRESS_WARNING` and `TOOL_CALL_CAP_WARNING`, each with `detail`, model-safe `feedback` and `evidence`. Opt in with `warnings: true`; `warnAt` on a rule (and on a tool policy, for `maxCalls`) sets its level and turns it on; `warnAt: false` turns one rule off; `warnings: false` silences every warning, budget warnings included. `preflight` returns the warnings an allowed call would carry. New `feedbackForWarning(warning)`.
- **`guard.report()`**: a short, deterministic, model-safe status block (steps, calls per tool, the warnings of the last verdict, the last stop); `guard.report({ format: 'json' })` returns the same facts as a `GuardReport`. Calls per tool are bounded (32 names counted by name, the rest summed).
- **`onDecision({ phase, verdict })`** option, called after every `check` and `preflight`. It gets a copy; what it throws (or rejects with) is swallowed; calling `check`, `preflight` or `reset` on the same guard from inside it throws an `Error` and leaves the guard untouched.
- **Custom signature functions**: `signature(toolName, args)`, `resultSignature(result)` and `errorSignature(error)` choose the fields that decide whether two calls, results or errors are the same. A function that throws or returns a non-string falls back to the default canonical form and is counted in `summary().signatures`. The options fingerprint records which are set.
- **`createToolRunner(guard, options?)`**: `run(name, args, executor)` asks `preflight` (counting the calls already started in the step), runs the executor if allowed and remembers the call; a refused call is not run and not recorded and comes back as `{ ran: false, denied }` with the model-safe feedback. `endStep(meta)` builds the step, calls `check` and clears the buffer. Errors are returned unless `rethrow: true`; parallel calls are judged together and recorded in start order; `signal` stops new calls from starting.
- **`oscillation: { includeResults: true }`**: a cycle only counts when the same results or errors come back each time.
- New exported types: `RepeatedToolCallWindowOptions`, `RepeatedToolCallWindowEvidence`, `RepeatedToolCallWindowVerdict`, `RepeatedToolCallWindowSnapshot`, `BudgetWarning`, `RepeatedToolCallWarning`, `RepeatedToolCallWindowWarning`, `OscillationWarning`, `NoProgressWarning`, `ToolLimitWarning`, `WarningCode`, `DecisionEvent`, `GuardReport`, `ReportOptions`, `ToolTallySnapshot`, `ToolRunner`, `ToolRunnerOptions`, `ToolRunOutcome`, `StepMeta`. New values: `MAX_WINDOW_SIZE`, `feedbackForWarning`, `createToolRunner`.
- Examples `examples/window-and-warnings.ts` (`npm run example:warnings`) and `examples/tool-runner.ts` (`npm run example:runner`), run in CI.

### Changed

- Nothing that changes behaviour with the 0.2.0 options. `warnAt` was added to `ToolPolicy`, and tool policies still reject options they do not know.

### Notes

- **Widened unions.** `StopReason` gains `'repeated-tool-call-window'`, `BuiltinStopCode` gains `'REPEATED_TOOL_CALL_WINDOW'`, `StopVerdict` gains `RepeatedToolCallWindowVerdict`, and `PreflightDeny` / `PreflightStopVerdict` gain the matching members. A TypeScript `switch` over `verdict.reason` or `verdict.code` that has no `default` and relies on exhaustiveness will stop compiling until you add a case. The new reason only appears if you set `window`. It is a new reason, not a new shape under `'repeated-tool-call'`, so code that narrows on the old reason keeps its types.
- **`GuardWarning` is now a union**, discriminated by `code`: `BudgetWarning` (the 0.2.0 shape, unchanged at run time) and the loop warnings. `metric`, `value`, `limit`, `ratio` and `feedback` are declared as `undefined` on the members that do not have them, so code that reads `warning.value` still compiles, but their types are now `T | undefined` unless you narrow on `code`. The loop warnings only appear with `warnings: true` or an explicit `warnAt`.
- **Warnings are off by default.** With default-on, 3 of the 682 assertions in the 0.2.0 test suite fail (`preflight` returning exactly `{ allow: true }` on the call before a repeat), and verdicts would gain a `warnings` field for code that never saw one.
- **`Guard` has a new method, `report`.** Code that implements the `Guard` interface itself (a test double, say) needs it.
- **Snapshots stay at `version: 1`; the new state is additive.** Apart from the new `callsByTool` entry, the snapshot of a guard that uses none of the new features is what 0.2.0 wrote (checked against fixtures generated by the published 0.2.0, see `test/fixtures`), and snapshots from 0.2.0 restore and continue with identical verdicts and summaries. Three optional entries were added: `detectors.repeatedToolCall.window` (only with a window; the window also changes the `repeatedToolCall` fingerprint, so 0.2.0 refuses such a snapshot and the reverse), `options.signatures` (only with a signature function) and `callsByTool` (once a call has been recorded; 0.2.0 ignores it). For a run resumed from a 0.2.0 snapshot, `report()` counts calls per tool from the restore on (`steps` and `toolCalls` carry over). The warning settings, `onDecision` and the signature functions' code are not fingerprinted; a window, `oscillation.includeResults` and the *presence* of signature functions are.
- A window holds one 28-character hash per slot (about 31 bytes in the JSON). Measured with 3000 distinct calls, a snapshot with `size: 1000` was 30,690 bytes larger than one with `size: 10`.
- `toStopWhen` replays every step in a fresh guard on each call, so a stateful `signature` function or an `onDecision` hook is called for the replays too.
- Tested offline only: nothing here has been tried against a real provider beyond the existing AI SDK integration test, and the tool runner has only been exercised with fake tools.

## [0.2.0] - 2026-10-14

Backwards compatible for code that uses the package. See Notes for the type-level changes and the one run-time edge case.

### Added

- `guard.preflight(call)` (also accepts an array of parallel calls): asks whether running a tool call now would immediately trip a rule, without recording anything or changing the guard. Judges budget and step limits that are already used up, per-tool call caps, repeated identical calls and oscillation, in the same priority order as `check`; returns `{ allow: true, warnings? }` or `{ allow: false, reason, code, detail, evidence, feedback }`. Rules that need a result, text, finish reason or usage, and result-aware repeat rules (`requireIdenticalResults`, `polling` tools), are not judged before a call runs.
- Model-facing `feedback` on every fault verdict from a built-in detector and on every `preflight` denial: fixed, deterministic plain-English text per code that names the tool but never repeats arguments, results or model text. New `feedback` option to override it, `feedbackFor(verdict, phase?)` for the default text, and a `feedback` field on custom stops.
- Save and resume: `guard.toJSON()` (so `JSON.stringify(guard)` works) and `guard.snapshot({ redact? })` return a versioned, JSON-safe, size-bounded `GuardSnapshot`; `createGuard.fromJSON(snapshot, options?, { allowLimitChanges? })` (also exported as `restoreGuard`) rebuilds a guard that gives identical verdicts. Options are fingerprinted, not stored: restoring under different options throws a `TypeError`. Malformed or hostile snapshots throw a `TypeError` at restore time.
- Per-tool policies: `tools: { [name]: { polling, maxCalls, repeatThreshold, ignore } }`. `maxCalls` adds the stop reason `'tool-limit'` with code `TOOL_CALL_CAP`.
- Oscillation evidence now lists the tool names of the cycle (`evidence.tools`); `summary().detectors.toolLimits` shows calls against each cap (present only when a cap is set).
- New exported types: `Preflight`, `PreflightAllow`, `PreflightDeny`, `PreflightCall`, `PreflightStopVerdict`, `ToolPolicy`, `ToolLimitEvidence`, `ToolLimitVerdict`, `FeedbackPhase`, `GuardSnapshot`, `GuardSnapshotVersion`, `GuardOptionsFingerprint`, `SnapshotOptions`, `RestoreOptions`, `RepeatedToolCallSnapshot`, `OscillationSnapshot`, `NoProgressSnapshot`.
- `examples/preflight-and-feedback.ts` (`npm run example:preflight`), run in CI.

### Notes

- **Widened unions.** `StopReason` gains `'tool-limit'`, `BuiltinStopCode` gains `'TOOL_CALL_CAP'`, and `StopVerdict` gains `ToolLimitVerdict`. A TypeScript `switch` over `verdict.reason` or `verdict.code` that has no `default` and relies on exhaustiveness will stop compiling until you add a case. At run time the new reason only appears if you set a `maxCalls`.
- **`Guard` has three new methods** (`preflight`, `toJSON`, `snapshot`). Code that implements the `Guard` interface itself (a test double, say) needs them.
- **Memory is now bounded, with one visible effect.** The no-progress detector remembers the newest 1024 distinct tool outcomes instead of all of them, so in a run with more than 1024 distinct outcomes an outcome older than that counts as new again. The oscillation detector keeps `maxPeriod` calls and one counter per period instead of a 4096-call window; the results are the same except that the reported cycle count is no longer capped by that window. Signatures are compared as 28-character hashes instead of raw strings (a collision between different values is possible in principle, not a practical concern).
- **A restored guard starts with an empty `history`**, and custom detectors see only the steps recorded since the restore; `summary().steps` and every detector keep counting across it. `summary().lastVerdict` is `null` until the first `check`.
- A custom verdict has no `feedback` unless its detector (or the `feedback` option) supplies one; the package has nothing sensible to say for rules it does not know.
- Tested offline only: preflight, feedback and snapshots have not been tried against real provider output beyond the existing AI SDK integration test.

## [0.1.0] - 2026-10-14

Published on npm as `@osama.ansar/agent-loopguard` (the unscoped name was too close to an existing package).

First release.

### Added

- `createGuard(options)` returning a `Guard` with `check(step)`, `reset()`, `summary()` and a read-only `history`.
- Typed, JSON-serialisable verdicts with a string-literal `reason`, a stable machine-readable `code`, a one-sentence `detail` and structured `evidence`.
- Detectors, each configurable or disableable: `maxSteps`, `repeatedToolCall`, `oscillation`, `noProgress`, `finishReason` (with `terminal` list and `otherPolicy`) and `budget` (tokens, cost, duration, with optional `warnAt` warnings).
- `custom` detector hook: `(history, step) => stop | undefined`.
- Canonical, key-order-insensitive argument comparison that handles `undefined`, `NaN`, bigint, Dates, Maps, Sets, circular references and very large values (by hashing). Exposed as `canonicalize` and `stableHash`.
- `explain(verdict)` and `isFault(verdict)`.
- Adapters: `toStopWhen` (Vercel AI SDK `stopWhen`-compatible, idempotent), `toGuardStep`, `runAgentLoop` (with `AbortSignal` support) and `withGuard` (async-iterable wrapper).
- ESM and CommonJS builds with type declarations; zero runtime dependencies.
