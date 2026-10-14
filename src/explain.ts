import type { StopVerdict, Verdict } from './types';

function hint(verdict: StopVerdict): string {
  switch (verdict.reason) {
    case 'max-steps':
      return 'Raise maxSteps if the task really needs more steps; otherwise find out why the agent is not converging.';
    case 'repeated-tool-call':
      return 'The model keeps issuing the same call. Check that the tool result gives it something to act on, and that the prompt says what to do when a tool fails.';
    case 'oscillation':
      return 'The model is flipping between the same calls. Look for two tools whose results send the model back to each other.';
    case 'no-progress':
      return 'Nothing new is coming back and the model is not saying anything new. Retrying the same request will not help.';
    case 'finish-reason':
      return verdict.evidence.normalized === 'stop'
        ? 'This is the normal end of a run, not a fault.'
        : 'The provider ended this step in a way the loop does not treat as "keep going". Inspect the raw response.';
    case 'budget':
      return 'Raise the limit, shorten the context, or split the task.';
    case 'custom':
      return 'Stopped by a custom detector.';
  }
}

/** True for a stop verdict that is not just the model finishing normally (`finishReason: 'stop'`). */
export function isFault(verdict: Verdict): verdict is StopVerdict {
  if (!verdict.stop) return false;
  return !(verdict.reason === 'finish-reason' && verdict.evidence.normalized === 'stop');
}

/** Turn a verdict into readable text for logs and error messages. Never throws. */
export function explain(verdict: Verdict): string {
  const lines: string[] = [];
  if (verdict.stop) {
    lines.push(`Stop [${verdict.code}] ${verdict.detail}`);
    lines.push(`Hint: ${hint(verdict)}`);
  } else {
    lines.push('Continue.');
  }
  for (const warning of verdict.warnings ?? []) lines.push(`Warning [${warning.code}] ${warning.detail}`);
  return lines.join('\n');
}
