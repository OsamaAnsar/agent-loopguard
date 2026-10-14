import type { Guard, GuardStep, GuardToolCall, Verdict } from '../src/index';

/** Small, fast, seedable PRNG (mulberry32) so property and fuzz tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function call(name: string, args?: unknown, extra: Partial<GuardToolCall> = {}): GuardToolCall {
  return { name, args, ...extra };
}

export function step(...toolCalls: GuardToolCall[]): GuardStep {
  return { toolCalls };
}

/** A tool-calling step that finished with `tool-calls`, as a healthy model would. */
export function toolStep(...toolCalls: GuardToolCall[]): GuardStep {
  return { toolCalls, finishReason: 'tool-calls' };
}

/** Feed steps to a guard and return every verdict. */
export function feed(guard: Guard, steps: readonly GuardStep[]): Verdict[] {
  return steps.map((s) => guard.check(s));
}

/** Index of the first stopping verdict, or -1. */
export function firstStop(verdicts: readonly Verdict[]): number {
  return verdicts.findIndex((v) => v.stop);
}
