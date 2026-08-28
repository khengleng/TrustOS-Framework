import { ApiError } from '@trustos/errors';

/**
 * The message template engine.
 *
 * This is deliberately **not** a template language. A message template is
 * authored by a customer through the API, which makes it untrusted input, and
 * compiling untrusted input with a real template engine is server-side template
 * injection: Handlebars, Nunjucks and EJS all expose enough of the runtime from
 * inside a template to read the process environment or execute code.
 *
 * So substitution here is literal and total:
 *
 *   * `{{name}}` is replaced by the value of the declared variable `name`
 *   * nothing else is interpreted — no expressions, no helpers, no property
 *     traversal, no partials, no loops, no conditionals
 *   * a placeholder for a variable the template did not declare is a validation
 *     error at authoring time, not a silent empty string at send time
 *   * `\{{` renders a literal `{{`, for the rare message that needs braces
 *
 * The cost is that a template cannot format a date or pluralise a noun. That
 * belongs to the caller, which has types and a test suite; a template does not.
 */

/** `{{ name }}` — the only construct the engine recognises. */
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** `\{{` — an escaped opening brace pair. */
const ESCAPED_OPEN = /\\\{\{/g;
/**
 * Placeholder stand-in for an escaped `\{{`.
 *
 * Null bytes rather than a printable marker, and written as escapes rather than
 * literal bytes: a template body is rejected if it contains a null byte, so this
 * sentinel cannot collide with anything a customer authored.
 */
const ESCAPE_SENTINEL = '\u0000TRUSTOS_OPEN\u0000';

export const MAX_TEMPLATE_LENGTH = 20_000;
export const MAX_VARIABLE_VALUE_LENGTH = 4_000;

export interface MessageTemplateBody {
  /** Subject line, for channels that have one. */
  subject: string;
  body: string;
}

/** Variable names referenced by a template body, in order of first appearance. */
export function collectPlaceholders(source: string): string[] {
  const found: string[] = [];

  for (const match of protect(source).matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Checks a template against its declared variables.
 *
 * Runs when a template is created or updated, so an unresolvable placeholder is
 * caught by the person authoring it rather than discovered when a message fails
 * to render for a customer.
 */
export function validateTemplate(template: MessageTemplateBody, declaredVariables: string[]): void {
  const declared = new Set(declaredVariables);
  const problems: Array<{ path: string; message: string }> = [];

  for (const field of ['subject', 'body'] as const) {
    const source = template[field];

    if (source.length > MAX_TEMPLATE_LENGTH) {
      problems.push({ path: field, message: `Longer than ${MAX_TEMPLATE_LENGTH} characters.` });
      continue;
    }

    // Enforces the assumption the escape sentinel relies on.
    if (source.includes('\u0000')) {
      problems.push({ path: field, message: 'Must not contain a null byte.' });
      continue;
    }

    for (const name of collectPlaceholders(source)) {
      if (!declared.has(name)) {
        problems.push({ path: field, message: `Undeclared variable "${name}".` });
      }
    }

    // An unmatched `{{` is almost always a typo in a placeholder, and it would
    // otherwise be delivered to a customer verbatim.
    const stripped = protect(source).replace(PLACEHOLDER, '');
    if (stripped.includes('{{')) {
      problems.push({ path: field, message: 'Unclosed or malformed placeholder.' });
    }
  }

  if (problems.length > 0) {
    throw ApiError.validation(problems, 'The message template is not valid.');
  }
}

/**
 * Renders a template.
 *
 * Every declared variable must have a value. A missing value is an error rather
 * than an empty string, because "Dear ," reaching a customer is worse than a
 * failed send that is retried after the caller is fixed.
 */
export function renderTemplate(
  template: MessageTemplateBody,
  declaredVariables: string[],
  values: Record<string, string>,
): MessageTemplateBody {
  const missing = declaredVariables.filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    throw ApiError.validation(
      missing.map((name) => ({ path: `variables.${name}`, message: 'Required.' })),
      `Missing template variables: ${missing.join(', ')}.`,
    );
  }

  const tooLong = Object.entries(values).filter(
    ([, value]) => String(value).length > MAX_VARIABLE_VALUE_LENGTH,
  );
  if (tooLong.length > 0) {
    throw ApiError.validation(
      tooLong.map(([name]) => ({
        path: `variables.${name}`,
        message: `Longer than ${MAX_VARIABLE_VALUE_LENGTH} characters.`,
      })),
      'A template variable value is too long.',
    );
  }

  return {
    subject: substitute(template.subject, values),
    body: substitute(template.body, values),
  };
}

/**
 * Replaces placeholders in one pass.
 *
 * One pass matters: substituting repeatedly would let a value containing
 * `{{other}}` be expanded on the next pass, which is how a customer-supplied
 * value would reach another variable's content.
 */
function substitute(source: string, values: Record<string, string>): string {
  const protectedSource = protect(source);

  const rendered = protectedSource.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values[name];
    // A placeholder that survived validation but has no value renders as itself
    // rather than as nothing, so the failure is visible in the output.
    return value === undefined ? whole : String(value);
  });

  return restore(rendered);
}

function protect(source: string): string {
  return source.replace(ESCAPED_OPEN, ESCAPE_SENTINEL);
}

function restore(source: string): string {
  return source.split(ESCAPE_SENTINEL).join('{{');
}

/**
 * Escapes a value for an HTML email body.
 *
 * Offered as a helper for callers that build HTML, not applied automatically:
 * the engine does not know whether a given template is plain text, HTML or a
 * webhook payload, and escaping a JSON payload would corrupt it.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
