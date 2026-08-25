/**
 * Agreements the console depends on but cannot enforce at a type level.
 */
import { describe, expect, it } from 'vitest';

import { pendingApproval } from '../src/run-policy';
import { EVENT_TYPES } from '../src/sse';

describe('the live stream carries everything the console reasons about', () => {
  /**
   * Event types the console interprets, as opposed to merely lists. Each one is
   * read by a model helper to decide what to render; a type absent from the
   * stream's subscription list reaches the browser only after a reload, which
   * is how a resolved approval could keep showing its prompt.
   */
  const INTERPRETED = [
    'approval.request',
    'approval.responded',
    'approval.auto_resolved',
    'asterism.approval.decision',
    'run.approval_policy.changed',
    'tool.started',
    'tool.completed',
    'message.delta',
    'asterism.run.terminal',
  ];

  it.each(INTERPRETED)('subscribes to %s', (type) => {
    expect(EVENT_TYPES).toContain(type);
  });

  it('clears a prompt once the stream reports the answer', () => {
    // The end-to-end property the subscription list exists for.
    const events = [
      { event_type: 'approval.request', payload: { description: 'Run a command' } },
      { event_type: 'approval.auto_resolved', payload: { choice: 'once' } },
    ];
    for (const event of events) expect(EVENT_TYPES).toContain(event.event_type);
    expect(pendingApproval(events)).toBeNull();
  });
});
