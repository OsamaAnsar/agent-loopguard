import { canonicalize, hashString } from './canonical';

/*
 * Helpers for reading a snapshot that may be anything: hand-edited, from another version, or hostile.
 * Every reader throws a `TypeError` that names the offending path, so a bad snapshot is rejected
 * when it is restored, never later from `check`.
 */

/** The only snapshot version this package reads and writes. */
export const SNAPSHOT_VERSION = 1;

/** Longest tool name kept in a snapshot (longer ones are cut; hashes still tell calls apart). */
export const MAX_NAME_LENGTH = 256;
/** Longest `tool(arguments)` label kept in a snapshot. */
export const MAX_LABEL_LENGTH = 1024;
/** Longest argument or text preview kept in a snapshot. Previews are 80 characters when made. */
export const MAX_PREVIEW_LENGTH = 128;
/** Longest finish reason kept in a snapshot. */
export const MAX_FINISH_REASON_LENGTH = 256;
/** What a preview becomes in a redacted snapshot. */
export const REDACTED = '[redacted]';

const HASH = /^[0-9a-f]{28}$/;

export function fail(path: string, problem: string): never {
  throw new TypeError(`agent-loopguard: invalid snapshot: ${path} ${problem}`);
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Fingerprint of any plain configuration value (a hash of its canonical form). */
export function fingerprint(config: unknown): string {
  return hashString(canonicalize(config));
}

export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
  return value as Record<string, unknown>;
}

/** Read an own property; an inherited or missing one is a problem. */
export function field(obj: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(`${path}.${key}`, 'is missing');
  return obj[key];
}

export function asInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(path, `must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

/** A finite number >= 0 (token counts, cost, durations). */
export function asAmount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(path, `must be a finite number >= 0, got ${String(value)}`);
  }
  return value;
}

export function asString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (value.length > maxLength) fail(path, `must be at most ${maxLength} characters`);
  return value;
}

export function asHash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) fail(path, 'must be a 28-character hex hash');
  return value;
}

export function asList(value: unknown, path: string, maxLength: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (value.length > maxLength) fail(path, `must have at most ${maxLength} entries`);
  // Copy to a dense array: a hole reads as `undefined`, which the element checks then reject.
  return Array.from(value as unknown[]);
}

/** `null` stays `null`; anything else goes through `read`. */
export function asNullable<T>(value: unknown, read: (v: unknown) => T): T | null {
  return value === null ? null : read(value);
}

/** The state of a detector section: `null` exactly when the detector is disabled. */
export function section(detectors: Record<string, unknown>, key: string, enabled: boolean): unknown {
  const value = field(detectors, key, 'detectors');
  if (enabled && value === null) fail(`detectors.${key}`, 'is null, but that detector is enabled in the options');
  if (!enabled && value !== null) fail(`detectors.${key}`, 'has state, but that detector is disabled in the options');
  return value;
}
