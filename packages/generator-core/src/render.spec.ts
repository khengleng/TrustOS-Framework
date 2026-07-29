import { describe, expect, it } from 'vitest';
import {
  collectTemplateVariables,
  renderTemplate,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  toSnakeCase,
} from './render';
import type { GeneratorError } from './errors';

describe('renderTemplate', () => {
  it('substitutes declared values', () => {
    expect(renderTemplate('Hello {{name}}!', { name: 'Acme' }, 'test')).toBe('Hello Acme!');
  });

  it('throws on an undeclared variable rather than rendering an empty string', () => {
    // The whole point of strict mode: silently emitting `DATABASE_URL=` into a
    // generated config file is the failure this prevents.
    expect(() => renderTemplate('DATABASE_URL={{missing}}', {}, 'env.hbs')).toThrowError(
      /failed to render/,
    );
  });

  it('reports which file failed, and how to fix it', () => {
    try {
      renderTemplate('{{missing}}', {}, 'apps/api/main.ts.hbs');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('apps/api/main.ts.hbs');
      expect((error as GeneratorError).hint).toContain('declared in the template manifest');
    }
  });

  it('does not HTML-escape, because the output is source code', () => {
    // Escaping would turn `&&` into `&amp;&amp;` and corrupt every file.
    expect(renderTemplate('{{code}}', { code: 'a && b < c' }, 'test')).toBe('a && b < c');
    expect(renderTemplate('{{name}}', { name: "O'Brien" }, 'test')).toBe("O'Brien");
  });

  it('never compiles a value as a template', () => {
    // User input is data, never a template. A value that looks like a
    // Handlebars expression must survive as literal text.
    expect(renderTemplate('{{name}}', { name: '{{constructor}}' }, 'test')).toBe('{{constructor}}');
  });

  it('supports conditionals and iteration over supplied values', () => {
    expect(renderTemplate('{{#if on}}yes{{else}}no{{/if}}', { on: true }, 'test')).toBe('yes');
    expect(renderTemplate('{{#if on}}yes{{else}}no{{/if}}', { on: false }, 'test')).toBe('no');
    expect(
      renderTemplate('{{#each items}}[{{this}}]{{/each}}', { items: ['a', 'b'] }, 'test'),
    ).toBe('[a][b]');
  });

  it('provides the casing helpers templates rely on', () => {
    const values = { name: 'merchant-portal' };
    expect(renderTemplate('{{pascalCase name}}', values, 'test')).toBe('MerchantPortal');
    expect(renderTemplate('{{camelCase name}}', values, 'test')).toBe('merchantPortal');
    expect(renderTemplate('{{snakeCase name}}', values, 'test')).toBe('merchant_portal');
    expect(renderTemplate('{{kebabCase name}}', values, 'test')).toBe('merchant-portal');
    expect(renderTemplate('{{upperSnakeCase name}}', values, 'test')).toBe('MERCHANT_PORTAL');
  });

  it('renders a quoted list, for role arrays in generated code', () => {
    expect(renderTemplate('[{{quotedList roles}}]', { roles: ['a', 'b'] }, 'test')).toBe(
      "['a', 'b']",
    );
  });

  it('emits a literal {{ when escaped, for platform variable syntax', () => {
    // Railway's own ${{VAR}} syntax has to survive rendering.
    expect(renderTemplate('PORT=$\\{{PORT}}', {}, 'test')).toBe('PORT=${{PORT}}');
  });
});

describe('collectTemplateVariables', () => {
  it('finds simple, conditional and iterated references', () => {
    const source = '{{a}} {{#if b}}{{c}}{{/if}} {{#each d}}{{this}}{{/each}}';
    // `this` is the block's current item, not a template variable, so it is
    // deliberately not reported — a manifest should not have to declare it.
    expect(collectTemplateVariables(source, 'test')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores helpers, reporting only their arguments', () => {
    expect(collectTemplateVariables('{{pascalCase name}}', 'test')).toEqual(['name']);
  });

  it('ignores comments and literal text', () => {
    expect(collectTemplateVariables('{{! a comment }} plain text', 'test')).toEqual([]);
  });

  it('reports the file when a template will not parse', () => {
    expect(() => collectTemplateVariables('{{#if unclosed}}', 'broken.hbs')).toThrowError(
      /broken\.hbs/,
    );
  });
});

describe('casing helpers', () => {
  it.each([
    ['merchant-portal', 'MerchantPortal', 'merchantPortal', 'merchant-portal', 'merchant_portal'],
    ['payKH', 'PayKh', 'payKh', 'pay-kh', 'pay_kh'],
    [
      'telegram mini app',
      'TelegramMiniApp',
      'telegramMiniApp',
      'telegram-mini-app',
      'telegram_mini_app',
    ],
  ])('converts %s', (input, pascal, camel, kebab, snake) => {
    expect(toPascalCase(input)).toBe(pascal);
    expect(toCamelCase(input)).toBe(camel);
    expect(toKebabCase(input)).toBe(kebab);
    expect(toSnakeCase(input)).toBe(snake);
  });
});
