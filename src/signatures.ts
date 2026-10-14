import { describe, truncate } from './canonical';
import type { Described } from './canonical';

/** Longest preview made from a custom signature, for messages. */
const PREVIEW_LIMIT = 80;
/** Longest failure message kept for `summary()`. */
const MAX_FAILURE_LENGTH = 200;

/** The functions a caller may supply to decide what makes two calls, results or errors "the same". */
export interface SignatureFunctions {
  signature?: ((toolName: string, args: unknown) => string) | undefined;
  resultSignature?: ((result: unknown) => string) | undefined;
  errorSignature?: ((error: unknown) => string) | undefined;
}

/** A readable message for whatever was thrown, without letting a hostile value throw again. */
function messageOf(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return 'an error that could not be read';
  }
}

function check(name: string, fn: unknown): void {
  if (fn !== undefined && typeof fn !== 'function') {
    throw new TypeError(`agent-loopguard: ${name} must be a function, got ${String(fn)}`);
  }
}

/**
 * Turns the parts of a tool call into the strings the detectors compare (after hashing).
 *
 * By default that is the canonical form of the value, as in 0.2.0. A caller's function replaces it for
 * one part, so that fields that do not matter for "is this the same call" (a timestamp, a page token,
 * a request id) can be left out, and a huge payload need not be walked at all.
 *
 * A function that throws, or returns anything but a string, never reaches the caller: that value
 * falls back to the default canonical form, and the failure is counted for `summary()`.
 */
export class Signer {
  readonly custom: boolean;
  private failures = 0;
  private lastFailure: string | null = null;

  constructor(private readonly fns: SignatureFunctions = {}) {
    check('signature', fns.signature);
    check('resultSignature', fns.resultSignature);
    check('errorSignature', fns.errorSignature);
    this.custom = fns.signature !== undefined || fns.resultSignature !== undefined || fns.errorSignature !== undefined;
  }

  /** The signature of the arguments of a call to `name`, and a short preview of it. */
  args(name: string, args: unknown): Described {
    const fn = this.fns.signature;
    if (fn !== undefined) {
      const custom = this.attempt(() => fn(name, args));
      if (custom !== undefined) return { signature: custom, preview: truncate(custom, PREVIEW_LIMIT) };
    }
    return describe(args);
  }

  /** The signature of a result the tool returned. */
  result(value: unknown): string {
    const fn = this.fns.resultSignature;
    const custom = fn === undefined ? undefined : this.attempt(() => fn(value));
    return custom ?? describe(value).signature;
  }

  /** The signature of an error the tool raised. */
  error(value: unknown): string {
    const fn = this.fns.errorSignature;
    const custom = fn === undefined ? undefined : this.attempt(() => fn(value));
    return custom ?? describe(value).signature;
  }

  /** Which functions are set. Part of the snapshot fingerprint: functions cannot be, but their presence can. */
  flags(): { signature: boolean; resultSignature: boolean; errorSignature: boolean } {
    return {
      signature: this.fns.signature !== undefined,
      resultSignature: this.fns.resultSignature !== undefined,
      errorSignature: this.fns.errorSignature !== undefined,
    };
  }

  state(): { failures: number; lastFailure: string | null } {
    return { failures: this.failures, lastFailure: this.lastFailure };
  }

  reset(): void {
    this.failures = 0;
    this.lastFailure = null;
  }

  private attempt(run: () => unknown): string | undefined {
    try {
      const out = run();
      if (typeof out === 'string') return out;
      this.fail(`returned ${out === null ? 'null' : typeof out} instead of a string`);
    } catch (error) {
      this.fail(messageOf(error));
    }
    return undefined;
  }

  private fail(message: string): void {
    this.failures += 1;
    this.lastFailure = message.length <= MAX_FAILURE_LENGTH ? message : message.slice(0, MAX_FAILURE_LENGTH);
  }
}

/** Used when no function is set: stateless, so one instance is shared. */
export const DEFAULT_SIGNER = new Signer();
