import type { WorkflowInstanceRow, WorkflowTaskRow } from './store';

/**
 * What happens when an approval breaches its SLA.
 *
 * A port, not a behaviour: escalation means "page the duty manager" in one
 * product and "email the approver's manager" in another, and neither belongs in a
 * framework module. Wire it to the notification module, to a pager, or to nothing.
 */
export interface EscalationEvent {
  task: WorkflowTaskRow;
  instance: WorkflowInstanceRow;
  organizationId: string;
  overdueMinutes: number;
}

export interface EscalationHook {
  readonly id: string;
  onBreach(event: EscalationEvent): Promise<void>;
}

/**
 * The default hook: records the breach and does nothing else.
 *
 * Deliberately not a no-op that discards the event — the recorded list is what a
 * test asserts on, and what an application inspects while deciding what its own
 * hook should do.
 */
export class RecordingEscalationHook implements EscalationHook {
  readonly id = 'recording';
  readonly events: EscalationEvent[] = [];

  async onBreach(event: EscalationEvent): Promise<void> {
    this.events.push(event);
  }
}
