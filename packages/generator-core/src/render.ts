import Handlebars from 'handlebars';
import { GeneratorError } from './errors';

/**
 * Template rendering.
 *
 * Two decisions carry the security weight:
 *
 * 1. **`strict: true`.** A reference to a variable that was not supplied
 *    throws instead of rendering an empty string. Silently emitting
 *    `DATABASE_URL=` or `const name = ;` into a generated project is exactly
 *    the failure mode this guards against, and `validate-template` relies on
 *    it to detect unresolved placeholders.
 *
 * 2. **`noEscape: true`.** The output is TypeScript, JSON and SQL, not HTML —
 *    HTML-escaping would turn `&&` into `&amp;&amp;` and corrupt every
 *    generated file. Safety therefore comes from validating input values
 *    (see `assertSafeValue`), not from escaping at render time.
 *
 * Template *files* are trusted: they live in this repository and go through
 * review. User input is only ever passed as data, never compiled as a
 * template, so there is no path from a prompt answer to template execution.
 */

export type TemplateValues = Record<string, unknown>;

/** Helpers available to templates. Deliberately tiny and pure. */
function createEnvironment(): typeof Handlebars {
  const env = Handlebars.create();

  // Casing helpers, so a template can derive identifiers from one variable
  // instead of asking the user the same thing four times.
  env.registerHelper('pascalCase', (value: unknown) => toPascalCase(String(value ?? '')));
  env.registerHelper('camelCase', (value: unknown) => toCamelCase(String(value ?? '')));
  env.registerHelper('kebabCase', (value: unknown) => toKebabCase(String(value ?? '')));
  env.registerHelper('snakeCase', (value: unknown) => toSnakeCase(String(value ?? '')));
  env.registerHelper('upperSnakeCase', (value: unknown) =>
    toSnakeCase(String(value ?? '')).toUpperCase(),
  );

  env.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  env.registerHelper('json', (value: unknown) => JSON.stringify(value, null, 2));

  // Renders a comma-separated quoted list, for role arrays in generated code.
  env.registerHelper('quotedList', (value: unknown) => {
    const items = Array.isArray(value) ? value : String(value ?? '').split(',');
    return items
      .map((item) => String(item).trim())
      .filter(Boolean)
      .map((item) => `'${item}'`)
      .join(', ');
  });

  return env;
}

const environment = createEnvironment();

/**
 * Renders one template string.
 *
 * `sourceName` is only used to make the error message point at a file.
 */
export function renderTemplate(source: string, values: TemplateValues, sourceName: string): string {
  let compiled: HandlebarsTemplateDelegate;
  try {
    compiled = environment.compile(source, {
      strict: true,
      noEscape: true,
      preventIndent: true,
    });
  } catch (error) {
    throw new GeneratorError(
      'render_failed',
      `Template ${sourceName} failed to compile: ${messageOf(error)}`,
    );
  }

  try {
    return compiled(values);
  } catch (error) {
    throw new GeneratorError(
      'render_failed',
      `Template ${sourceName} failed to render: ${messageOf(error)}`,
      'Every referenced variable must be declared in the template manifest.',
    );
  }
}

/**
 * Lists the variable names a template references.
 *
 * Used by `validate-template` to prove that every placeholder is declared in
 * the manifest, without rendering the template. Walks the parsed AST rather
 * than pattern-matching the source, so comments and block helpers are handled
 * the way Handlebars actually handles them.
 */
export function collectTemplateVariables(source: string, sourceName: string): string[] {
  let ast: hbs.AST.Program;
  try {
    ast = environment.parse(source);
  } catch (error) {
    throw new GeneratorError(
      'template_invalid',
      `Template ${sourceName} failed to parse: ${messageOf(error)}`,
    );
  }

  const found = new Set<string>();

  const visitProgram = (program: hbs.AST.Program | undefined): void => {
    if (!program) return;
    for (const statement of program.body) visitStatement(statement);
  };

  const visitStatement = (statement: hbs.AST.Statement): void => {
    switch (statement.type) {
      case 'MustacheStatement':
      case 'SubExpression': {
        const node = statement as hbs.AST.MustacheStatement;
        recordExpression(node.path);
        node.params?.forEach(recordExpression);
        break;
      }
      case 'BlockStatement': {
        const node = statement as hbs.AST.BlockStatement;
        recordExpression(node.path);
        node.params?.forEach(recordExpression);
        visitProgram(node.program);
        visitProgram(node.inverse);
        break;
      }
      default:
        break;
    }
  };

  const recordExpression = (expression: hbs.AST.Expression | undefined): void => {
    if (!expression) return;
    if (expression.type !== 'PathExpression') return;

    const path = expression as hbs.AST.PathExpression;
    const head = path.parts[0];
    // Helpers and block parameters are not template variables.
    if (!head || environment.helpers[head] || path.data) return;
    found.add(head);
  };

  visitProgram(ast);
  return [...found].sort();
}

// ---------------------------------------------------------------------------

function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
}

export function toPascalCase(value: string): string {
  return splitWords(value)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

export function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function toKebabCase(value: string): string {
  return splitWords(value)
    .map((word) => word.toLowerCase())
    .join('-');
}

export function toSnakeCase(value: string): string {
  return splitWords(value)
    .map((word) => word.toLowerCase())
    .join('_');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
