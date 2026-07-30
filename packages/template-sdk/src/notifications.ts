import { z } from 'zod';

/**
 * Notifications.
 *
 * Descriptors and a builder. No transport: no email client, no SMS gateway, no push service, no
 * Telegram call. A template declares *what* it notifies about and the deployment decides how —
 * which is the only arrangement that survives a product being sold to a customer whose compliance
 * team will not allow the vendor you picked.
 *
 * The part worth encoding is templating discipline. A notification is assembled from a body with
 * `{placeholders}` and a set of values, and two rules apply:
 *
 *   1. **A missing value fails loudly.** The alternative ships "Dear {name}," to a customer, and
 *      the person who notices is the customer.
 *   2. **Sensitive values are never interpolated.** A notification body is written to a log, a
 *      queue, a provider's dashboard and often a delivery receipt. A balance, an OTP or an
 *      account number in that chain is a leak with four copies. `notificationSchema` refuses the
 *      body outright rather than redacting it later, because "later" is after it was queued.
 */

export const NOTIFICATION_CHANNELS = ['inApp', 'email', 'sms', 'push', 'webhook'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'success', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * Placeholders that must never appear in a notification body.
 *
 * Matched on the placeholder name, before any value is substituted — so the refusal happens at
 * authoring time, in a test, rather than at send time in production.
 */
const FORBIDDEN_PLACEHOLDERS =
  /\{\s*(otp|pin|password|secret|token|balance|cardNumber|pan|cvv|accountNumber|nationalId)\s*\}/i;

export const notificationTemplateSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/, 'Must be a dotted lowercase key.'),
    /** What this notification is for. Read by whoever is deciding whether to switch it off. */
    description: z.string().min(1).max(300),
    channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(1),
    severity: z.enum(NOTIFICATION_SEVERITIES).default('info'),
    subject: z.string().min(1).max(160),
    body: z.string().min(1).max(2000),
    /** Names that must be supplied at send time. Checked against the body. */
    variables: z.array(z.string().regex(/^[a-z][a-zA-Z0-9]*$/)).default([]),
    /** Deep link opened when the notification is tapped. Relative to the application root. */
    href: z.string().max(300).optional(),
    /**
     * Whether a recipient may switch this off.
     *
     * False for the few that are not marketing: a password change, a login from a new device, a
     * large withdrawal. A product where those can be silenced is a product where an attacker
     * silences them first.
     */
    optional: z.boolean().default(true),
  })
  .strict()
  .superRefine((template, ctx) => {
    for (const field of ['subject', 'body'] as const) {
      if (FORBIDDEN_PLACEHOLDERS.test(template[field])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message:
            'A notification may not carry a secret or a balance. The body reaches logs, queues ' +
            'and the delivery provider — send a link to the screen that shows it instead.',
        });
      }
    }

    const used = new Set(
      [...`${template.subject} ${template.body}`.matchAll(/\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}/g)].map(
        (match) => match[1] as string,
      ),
    );

    for (const name of used) {
      if (!template.variables.includes(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['variables'],
          message: `"{${name}}" is used but not declared, so nothing checks that it is supplied.`,
        });
      }
    }

    for (const name of template.variables) {
      if (!used.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['variables'],
          message: `"${name}" is declared but never used — a value nobody reads is a value that rots.`,
        });
      }
    }
  });

export type NotificationTemplate = z.infer<typeof notificationTemplateSchema>;

export interface BuiltNotification {
  key: string;
  channels: NotificationChannel[];
  severity: NotificationSeverity;
  subject: string;
  body: string;
  href?: string;
}

/**
 * Substitutes values into a template.
 *
 * Throws on a missing value rather than leaving the placeholder or emptying it. See rule 1 in the
 * header: the failure mode of being lenient here is a message a customer reads.
 */
export function buildNotification(
  template: NotificationTemplate,
  values: Record<string, string | number>,
): BuiltNotification {
  const missing = template.variables.filter((name) => values[name] === undefined);

  if (missing.length > 0) {
    throw new Error(
      `Notification "${template.key}" is missing value(s) for: ${missing.join(', ')}. ` +
        'Sending it would deliver a literal placeholder to a recipient.',
    );
  }

  const substitute = (text: string): string =>
    text.replace(/\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}/g, (_match, name: string) =>
      String(values[name]),
    );

  return {
    key: template.key,
    channels: template.channels,
    severity: template.severity,
    subject: substitute(template.subject),
    body: substitute(template.body),
    href: template.href,
  };
}

/**
 * The channels to actually send on, given a recipient's preferences.
 *
 * A non-optional notification ignores preferences entirely — see `optional` above. Everything
 * else is intersected, and an intersection that comes out empty means the recipient has opted out
 * of all of them, which is an answer rather than a bug.
 */
export function resolveChannels(
  template: NotificationTemplate,
  muted: readonly NotificationChannel[],
): NotificationChannel[] {
  if (!template.optional) return template.channels;
  return template.channels.filter((channel) => !muted.includes(channel));
}
