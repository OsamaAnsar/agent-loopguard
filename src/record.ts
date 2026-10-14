import { describe, hashString } from './canonical';

/** One tool call, reduced to the comparable facts the detectors need. */
export interface CallRecord {
  name: string;
  /** `tool(args)` with a truncated canonical argument string, for messages. */
  label: string;
  /**
   * Equality key for "same tool, same arguments". Always a fixed-length hash, so detector state
   * holds no raw arguments (and can be snapshotted without them).
   */
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
  /** Finish reason after normalisation, or `undefined` when none was supplied. */
  finishReason: string | undefined;
  /** The finish reason exactly as supplied. */
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

/** Read a property without letting a hostile getter or revoked proxy throw. */
function get(obj: Record<string, unknown>, key: string): unknown {
  try {
    return obj[key];
  } catch {
    return undefined;
  }
}

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false; // revoked proxy
  }
}

function buildCall(raw: unknown): CallRecord | undefined {
  if (!isObject(raw)) return undefined;
  const rawName = get(raw, 'name');
  const name = typeof rawName === 'string' ? rawName : describe(rawName).signature;
  const args = describe(get(raw, 'args'));
  const error = get(raw, 'error');
  const result = get(raw, 'result');
  const failed = error !== undefined && error !== null;
  const callSig = hashString(`${JSON.stringify(name)}(${args.signature})`);

  let resultSig: string | undefined;
  if (failed) resultSig = hashString(`error:${describe(error).signature}`);
  else if (result !== undefined) resultSig = hashString(`ok:${describe(result).signature}`);

  return {
    name,
    label: `${name}(${args.preview})`,
    callSig,
    resultSig,
    // With no result supplied the call itself stands in as "the evidence".
    outcomeSig: resultSig === undefined ? callSig : hashString(`${callSig}=>${resultSig}`),
    failed,
    argsPreview: args.preview,
  };
}

function buildCalls(step: Record<string, unknown>): CallRecord[] {
  const calls: CallRecord[] = [];
  try {
    const raw = get(step, 'toolCalls');
    if (!isArray(raw)) return calls;
    for (const item of raw) {
      const call = buildCall(item);
      if (call !== undefined) calls.push(call);
    }
  } catch {
    // A hostile iterable: keep whatever was read before it failed.
  }
  return calls;
}

/**
 * Reduce a step to a record. Defensive on purpose: steps often come straight from provider
 * responses, so every field is type-checked at runtime and unusable data (including getters
 * that throw and revoked proxies) is ignored, never thrown on.
 */
export function buildRecord(step: unknown, index: number): StepRecord {
  const s: Record<string, unknown> = isObject(step) ? step : {};

  const rawUsage = get(s, 'usage');
  const usage: Record<string, unknown> = isObject(rawUsage) ? rawUsage : {};
  const inputTokens = num(get(usage, 'inputTokens'));
  const outputTokens = num(get(usage, 'outputTokens'));
  let totalTokens = num(get(usage, 'totalTokens'));
  if (totalTokens === undefined && (inputTokens !== undefined || outputTokens !== undefined)) {
    totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }

  const rawFinish = get(s, 'finishReason');
  const finishReason =
    typeof rawFinish === 'string' && rawFinish.trim() !== '' ? normalizeFinishReason(rawFinish) : undefined;
  const rawText = get(s, 'text');

  return {
    index,
    calls: buildCalls(s),
    text: typeof rawText === 'string' ? normalizeText(rawText) : '',
    finishReason,
    rawFinishReason: typeof rawFinish === 'string' && finishReason !== undefined ? rawFinish : undefined,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: num(get(usage, 'costUsd')),
    durationMs: num(get(s, 'durationMs')),
  };
}
