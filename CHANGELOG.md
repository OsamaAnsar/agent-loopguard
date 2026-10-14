# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-14

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
