# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
