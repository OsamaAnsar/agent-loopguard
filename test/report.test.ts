import { describe, expect, expectTypeOf, it } from 'vitest';
import { createGuard, restoreGuard } from '../src/index';
import type { DecisionEvent, Guard, GuardOptions, GuardReport, GuardSnapshot, Preflight, Verdict } from '../src/index';
import { call, feed, step } from './helpers';

const SECRET = 'SENTINEL-sk-live-3319';

/** Options that switch every detector off, so a test can enable exactly one. */
const ONLY: GuardOptions = {
  maxSteps: false,
  repeatedToolCall: false,
  oscillation: false,
  noProgress: false,
  finishReason: false,
};

// ---------------------------------------------------------------------------
describe('report: text', () => {
  it('a fresh guard', () => {
    expect(createGuard().report()).toBe('Loop guard status\nSteps: 0\nTool calls: 0');
  });

  it('steps, calls per tool (most called first, ties by name), failures, warnings and the last stop', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {} });
    feed(guard, [
      step(call('search', 1), call('read', 1), call('read', 2, { error: 'boom' })),
      step(call('write', 1), call('search', 2)),
      step(call('search', 3)),
    ]);
    expect(guard.report()).toBe('Loop guard status\nSteps: 3\nTool calls: 6 (1 failed): search 3, read 2, write 1');
    feed(guard, [step(call('read', 2)), step(call('read', 2)), step(call('read', 2))]);
    expect(guard.report()).toBe(
      [
        'Loop guard status',
        'Steps: 6',
        'Tool calls: 9 (1 failed): read 5, search 3, write 1',
        'Last stop: repeated-tool-call (REPEATED_TOOL_CALL)',
      ].join('\n'),
    );
  });

  it('lists the warnings of the most recent verdict, in the model-facing wording, until a verdict without them', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {} });
    guard.check(step(call('t', 1)));
    guard.check(step(call('t', 1)));
    expect(guard.report()).toBe(
      [
        'Loop guard status',
        'Steps: 2',
        'Tool calls: 2: t 2',
        'Warnings:',
        '- You have called `t` 2 times in a row with the same arguments. Calling it that way once more will stop this task. Try a different tool or different arguments, or answer with what you have.',
      ].join('\n'),
    );
    guard.check(step(call('other', 1)));
    expect(guard.report()).not.toContain('Warnings:');
  });

  it('words a budget warning from counts', () => {
    const guard = createGuard({ budget: { maxTotalTokens: { limit: 100, warnAt: 0.5 } } });
    guard.check({ usage: { totalTokens: 60 } });
    expect(guard.report()).toContain('- The token budget for this task is 60% used.');
  });

  it('keeps the last stop after later steps carry on, shows a normal finish too, and a custom code only if it is an identifier', () => {
    const guard = createGuard({ maxSteps: 1 });
    guard.check({});
    guard.check({});
    expect(guard.report()).toContain('Last stop: max-steps (MAX_STEPS)');
    expect(createGuard().check({ finishReason: 'stop' }).stop).toBe(true);
    const finished = createGuard();
    finished.check({ finishReason: 'stop' });
    expect(finished.report()).toContain('Last stop: finish-reason (FINISH_TERMINAL)');
    const custom = createGuard({ custom: () => ({ stop: true, code: `has spaces ${SECRET}` }) });
    custom.check({});
    expect(custom.report()).toContain('Last stop: custom (CUSTOM)');
    expect(custom.report()).not.toContain('SENTINEL');
    const named = createGuard({ custom: () => ({ stop: true, code: 'TOO_MANY_DELETES' }) });
    named.check({});
    expect(named.report()).toContain('Last stop: custom (TOO_MANY_DELETES)');
  });

  it('is deterministic: the same steps give the same text, however the arguments are ordered', () => {
    const run = (args: unknown): string => {
      const guard = createGuard();
      feed(guard, [step(call('a', args), call('b', args)), step(call('a', args))]);
      return guard.report();
    };
    expect(run({ x: 1, y: 2 })).toBe(run({ y: 2, x: 1 }));
    expect(createGuard().report()).toBe(createGuard().report());
  });

  it('never contains arguments, results, errors, text or odd tool names', () => {
    const guard = createGuard({ warnings: true });
    const secretCall = (name: string) => call(name, { token: SECRET }, { result: SECRET, error: new Error(SECRET) });
    feed(guard, [
      { text: SECRET, toolCalls: [secretCall('search'), secretCall(`weird name ${SECRET}`), secretCall('x'.repeat(65)), secretCall('')] },
      { text: SECRET, toolCalls: [secretCall('search')] },
    ]);
    const text = guard.report();
    expect(text.toLowerCase()).not.toContain('sentinel');
    expect(text).toContain('search 2');
    expect(text).toContain('other tools 3');
    expect(JSON.stringify(guard.report({ format: 'json' })).toLowerCase()).not.toContain('sentinel');
  });

  it('lists eight tools and sums the rest; counts at most 32 names, bounding memory', () => {
    const guard = createGuard(ONLY);
    for (let i = 0; i < 40; i += 1) guard.check(step(call(`tool_${String(i).padStart(2, '0')}`, i), call('busy', i)));
    const json = guard.report({ format: 'json' });
    expect(json.callsByTool).toHaveLength(32);
    expect(json.callsByTool[0]).toEqual({ tool: 'busy', calls: 40 });
    expect(json.otherToolCalls).toBe(40 - 31); // busy took one of the 32 slots; the last nine new names did not fit
    const lines = guard.report().split('\n');
    expect(lines[2]).toMatch(/^Tool calls: 80: busy 40, tool_00 1, tool_01 1, tool_02 1, tool_03 1, tool_04 1, tool_05 1, tool_06 1, other tools \d+$/);
    expect(guard.toJSON().callsByTool?.tools).toHaveLength(32);
  });

  it('does not change the guard, and only the literal "json" asks for the object', () => {
    const guard = createGuard({ warnings: true });
    feed(guard, [step(call('t', 1)), step(call('t', 1))]);
    const before = JSON.stringify([guard.summary(), guard.toJSON()]);
    for (let i = 0; i < 3; i += 1) guard.report();
    expect(JSON.stringify([guard.summary(), guard.toJSON()])).toBe(before);
    const text = guard.report();
    expect(guard.report({})).toBe(text);
    expect(guard.report({ format: 'text' })).toBe(text);
    expect(guard.report(null as unknown as undefined)).toBe(text);
    expect(guard.report({ format: 'yaml' as 'text' })).toBe(text);
  });

  it('reset() starts the report over', () => {
    const guard = createGuard({ maxSteps: 1 });
    guard.check(step(call('t')));
    guard.reset();
    expect(guard.report()).toBe(createGuard().report());
  });
});

// ---------------------------------------------------------------------------
describe('report: json', () => {
  it('has the documented shape, is plain data and carries the same facts as the text', () => {
    const guard = createGuard({ ...ONLY, warnings: true, repeatedToolCall: {} });
    feed(guard, [step(call('b', 1), call('a', 1, { error: 'x' })), step(call('a', 1)), step(call('a', 1))]);
    const json = guard.report({ format: 'json' });
    expect(json).toEqual({
      steps: 3,
      toolCalls: 4,
      failedToolCalls: 1,
      callsByTool: [
        { tool: 'a', calls: 3 },
        { tool: 'b', calls: 1 },
      ],
      otherToolCalls: 0,
      warnings: [],
      lastStop: { reason: 'repeated-tool-call', code: 'REPEATED_TOOL_CALL' },
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(Object.keys(json).sort()).toEqual(['callsByTool', 'failedToolCalls', 'lastStop', 'otherToolCalls', 'steps', 'toolCalls', 'warnings']);
  });

  it('is a fresh object each time, so changing it changes nothing', () => {
    const guard = createGuard();
    guard.check(step(call('t')));
    const a = guard.report({ format: 'json' });
    a.callsByTool.push({ tool: 'hacked', calls: 9 });
    a.steps = 99;
    expect(guard.report({ format: 'json' }).callsByTool).toEqual([{ tool: 't', calls: 1 }]);
    expect(guard.report({ format: 'json' }).steps).toBe(1);
  });

  it('is typed: the overloads give a string, an object, or either', () => {
    const guard = createGuard();
    expectTypeOf(guard.report()).toBeString();
    expectTypeOf(guard.report({ format: 'text' })).toBeString();
    expectTypeOf(guard.report({ format: 'json' })).toEqualTypeOf<GuardReport>();
    const format = 'json' as 'json' | 'text';
    expectTypeOf(guard.report({ format })).toEqualTypeOf<string | GuardReport>();
  });
});

// ---------------------------------------------------------------------------
describe('report: snapshots', () => {
  const options = (): GuardOptions => ({ tools: { think: { ignore: true } } });
  const trace = [step(call('search', 1), call('think', 1)), step(call('read', 1), call('search', 2, { error: 'x' })), step(call('search', 3))];

  it('a fresh guard writes the same snapshot as 0.2.0 (no callsByTool); one with calls writes it', () => {
    expect(createGuard().toJSON()).not.toHaveProperty('callsByTool');
    const guard = createGuard(options());
    feed(guard, trace);
    expect(guard.toJSON().callsByTool).toEqual({
      tools: [
        { tool: 'search', calls: 3 },
        { tool: 'think', calls: 1 },
        { tool: 'read', calls: 1 },
      ],
      other: 0,
    });
  });

  it('a restored guard reports the same counts, through JSON, and keeps counting', () => {
    const original = createGuard(options());
    feed(original, trace);
    const restored = restoreGuard(JSON.parse(JSON.stringify(original.toJSON())), options());
    const strip = (r: GuardReport): GuardReport => ({ ...r, warnings: [], lastStop: null });
    expect(strip(restored.report({ format: 'json' }))).toEqual(strip(original.report({ format: 'json' })));
    restored.check(step(call('read', 2)));
    original.check(step(call('read', 2)));
    expect(restored.report({ format: 'json' }).callsByTool).toEqual(original.report({ format: 'json' }).callsByTool);
    expect(restored.toJSON()).toEqual(original.toJSON());
  });

  it('a snapshot from 0.2.0 has no tally: the counts start at zero while steps and calls carry on', () => {
    const old = createGuard(options());
    feed(old, trace);
    const snapshot = old.toJSON() as unknown as Record<string, unknown>;
    delete snapshot['callsByTool'];
    const restored = restoreGuard(snapshot, options());
    expect(restored.report({ format: 'json' })).toMatchObject({ steps: 3, toolCalls: 5, callsByTool: [], otherToolCalls: 0 });
    restored.check(step(call('read', 1)));
    expect(restored.report({ format: 'json' }).callsByTool).toEqual([{ tool: 'read', calls: 1 }]);
  });

  describe('rejects a bad tally', () => {
    const base = (): GuardSnapshot => {
      const guard = createGuard(options());
      feed(guard, trace);
      return guard.toJSON();
    };
    const damaged = (change: (tally: Record<string, unknown>) => void): unknown => {
      const snapshot = structuredClone(base()) as unknown as { callsByTool: Record<string, unknown> };
      change(snapshot.callsByTool);
      return snapshot;
    };
    it.each([
      ['a tally that is not an object', (t: Record<string, unknown>) => Object.assign(t, { tools: 5 }), /callsByTool\.tools must be an array/],
      ['tools that are missing', (t: Record<string, unknown>) => delete t['tools'], /callsByTool\.tools is missing/],
      ['a negative other', (t: Record<string, unknown>) => (t['other'] = -1), /other must be a non-negative integer/],
      ['a missing other', (t: Record<string, unknown>) => delete t['other'], /other is missing/],
      ['more than 32 tools', (t: Record<string, unknown>) => (t['tools'] = Array.from({ length: 33 }, (_, i) => ({ tool: `t${i}`, calls: 0 }))), /at most 32 entries/],
      ['a repeated tool', (t: Record<string, unknown>) => (t['tools'] = [{ tool: 'a', calls: 1 }, { tool: 'a', calls: 1 }]), /repeats a tool/],
      ['an unusual tool name', (t: Record<string, unknown>) => (t['tools'] = [{ tool: 'has spaces', calls: 1 }]), /is not an ordinary tool name/],
      ['a name that is not a string', (t: Record<string, unknown>) => (t['tools'] = [{ tool: 5, calls: 1 }]), /tool must be a string/],
      ['a negative count', (t: Record<string, unknown>) => (t['tools'] = [{ tool: 'a', calls: -1 }]), /calls must be a non-negative integer/],
      ['more calls than the snapshot made', (t: Record<string, unknown>) => (t['other'] = 99), /counts more calls than the snapshot says/],
    ])('%s', (_name, change, message) => {
      const snapshot = damaged(change as (t: Record<string, unknown>) => void);
      expect(() => restoreGuard(snapshot, options())).toThrow(TypeError);
      expect(() => restoreGuard(snapshot, options())).toThrow(message);
    });

    it('and a tally that is not an object at all', () => {
      const snapshot = structuredClone(base()) as unknown as Record<string, unknown>;
      snapshot['callsByTool'] = [];
      expect(() => restoreGuard(snapshot, options())).toThrow(/snapshot\.callsByTool must be an object/);
    });
  });
});

// ---------------------------------------------------------------------------
describe('onDecision', () => {
  const record = (extra: GuardOptions = {}): { guard: Guard; events: DecisionEvent[] } => {
    const events: DecisionEvent[] = [];
    return { guard: createGuard({ ...extra, onDecision: (e) => void events.push(e) }), events };
  };

  it('is called after every check and every preflight, in order, with the phase and the decision', () => {
    const { guard, events } = record({ ...ONLY, repeatedToolCall: { threshold: 2 } });
    const v1 = guard.check(step(call('t', 1)));
    const p1 = guard.preflight({ name: 't', args: 1 });
    const p2 = guard.preflight({ name: 'u' });
    const v2 = guard.check(step(call('t', 1)));
    expect(events.map((e) => e.phase)).toEqual(['check', 'preflight', 'preflight', 'check']);
    expect(events[0]?.verdict).toEqual(v1);
    expect(events[1]?.verdict).toEqual(p1);
    expect(events[2]?.verdict).toEqual(p2);
    expect(events[3]?.verdict).toEqual(v2);
    expect(p1.allow).toBe(false);
    expect(v2.stop).toBe(true);
  });

  it('narrows by phase in TypeScript', () => {
    const { guard, events } = record();
    guard.check({});
    guard.preflight({ name: 't' });
    for (const e of events) {
      if (e.phase === 'check') expectTypeOf(e.verdict).toEqualTypeOf<Verdict>();
      else expectTypeOf(e.verdict).toEqualTypeOf<Preflight>();
    }
    expect(events).toHaveLength(2);
  });

  it('is not called for a check that throws', () => {
    const events: DecisionEvent[] = [];
    const guard = createGuard({
      custom: () => {
        throw new Error('detector bug');
      },
      onDecision: (e) => void events.push(e),
    });
    expect(() => guard.check({})).toThrow('detector bug');
    expect(events).toEqual([]);
  });

  it('gets a copy: changing it affects neither the verdict the caller holds nor the guard', () => {
    const guard = createGuard({
      ...ONLY,
      maxSteps: 1,
      onDecision: (e) => {
        if (e.phase === 'check' && e.verdict.stop) {
          (e.verdict as { code: string }).code = 'HACKED';
          e.verdict.evidence = null as never;
          delete (e.verdict as { feedback?: string }).feedback;
        }
      },
    });
    const verdict = guard.check({});
    expect(verdict).toMatchObject({ stop: true, code: 'MAX_STEPS', evidence: { steps: 1, limit: 1 } });
    expect(verdict.stop && verdict.feedback).toContain('step');
    expect(guard.summary().lastVerdict).toBe(verdict);
    expect(guard.report()).toContain('MAX_STEPS');
  });

  it('hands over the event itself when it cannot be copied (evidence with a function in it)', () => {
    const seen: unknown[] = [];
    const guard = createGuard({ custom: () => ({ stop: true, code: 'MINE', evidence: { run: () => 1 } }), onDecision: (e) => void seen.push(e) });
    guard.check({});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ phase: 'check', verdict: { code: 'MINE' } });
  });

  it('swallows what the hook throws, and the rejection of a promise it returns, and carries on', async () => {
    let calls = 0;
    const guard = createGuard({
      onDecision: () => {
        calls += 1;
        if (calls === 1) throw new Error('logging is down');
        if (calls === 2) throw 'a string';
        return Promise.reject(new Error('async logging is down')) as never;
      },
    });
    expect(guard.check(step(call('t'))).stop).toBe(false);
    expect(guard.check(step(call('t'))).stop).toBe(false);
    expect(guard.preflight({ name: 'u' }).allow).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5)); // an unhandled rejection would fail the run
    expect(calls).toBe(3);
    expect(guard.summary().steps).toBe(2);
    const thenable = createGuard({ onDecision: () => ({ then: (_ok: unknown, bad: (e: unknown) => void) => bad(new Error('x')) }) as never });
    expect(() => thenable.check({})).not.toThrow();
  });

  it('rejects check, preflight and reset from inside the hook with a clear Error, and leaves the guard intact', () => {
    const errors: string[] = [];
    const holder: { guard?: Guard } = {};
    const guard = createGuard({
      ...ONLY,
      repeatedToolCall: { threshold: 2 },
      onDecision: (e) => {
        if (e.phase !== 'check') return;
        for (const attempt of [() => holder.guard?.check({}), () => holder.guard?.preflight({ name: 'x' }), () => holder.guard?.reset()]) {
          try {
            attempt();
          } catch (error) {
            errors.push((error as Error).message);
          }
        }
      },
    });
    holder.guard = guard;
    guard.check(step(call('t', 1)));
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBe('agent-loopguard: guard.check() cannot be called from inside onDecision; the guard is still reporting a decision. Call it after the hook returns.');
    expect(errors[1]).toContain('guard.preflight() cannot be called from inside onDecision');
    expect(errors[2]).toContain('guard.reset() cannot be called from inside onDecision');
    // The step was recorded once and the state is exactly what a guard without a hook would have.
    const control = createGuard({ ...ONLY, repeatedToolCall: { threshold: 2 } });
    control.check(step(call('t', 1)));
    expect(guard.toJSON()).toEqual(control.toJSON());
    expect(guard.check(step(call('t', 1)))).toEqual(control.check(step(call('t', 1))));
  });

  it('a hook that does not catch the Error is swallowed like any other failure, and the guard works afterwards', () => {
    const guard: Guard = createGuard({
      onDecision: () => {
        guard.check({});
      },
    });
    expect(guard.check(step(call('t'))).stop).toBe(false);
    expect(guard.summary().steps).toBe(1);
    expect(guard.check({}).stop).toBe(false); // the guard is not stuck "inside the hook"
    expect(guard.summary().steps).toBe(2);
  });

  it('may read the guard from inside the hook, and use another guard', () => {
    const other = createGuard();
    const reads: string[] = [];
    const guard: Guard = createGuard({
      onDecision: () => {
        reads.push(guard.report(), JSON.stringify(guard.summary()), JSON.stringify(guard.toJSON()), String(guard.history.length));
        other.check({});
      },
    });
    guard.check(step(call('t')));
    expect(reads[0]).toBe('Loop guard status\nSteps: 1\nTool calls: 1: t 1');
    expect(reads[3]).toBe('1');
    expect(other.summary().steps).toBe(1);
  });

  it('sees warnings, denials and the verdict of a restored guard; is not part of the fingerprint', () => {
    const { guard, events } = record({ ...ONLY, warnings: true, repeatedToolCall: {} });
    guard.check(step(call('t', 1)));
    guard.check(step(call('t', 1)));
    expect((events[1]?.verdict as Verdict).warnings?.[0]?.code).toBe('REPEATED_TOOL_CALL_WARNING');
    const snapshot = guard.toJSON();
    const seen: DecisionEvent[] = [];
    const restored = restoreGuard(snapshot, { ...ONLY, warnings: true, repeatedToolCall: {}, onDecision: (e) => void seen.push(e) });
    expect(restored.preflight({ name: 't', args: 1 }).allow).toBe(false);
    expect(seen[0]).toMatchObject({ phase: 'preflight', verdict: { allow: false, code: 'REPEATED_TOOL_CALL' } });
    expect(() => restoreGuard(snapshot, { ...ONLY, warnings: true, repeatedToolCall: {} })).not.toThrow();
  });

  it('must be a function', () => {
    for (const bad of [5, 'log', {}, null]) {
      expect(() => createGuard({ onDecision: bad as never })).toThrow(/onDecision must be a function/);
    }
    expect(() => createGuard({ onDecision: undefined })).not.toThrow();
  });
});
