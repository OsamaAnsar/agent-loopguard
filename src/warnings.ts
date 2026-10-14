import { BUDGET_LABEL, ELSE, times, toolList, toolRef } from './feedback';
import type {
  GuardWarning,
  NoProgressEvidence,
  NoProgressWarning,
  OscillationEvidence,
  OscillationWarning,
  RepeatedToolCallEvidence,
  RepeatedToolCallWarning,
  RepeatedToolCallWindowEvidence,
  RepeatedToolCallWindowWarning,
  ToolLimitEvidence,
  ToolLimitWarning,
} from './types';

/*
 * Early warnings: the loop rules' version of a stop, one step short of it. They are built from the
 * same evidence as the stop would be (the counts are still below the threshold) and follow the same
 * privacy rule for the model-facing text: fixed wording, counts, and the tool NAME if it looks like an
 * identifier. Never arguments, results or model text. `detail` is the developer's view and does show
 * an argument preview, like a stop's `detail`.
 */

/** "once more" / "3 more times": how much more of the same ends the run. */
function more(left: number): string {
  return left === 1 ? 'once more' : `${times(left)} more`;
}

export function repeatWarning(e: RepeatedToolCallEvidence): RepeatedToolCallWarning {
  const left = e.threshold - e.count;
  const results = e.identicalResults ? ' and identical results' : '';
  const same = e.identicalResults ? ' and got the same result each time' : '';
  return {
    code: 'REPEATED_TOOL_CALL_WARNING',
    detail: `Tool "${e.tool}" has been called ${e.count} times in a row with identical arguments${results} (the limit is ${e.threshold}): ${e.tool}(${e.argsPreview}).`,
    feedback: `You have called ${toolRef(e.tool)} ${times(e.count)} in a row with the same arguments${same}. Calling it that way ${more(left)} will stop this task. ${ELSE}`,
    evidence: e,
  };
}

export function windowWarning(e: RepeatedToolCallWindowEvidence): RepeatedToolCallWindowWarning {
  const left = e.threshold - e.count;
  const results = e.identicalResults ? ' and identical results' : '';
  const same = e.identicalResults ? ' and got the same result each time' : '';
  return {
    code: 'REPEATED_TOOL_CALL_WINDOW_WARNING',
    detail: `Tool "${e.tool}" has been called ${e.count} times with identical arguments${results} within the last ${e.windowSize} calls (the limit is ${e.threshold}): ${e.tool}(${e.argsPreview}).`,
    feedback: `You have called ${toolRef(e.tool)} ${times(e.count)} with the same arguments${same} within your last ${e.windowSize} calls, even with other calls in between. Calling it that way ${more(left)} will stop this task. ${ELSE}`,
    evidence: e,
  };
}

export function oscillationWarning(e: OscillationEvidence): OscillationWarning {
  const left = e.threshold - e.repeats;
  return {
    code: 'OSCILLATION_WARNING',
    detail: `The agent may be oscillating: a cycle of ${e.period} calls (${e.cycle.join(' -> ')}) has repeated ${e.repeats} times in a row (the limit is ${e.threshold}).`,
    feedback: `You may be going round in a cycle of calls (${toolList(e.tools)}). Going round ${more(left)} will stop this task: try a different approach, or answer with what you have.`,
    evidence: e,
  };
}

export function noProgressWarning(e: NoProgressEvidence): NoProgressWarning {
  const left = e.threshold - e.steps;
  const what =
    e.textPreview === ''
      ? `${e.steps} consecutive steps have produced no new tool results and no text`
      : `${e.steps} consecutive steps have repeated the same text and produced no new tool results ("${e.textPreview}")`;
  return {
    code: 'NO_PROGRESS_WARNING',
    detail: `No progress: ${what} (the limit is ${e.threshold}).`,
    feedback: `Your last ${e.steps} steps added nothing new: no new tool results and the same text. ${left === 1 ? 'One more step like that' : `${left} more steps like that`} will stop this task. Do something different, such as using another tool or approach, or answer with what you have.`,
    evidence: e,
  };
}

export function toolLimitWarning(e: ToolLimitEvidence): ToolLimitWarning {
  const left = e.limit - e.calls;
  return {
    code: 'TOOL_CALL_CAP_WARNING',
    detail:
      left === 0
        ? `Tool "${e.tool}" has been called ${e.calls} times, all that its limit of ${e.limit} allows; the next call stops the run.`
        : `Tool "${e.tool}" has been called ${e.calls} of the ${e.limit} times its limit allows.`,
    feedback:
      left === 0
        ? `You have used ${toolRef(e.tool)} ${times(e.limit)}, the most allowed for it in this task. Do not call it again; use a different tool, or answer with what you have.`
        : `You have used ${toolRef(e.tool)} ${e.calls} of the ${e.limit} times allowed for it in this task (${left} left). Use the rest sparingly, or answer with what you have.`,
    evidence: e,
  };
}

/**
 * Model-facing text for any warning: the `feedback` field of a loop warning, and fixed wording for a
 * budget warning (which has none of its own). Built from counts only, so it is safe to send to the model.
 */
export function feedbackForWarning(warning: GuardWarning): string {
  if (warning.code === 'BUDGET_WARNING') {
    return `The ${BUDGET_LABEL[warning.metric]} budget for this task is ${Math.round(warning.ratio * 100)}% used. Plan to wrap up soon, and answer with what you have when you can.`;
  }
  return warning.feedback;
}
