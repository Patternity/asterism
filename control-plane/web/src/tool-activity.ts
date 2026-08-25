/**
 * What the agent actually did, summarised for a conversation.
 *
 * The run journal records one `tool.started` and one `tool.completed` per
 * invocation. Listed raw, that is a wall of repeated event names — nine
 * `read_file` lines say nothing a reader could not have guessed, and the thing
 * they would want to know, *which* tool, is one field further in.
 *
 * So this collapses the journal into one line per tool: how many times it ran,
 * whether any of those failed, and whether one is still running. That is the
 * question a chat can answer usefully. Anything finer belongs on the run detail
 * page, where a per-event timeline is what the reader came for.
 */
import type { RunEvent } from './types';

export interface ToolUse {
  /** The tool's own name, as the runtime reported it. */
  tool: string;
  /** How many times it was invoked in this run. */
  count: number;
  /**
   * How many invocations reported an error.
   *
   * A count rather than a flag: three failures out of forty-eight is a run that
   * recovered, and forty out of forty-eight is a run that did not. A boolean
   * renders both as the same word.
   */
  failures: number;
  /** Started and not yet finished. */
  running: boolean;
}

const STARTED = 'tool.started';
const COMPLETED = 'tool.completed';

function nameOf(event: RunEvent): string | null {
  // The runtime calls this field `tool`. An earlier version of this screen read
  // `name`, which is why it rendered a row of empty labels.
  const value = event.payload?.tool;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Collapse tool events into one entry per tool, in the order each first ran.
 *
 * Unnamed events still count: dropping them would quietly under-report activity,
 * and a wrong total is worse than an ugly label.
 */
export function summarizeToolActivity(events: RunEvent[]): ToolUse[] {
  const order: string[] = [];
  const byTool = new Map<string, { started: number; completed: number; failures: number }>();

  for (const event of events) {
    if (event.event_type !== STARTED && event.event_type !== COMPLETED) continue;
    const tool = nameOf(event) ?? 'unnamed tool';
    let entry = byTool.get(tool);
    if (!entry) {
      entry = { started: 0, completed: 0, failures: 0 };
      byTool.set(tool, entry);
      order.push(tool);
    }
    if (event.event_type === STARTED) entry.started += 1;
    else {
      entry.completed += 1;
      if (event.payload?.error === true) entry.failures += 1;
    }
  }

  return order.map((tool) => {
    const entry = byTool.get(tool)!;
    return {
      tool,
      // A completion without its start still counts as one invocation, so a
      // truncated journal does not report zero.
      count: Math.max(entry.started, entry.completed),
      failures: entry.failures,
      running: entry.started > entry.completed,
    };
  });
}

/** One tool per entry: `read_file ×9`, `terminal ×48 (3 failed)`. */
export function describeToolUse(use: ToolUse): string {
  const count = use.count > 1 ? ` ×${use.count}` : '';
  const outcome =
    use.failures === 0
      ? ''
      : use.failures === use.count
        ? ' (failed)'
        : ` (${use.failures} failed)`;
  return `${use.tool}${count}${outcome}`;
}
