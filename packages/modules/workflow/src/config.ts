import { z } from 'zod';

/**
 * Workflow configuration.
 *
 * `defaultSlaMinutes` applies to a step that does not declare its own. Four hours
 * is short enough that a stalled approval is noticed the same working day, which
 * is the point of tracking it at all.
 */
export const workflowConfigSchema = z
  .object({
    defaultSlaMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 30)
      .default(240),

    /** Run escalation hooks when a task breaches its SLA. */
    escalationEnabled: z.boolean().default(true),

    /** Escalations processed per `runEscalations` call. */
    escalationBatchSize: z.number().int().min(1).max(500).default(50),
  })
  .strict();

export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;
