import type { BudgetMetric, FeedbackPhase, PreflightStopVerdict, StopVerdict } from './types';

/*
 * Model-facing feedback: short, plain English, written to be pasted into the model's next turn or
 * tool result.
 *
 * Privacy rule: the text is built only from fixed wording, counts and limits, and the tool NAME.
 * It never includes arguments, results, model text or provider strings, because those can carry
 * secrets or personal data and this text is meant to go back to the model (and into logs and
 * transcripts). `explain()` is the developer-facing view and does show arguments. A tool name is
 * used only if it looks like a normal identifier; anything else (the name is chosen by the model,
 * and could be long or contain anything) is replaced by "that tool".
 */

const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:/-]{1,64}$/;

function isSafeName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_TOOL_NAME.test(name);
}

function toolRef(name: unknown): string {
  return isSafeName(name) ? `\`${name}\`` : 'that tool';
}

function times(n: number): string {
  return `${n} time${n === 1 ? '' : 's'}`;
}

/** "`a`", "`a` and `b`", "`a`, `b` and `c`", or a generic phrase when a name is not safe to show. */
function toolList(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length === 0 || !unique.every(isSafeName)) return 'the same few tools';
  const refs = unique.map((n) => `\`${n}\``);
  return refs.length === 1 ? (refs[0] as string) : `${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1] as string}`;
}

const BUDGET_LABEL: Record<BudgetMetric, string> = {
  totalTokens: 'token',
  inputTokens: 'input token',
  outputTokens: 'output token',
  costUsd: 'cost',
  durationMs: 'time',
};

const ELSE = 'Try a different tool or different arguments, or answer with what you have.';

/**
 * The default model-facing text for a stop verdict, or `undefined` when there is none: a normal
 * `stop` finish (not a fault), and a `custom` verdict that did not bring its own `feedback`.
 *
 * `phase` is `'check'` (the default) for a verdict returned by `guard.check`, where the step has
 * already happened, and `'preflight'` for a call that `guard.preflight` refused to let run. The
 * text is deterministic: the same verdict always produces the same string.
 */
export function feedbackFor(verdict: PreflightStopVerdict, phase?: FeedbackPhase): string;
export function feedbackFor(verdict: StopVerdict, phase?: FeedbackPhase): string | undefined;
export function feedbackFor(verdict: StopVerdict, phase: FeedbackPhase = 'check'): string | undefined {
  const before = phase === 'preflight';
  switch (verdict.reason) {
    case 'max-steps':
      return before
        ? 'That call was not run because the step limit for this task has been reached. Do not call any more tools; answer with what you have so far.'
        : 'You have reached the limit on how many steps this task may take. Do not call any more tools; answer with what you have so far.';

    case 'tool-limit': {
      const { tool, calls, limit } = verdict.evidence;
      if (limit === 0) {
        return before
          ? `That call was not run: you may not use ${toolRef(tool)} in this task. Use a different tool, or answer with what you have.`
          : `You may not use ${toolRef(tool)} in this task. Use a different tool, or answer with what you have.`;
      }
      return before
        ? `That call was not run: you have already used ${toolRef(tool)} ${times(limit)}, the most allowed for it in this task. Use a different tool, or answer with what you have.`
        : `You have called ${toolRef(tool)} ${times(calls)}, more than the ${limit} allowed for it in this task. Do not call it again; use a different tool, or answer with what you have.`;
    }

    case 'repeated-tool-call': {
      const { tool, count, identicalResults } = verdict.evidence;
      const same = identicalResults ? ' and got the same result each time' : '';
      if (before) {
        return `That call was not run: you have already called ${toolRef(tool)} ${times(count - 1)} in a row with the same arguments${same}, and repeating it is unlikely to give you anything new. ${ELSE}`;
      }
      return `You have called ${toolRef(tool)} ${times(count)} in a row with the same arguments${same}. Repeating it is unlikely to give you anything new. ${ELSE}`;
    }

    case 'oscillation': {
      const list = toolList(verdict.evidence.tools);
      return before
        ? `That call was not run because it would continue a cycle you are stuck in (${list}). Try a different approach, or answer with what you have.`
        : `You are going round in a cycle of calls (${list}) without getting anywhere. Stop repeating it: try a different approach, or answer with what you have.`;
    }

    case 'no-progress':
      return `Your last ${verdict.evidence.steps} steps added nothing new: no new tool results and the same text. Do something different, such as using another tool or approach, or answer with what you have.`;

    case 'finish-reason':
      return finishReasonFeedback(verdict);

    case 'budget': {
      const label = BUDGET_LABEL[verdict.evidence.metric];
      return before
        ? `That call was not run because the ${label} budget for this task has been used up. Answer with what you have.`
        : `The ${label} budget for this task has been used up. Do not start any new work; answer with what you have.`;
    }

    case 'custom':
      return verdict.feedback;
  }
}

function finishReasonFeedback(verdict: Extract<StopVerdict, { reason: 'finish-reason' }>): string | undefined {
  if (verdict.code === 'FINISH_OTHER') {
    return 'Your last step ended without a clear signal that you were finished. If you are done, give your final answer; otherwise continue with a tool call.';
  }
  if (verdict.code === 'FINISH_OTHER_TEXT_ONLY') {
    return 'Your last step was a text answer with no clear signal that you were finished. If that was your final answer, you are done; otherwise call a tool to continue.';
  }
  switch (verdict.evidence.normalized) {
    case 'stop':
      return undefined; // the model finished normally: nothing went wrong
    case 'length':
      return 'Your last response was cut off because it reached the length limit. Continue more briefly, or give a short answer with what you have.';
    case 'content-filter':
      return 'Your last response was blocked by a content filter. Rephrase it or take a different approach.';
    case 'error':
      return 'The last step ended with an error from the provider. Try again, or answer with what you have.';
    default:
      return 'The last step ended in a way that ends this run. Give your final answer with what you have.';
  }
}
