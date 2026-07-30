import { describe, expect, it } from 'vitest';
import {
  collectPlaceholders,
  escapeHtml,
  renderTemplate,
  validateTemplate,
} from './template-engine';

/**
 * The template engine.
 *
 * A message template is customer-authored, so these tests are about what the
 * engine refuses to do rather than what it can do. The cases below are the
 * server-side template injection paths a real template language would open.
 */

const body = (source: string) => ({ subject: 'Subject', body: source });

describe('collectPlaceholders', () => {
  it('finds each variable once, in order', () => {
    expect(collectPlaceholders('Hi {{name}}, your {{item}} for {{name}} is ready.')).toEqual([
      'name',
      'item',
    ]);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(collectPlaceholders('Hi {{  name  }}')).toEqual(['name']);
  });

  it('does not treat an escaped brace pair as a placeholder', () => {
    expect(collectPlaceholders('Literal \\{{name}} stays')).toEqual([]);
  });
});

describe('validateTemplate', () => {
  it('accepts a template whose placeholders are all declared', () => {
    expect(() => validateTemplate(body('Hi {{name}}'), ['name'])).not.toThrow();
  });

  it('rejects an undeclared variable at authoring time', () => {
    // Caught when the template is saved, not when a message fails to render for
    // a customer three weeks later.
    expect(() => validateTemplate(body('Hi {{name}}'), [])).toThrowError(/not valid/);
  });

  it('rejects a malformed placeholder', () => {
    expect(() => validateTemplate(body('Hi {{name'), ['name'])).toThrowError(/not valid/);
  });

  it('rejects a null byte', () => {
    expect(() => validateTemplate(body('Hi \u0000 there'), [])).toThrowError(/not valid/);
  });

  it('reports every problem at once', () => {
    try {
      validateTemplate({ subject: 'Hi {{a}}', body: 'And {{b}}' }, []);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { details?: unknown[] }).details).toHaveLength(2);
    }
  });
});

describe('renderTemplate', () => {
  it('substitutes declared variables', () => {
    const rendered = renderTemplate(
      { subject: 'Order {{id}}', body: 'Hi {{name}}, order {{id}} shipped.' },
      ['id', 'name'],
      { id: 'A-1', name: 'Ada' },
    );

    expect(rendered.subject).toBe('Order A-1');
    expect(rendered.body).toBe('Hi Ada, order A-1 shipped.');
  });

  it('refuses to render with a missing value', () => {
    // "Dear ," reaching a customer is worse than a failed send.
    expect(() => renderTemplate(body('Hi {{name}}'), ['name'], {})).toThrowError(
      /Missing template variables: name/,
    );
  });

  it('does not interpret anything but a placeholder', () => {
    const source = 'Total: {{amount}} {{#if admin}}secret{{/if}} {{a.b}} {{lookup this "x"}}';
    // `{{#if}}`, dotted paths and helper calls are not placeholders, so they are
    // not declared, not substituted, and — because validation runs first — not
    // accepted into a template at all.
    expect(collectPlaceholders(source)).toEqual(['amount']);

    const rendered = renderTemplate({ subject: '', body: source }, ['amount'], { amount: '10' });
    expect(rendered.body).toContain('{{#if admin}}');
    expect(rendered.body).toContain('{{a.b}}');
  });

  it('substitutes in one pass, so a value cannot expand into another placeholder', () => {
    // The injection that a naive repeated-replace implementation allows: a
    // customer-supplied value that names another variable.
    const rendered = renderTemplate(
      { subject: '', body: 'A: {{first}} B: {{second}}' },
      ['first', 'second'],
      { first: '{{second}}', second: 'SECRET' },
    );

    expect(rendered.body).toBe('A: {{second}} B: SECRET');
  });

  it('renders an escaped brace pair literally', () => {
    const rendered = renderTemplate(
      { subject: '', body: 'Use \\{{name}} to insert a name. Hi {{name}}.' },
      ['name'],
      { name: 'Ada' },
    );

    expect(rendered.body).toBe('Use {{name}} to insert a name. Hi Ada.');
  });

  it('rejects an over-long variable value', () => {
    expect(() =>
      renderTemplate(body('{{name}}'), ['name'], { name: 'x'.repeat(4001) }),
    ).toThrowError(/too long/);
  });

  it('does not attempt to read a property of an object value', () => {
    const rendered = renderTemplate(body('{{name}}'), ['name'], {
      name: { toString: () => 'coerced' } as unknown as string,
    });

    // Values are coerced with String(), not traversed: there is no path from a
    // value to a prototype or a getter.
    expect(rendered.body).toBe('coerced');
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('is offered, not applied automatically', () => {
    // Escaping every value would corrupt a webhook JSON payload, so the caller
    // decides. Stated as a test so the decision is not quietly reversed.
    const rendered = renderTemplate(body('{{html}}'), ['html'], { html: '<b>bold</b>' });
    expect(rendered.body).toBe('<b>bold</b>');
  });
});
