import { assertInteger, assertIntegerBetween } from './detectors/types';
import type { ToolPolicy } from './types';

/** A `ToolPolicy` with every field checked and defaulted. */
export interface ResolvedToolPolicy {
  readonly ignore: boolean;
  readonly polling: boolean;
  /** `polling.maxIdenticalResults`, when set. */
  readonly pollingThreshold: number | undefined;
  readonly repeatThreshold: number | undefined;
  /** `undefined` for no cap, and always for an ignored tool. */
  readonly maxCalls: number | undefined;
}

const POLICY_KEYS: readonly string[] = ['polling', 'maxCalls', 'repeatThreshold', 'ignore', 'warnAt'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One tool's rules, and its early-warning setting. The warning setting is kept apart: it never changes a decision, so it stays out of the snapshot fingerprint. */
interface Resolved {
  policy: ResolvedToolPolicy;
  warnAt: number | false | undefined;
}

/** Check one tool's policy and fill in the defaults. Throws a `TypeError` naming the bad option. */
function resolve(tool: string, raw: unknown): Resolved {
  const where = `tools[${JSON.stringify(tool)}]`;
  if (!isPlainObject(raw)) throw new TypeError(`agent-loopguard: ${where} must be an object, got ${String(raw)}`);
  for (const key of Object.keys(raw)) {
    if (!POLICY_KEYS.includes(key)) {
      throw new TypeError(`agent-loopguard: ${where} has an unknown option "${key}" (known: ${POLICY_KEYS.join(', ')})`);
    }
  }

  const ignore = raw['ignore'];
  if (ignore !== undefined && typeof ignore !== 'boolean') {
    throw new TypeError(`agent-loopguard: ${where}.ignore must be a boolean, got ${String(ignore)}`);
  }

  let polling = false;
  let pollingThreshold: number | undefined;
  const rawPolling = raw['polling'];
  if (typeof rawPolling === 'boolean') {
    polling = rawPolling;
  } else if (rawPolling !== undefined) {
    if (!isPlainObject(rawPolling)) {
      throw new TypeError(`agent-loopguard: ${where}.polling must be a boolean or an object, got ${String(rawPolling)}`);
    }
    for (const key of Object.keys(rawPolling)) {
      if (key !== 'maxIdenticalResults') {
        throw new TypeError(`agent-loopguard: ${where}.polling has an unknown option "${key}" (known: maxIdenticalResults)`);
      }
    }
    polling = true;
    const limit = rawPolling['maxIdenticalResults'];
    if (limit !== undefined) pollingThreshold = assertInteger(`${where}.polling.maxIdenticalResults`, limit, 2);
  }

  const repeat = raw['repeatThreshold'];
  const repeatThreshold = repeat === undefined ? undefined : assertInteger(`${where}.repeatThreshold`, repeat, 2);
  const cap = raw['maxCalls'];
  const maxCalls = cap === undefined ? undefined : assertInteger(`${where}.maxCalls`, cap, 0);

  let warnAt: number | false | undefined;
  const warn = raw['warnAt'];
  if (warn === false) {
    warnAt = false;
  } else if (warn !== undefined) {
    if (typeof warn !== 'number') {
      throw new TypeError(`agent-loopguard: ${where}.warnAt must be false or an integer from 1 to maxCalls, got ${String(warn)}`);
    }
    if (ignore !== true) {
      if (maxCalls === undefined) {
        throw new TypeError(`agent-loopguard: ${where}.warnAt needs maxCalls: it is the number of calls at which the warning about the cap starts`);
      }
      warnAt = assertIntegerBetween(`${where}.warnAt`, warn, 1, maxCalls);
    }
  }

  return {
    policy: {
      ignore: ignore === true,
      polling,
      pollingThreshold,
      repeatThreshold,
      maxCalls: ignore === true ? undefined : maxCalls,
    },
    warnAt,
  };
}

/**
 * The per-tool rules of one guard, validated once at `createGuard` time. Lookups go through a
 * `Map`, so a tool called `constructor` or `__proto__` is just a name like any other.
 */
export class ToolPolicies {
  private readonly byName = new Map<string, ResolvedToolPolicy>();
  private readonly warnByName = new Map<string, number | false>();
  /** Tools that have a call cap, in the order they were configured. */
  readonly capped: ReadonlyArray<{ tool: string; limit: number }>;
  readonly hasIgnored: boolean;

  constructor(tools: Readonly<Record<string, ToolPolicy>> | undefined) {
    if (tools !== undefined && !isPlainObject(tools)) {
      throw new TypeError(`agent-loopguard: tools must be an object keyed by tool name, got ${String(tools)}`);
    }
    const capped: Array<{ tool: string; limit: number }> = [];
    let hasIgnored = false;
    for (const [tool, raw] of Object.entries(tools ?? {})) {
      const { policy, warnAt } = resolve(tool, raw);
      this.byName.set(tool, policy);
      if (warnAt !== undefined) this.warnByName.set(tool, warnAt);
      if (policy.maxCalls !== undefined) capped.push({ tool, limit: policy.maxCalls });
      if (policy.ignore) hasIgnored = true;
    }
    this.capped = capped;
    this.hasIgnored = hasIgnored;
  }

  get(name: string): ResolvedToolPolicy | undefined {
    return this.byName.get(name);
  }

  /** The tool's `warnAt`: a number, `false`, or `undefined` when it names none. */
  warnAt(name: string): number | false | undefined {
    return this.warnByName.get(name);
  }

  isIgnored(name: string): boolean {
    return this.byName.get(name)?.ignore === true;
  }

  /** Plain, order-independent description of the resolved rules (used for the snapshot fingerprint). */
  config(): Array<[string, ResolvedToolPolicy]> {
    return [...this.byName].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
}
