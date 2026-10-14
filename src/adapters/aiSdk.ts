import { createGuard } from '../guard';
import type { Guard, GuardOptions, GuardStep, GuardToolCall, StopVerdict } from '../types';

/*
 * Structural types for the parts of an AI SDK step we read. They are deliberately minimal and
 * declared here so this package has no dependency on `ai`. The names follow the AI SDK's
 * `StepResult` (`toolCalls[].input`, `toolResults[].output`, `usage`, `performance.stepTimeMs`);
 * the older `args` / `result` names are accepted too. Real `StepResult` objects are assignable to
 * `AiSdkStepLike`; this is checked at compile time in the test suite against the installed `ai`.
 */

export interface AiSdkToolCallLike {
  readonly toolCallId?: string | undefined;
  readonly toolName: string;
  readonly input?: unknown;
  readonly args?: unknown;
}

export interface AiSdkToolResultLike {
  readonly toolCallId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly output?: unknown;
  readonly result?: unknown;
}

export interface AiSdkStepLike {
  readonly text?: string | undefined;
  readonly finishReason?: string | undefined;
  readonly toolCalls?: ReadonlyArray<AiSdkToolCallLike> | undefined;
  readonly toolResults?: ReadonlyArray<AiSdkToolResultLike> | undefined;
  /** Scanned for `{ type: 'tool-error', toolCallId, error }` parts. */
  readonly content?: ReadonlyArray<{ readonly type: string }> | undefined;
  readonly usage?:
    | {
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
        readonly totalTokens?: number | undefined;
      }
    | undefined;
  readonly performance?: { readonly stepTimeMs?: number | undefined } | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Map one AI SDK step to a `GuardStep`. Tool results and errors are matched to calls by `toolCallId`. */
export function toGuardStep(step: AiSdkStepLike): GuardStep {
  const results = new Map<string, unknown>();
  const errors = new Map<string, unknown>();
  const positionalResults: AiSdkToolResultLike[] = [];

  for (const r of step.toolResults ?? []) {
    if (typeof r.toolCallId === 'string') results.set(r.toolCallId, 'output' in r ? r.output : r.result);
    else positionalResults.push(r);
  }
  for (const part of step.content ?? []) {
    const p: unknown = part;
    if (isRecord(p) && p['type'] === 'tool-error' && typeof p['toolCallId'] === 'string') {
      errors.set(p['toolCallId'], p['error'] ?? 'tool-error');
    }
  }

  const toolCalls: GuardToolCall[] = (step.toolCalls ?? []).map((call, i) => {
    const out: GuardToolCall = { name: call.toolName, args: 'input' in call ? call.input : call.args };
    const id = call.toolCallId;
    if (typeof id === 'string') {
      if (results.has(id)) out.result = results.get(id);
      if (errors.has(id)) out.error = errors.get(id);
    } else {
      const positional = positionalResults[i];
      if (positional !== undefined) out.result = 'output' in positional ? positional.output : positional.result;
    }
    return out;
  });

  const guardStep: GuardStep = { toolCalls };
  if (step.text !== undefined) guardStep.text = step.text;
  if (step.finishReason !== undefined) guardStep.finishReason = step.finishReason;
  if (step.usage !== undefined) guardStep.usage = { ...step.usage };
  const duration = step.performance?.stepTimeMs;
  if (typeof duration === 'number') guardStep.durationMs = duration;
  return guardStep;
}

export interface ToStopWhenOptions {
  /** Called when the guard decides to stop, so you can log or record why. May be called more than once for the same stop. */
  onStop?: (verdict: StopVerdict) => void;
}

/**
 * Build an AI SDK `stopWhen` condition from a guard.
 *
 * ```ts
 * generateText({ model, tools, stopWhen: toStopWhen(() => createGuard()) });
 * ```
 *
 * The condition is idempotent: on every call it creates a fresh guard from `guardFactory` and
 * replays the whole `steps` array, so it gives the same answer for the same steps however often
 * the SDK calls it, and it holds no state between calls or runs. Only the verdict for the latest
 * step counts. Wall-clock budgets are meaningless in a replay, so use durations from the steps
 * (`performance.stepTimeMs`, summed) rather than a `now()`-based limit here.
 *
 * You may pass `GuardOptions` instead of a factory.
 */
export function toStopWhen<S extends AiSdkStepLike = AiSdkStepLike>(
  guardFactory: (() => Guard) | GuardOptions = {},
  hooks: ToStopWhenOptions = {},
): (options: { steps: ReadonlyArray<S> }) => boolean {
  const makeGuard = typeof guardFactory === 'function' ? guardFactory : () => createGuard(guardFactory);
  // Converting a step canonicalises its arguments; cache so replays do not repeat that work.
  const converted = new WeakMap<object, GuardStep>();

  return ({ steps }) => {
    const guard = makeGuard();
    let stopped: StopVerdict | undefined;
    for (const step of steps) {
      let guardStep = converted.get(step);
      if (guardStep === undefined) {
        guardStep = toGuardStep(step);
        converted.set(step, guardStep);
      }
      const verdict = guard.check(guardStep);
      stopped = verdict.stop ? verdict : undefined;
    }
    if (stopped === undefined) return false;
    hooks.onStop?.(stopped);
    return true;
  };
}
