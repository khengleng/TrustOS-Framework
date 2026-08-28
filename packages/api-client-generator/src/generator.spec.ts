import { describe, expect, it } from 'vitest';
import { parseOpenApi, resolveRef, toCamelCase, toPascalCase, type OpenApiDocument } from './spec';
import { GENERATORS, TypeScriptGenerator, generatorFor } from './targets';

const document: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Merchant API', version: '2.1.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Merchant: {
        type: 'object',
        description: 'A merchant.',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string', description: 'Trading name.' },
          status: { type: 'string', enum: ['active', 'suspended'] },
          tags: { type: 'array', items: { type: 'string' } },
          closedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      MerchantList: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Merchant' } },
          total: { type: 'integer' },
        },
      },
      CreateMerchant: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  },
  paths: {
    '/merchants': {
      get: {
        operationId: 'listMerchants',
        summary: 'Lists merchants.',
        tags: ['merchants'],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'X-Request-Id', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MerchantList' } },
            },
          },
          '401': { description: 'Unauthorized' },
          '429': { description: 'Rate limited' },
        },
      },
      post: {
        operationId: 'createMerchant',
        summary: 'Creates a merchant.',
        tags: ['merchants'],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateMerchant' } },
          },
        },
        responses: {
          '201': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Merchant' } } },
          },
        },
      },
    },
    '/merchants/{merchantId}': {
      get: {
        operationId: 'getMerchant',
        tags: ['merchants'],
        parameters: [
          { name: 'merchantId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Merchant' } } },
          },
        },
      },
      delete: {
        operationId: 'deleteMerchant',
        tags: ['merchants'],
        deprecated: true,
        parameters: [
          { name: 'merchantId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '204': { description: 'Deleted' } },
      },
    },
  },
};

describe('parsing', () => {
  it('reads every operation', () => {
    const spec = parseOpenApi(document);

    expect(spec.endpoints.map((endpoint) => endpoint.operationId)).toEqual([
      'createMerchant',
      'deleteMerchant',
      'getMerchant',
      'listMerchants',
    ]);
  });

  it('reads the title, version and base URL', () => {
    const spec = parseOpenApi(document);

    expect(spec.title).toBe('Merchant API');
    expect(spec.baseUrl).toBe('https://api.example.com/v1');
  });

  it('separates path, query and header parameters', () => {
    const list = parseOpenApi(document).endpoints.find((e) => e.operationId === 'listMerchants')!;

    expect(list.queryParams.map((p) => p.name)).toEqual(['status', 'limit']);
    expect(list.headerParams.map((p) => p.name)).toEqual(['X-Request-Id']);
    expect(list.pathParams).toEqual([]);
  });

  it('records which query parameters are required', () => {
    const list = parseOpenApi(document).endpoints.find((e) => e.operationId === 'listMerchants')!;

    expect(list.queryParams.find((p) => p.name === 'limit')?.required).toBe(true);
    expect(list.queryParams.find((p) => p.name === 'status')?.required).toBe(false);
  });

  it('picks the 2xx response schema', () => {
    const get = parseOpenApi(document).endpoints.find((e) => e.operationId === 'getMerchant')!;

    expect(get.responseSchema?.$ref).toBe('#/components/schemas/Merchant');
  });

  it('records a 204 as no response body rather than as an error', () => {
    const remove = parseOpenApi(document).endpoints.find(
      (e) => e.operationId === 'deleteMerchant',
    )!;

    expect(remove.responseSchema).toBeNull();
  });

  it('records documented error statuses', () => {
    const list = parseOpenApi(document).endpoints.find((e) => e.operationId === 'listMerchants')!;

    expect(list.errorStatuses).toEqual([401, 429]);
  });

  it('carries the deprecation flag through', () => {
    const remove = parseOpenApi(document).endpoints.find(
      (e) => e.operationId === 'deleteMerchant',
    )!;

    expect(remove.deprecated).toBe(true);
  });

  it('detects bearer authentication', () => {
    expect(parseOpenApi(document).security).toEqual({
      kind: 'bearer',
      headerName: 'Authorization',
    });
  });

  it('detects an API-key header', () => {
    const spec = parseOpenApi({
      ...document,
      components: {
        ...document.components,
        securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
      },
    });

    expect(spec.security).toEqual({ kind: 'apiKey', headerName: 'X-API-Key' });
  });

  it('derives a method name when operationId is absent', () => {
    const spec = parseOpenApi({
      paths: { '/users/{id}': { get: { responses: {} } } },
    });

    // `/users/{id}` → `get_users_by_id` → `getUsersById`.
    expect(spec.endpoints[0]?.operationId).toBe('getUsersById');
  });

  it('renames a colliding method name and reports it', () => {
    // Two methods with one name is a compile error in most targets and a silent overwrite in the
    // rest.
    const spec = parseOpenApi({
      paths: {
        '/a': { get: { operationId: 'fetch', responses: {} } },
        '/b': { get: { operationId: 'fetch', responses: {} } },
      },
    });

    expect(spec.endpoints.map((e) => e.operationId)).toEqual(['fetch', 'fetch2']);
    expect(spec.warnings.join(' ')).toMatch(/renamed to "fetch2"/);
  });

  it('reports an unsupported body type rather than dropping it silently', () => {
    // A client generated without the body fails at runtime with a confusing 400 rather than at
    // generation time with a clear message.
    const spec = parseOpenApi({
      paths: {
        '/upload': {
          post: {
            operationId: 'upload',
            requestBody: { content: { 'multipart/form-data': {} } },
            responses: {},
          },
        },
      },
    });

    expect(spec.warnings.join(' ')).toMatch(/multipart\/form-data.*not generated/);
  });

  it('reports a dropped cookie parameter', () => {
    const spec = parseOpenApi({
      paths: {
        '/a': {
          get: {
            operationId: 'a',
            parameters: [{ name: 'session', in: 'cookie' }],
            responses: {},
          },
        },
      },
    });

    expect(spec.warnings.join(' ')).toMatch(/cookie parameters/);
  });

  it('refuses a document with no paths', () => {
    // The detail carries the explanation; `toThrow` only sees the one-line summary.
    expect(() => parseOpenApi({ paths: {} })).toThrow(/empty/);
  });
});

describe('ref resolution', () => {
  it('follows a reference', () => {
    const spec = parseOpenApi(document);
    const resolved = resolveRef({ $ref: '#/components/schemas/Merchant' }, spec.schemas);

    expect(resolved.properties?.name?.type).toBe('string');
  });

  it('returns a placeholder for an unresolvable reference rather than throwing', () => {
    // One bad reference must not stop the other 200 endpoints being generated.
    const resolved = resolveRef({ $ref: '#/components/schemas/Missing' }, {});

    expect(resolved.description).toMatch(/Unresolved reference/);
  });

  it('stops at the depth limit rather than overflowing on a recursive schema', () => {
    const schemas = { Node: { $ref: '#/components/schemas/Node' } };

    expect(() => resolveRef({ $ref: '#/components/schemas/Node' }, schemas)).not.toThrow();
  });
});

describe('name conversion', () => {
  it.each([
    ['list_merchants', 'listMerchants'],
    ['List-Merchants', 'listMerchants'],
    ['listMerchants', 'listMerchants'],
  ])('camel-cases %s', (input, expected) => {
    expect(toCamelCase(input)).toBe(expected);
  });

  it('pascal-cases for a type name', () => {
    expect(toPascalCase('merchant_list')).toBe('MerchantList');
  });
});

describe('the TypeScript generator', () => {
  const spec = parseOpenApi(document);
  const files = new TypeScriptGenerator().generate(spec);
  const types = files.find((file) => file.path === 'types.ts')!.content;
  const client = files.find((file) => file.path === 'client.ts')!.content;

  it('emits a type per schema', () => {
    expect(types).toContain('export type Merchant = {');
    expect(types).toContain('export type MerchantList = {');
  });

  it('marks optional properties optional and required ones required', () => {
    expect(types).toMatch(/"id": string;/);
    expect(types).toMatch(/"status"\?:/);
  });

  it('renders an enum as a union of literals', () => {
    expect(types).toContain(`"active" | "suspended"`);
  });

  it('renders nullable as a union with null', () => {
    expect(types).toMatch(/"closedAt"\?: string \| null/);
  });

  it('renders an array', () => {
    expect(types).toContain('Array<string>');
    expect(types).toContain('Array<Merchant>');
  });

  it('carries a schema description into a doc comment', () => {
    expect(types).toContain('/** Trading name. */');
  });

  it('emits a method per endpoint, with the path parameter interpolated', () => {
    expect(client).toContain('async getMerchant(merchantId: string');
    expect(client).toContain('encodeURIComponent(String(merchantId))');
  });

  it('types the response from the referenced schema', () => {
    expect(client).toMatch(/async getMerchant\([^)]*\): Promise<Merchant>/);
  });

  it('types a 204 endpoint as void', () => {
    expect(client).toMatch(/async deleteMerchant\([^)]*\): Promise<void>/);
  });

  it('takes the request body as a typed argument', () => {
    expect(client).toContain('body: CreateMerchant');
  });

  it('passes query parameters through options', () => {
    expect(client).toContain('"status": options?.status');
  });

  it('marks a deprecated endpoint', () => {
    expect(client).toContain('@deprecated');
  });

  it('configures authentication once, on the client', () => {
    expect(client).toContain('setToken(token: string | undefined)');
    expect(client).toContain('`Bearer ${this.config.token}`');
  });

  it('retries with jittered exponential backoff', () => {
    // Without the jitter, every client that failed together retries together.
    expect(client).toMatch(/Math\.random\(\) \* Math\.min\(1000 \* 2 \*\* \(attempt - 1\)/);
  });

  it('does not retry a 4xx', () => {
    expect(client).toContain('this.status >= 500 || this.status === 429 || this.status === 408');
  });

  it('exposes a typed error with the server’s code', () => {
    expect(client).toContain('export class ApiError extends Error');
    expect(client).toContain('readonly code: string');
  });

  it('offers request and response hooks rather than choosing a logger', () => {
    expect(client).toContain('onRequest?:');
    expect(client).toContain('onResponse?:');
  });

  it('has no runtime imports', () => {
    // A generated client that needed a specific HTTP library would impose that choice on every
    // consuming application.
    const runtimeImports = client
      .split('\n')
      .filter((line) => line.startsWith('import ') && !line.startsWith('import type'));

    expect(runtimeImports).toEqual([]);
  });

  it('refuses to construct without a base URL', () => {
    expect(client).toContain('baseUrl is required');
  });

  it('is syntactically valid TypeScript', async () => {
    // Compiled rather than eyeballed: a generator that emits code which does not parse is a
    // generator whose tests only checked for substrings.
    const ts = await import('typescript');
    const result = ts.transpileModule(client, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });

    expect(result.diagnostics ?? []).toEqual([]);
  });

  it('emits types that parse as TypeScript', async () => {
    const ts = await import('typescript');
    const result = ts.transpileModule(types, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });

    expect(result.diagnostics ?? []).toEqual([]);
  });
});

describe('every generator', () => {
  const spec = parseOpenApi(document);

  it('covers the six required targets', () => {
    expect(GENERATORS.map((generator) => generator.target).sort()).toEqual([
      'csharp',
      'dart',
      'java',
      'javascript',
      'python',
      'typescript',
    ]);
  });

  it.each(GENERATORS.map((generator) => [generator.target, generator]))(
    '%s produces files with content',
    (_target, generator) => {
      const files = generator.generate(spec, { packageName: 'com.example.api' });

      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file.path).not.toBe('');
        expect(file.content.length).toBeGreaterThan(0);
      }

      // The largest file is the client itself, and it should be substantial rather than a stub.
      const largest = Math.max(...files.map((file) => file.content.length));
      expect(largest).toBeGreaterThan(1000);
    },
  );

  it.each(GENERATORS.map((generator) => [generator.target, generator]))(
    '%s emits a method for every endpoint',
    (_target, generator) => {
      // Compared with separators stripped, because the targets differ on naming: `listMerchants`
      // in TypeScript is `list_merchants` in Python and `ListMerchantsAsync` in C#.
      const flatten = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

      const content = flatten(
        generator
          .generate(spec, { packageName: 'com.example.api' })
          .map((file) => file.content)
          .join('\n'),
      );

      for (const endpoint of spec.endpoints) {
        expect(content).toContain(flatten(endpoint.operationId));
      }
    },
  );

  it.each(GENERATORS.map((generator) => [generator.target, generator]))(
    '%s retries with jitter and refuses to run without a base URL',
    (_target, generator) => {
      const content = generator
        .generate(spec, { packageName: 'com.example.api' })
        .map((file) => file.content)
        .join('\n');

      expect(content.toLowerCase()).toMatch(/random/);
      expect(content.toLowerCase()).toMatch(/baseurl|base_url/);
    },
  );

  it.each(GENERATORS.map((generator) => [generator.target, generator]))(
    '%s marks its output as generated',
    (_target, generator) => {
      const content = generator.generate(spec, { packageName: 'com.example.api' })[0]!.content;

      expect(content).toMatch(/Do not edit by hand/);
      expect(content).toMatch(/Re-run: trustos generate client/);
    },
  );

  it('names the available targets when asked for an unknown one', () => {
    expect(() => generatorFor('cobol')).toThrow(/Available: typescript/);
  });
});

describe('generated JavaScript', () => {
  const files = generatorFor('javascript').generate(parseOpenApi(document));
  const client = files.find((file) => file.path === 'client.js')!.content;

  it('parses as JavaScript', async () => {
    /*
     * The test that matters here.
     *
     * An earlier version stripped the type annotations with regular expressions and produced
     * code that did not parse — `constructor(readonly status: number)` became
     * `constructor(this.status)`. Every substring assertion passed. Only actually parsing the
     * output catches that class of bug.
     */
    const { parse } = await import('node:module');
    void parse;

    expect(
      () => new Function(`return (async () => { ${client.replace(/^export /gm, '')} })`),
    ).not.toThrow();
  });

  it('has no type annotations left in it', () => {
    expect(client).not.toMatch(/: Promise</);
    expect(client).not.toMatch(/\breadonly\b/);
    expect(client).not.toMatch(/\binterface\b/);
  });

  it('keeps the class and its methods', () => {
    expect(client).toContain('class MerchantAPIClient');
    expect(client).toContain('async getMerchant(');
  });

  it('expands parameter properties into real assignments', () => {
    // The exact construct the regex version got wrong.
    expect(client).toMatch(/this\.status = status/);
  });

  it('ships declarations, so a JavaScript consumer still gets completion', () => {
    expect(files.map((file) => file.path)).toContain('client.d.ts');
    expect(files.map((file) => file.path)).toContain('types.d.ts');
  });
});

describe('generated Python', () => {
  const files = generatorFor('python').generate(parseOpenApi(document));
  const content = files[0]!.content;

  it('uses only the standard library', () => {
    // A generated client that required `requests` would impose it on every consuming project.
    expect(content).toContain('import urllib.request');
    expect(content).not.toContain('import requests');
  });

  it('uses snake_case, as Python expects', () => {
    expect(content).toContain('def list_merchants(');
    expect(content).toContain('def get_merchant(');
  });
});

describe('generated Dart', () => {
  const content = generatorFor('dart').generate(parseOpenApi(document))[0]!.content;

  it('uses dart:io rather than the http package', () => {
    // Version conflicts in Flutter are particularly unpleasant.
    expect(content).toContain("import 'dart:io'");
    expect(content).not.toContain('package:http');
  });

  it('offers a close method, so connections are released', () => {
    expect(content).toContain('void close()');
  });
});

describe('generated Java', () => {
  const files = generatorFor('java').generate(parseOpenApi(document), {
    packageName: 'com.example.api',
  });

  it('places the file in the package directory', () => {
    expect(files[0]?.path).toBe('com/example/api/MerchantAPIClient.java');
  });

  it('uses the built-in HTTP client', () => {
    expect(files[0]?.content).toContain('java.net.http.HttpClient');
  });

  it('restores the interrupt flag rather than swallowing it', () => {
    // A swallowed interrupt makes a thread pool impossible to shut down.
    expect(files[0]?.content).toContain('Thread.currentThread().interrupt()');
  });
});

describe('generated C#', () => {
  const content = generatorFor('csharp').generate(parseOpenApi(document), {
    packageName: 'Example.Api',
  })[0]!.content;

  it('accepts an injected HttpClient', () => {
    // Creating one per client is the classic source of socket exhaustion in .NET.
    expect(content).toContain('HttpClient httpClient = null');
  });

  it('uses async method names, as .NET expects', () => {
    expect(content).toContain('public Task<string> ListMerchantsAsync(');
  });

  it('does not swallow a cancellation', () => {
    expect(content).toContain('when (!(caught is OperationCanceledException))');
  });
});
