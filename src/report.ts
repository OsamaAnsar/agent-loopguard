import type { GuardReport, GuardWarning, StopReason, Verdict } from './types';
import { feedbackForWarning } from './warnings';

/** A stop code is shown in a report only if it looks like an identifier (a custom detector chooses its own); otherwise it shows as `CUSTOM`. */
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Tools listed by name in the text report; the rest are summed. */
const LISTED_TOOLS = 8;

/** Only the reason and code of a stop are kept: enough for a report, nothing from the arguments or results. */
export function lastStopOf(verdict: Verdict): { reason: StopReason; code: string } | undefined {
  if (!verdict.stop) return undefined;
  return { reason: verdict.reason, code: SAFE_CODE.test(verdict.code) ? verdict.code : 'CUSTOM' };
}

export interface ReportInput {
  steps: number;
  toolCalls: number;
  failedToolCalls: number;
  tools: Array<{ tool: string; calls: number }>;
  other: number;
  warnings: readonly GuardWarning[];
  lastStop: { reason: StopReason; code: string } | null;
}

export function buildReport(input: ReportInput): GuardReport {
  const callsByTool = [...input.tools].sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
  return {
    steps: input.steps,
    toolCalls: input.toolCalls,
    failedToolCalls: input.failedToolCalls,
    callsByTool,
    otherToolCalls: input.other,
    warnings: input.warnings.map((w) => ({ code: w.code, message: feedbackForWarning(w) })),
    lastStop: input.lastStop === null ? null : { ...input.lastStop },
  };
}

/** The text form: one fact per line, the same words for the same facts. */
export function renderReport(report: GuardReport): string {
  const lines = ['Loop guard status', `Steps: ${report.steps}`];

  let calls = `Tool calls: ${report.toolCalls}`;
  if (report.failedToolCalls > 0) calls += ` (${report.failedToolCalls} failed)`;
  const listed = report.callsByTool.slice(0, LISTED_TOOLS).map((t) => `${t.tool} ${t.calls}`);
  const rest = report.callsByTool.slice(LISTED_TOOLS).reduce((sum, t) => sum + t.calls, 0) + report.otherToolCalls;
  if (rest > 0) listed.push(`other tools ${rest}`);
  if (listed.length > 0) calls += `: ${listed.join(', ')}`;
  lines.push(calls);

  if (report.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of report.warnings) lines.push(`- ${warning.message}`);
  }
  if (report.lastStop !== null) lines.push(`Last stop: ${report.lastStop.reason} (${report.lastStop.code})`);
  return lines.join('\n');
}
