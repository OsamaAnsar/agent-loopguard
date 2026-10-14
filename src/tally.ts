import { isSafeName } from './feedback';
import { MAX_NAME_LENGTH, asInt, asList, asRecord, asString, fail, field } from './snapshot';
import type { ToolTallySnapshot } from './types';

/** How many distinct tool names are counted one by one; calls to any further names are counted together. */
export const MAX_TRACKED_TOOLS = 32;

/**
 * Calls per tool, for `report()`. Memory is bounded: a tool name chosen by the model is only counted by
 * name if it looks like an ordinary identifier (the same rule as for model-facing text) and fewer than
 * `MAX_TRACKED_TOOLS` names are tracked already; every other call goes to `other`.
 */
export class ToolTally {
  private counts = new Map<string, number>();
  private other = 0;

  add(name: string): void {
    const known = this.counts.get(name);
    if (known !== undefined) this.counts.set(name, known + 1);
    else if (isSafeName(name) && this.counts.size < MAX_TRACKED_TOOLS) this.counts.set(name, 1);
    else this.other += 1;
  }

  /** The counted tools in the order they were first called, and the calls that were not counted by name. */
  entries(): { tools: Array<{ tool: string; calls: number }>; other: number } {
    return { tools: [...this.counts].map(([tool, calls]) => ({ tool, calls })), other: this.other };
  }

  /** `undefined` while nothing has been counted, so that a snapshot of a fresh guard is what 0.2.0 wrote. */
  snapshot(): ToolTallySnapshot | undefined {
    if (this.counts.size === 0 && this.other === 0) return undefined;
    return this.entries();
  }

  /** Read the snapshot's tally (absent in snapshots from 0.2.0, which means nothing was counted). */
  restore(raw: unknown, totalCalls: number): void {
    if (raw === undefined) {
      this.reset();
      return;
    }
    const path = 'snapshot.callsByTool';
    const state = asRecord(raw, path);
    const tools = asList(field(state, 'tools', path), `${path}.tools`, MAX_TRACKED_TOOLS);
    const other = asInt(field(state, 'other', path), `${path}.other`);
    const counts = new Map<string, number>();
    let sum = other;
    tools.forEach((entry, i) => {
      const where = `${path}.tools[${i}]`;
      const record = asRecord(entry, where);
      const tool = asString(field(record, 'tool', where), `${where}.tool`, MAX_NAME_LENGTH);
      if (!isSafeName(tool)) fail(`${where}.tool`, 'is not an ordinary tool name');
      if (counts.has(tool)) fail(`${where}.tool`, 'repeats a tool');
      const calls = asInt(field(record, 'calls', where), `${where}.calls`);
      counts.set(tool, calls);
      sum += calls;
    });
    if (sum > totalCalls) fail(path, 'counts more calls than the snapshot says were made');
    this.counts = counts;
    this.other = other;
  }

  reset(): void {
    this.counts = new Map();
    this.other = 0;
  }
}
