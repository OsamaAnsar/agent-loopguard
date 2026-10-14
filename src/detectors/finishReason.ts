import { normalizeFinishReason } from '../record';
import type { StepRecord } from '../record';
import { MAX_FINISH_REASON_LENGTH, asNullable, asRecord, asString, clip, field } from '../snapshot';
import type { FinishReasonEvidence, FinishReasonOptions, OtherFinishPolicy } from '../types';
import type { Detector, DetectorResult } from './types';

export const DEFAULT_TERMINAL_FINISH_REASONS: readonly string[] = ['stop', 'length', 'content-filter', 'error'];

const OTHER_POLICIES: readonly OtherFinishPolicy[] = ['stop', 'continue', 'stop-if-text-only'];

/**
 * Decides from the finish reason whether the run is over.
 *
 * 1. A reason in `terminal` always stops.
 * 2. `tool-calls` always continues: the model is waiting for tool results.
 * 3. Anything else (`other`, `unknown`, an unfamiliar provider string) follows `otherPolicy`:
 *    `stop`, `continue`, or `stop-if-text-only` (default): stop when the step has text and no tool calls.
 *
 * Rule 3 exists because some frameworks only treat `stop` as "done". If a provider ends a final,
 * text-only answer with an unfamiliar finish reason, such a framework sees "not done" and re-sends
 * the same request until its step limit. A text-only step that is not a clean stop is the
 * signature of that bug, so by default we end the run there.
 *
 * Steps with no finish reason say nothing and are left to the other detectors.
 */
export class FinishReasonDetector implements Detector {
  readonly terminal: ReadonlySet<string>;
  readonly otherPolicy: OtherFinishPolicy;
  private last: string | null = null;

  constructor(options: FinishReasonOptions = {}) {
    this.terminal = new Set((options.terminal ?? DEFAULT_TERMINAL_FINISH_REASONS).map(normalizeFinishReason));
    const policy = options.otherPolicy ?? 'stop-if-text-only';
    if (!OTHER_POLICIES.includes(policy)) {
      throw new TypeError(
        `agent-loopguard: finishReason.otherPolicy must be one of ${OTHER_POLICIES.join(', ')}, got ${String(policy)}`,
      );
    }
    this.otherPolicy = policy;
  }

  observe(record: StepRecord): DetectorResult | undefined {
    const normalized = record.finishReason;
    if (normalized === undefined) return undefined;
    this.last = normalized;

    const raw = record.rawFinishReason ?? normalized;
    const hasText = record.text !== '';
    const toolCallCount = record.calls.length;
    const evidence = (policy: FinishReasonEvidence['policy']): FinishReasonEvidence => ({
      finishReason: raw,
      normalized,
      policy,
      hasText,
      toolCallCount,
    });

    if (this.terminal.has(normalized)) {
      return {
        stop: {
          stop: true,
          reason: 'finish-reason',
          code: 'FINISH_TERMINAL',
          detail: `The model finished with "${raw}", which ends the run.`,
          evidence: evidence('terminal'),
        },
      };
    }

    if (normalized === 'tool-calls') return undefined;

    if (this.otherPolicy === 'stop') {
      return {
        stop: {
          stop: true,
          reason: 'finish-reason',
          code: 'FINISH_OTHER',
          detail: `The model finished with the unfamiliar reason "${raw}" and the policy is to stop on those.`,
          evidence: evidence('other-stop'),
        },
      };
    }

    if (this.otherPolicy === 'stop-if-text-only' && hasText && toolCallCount === 0) {
      return {
        stop: {
          stop: true,
          reason: 'finish-reason',
          code: 'FINISH_OTHER_TEXT_ONLY',
          detail: `The model returned text with no tool calls and the unfamiliar finish reason "${raw}"; re-sending would likely repeat the same answer.`,
          evidence: evidence('other-text-only'),
        },
      };
    }

    return undefined;
  }

  state(): { lastFinishReason: string | null } {
    return { lastFinishReason: this.last };
  }

  /** The resolved options, for the snapshot fingerprint. */
  config(): { terminal: string[]; otherPolicy: OtherFinishPolicy } {
    return { terminal: [...this.terminal].sort(), otherPolicy: this.otherPolicy };
  }

  snapshot(): { lastFinishReason: string | null } {
    return { lastFinishReason: this.last === null ? null : clip(this.last, MAX_FINISH_REASON_LENGTH) };
  }

  restore(raw: unknown): void {
    const path = 'detectors.finishReason';
    const state = asRecord(raw, path);
    this.last = asNullable(field(state, 'lastFinishReason', path), (v) =>
      asString(v, `${path}.lastFinishReason`, MAX_FINISH_REASON_LENGTH),
    );
  }

  reset(): void {
    this.last = null;
  }
}
