import { describe } from './canonical';

/** One tool call, reduced to the comparable facts the detectors need. */
export interface CallRecord {
  name: string;
  /** `tool(args)` with a truncated canonical argument string, for messages. */
  label: string;
  /** Equality key for "same tool, same arguments". */
  callSig: string;
  /** Equality key of the result or error; `undefined` when neither was supplied. */
  resultSig: string | undefined;
  /** Equality key of the whole interaction: the call plus whatever came back. */
  outcomeSig: string;
  failed: boolean;
  argsPreview: string;
}

/** A step reduced to comparable facts. Built once per `check`, never mutated. */
export interface StepRecord {
  /** 0-based position in the run. */
  index: number;
  calls: CallRecord[];
  /** Whitespace-collapsed, lower-cased text ('' when there is none). */
  text: string;
  /** Raw finish reason after normalisation, or `undefined` when none was supplied. */
  finishReason: string | undefined;
  rawFinishReason: string | undefined;
  /** Sanitised numbers (finite, >= 0) or `undefined` when absent or invalid. */
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
  costUsd: number | undefined;
  durationMs: number | undefined;
}

/** `'Content_Filter '` -> `'content-filter'`. */
export function normalizeFinishReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/_/g, '-');
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Accept only finite, non-negative numbers; anything else is treated as "not supplied". */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reduce a step to a record. Defensive on purpose: steps often come straight from provider
 * responses, so every field is type-checked at runtime and unusable data is ignored, never thrown on.
 */
export function buildRecord(step: unknown, index: number): StepRecord {
  const s: Record<string, unknown> = isObject(step) ? step : {};

  const calls: CallRecord[] = [];
  const rawCalls: unknown = s['toolCalls'];
  if (Array.isArray(rawCalls)) {
    for (const raw of rawCalls as unknown[]) {
      if (!isObject(raw)) continue;
      const name = typeof raw['name'] === 'string' ? raw['name'] : describe(raw['name']).signature;
      const args = describe(raw['args']);
      const failed = raw['error'] !== undefined && raw['error'] !== null;
      const callSig = `${JSON.stringify(name)}(${args.signature})`;

      let resultSig: string | undefined;
      if (failed) resultSig = `error:${describe(raw['error']).signature}`;
      else if (raw['result'] !== undefined) resultSig = `ok:${describe(raw['result']).signature}`;

      calls.push({
        name,
        label: `${name}(${args.preview})`,
        callSig,
        resultSig,
        // With no result supplied the call itself stands in as "the evidence".
        outcomeSig: resultSig === undefined ? callSig : `${callSig}=>${resultSig}`,
        failed,
        argsPreview: args.preview,
      });
    }
  }

  const usage = isObject(s['usage']) ? s['usage'] : {};
  const inputTokens = num(usage['inputTokens']);
  const outputTokens = num(usage['outputTokens']);
  let totalTokens = num(usage['totalTokens']);
  if (totalTokens === undefined && (inputTokens !== undefined || outputTokens !== undefined)) {
    totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }

  const rawFinish: unknown = s['finishReason'];
  const finishReason =
    typeof rawFinish === 'string' && rawFinish.trim() !== '' ? normalizeFinishReason(rawFinish) : undefined;

  return {
    index,
    calls,
    text: typeof s['text'] === 'string' ? normalizeText(s['text']) : '',
    finishReason,
    rawFinishReason: finishReason === undefined ? undefined : (rawFinish as string),
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: num(usage['costUsd']),
    durationMs: num(s['durationMs']),
  };
}
