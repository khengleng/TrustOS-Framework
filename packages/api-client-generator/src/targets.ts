import {
  refName,
  resolveRef,
  toPascalCase,
  type Endpoint,
  type OpenApiSchema,
  type ParsedSpec,
} from './spec';

/**
 * Code generators, one per target language.
 *
 * Every generated client has the same five properties, because an integrator moving between two
 * of them should not have to relearn the shape:
 *
 *   1. **Authentication** is configured once, on the client, not passed per call.
 *   2. **Retry** with exponential backoff and jitter, on the same rules as `@trustos/retry`:
 *      5xx and 429 are retried, 4xx is not.
 *   3. **Errors are typed.** An `ApiError` carrying status, code and details, rather than a
 *      generic exception that forces string-matching on a message.
 *   4. **A logging hook**, so a caller can see requests without the client choosing a logger.
 *   5. **Configuration is a single object** with a base URL, a timeout and the auth token.
 *
 * The generated code has **no runtime dependencies** in any target. A generated client that
 * needed a specific HTTP library would impose that choice on every consuming application, and
 * the one thing worse than writing an HTTP call is being told which library to write it with.
 */

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface ClientGenerator {
  readonly target: string;
  readonly language: string;
  generate(spec: ParsedSpec, options: GenerateOptions): GeneratedFile[];
}

export interface GenerateOptions {
  /** The class or module name. Defaults to something derived from the spec title. */
  clientName?: string;
  /** Java/C# namespace or package. */
  packageName?: string;
}

function clientNameFor(spec: ParsedSpec, options: GenerateOptions): string {
  return options.clientName ?? `${toPascalCase(spec.title)}Client`;
}

/** A generated banner. Says not to edit, and what to re-run. */
function banner(spec: ParsedSpec, comment = '//'): string {
  return [
    `${comment} Generated from ${spec.title} ${spec.version}. Do not edit by hand.`,
    `${comment} Re-run: trustos generate client --spec <openapi.json> --target <target>`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------------- *
 * TypeScript
 * ------------------------------------------------------------------------- */

export class TypeScriptGenerator implements ClientGenerator {
  readonly target = 'typescript';
  readonly language = 'TypeScript';

  generate(spec: ParsedSpec, options: GenerateOptions = {}): GeneratedFile[] {
    const name = clientNameFor(spec, options);

    return [
      { path: 'types.ts', content: this.types(spec) },
      { path: 'client.ts', content: this.client(spec, name) },
      { path: 'index.ts', content: `export * from './client';\nexport * from './types';\n` },
    ];
  }

  private types(spec: ParsedSpec): string {
    const lines = [banner(spec)];

    for (const [rawName, schema] of Object.entries(spec.schemas)) {
      const typeName = toPascalCase(rawName);
      if (schema.description) lines.push(`/** ${schema.description} */`);
      lines.push(`export type ${typeName} = ${tsType(schema, spec.schemas, 0)};`, '');
    }

    return lines.join('\n');
  }

  private client(spec: ParsedSpec, name: string): string {
    const methods = spec.endpoints.map((endpoint) => this.method(endpoint, spec)).join('\n\n');
    const typeImports = [...new Set(Object.keys(spec.schemas).map(toPascalCase))];

    return `${banner(spec)}${
      typeImports.length > 0 ? `import type { ${typeImports.join(', ')} } from './types';\n\n` : ''
    }export interface ClientConfig {
  /** Base URL, without a trailing slash. */
  baseUrl${spec.baseUrl ? '?' : ''}: string;
  /** ${spec.security.kind === 'bearer' ? 'Bearer token' : 'API key'}. Sent on every request. */
  token?: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Called before and after each request. For a caller's own logging. */
  onRequest?: (info: { method: string; url: string; attempt: number }) => void;
  onResponse?: (info: { method: string; url: string; status: number; durationMs: number }) => void;
  /** Injectable, so a test can supply a double and a deployment can supply an agent. */
  fetch?: typeof fetch;
}

/**
 * A typed error.
 *
 * Carries the status, the server's error code and its details, so a caller can branch on the
 * code rather than matching on a message that will change.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 5xx, 429 and 408 are worth trying again; other 4xx are not. */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

export class ${name} {
  private readonly config: Required<Pick<ClientConfig, 'baseUrl' | 'timeoutMs' | 'maxRetries'>> &
    ClientConfig;

  constructor(config: ClientConfig${spec.baseUrl ? ' = {} as ClientConfig' : ''}) {
    this.config = {
      ...config,
      baseUrl: (config.baseUrl ?? ${JSON.stringify(spec.baseUrl ?? '')}).replace(/\\/$/, ''),
      timeoutMs: config.timeoutMs ?? 30_000,
      maxRetries: config.maxRetries ?? 2,
    };

    if (!this.config.baseUrl) {
      throw new Error('baseUrl is required: the client does not know where to send requests.');
    }
  }

  /** Replaces the token, for a refresh flow. */
  setToken(token: string | undefined): void {
    this.config.token = token;
  }

${methods}

  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const url = new URL(this.config.baseUrl + path);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      // An array becomes repeated parameters — the only encoding every server framework agrees on.
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, String(entry));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const doFetch = this.config.fetch ?? fetch;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt += 1) {
      this.config.onRequest?.({ method, url: url.toString(), attempt });

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const startedAt = Date.now();

      try {
        const response = await doFetch(url.toString(), {
          method,
          headers: this.buildHeaders(options.headers, options.body !== undefined),
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });

        const durationMs = Date.now() - startedAt;
        this.config.onResponse?.({ method, url: url.toString(), status: response.status, durationMs });

        if (response.ok) {
          if (response.status === 204) return undefined as T;
          const text = await response.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }

        const error = await this.toError(response);

        // A 4xx will fail identically next time; only a transient status is worth another attempt.
        if (!error.isRetryable || attempt > this.config.maxRetries) throw error;
        lastError = error;
      } catch (caught) {
        if (caught instanceof ApiError) {
          if (!caught.isRetryable || attempt > this.config.maxRetries) throw caught;
          lastError = caught;
        } else if (options.signal?.aborted) {
          throw caught;
        } else {
          // A network failure or a timeout, which is exactly what retry is for.
          if (attempt > this.config.maxRetries) throw caught;
          lastError = caught;
        }
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }

      // Exponential backoff with full jitter. Without the jitter, every client that failed
      // together retries together, and the retry storm is worse than the original failure.
      const delay = Math.random() * Math.min(1000 * 2 ** (attempt - 1), 10_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw lastError;
  }

  private buildHeaders(extra: Record<string, string> | undefined, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.config.headers, ...extra };
    if (hasBody) headers['content-type'] = 'application/json';
    if (this.config.token) {
      headers[${JSON.stringify(spec.security.headerName.toLowerCase())}] = ${
        spec.security.kind === 'bearer' ? '`Bearer ${this.config.token}`' : 'this.config.token'
      };
    }
    return headers;
  }

  private async toError(response: Response): Promise<ApiError> {
    let code = 'error';
    let message = \`Request failed with status ${'$'}{response.status}.\`;
    let details: unknown;

    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
        requestId?: string;
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      details = body.error?.details;
      return new ApiError(response.status, code, message, details, body.requestId);
    } catch {
      // A non-JSON error body is normal from a proxy or a load balancer. The status is still the
      // useful part, so it is reported rather than being replaced by a parse failure.
      return new ApiError(response.status, code, message);
    }
  }
}
`;
  }

  private method(endpoint: Endpoint, spec: ParsedSpec): string {
    const args: string[] = [];

    for (const parameter of endpoint.pathParams) {
      args.push(`${safeIdent(parameter.name)}: ${tsType(parameter.schema, spec.schemas, 0)}`);
    }

    if (endpoint.requestBody) {
      const type =
        refName(endpoint.requestBody.schema) ??
        tsType(endpoint.requestBody.schema, spec.schemas, 0);
      args.push(`body${endpoint.requestBody.required ? '' : '?'}: ${type}`);
    }

    const optionals = [
      ...endpoint.queryParams.map(
        (parameter) =>
          `${safeIdent(parameter.name)}${parameter.required ? '' : '?'}: ${tsType(parameter.schema, spec.schemas, 0)}`,
      ),
      ...endpoint.headerParams.map(
        (parameter) =>
          `${safeIdent(parameter.name)}?: ${tsType(parameter.schema, spec.schemas, 0)}`,
      ),
      'signal?: AbortSignal',
    ];

    args.push(`options?: { ${optionals.join('; ')} }`);

    const returnType = endpoint.responseSchema
      ? (refName(endpoint.responseSchema) ?? tsType(endpoint.responseSchema, spec.schemas, 0))
      : 'void';

    const pathExpression = endpoint.path.replace(
      /\{([^}]+)\}/g,
      (_, param: string) => `${'$'}{encodeURIComponent(String(${safeIdent(param)}))}`,
    );

    const query =
      endpoint.queryParams.length === 0
        ? ''
        : `\n      query: { ${endpoint.queryParams
            .map(
              (parameter) =>
                `${JSON.stringify(parameter.name)}: options?.${safeIdent(parameter.name)}`,
            )
            .join(', ')} },`;

    const headers =
      endpoint.headerParams.length === 0
        ? ''
        : `\n      headers: { ${endpoint.headerParams
            .map(
              (parameter) =>
                `...(options?.${safeIdent(parameter.name)} ? { ${JSON.stringify(
                  parameter.name.toLowerCase(),
                )}: String(options.${safeIdent(parameter.name)}) } : {})`,
            )
            .join(', ')} },`;

    const doc = [
      '  /**',
      `   * ${endpoint.summary ?? `${endpoint.method.toUpperCase()} ${endpoint.path}`}`,
      endpoint.deprecated ? '   * @deprecated' : null,
      '   */',
    ]
      .filter(Boolean)
      .join('\n');

    return `${doc}
  async ${endpoint.operationId}(${args.join(', ')}): Promise<${returnType}> {
    return this.request<${returnType}>(${JSON.stringify(endpoint.method.toUpperCase())}, \`${pathExpression}\`, {${query}${headers}${
      endpoint.requestBody ? '\n      body,' : ''
    }
      signal: options?.signal,
    });
  }`;
  }
}

/** A TypeScript type expression for a schema. */
function tsType(
  schema: OpenApiSchema,
  schemas: Record<string, OpenApiSchema>,
  depth: number,
): string {
  if (depth > 15) return 'unknown';

  const named = refName(schema);
  if (named) return named;

  if (schema.oneOf || schema.anyOf) {
    const options = (schema.oneOf ?? schema.anyOf)!;
    return options.map((option) => tsType(option, schemas, depth + 1)).join(' | ');
  }

  if (schema.allOf) {
    // Merged with `&` rather than by flattening the properties: an intersection is what `allOf`
    // means, and flattening loses which part a field came from.
    return schema.allOf.map((part) => tsType(part, schemas, depth + 1)).join(' & ');
  }

  if (schema.enum) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  }

  const nullable = schema.nullable ? ' | null' : '';

  switch (schema.type) {
    case 'string':
      return `string${nullable}`;
    case 'integer':
    case 'number':
      return `number${nullable}`;
    case 'boolean':
      return `boolean${nullable}`;
    case 'array':
      return `Array<${schema.items ? tsType(schema.items, schemas, depth + 1) : 'unknown'}>${nullable}`;
    case 'object':
    default: {
      if (!schema.properties) {
        if (typeof schema.additionalProperties === 'object') {
          return `Record<string, ${tsType(schema.additionalProperties, schemas, depth + 1)}>${nullable}`;
        }
        return schema.type === 'object'
          ? `Record<string, unknown>${nullable}`
          : `unknown${nullable}`;
      }

      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties).map(([key, value]) => {
        const optional = required.has(key) ? '' : '?';
        const comment = value.description ? `\n  /** ${value.description} */\n  ` : '\n  ';
        return `${comment}${JSON.stringify(key)}${optional}: ${tsType(value, schemas, depth + 1)};`;
      });

      return `{${fields.join('')}\n}${nullable}`;
    }
  }
}

function safeIdent(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_$]/g, '_');
  return /^\d/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/* ------------------------------------------------------------------------- *
 * JavaScript
 * ------------------------------------------------------------------------- */

/**
 * Plain JavaScript, plus a `.d.ts` so an editor still gives completion.
 *
 * The JavaScript is the TypeScript client run through the TypeScript compiler, not through a set
 * of regexes. An earlier version did strip the annotations with regular expressions, and it
 * produced code that did not parse — `constructor(readonly status: number)` became
 * `constructor(this.status)`. The substring tests passed. Nothing else would have caught it,
 * which is why `generate` is now the compiler's job and the test compiles the output.
 *
 * One source, two outputs: the implementation cannot drift between the TypeScript and JavaScript
 * clients because there is only one of it.
 */
export class JavaScriptGenerator implements ClientGenerator {
  readonly target = 'javascript';
  readonly language = 'JavaScript';

  constructor(private readonly transpile: (source: string) => string = defaultTranspile) {}

  generate(spec: ParsedSpec, options: GenerateOptions = {}): GeneratedFile[] {
    const typescript = new TypeScriptGenerator().generate(spec, options);
    const client = typescript.find((file) => file.path === 'client.ts')!;
    const types = typescript.find((file) => file.path === 'types.ts')!;

    // The banner is re-attached: the compiler drops leading trivia that precedes the first
    // statement, so transpiling alone would produce a file with no "do not edit" line.
    return [
      { path: 'client.js', content: banner(spec) + this.transpile(client.content) },
      // Emitted alongside, so a JavaScript consumer gets the same editor completion a TypeScript
      // one does. A `.d.ts` is the only way to have that without asking them to adopt TypeScript.
      { path: 'client.d.ts', content: client.content },
      { path: 'types.d.ts', content: types.content },
      { path: 'index.js', content: `export * from './client.js';\n` },
      {
        path: 'index.d.ts',
        content: `export * from './client';\nexport * from './types';\n`,
      },
    ];
  }
}

/**
 * Strips types with the TypeScript compiler.
 *
 * `require` rather than a static import, because `typescript` is a build-time dependency of the
 * generator and not something an application consuming the generated client should carry.
 */
function defaultTranspile(source: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript');

  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
      // The generated client uses parameter properties; the compiler expands them correctly,
      // which is precisely what a regex could not.
      useDefineForClassFields: false,
    },
    reportDiagnostics: true,
  });

  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === 1 /* Error */,
  );

  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(
      'The generated TypeScript client did not compile, so no JavaScript was produced: ' +
        String(first.messageText),
    );
  }

  return result.outputText;
}

/* ------------------------------------------------------------------------- *
 * Dart / Flutter
 * ------------------------------------------------------------------------- */

export class DartGenerator implements ClientGenerator {
  readonly target = 'dart';
  readonly language = 'Dart (Flutter)';

  generate(spec: ParsedSpec, options: GenerateOptions = {}): GeneratedFile[] {
    const name = clientNameFor(spec, options);
    const methods = spec.endpoints.map((endpoint) => this.method(endpoint)).join('\n\n');

    // `dart:io` HttpClient, not the `http` package: a generated client with a package dependency
    // imposes that package on every app that uses it, and version conflicts in Flutter are
    // particularly unpleasant.
    const content = `${banner(spec)}import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// A typed error carrying the status, code and details.
class ApiException implements Exception {
  ApiException(this.status, this.code, this.message, [this.details, this.requestId]);

  final int status;
  final String code;
  final String message;
  final dynamic details;
  final String? requestId;

  /// 5xx, 429 and 408 are worth another attempt; other 4xx are not.
  bool get isRetryable => status >= 500 || status == 429 || status == 408;

  @override
  String toString() => 'ApiException(${'$'}status, ${'$'}code): ${'$'}message';
}

class ${name} {
  ${name}({
    String? baseUrl,
    this.token,
    this.timeout = const Duration(seconds: 30),
    this.maxRetries = 2,
    this.headers = const {},
    this.onRequest,
    this.onResponse,
    HttpClient? httpClient,
  })  : baseUrl = (baseUrl ?? ${JSON.stringify(spec.baseUrl ?? '')}).replaceAll(RegExp(r'/${'$'}'), ''),
        _client = httpClient ?? HttpClient() {
    if (baseUrl!.isEmpty) {
      throw ArgumentError('baseUrl is required: the client does not know where to send requests.');
    }
  }

  final String baseUrl;
  String? token;
  final Duration timeout;
  final int maxRetries;
  final Map<String, String> headers;
  final void Function(String method, String url, int attempt)? onRequest;
  final void Function(String method, String url, int status, int durationMs)? onResponse;
  final HttpClient _client;
  final Random _random = Random();

  /// Releases the underlying connections. Call it when the client is finished with.
  void close() => _client.close(force: false);

${methods}

  Future<dynamic> _request(
    String method,
    String path, {
    Map<String, dynamic>? query,
    Object? body,
    Map<String, String>? extraHeaders,
  }) async {
    final uri = Uri.parse('${'$'}baseUrl${'$'}path').replace(
      queryParameters: query?.map((key, value) => MapEntry(key, value?.toString()))
        ?..removeWhere((_, value) => value == null),
    );

    Object? lastError;

    for (var attempt = 1; attempt <= maxRetries + 1; attempt++) {
      onRequest?.call(method, uri.toString(), attempt);
      final startedAt = DateTime.now();

      try {
        final request = await _client.openUrl(method, uri).timeout(timeout);
        request.headers.set('accept', 'application/json');
        headers.forEach(request.headers.set);
        extraHeaders?.forEach(request.headers.set);

        if (token != null) {
          request.headers.set(${JSON.stringify(spec.security.headerName)}, ${
            spec.security.kind === 'bearer' ? "'Bearer ${'$'}token'" : 'token!'
          });
        }

        if (body != null) {
          request.headers.set('content-type', 'application/json');
          request.write(jsonEncode(body));
        }

        final response = await request.close().timeout(timeout);
        final durationMs = DateTime.now().difference(startedAt).inMilliseconds;
        onResponse?.call(method, uri.toString(), response.statusCode, durationMs);

        final text = await response.transform(utf8.decoder).join();

        if (response.statusCode >= 200 && response.statusCode < 300) {
          return text.isEmpty ? null : jsonDecode(text);
        }

        final error = _toError(response.statusCode, text);
        if (!error.isRetryable || attempt > maxRetries) throw error;
        lastError = error;
      } on ApiException catch (error) {
        if (!error.isRetryable || attempt > maxRetries) rethrow;
        lastError = error;
      } catch (error) {
        // A socket failure or a timeout — exactly what retry is for.
        if (attempt > maxRetries) rethrow;
        lastError = error;
      }

      // Exponential backoff with full jitter, so clients that failed together do not retry
      // together.
      final capped = min(1000 * (1 << (attempt - 1)), 10000);
      await Future<void>.delayed(Duration(milliseconds: _random.nextInt(capped)));
    }

    throw lastError!;
  }

  ApiException _toError(int status, String text) {
    try {
      final body = jsonDecode(text) as Map<String, dynamic>;
      final error = body['error'] as Map<String, dynamic>?;
      return ApiException(
        status,
        error?['code'] as String? ?? 'error',
        error?['message'] as String? ?? 'Request failed with status ${'$'}status.',
        error?['details'],
        body['requestId'] as String?,
      );
    } catch (_) {
      // A non-JSON error body is normal from a proxy. The status is still the useful part.
      return ApiException(status, 'error', 'Request failed with status ${'$'}status.');
    }
  }
}
`;

    return [{ path: `${snakeCase(name)}.dart`, content }];
  }

  private method(endpoint: Endpoint): string {
    const pathArgs = endpoint.pathParams.map(
      (parameter) => `required String ${camel(parameter.name)}`,
    );
    if (endpoint.requestBody) pathArgs.push('required Object body');
    for (const parameter of endpoint.queryParams) pathArgs.push(`Object? ${camel(parameter.name)}`);

    const dartPath = endpoint.path.replace(
      /\{([^}]+)\}/g,
      (_, param: string) => `${'$'}{${camel(param)}}`,
    );

    const query =
      endpoint.queryParams.length === 0
        ? ''
        : `\n      query: {${endpoint.queryParams
            .map((parameter) => `'${parameter.name}': ${camel(parameter.name)}`)
            .join(', ')}},`;

    return `  /// ${endpoint.summary ?? `${endpoint.method.toUpperCase()} ${endpoint.path}`}
  Future<dynamic> ${camel(endpoint.operationId)}({${pathArgs.join(', ')}}) async {
    return _request('${endpoint.method.toUpperCase()}', '${dartPath}',${query}${
      endpoint.requestBody ? '\n      body: body,' : ''
    }
    );
  }`;
  }
}

/* ------------------------------------------------------------------------- *
 * Python
 * ------------------------------------------------------------------------- */

export class PythonGenerator implements ClientGenerator {
  readonly target = 'python';
  readonly language = 'Python';

  generate(spec: ParsedSpec, options: GenerateOptions = {}): GeneratedFile[] {
    const name = clientNameFor(spec, options);
    const methods = spec.endpoints.map((endpoint) => this.method(endpoint)).join('\n\n');

    // `urllib` from the standard library rather than `requests`: a generated client that required
    // `requests` would impose it on every consuming project.
    const content = `${banner(spec, '#')}
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional


class ApiError(Exception):
    """A typed error carrying the status, code and details."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Any = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.request_id = request_id

    @property
    def is_retryable(self) -> bool:
        """5xx, 429 and 408 are worth another attempt; other 4xx are not."""
        return self.status >= 500 or self.status in (429, 408)


class ${name}:
    def __init__(
        self,
        base_url: str = ${JSON.stringify(spec.baseUrl ?? '')},
        token: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        headers: Optional[Dict[str, str]] = None,
        on_request: Optional[Callable[[str, str, int], None]] = None,
        on_response: Optional[Callable[[str, str, int, float], None]] = None,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required: the client does not know where to send requests.")

        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.max_retries = max_retries
        self.headers = headers or {}
        self.on_request = on_request
        self.on_response = on_response

${methods}

    def _request(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, Any]] = None,
        body: Any = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        url = self.base_url + path

        if query:
            filtered = {key: value for key, value in query.items() if value is not None}
            if filtered:
                url += "?" + urllib.parse.urlencode(filtered, doseq=True)

        last_error: Optional[Exception] = None

        for attempt in range(1, self.max_retries + 2):
            if self.on_request:
                self.on_request(method, url, attempt)

            request_headers = {"Accept": "application/json", **self.headers}
            if extra_headers:
                request_headers.update(extra_headers)
            if self.token:
                request_headers[${JSON.stringify(spec.security.headerName)}] = ${
                  spec.security.kind === 'bearer' ? 'f"Bearer {self.token}"' : 'self.token'
                }

            data = None
            if body is not None:
                data = json.dumps(body).encode("utf-8")
                request_headers["Content-Type"] = "application/json"

            request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
            started_at = time.monotonic()

            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    duration_ms = (time.monotonic() - started_at) * 1000
                    if self.on_response:
                        self.on_response(method, url, response.status, duration_ms)

                    text = response.read().decode("utf-8")
                    return json.loads(text) if text else None

            except urllib.error.HTTPError as http_error:
                duration_ms = (time.monotonic() - started_at) * 1000
                if self.on_response:
                    self.on_response(method, url, http_error.code, duration_ms)

                error = self._to_error(http_error)
                if not error.is_retryable or attempt > self.max_retries:
                    raise error from http_error
                last_error = error

            except Exception as caught:
                # A connection failure or a timeout — exactly what retry is for.
                if attempt > self.max_retries:
                    raise
                last_error = caught

            # Exponential backoff with full jitter, so clients that failed together do not retry
            # together.
            capped = min(1.0 * (2 ** (attempt - 1)), 10.0)
            time.sleep(random.uniform(0, capped))

        raise last_error  # type: ignore[misc]

    @staticmethod
    def _to_error(http_error: "urllib.error.HTTPError") -> ApiError:
        try:
            body = json.loads(http_error.read().decode("utf-8"))
            error = body.get("error", {})
            return ApiError(
                http_error.code,
                error.get("code", "error"),
                error.get("message", f"Request failed with status {http_error.code}."),
                error.get("details"),
                body.get("requestId"),
            )
        except Exception:
            # A non-JSON error body is normal from a proxy. The status is still the useful part.
            return ApiError(
                http_error.code, "error", f"Request failed with status {http_error.code}."
            )
`;

    return [{ path: `${snakeCase(name)}.py`, content }];
  }

  private method(endpoint: Endpoint): string {
    const args = ['self'];
    for (const parameter of endpoint.pathParams) args.push(`${snakeCase(parameter.name)}: str`);
    if (endpoint.requestBody) args.push('body: Any');
    for (const parameter of endpoint.queryParams) {
      args.push(`${snakeCase(parameter.name)}: Any = None`);
    }

    const pythonPath = endpoint.path.replace(
      /\{([^}]+)\}/g,
      (_, param: string) => `{${snakeCase(param)}}`,
    );

    const query =
      endpoint.queryParams.length === 0
        ? ''
        : `\n            query={${endpoint.queryParams
            .map((parameter) => `"${parameter.name}": ${snakeCase(parameter.name)}`)
            .join(', ')}},`;

    return `    def ${snakeCase(endpoint.operationId)}(${args.join(', ')}) -> Any:
        """${endpoint.summary ?? `${endpoint.method.toUpperCase()} ${endpoint.path}`}"""
        return self._request(
            "${endpoint.method.toUpperCase()}",
            f"${pythonPath}",${query}${endpoint.requestBody ? '\n            body=body,' : ''}
        )`;
  }
}

/* ------------------------------------------------------------------------- *
 * Java
 * ------------------------------------------------------------------------- */

export class JavaGenerator implements ClientGenerator {
  readonly target = 'java';
  readonly language = 'Java';

  generate(spec: ParsedSpec, options: GenerateOptions = {}): GeneratedFile[] {
    const name = clientNameFor(spec, options);
    const packageName = options.packageName ?? 'com.example.client';
    const methods = spec.endpoints.map((endpoint) => this.method(endpoint)).join('\n\n');

    // `java.net.http.HttpClient` from Java 11, not OkHttp or Apache: no dependency to impose.
    const content = `${banner(spec)}package ${packageName};

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Random;
import java.util.function.Consumer;

/** Generated client for ${spec.title} ${spec.version}. */
public class ${name} {

    /** A typed error carrying the status, code and body. */
    public static class ApiException extends RuntimeException {
        public final int status;
        public final String code;
        public final String body;

        public ApiException(int status, String code, String message, String body) {
            super(message);
            this.status = status;
            this.code = code;
            this.body = body;
        }

        /** 5xx, 429 and 408 are worth another attempt; other 4xx are not. */
        public boolean isRetryable() {
            return status >= 500 || status == 429 || status == 408;
        }
    }

    public static class Config {
        public String baseUrl = ${JSON.stringify(spec.baseUrl ?? '')};
        public String token;
        public Duration timeout = Duration.ofSeconds(30);
        public int maxRetries = 2;
        public Map<String, String> headers = new HashMap<>();
        public Consumer<String> onRequest;
        public Consumer<String> onResponse;
    }

    private final Config config;
    private final HttpClient http;
    private final Random random = new Random();

    public ${name}(Config config) {
        if (config.baseUrl == null || config.baseUrl.isEmpty()) {
            throw new IllegalArgumentException(
                "baseUrl is required: the client does not know where to send requests.");
        }
        this.config = config;
        this.config.baseUrl = config.baseUrl.replaceAll("/$", "");
        this.http = HttpClient.newBuilder().connectTimeout(config.timeout).build();
    }

${methods}

    private String request(String method, String path, Map<String, String> query, String body) {
        StringBuilder url = new StringBuilder(config.baseUrl).append(path);

        if (query != null && !query.isEmpty()) {
            StringBuilder qs = new StringBuilder();
            for (Map.Entry<String, String> entry : query.entrySet()) {
                if (entry.getValue() == null) continue;
                qs.append(qs.length() == 0 ? "?" : "&")
                  .append(URLEncoder.encode(entry.getKey(), StandardCharsets.UTF_8))
                  .append("=")
                  .append(URLEncoder.encode(entry.getValue(), StandardCharsets.UTF_8));
            }
            url.append(qs);
        }

        RuntimeException lastError = null;

        for (int attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
            if (config.onRequest != null) config.onRequest.accept(method + " " + url);

            HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url.toString()))
                .timeout(config.timeout)
                .header("Accept", "application/json");

            config.headers.forEach(builder::header);

            if (config.token != null) {
                builder.header(${JSON.stringify(spec.security.headerName)}, ${
                  spec.security.kind === 'bearer' ? '"Bearer " + config.token' : 'config.token'
                });
            }

            if (body != null) {
                builder.header("Content-Type", "application/json");
                builder.method(method, HttpRequest.BodyPublishers.ofString(body));
            } else {
                builder.method(method, HttpRequest.BodyPublishers.noBody());
            }

            try {
                HttpResponse<String> response =
                    http.send(builder.build(), HttpResponse.BodyHandlers.ofString());

                if (config.onResponse != null) {
                    config.onResponse.accept(method + " " + url + " -> " + response.statusCode());
                }

                if (response.statusCode() >= 200 && response.statusCode() < 300) {
                    return response.body();
                }

                ApiException error = new ApiException(
                    response.statusCode(),
                    "error",
                    "Request failed with status " + response.statusCode() + ".",
                    response.body());

                if (!error.isRetryable() || attempt > config.maxRetries) throw error;
                lastError = error;

            } catch (ApiException error) {
                if (!error.isRetryable() || attempt > config.maxRetries) throw error;
                lastError = error;
            } catch (Exception caught) {
                // A connection failure or a timeout — exactly what retry is for.
                if (attempt > config.maxRetries) throw new RuntimeException(caught);
                lastError = new RuntimeException(caught);
            }

            // Exponential backoff with full jitter, so clients that failed together do not retry
            // together.
            try {
                int capped = (int) Math.min(1000L * (1L << (attempt - 1)), 10000L);
                Thread.sleep(random.nextInt(capped));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new RuntimeException(interrupted);
            }
        }

        throw lastError;
    }
}
`;

    return [{ path: `${packageName.replace(/\./g, '/')}/${name}.java`, content }];
  }

  private method(endpoint: Endpoint): string {
    const args = endpoint.pathParams.map((parameter) => `String ${camel(parameter.name)}`);
    if (endpoint.requestBody) args.push('String body');
    for (const parameter of endpoint.queryParams) args.push(`String ${camel(parameter.name)}`);

    const javaPath = endpoint.path.replace(
      /\{([^}]+)\}/g,
      (_, param: string) => `" + ${camel(param)} + "`,
    );

    const query =
      endpoint.queryParams.length === 0
        ? 'null'
        : `new LinkedHashMap<>(Map.of(${endpoint.queryParams
            .map((parameter) => `"${parameter.name}", ${camel(parameter.name)}`)
            .join(', ')}))`;

    return `    /** ${endpoint.summary ?? `${endpoint.method.toUpperCase()} ${endpoint.path}`} */
    public String ${camel(endpoint.operationId)}(${args.join(', ')}) {
        return request("${endpoint.method.toUpperCase()}", "${javaPath}", ${query}, ${
          endpoint.requestBody ? 'body' : 'null'
        });
    }`;
  }
}

/* ------------------------------------------------------------------------- *
 * C#
 * ------------------------------------------------------------------------- */

export class CSharpGenerator implements ClientGenerator {
  readonly target = 'csharp';
  readonly language = 'C#';

  generate(spec: ParsedSpec, options: GenerateOptions = {}): GeneratedFile[] {
    const name = clientNameFor(spec, options);
    const namespace = options.packageName ?? 'Example.Client';
    const methods = spec.endpoints.map((endpoint) => this.method(endpoint)).join('\n\n');

    const content = `${banner(spec)}using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ${namespace}
{
    /// <summary>A typed error carrying the status, code and body.</summary>
    public class ApiException : Exception
    {
        public int Status { get; }
        public string Code { get; }
        public string Body { get; }

        public ApiException(int status, string code, string message, string body) : base(message)
        {
            Status = status;
            Code = code;
            Body = body;
        }

        /// <summary>5xx, 429 and 408 are worth another attempt; other 4xx are not.</summary>
        public bool IsRetryable => Status >= 500 || Status == 429 || Status == 408;
    }

    public class ClientConfig
    {
        public string BaseUrl { get; set; } = ${JSON.stringify(spec.baseUrl ?? '')};
        public string Token { get; set; }
        public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);
        public int MaxRetries { get; set; } = 2;
        public Dictionary<string, string> Headers { get; set; } = new Dictionary<string, string>();
        public Action<string> OnRequest { get; set; }
        public Action<string> OnResponse { get; set; }
    }

    /// <summary>Generated client for ${spec.title} ${spec.version}.</summary>
    public class ${name} : IDisposable
    {
        private readonly ClientConfig _config;
        private readonly HttpClient _http;
        private readonly Random _random = new Random();

        public ${name}(ClientConfig config, HttpClient httpClient = null)
        {
            if (string.IsNullOrEmpty(config?.BaseUrl))
            {
                throw new ArgumentException(
                    "BaseUrl is required: the client does not know where to send requests.");
            }

            _config = config;
            _config.BaseUrl = _config.BaseUrl.TrimEnd('/');
            // An injected HttpClient is honoured: creating one per client is the classic source
            // of socket exhaustion in .NET, and a caller with an IHttpClientFactory should use it.
            _http = httpClient ?? new HttpClient { Timeout = config.Timeout };
        }

${methods}

        private async Task<string> RequestAsync(
            HttpMethod method,
            string path,
            Dictionary<string, string> query = null,
            string body = null,
            CancellationToken cancellationToken = default)
        {
            var url = _config.BaseUrl + path;

            if (query != null && query.Count > 0)
            {
                var parts = new List<string>();
                foreach (var entry in query)
                {
                    if (entry.Value == null) continue;
                    parts.Add(Uri.EscapeDataString(entry.Key) + "=" + Uri.EscapeDataString(entry.Value));
                }
                if (parts.Count > 0) url += "?" + string.Join("&", parts);
            }

            Exception lastError = null;

            for (var attempt = 1; attempt <= _config.MaxRetries + 1; attempt++)
            {
                _config.OnRequest?.Invoke(method + " " + url);

                using (var request = new HttpRequestMessage(method, url))
                {
                    request.Headers.Add("Accept", "application/json");
                    foreach (var header in _config.Headers) request.Headers.Add(header.Key, header.Value);

                    if (!string.IsNullOrEmpty(_config.Token))
                    {
                        request.Headers.Add(${JSON.stringify(spec.security.headerName)}, ${
                          spec.security.kind === 'bearer'
                            ? '"Bearer " + _config.Token'
                            : '_config.Token'
                        });
                    }

                    if (body != null)
                    {
                        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                    }

                    try
                    {
                        var response = await _http.SendAsync(request, cancellationToken)
                            .ConfigureAwait(false);
                        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);

                        _config.OnResponse?.Invoke(method + " " + url + " -> " + (int)response.StatusCode);

                        if (response.IsSuccessStatusCode) return text;

                        var error = new ApiException(
                            (int)response.StatusCode,
                            "error",
                            "Request failed with status " + (int)response.StatusCode + ".",
                            text);

                        if (!error.IsRetryable || attempt > _config.MaxRetries) throw error;
                        lastError = error;
                    }
                    catch (ApiException error)
                    {
                        if (!error.IsRetryable || attempt > _config.MaxRetries) throw;
                        lastError = error;
                    }
                    catch (Exception caught) when (!(caught is OperationCanceledException))
                    {
                        // A connection failure or a timeout — exactly what retry is for.
                        if (attempt > _config.MaxRetries) throw;
                        lastError = caught;
                    }
                }

                // Exponential backoff with full jitter, so clients that failed together do not
                // retry together.
                var capped = (int)Math.Min(1000L * (1L << (attempt - 1)), 10000L);
                await Task.Delay(_random.Next(capped), cancellationToken).ConfigureAwait(false);
            }

            throw lastError;
        }

        public void Dispose() => _http.Dispose();
    }
}
`;

    return [{ path: `${name}.cs`, content }];
  }

  private method(endpoint: Endpoint): string {
    const args = endpoint.pathParams.map((parameter) => `string ${camel(parameter.name)}`);
    if (endpoint.requestBody) args.push('string body');
    for (const parameter of endpoint.queryParams)
      args.push(`string ${camel(parameter.name)} = null`);
    args.push('CancellationToken cancellationToken = default');

    const csharpPath = endpoint.path.replace(
      /\{([^}]+)\}/g,
      (_, param: string) => `" + ${camel(param)} + "`,
    );

    const query =
      endpoint.queryParams.length === 0
        ? 'null'
        : `new Dictionary<string, string> { ${endpoint.queryParams
            .map((parameter) => `{ "${parameter.name}", ${camel(parameter.name)} }`)
            .join(', ')} }`;

    return `        /// <summary>${
      endpoint.summary ?? `${endpoint.method.toUpperCase()} ${endpoint.path}`
    }</summary>
        public Task<string> ${pascal(endpoint.operationId)}Async(${args.join(', ')})
        {
            return RequestAsync(new HttpMethod("${endpoint.method.toUpperCase()}"), "${csharpPath}", ${query}, ${
              endpoint.requestBody ? 'body' : 'null'
            }, cancellationToken);
        }`;
  }
}

/* ------------------------------------------------------------------------- */

function camel(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9]+(.)?/g, (_, char: string | undefined) =>
    char ? char.toUpperCase() : '',
  );
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function pascal(value: string): string {
  const result = camel(value);
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_|_$/g, '');
}

/** Every generator the framework ships. */
export const GENERATORS: ClientGenerator[] = [
  new TypeScriptGenerator(),
  new JavaScriptGenerator(),
  new DartGenerator(),
  new PythonGenerator(),
  new JavaGenerator(),
  new CSharpGenerator(),
];

export function generatorFor(target: string): ClientGenerator {
  const generator = GENERATORS.find((candidate) => candidate.target === target.toLowerCase());

  if (!generator) {
    throw new Error(
      `No generator for "${target}". Available: ${GENERATORS.map((g) => g.target).join(', ')}.`,
    );
  }

  return generator;
}

export { resolveRef };
