import { ApiError } from '@trustsystem/errors';
import { z } from 'zod';

/**
 * Prompt templates.
 *
 * A restricted substitution language, and the restriction is the point. This is the same decision
 * the workflow condition language made in phase 5, for the same reason: a template engine that
 * can execute is a template engine an attacker can execute, and the values substituted here come
 * from user input.
 *
 * What is supported:
 *
 *     {{variable}}                       substitution
 *     {{#if variable}}...{{/if}}         a section, present when the variable is truthy
 *     {{#unless variable}}...{{/unless}} the inverse
 *     {{#each items}}...{{/each}}        repetition, with {{.}} for the item
 *     {{> component}}                    include another registered component
 *
 * What is **not**, deliberately: expressions, comparisons, arithmetic, function calls, property
 * paths with `[]`, and anything resembling a scripting language. A prompt that needs logic should
 * have that logic in the code that builds its variables, where it can be tested.
 *
 * The other rule: **a substituted value is never re-scanned for template syntax.** A user whose
 * name is `{{#each secrets}}` gets a literal name, not a loop. That single line is the difference
 * between a template engine and a server-side template injection.
 */

export const VARIABLE_TYPES = ['string', 'number', 'boolean', 'string_list'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const promptVariableSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9_]*$/, 'A variable name is lowercase, starting with a letter.'),
    type: z.enum(VARIABLE_TYPES),
    description: z.string().min(1).max(500),
    required: z.boolean().default(true),
    /** Used when the variable is absent and not required. */
    defaultValue: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
    /**
     * Marks a variable as carrying user input rather than application data.
     *
     * Drives two things: prompt-injection scanning applies to these and not to the rest, and the
     * audit record redacts them. A variable holding a support ticket body is untrusted; one
     * holding a tenant's configured tone of voice is not.
     */
    untrusted: z.boolean().default(false),
    /** Ceiling on the substituted length. An unbounded value is a context-window overflow. */
    maxLength: z.number().int().min(1).max(1_000_000).default(50_000),
  })
  .strict();

export type PromptVariable = z.infer<typeof promptVariableSchema>;

export type VariableValue = string | number | boolean | string[] | null | undefined;

const MAX_INCLUDE_DEPTH = 5;
const MAX_LOOP_ITEMS = 1000;

export interface RenderOptions {
  /** Reusable fragments, by name, for `{{> component}}`. */
  components?: Record<string, string>;
  /** Locale-specific overrides of the whole template, by locale key. */
  locale?: string;
  localizedTemplates?: Record<string, string>;
}

export interface RenderResult {
  text: string;
  /** Variables the template actually used. For the audit record and for dead-variable checks. */
  used: string[];
  /** Declared but never referenced. A signal the template and its schema have drifted. */
  unused: string[];
}

/**
 * Renders a template.
 *
 * Single-pass over the source. Substituted values are inserted verbatim and never re-parsed —
 * see the header.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, VariableValue>,
  declared: PromptVariable[] = [],
  options: RenderOptions = {},
): RenderResult {
  const source = (options.locale && options.localizedTemplates?.[options.locale]) ?? template;

  const used = new Set<string>();
  const byName = new Map(declared.map((variable) => [variable.name, variable]));

  const resolved = resolveVariables(variables, declared);
  const text = render(source, resolved, used, byName, options, 0);

  return {
    text,
    used: [...used].sort(),
    unused: declared
      .map((variable) => variable.name)
      .filter((name) => !used.has(name))
      .sort(),
  };
}

/** Applies defaults and checks required variables and length limits. */
function resolveVariables(
  supplied: Record<string, VariableValue>,
  declared: PromptVariable[],
): Record<string, VariableValue> {
  const resolved: Record<string, VariableValue> = { ...supplied };
  const problems: Array<{ path: string; message: string }> = [];

  for (const variable of declared) {
    const value = resolved[variable.name];
    const missing = value === undefined || value === null;

    if (missing && variable.defaultValue !== undefined) {
      resolved[variable.name] = variable.defaultValue;
      continue;
    }

    if (missing && variable.required) {
      problems.push({
        path: variable.name,
        message: `"${variable.name}" is required: ${variable.description}`,
      });
      continue;
    }

    if (missing) continue;

    const text = stringify(value);
    if (text.length > variable.maxLength) {
      // Refused rather than truncated: a silently truncated variable produces a prompt that reads
      // as complete and is missing the end of the thing it was asked about.
      problems.push({
        path: variable.name,
        message:
          `"${variable.name}" is ${text.length} characters and the limit is ${variable.maxLength}. ` +
          'Summarise or chunk it before rendering; truncating here would produce a prompt that ' +
          'looks complete and is not.',
      });
    }

    if (variable.type === 'string_list' && !Array.isArray(value)) {
      problems.push({
        path: variable.name,
        message: `"${variable.name}" is declared as a list and a ${typeof value} was supplied.`,
      });
    }

    if (variable.type === 'number' && typeof value !== 'number') {
      problems.push({
        path: variable.name,
        message: `"${variable.name}" is declared as a number and a ${typeof value} was supplied.`,
      });
    }
  }

  if (problems.length > 0) {
    throw ApiError.validation(problems, 'This prompt cannot be rendered with these variables.');
  }

  return resolved;
}

function render(
  source: string,
  variables: Record<string, VariableValue>,
  used: Set<string>,
  declared: Map<string, PromptVariable>,
  options: RenderOptions,
  depth: number,
): string {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw ApiError.validation(
      [
        {
          path: 'template',
          message:
            `Component includes nested more than ${MAX_INCLUDE_DEPTH} deep. This is almost ` +
            'always a component that includes itself.',
        },
      ],
      'This prompt template includes itself.',
    );
  }

  let output = source;

  // Sections first, so a variable inside a removed section is never substituted — otherwise a
  // secret in a false branch would still be evaluated, and its absence from the output would be
  // the only thing hiding it.
  output = renderSections(output, variables, used, declared, options, depth);
  output = renderLoops(output, variables, used, declared, options, depth);
  output = renderIncludes(output, variables, used, declared, options, depth);
  output = renderVariables(output, variables, used);

  return output;
}

function renderSections(
  source: string,
  variables: Record<string, VariableValue>,
  used: Set<string>,
  declared: Map<string, PromptVariable>,
  options: RenderOptions,
  depth: number,
): string {
  const pattern = /\{\{#(if|unless)\s+([a-z][a-z0-9_]*)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

  return source.replace(pattern, (_match, kind: string, name: string, body: string) => {
    used.add(name);
    const truthy = isTruthy(variables[name]);
    const include = kind === 'if' ? truthy : !truthy;

    return include ? render(body, variables, used, declared, options, depth + 1) : '';
  });
}

function renderLoops(
  source: string,
  variables: Record<string, VariableValue>,
  used: Set<string>,
  declared: Map<string, PromptVariable>,
  options: RenderOptions,
  depth: number,
): string {
  const pattern = /\{\{#each\s+([a-z][a-z0-9_]*)\}\}([\s\S]*?)\{\{\/each\}\}/g;

  return source.replace(pattern, (_match, name: string, body: string) => {
    used.add(name);
    const value = variables[name];

    if (!Array.isArray(value)) return '';

    if (value.length > MAX_LOOP_ITEMS) {
      throw ApiError.validation(
        [
          {
            path: name,
            message:
              `"${name}" has ${value.length} items and the loop limit is ${MAX_LOOP_ITEMS}. A ` +
              'prompt built from that many items will overflow any context window.',
          },
        ],
        'Too many items to render.',
      );
    }

    return value
      .map((item) => {
        // `{{.}}` is the item, substituted verbatim like any other value.
        const rendered = render(body, variables, used, declared, options, depth + 1);
        return rendered.replace(/\{\{\.\}\}/g, () => String(item));
      })
      .join('');
  });
}

function renderIncludes(
  source: string,
  variables: Record<string, VariableValue>,
  used: Set<string>,
  declared: Map<string, PromptVariable>,
  options: RenderOptions,
  depth: number,
): string {
  const pattern = /\{\{>\s*([a-z][a-z0-9_]*)\s*\}\}/g;

  return source.replace(pattern, (_match, name: string) => {
    const component = options.components?.[name];

    if (component === undefined) {
      throw ApiError.validation(
        [
          {
            path: 'template',
            message:
              `The component "${name}" is not registered. A missing component would otherwise ` +
              'render as nothing, and a prompt silently missing a section is worse than one that ' +
              'fails to render.',
          },
        ],
        `Unknown prompt component "${name}".`,
      );
    }

    return render(component, variables, used, declared, options, depth + 1);
  });
}

function renderVariables(
  source: string,
  variables: Record<string, VariableValue>,
  used: Set<string>,
): string {
  return source.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    used.add(name);
    const value = variables[name];

    // An absent optional variable renders as empty rather than as the literal `{{name}}`. A
    // template placeholder reaching a model is a prompt asking the model to interpret it.
    if (value === undefined || value === null) return '';

    /*
     * Substituted verbatim. Never re-scanned.
     *
     * This is the line that stops server-side template injection: a user whose name is
     * `{{#each secrets}}` gets a literal name, because the replacement callback's return value
     * is not re-processed by `String.replace`.
     */
    return stringify(value);
  });
}

function stringify(value: VariableValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function isTruthy(value: VariableValue): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  return value.trim().length > 0;
}

/**
 * Every variable a template references.
 *
 * Used to check a template against its declared variables, which catches the two drifts that
 * actually happen: a variable renamed in the schema and not in the template, and a variable used
 * in the template that nobody declared — the second renders as empty and is invisible.
 */
export function referencedVariables(template: string): string[] {
  const names = new Set<string>();

  for (const match of template.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of template.matchAll(/\{\{#(?:if|unless|each)\s+([a-z][a-z0-9_]*)\}\}/g)) {
    if (match[1]) names.add(match[1]);
  }

  return [...names].sort();
}

/** Component names a template includes. For checking they all exist before publishing. */
export function referencedComponents(template: string): string[] {
  const names = new Set<string>();

  for (const match of template.matchAll(/\{\{>\s*([a-z][a-z0-9_]*)\s*\}\}/g)) {
    if (match[1]) names.add(match[1]);
  }

  return [...names].sort();
}

/**
 * Structural problems with a template, independent of any variables.
 *
 * Run before publishing. An unclosed section renders as literal text in the middle of a prompt,
 * which a model will cheerfully try to interpret.
 */
export function validateTemplateSyntax(template: string): string[] {
  const problems: string[] = [];

  for (const keyword of ['if', 'unless', 'each'] as const) {
    const opens = (template.match(new RegExp(`\\{\\{#${keyword}\\s`, 'g')) ?? []).length;
    const closes = (template.match(new RegExp(`\\{\\{/${keyword}\\}\\}`, 'g')) ?? []).length;

    if (opens !== closes) {
      problems.push(
        `${opens} {{#${keyword}}} and ${closes} {{/${keyword}}}. An unclosed section renders as ` +
          'literal text in the middle of the prompt.',
      );
    }
  }

  /*
   * A section header the renderer will not match.
   *
   * `{{#if a == b}}` counts as one open and one close, so the balance check above passes — and
   * the renderer's pattern requires a bare variable name, so the whole header reaches the model
   * as literal text. Checked separately because the balance check cannot see it.
   */
  const malformedSections = [...template.matchAll(/\{\{#(if|unless|each)([^}]*)\}\}/g)]
    .filter((match) => !/^\s+[a-z][a-z0-9_]*\s*$/.test(match[2] ?? ''))
    .map((match) => match[0]);

  if (malformedSections.length > 0) {
    problems.push(
      `Unsupported section headers: ${malformedSections.slice(0, 3).join(', ')}. A section takes ` +
        'a bare variable name — there are no expressions, comparisons or function calls, ' +
        'deliberately. Put the logic in the code that builds the variables, where it can be ' +
        'tested.',
    );
  }

  // A brace pair that matched none of the supported forms. Almost always a typo, and it reaches
  // the model as literal `{{ }}`.
  const unknown = template.match(/\{\{(?![#/>.]|\s*[a-z][a-z0-9_]*\s*\}\})[^}]*\}\}/g);
  if (unknown) {
    problems.push(
      `Unrecognised template expressions: ${unknown.slice(0, 3).join(', ')}. Only {{variable}}, ` +
        '{{#if}}, {{#unless}}, {{#each}} and {{> component}} are supported — there are no ' +
        'expressions, comparisons or function calls, deliberately.',
    );
  }

  return problems;
}
