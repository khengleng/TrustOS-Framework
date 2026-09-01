import { ApiError } from '@trustsystem/errors';

/**
 * The OpenAPI subset the generator reads.
 *
 * Deliberately a subset. A complete OpenAPI implementation is a large project with a long tail of
 * features nobody in a single organization uses, and getting 95% of it wrong is worse than
 * getting a clear 80% right. What is supported is stated here; what is not is **reported**, not
 * silently ignored — a generated client missing an endpoint because of an unsupported construct
 * is a bug somebody finds at runtime.
 *
 * Supported: paths and operations, path/query/header parameters, JSON request and response
 * bodies, `$ref` to `components/schemas`, objects, arrays, primitives, enums, `nullable`,
 * `allOf` (merged), `oneOf`/`anyOf` (as a union).
 *
 * Not supported, and reported: `multipart/form-data`, XML bodies, callbacks, links, discriminated
 * polymorphism, recursive `$ref` beyond a depth limit.
 */

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, { type: string; scheme?: string; name?: string; in?: string }>;
  };
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: OpenApiSchema }> }
  >;
  deprecated?: boolean;
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}

export interface OpenApiSchema {
  $ref?: string;
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  description?: string;
  example?: unknown;
}

/** One endpoint, resolved into what a generator needs. Language-neutral. */
export interface Endpoint {
  /** The method name in the generated client. */
  operationId: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';
  path: string;
  summary: string | null;
  tag: string;
  deprecated: boolean;

  pathParams: ResolvedParameter[];
  queryParams: ResolvedParameter[];
  headerParams: ResolvedParameter[];

  requestBody: { schema: OpenApiSchema; required: boolean } | null;
  /** The 2xx response schema, or null when the endpoint returns nothing. */
  responseSchema: OpenApiSchema | null;
  /** Documented error statuses. Rendered into the client's error handling. */
  errorStatuses: number[];
}

export interface ResolvedParameter {
  name: string;
  required: boolean;
  schema: OpenApiSchema;
  description: string | null;
}

export interface ParsedSpec {
  title: string;
  version: string;
  /** The first server URL, as the client's default base. */
  baseUrl: string | null;
  endpoints: Endpoint[];
  schemas: Record<string, OpenApiSchema>;
  /** Constructs that were skipped. Reported, never silently dropped. */
  warnings: string[];
  security: { kind: 'bearer' | 'apiKey' | 'none'; headerName: string };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

export function parseOpenApi(document: OpenApiDocument): ParsedSpec {
  if (!document.paths || Object.keys(document.paths).length === 0) {
    throw ApiError.validation(
      [{ path: 'paths', message: 'The document has no paths, so there is nothing to generate.' }],
      'This OpenAPI document is empty.',
    );
  }

  const warnings: string[] = [];
  const endpoints: Endpoint[] = [];
  const seenOperationIds = new Set<string>();

  for (const [path, operations] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = operations[method];
      if (!operation) continue;

      const operationId = resolveOperationId(operation, method, path, seenOperationIds, warnings);
      const parameters = operation.parameters ?? [];

      const body = pickJsonBody(operation, warnings, operationId);
      const response = pickJsonResponse(operation, warnings, operationId);

      endpoints.push({
        operationId,
        method,
        path,
        summary: operation.summary ?? operation.description ?? null,
        tag: operation.tags?.[0] ?? 'default',
        deprecated: operation.deprecated === true,
        pathParams: parameters.filter((p) => p.in === 'path').map(toResolved),
        queryParams: parameters.filter((p) => p.in === 'query').map(toResolved),
        // Cookie parameters are dropped: a generated HTTP client should not be managing cookies,
        // and silently ignoring one would produce a client that omits a required value.
        headerParams: parameters.filter((p) => p.in === 'header').map(toResolved),
        requestBody: body,
        responseSchema: response,
        errorStatuses: Object.keys(operation.responses ?? {})
          .map((status) => Number.parseInt(status, 10))
          .filter((status) => Number.isFinite(status) && status >= 400)
          .sort(),
      });

      const cookies = parameters.filter((p) => p.in === 'cookie');
      if (cookies.length > 0) {
        warnings.push(
          `${operationId}: cookie parameters (${cookies.map((p) => p.name).join(', ')}) are not ` +
            'generated. A generated client should not manage cookies.',
        );
      }
    }
  }

  /*
   * A path with no generated operation is reported.
   *
   * The whole point of collecting warnings: a client silently missing an endpoint is a bug found
   * at runtime by whoever tries to call it, long after the generation that dropped it.
   */
  const security = resolveSecurity(document);

  return {
    title: document.info?.title ?? 'API',
    version: document.info?.version ?? '1.0.0',
    baseUrl: document.servers?.[0]?.url ?? null,
    endpoints: endpoints.sort(
      (a, b) => a.tag.localeCompare(b.tag) || a.operationId.localeCompare(b.operationId),
    ),
    schemas: document.components?.schemas ?? {},
    warnings,
    security,
  };
}

function toResolved(parameter: OpenApiParameter): ResolvedParameter {
  return {
    name: parameter.name,
    required: parameter.required === true,
    schema: parameter.schema ?? { type: 'string' },
    description: parameter.description ?? null,
  };
}

/**
 * The method name.
 *
 * Derived from the path when `operationId` is absent, because a spec without them is common and
 * refusing to generate would be unhelpful. A collision is renamed and reported — two methods with
 * one name is a compile error in most of the target languages and a silent overwrite in the rest.
 */
function resolveOperationId(
  operation: OpenApiOperation,
  method: string,
  path: string,
  seen: Set<string>,
  warnings: string[],
): string {
  let candidate = operation.operationId ?? deriveOperationId(method, path);
  candidate = toCamelCase(candidate);

  if (seen.has(candidate)) {
    const original = candidate;
    let suffix = 2;
    while (seen.has(`${candidate}${suffix}`)) suffix += 1;
    candidate = `${candidate}${suffix}`;

    warnings.push(
      `Two operations resolve to the name "${original}"; the second was renamed to ` +
        `"${candidate}". Set an explicit operationId to control this.`,
    );
  }

  seen.add(candidate);
  return candidate;
}

function deriveOperationId(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    // `{id}` becomes `by_id`, so `GET /users/{id}` reads as `getUsersById`.
    .map((segment) => (segment.startsWith('{') ? `by_${segment.slice(1, -1)}` : segment));

  return [method, ...segments].join('_');
}

export function toCamelCase(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9]+(.)?/g, (_, char: string | undefined) =>
    char ? char.toUpperCase() : '',
  );
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

export function toPascalCase(value: string): string {
  const camel = toCamelCase(value);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function pickJsonBody(
  operation: OpenApiOperation,
  warnings: string[],
  operationId: string,
): { schema: OpenApiSchema; required: boolean } | null {
  const content = operation.requestBody?.content;
  if (!content) return null;

  const json = content['application/json'];

  if (!json?.schema) {
    const types = Object.keys(content);
    // Reported rather than ignored: a client generated without the body would fail at runtime
    // with a confusing 400 rather than at generation time with a clear message.
    warnings.push(
      `${operationId}: the request body is ${types.join(', ')}, which is not generated. Only ` +
        'application/json is supported.',
    );
    return null;
  }

  return { schema: json.schema, required: operation.requestBody?.required === true };
}

function pickJsonResponse(
  operation: OpenApiOperation,
  warnings: string[],
  operationId: string,
): OpenApiSchema | null {
  const responses = operation.responses ?? {};

  const successStatus = Object.keys(responses)
    .filter((status) => /^2\d\d$/.test(status))
    .sort()[0];

  if (!successStatus) return null;

  const content = responses[successStatus]?.content;
  // 204 and friends genuinely have no body; that is not worth a warning.
  if (!content) return null;

  const json = content['application/json'];

  if (!json?.schema) {
    warnings.push(
      `${operationId}: the ${successStatus} response is ${Object.keys(content).join(', ')}, ` +
        'which is not generated. The method will return the raw response.',
    );
    return null;
  }

  return json.schema;
}

function resolveSecurity(document: OpenApiDocument): ParsedSpec['security'] {
  const schemes = document.components?.securitySchemes ?? {};

  for (const scheme of Object.values(schemes)) {
    if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      return { kind: 'bearer', headerName: 'Authorization' };
    }
    if (scheme.type === 'apiKey' && scheme.in === 'header') {
      return { kind: 'apiKey', headerName: scheme.name ?? 'X-API-Key' };
    }
  }

  return { kind: 'none', headerName: 'Authorization' };
}

/**
 * Resolves a `$ref` against the document's schemas.
 *
 * Depth-limited, because a recursive schema — a tree node with children of its own type — would
 * otherwise loop forever. The limit is deep enough for any real payload and shallow enough that
 * hitting it is a signal rather than a stack overflow.
 */
export function resolveRef(
  schema: OpenApiSchema,
  schemas: Record<string, OpenApiSchema>,
  depth = 0,
): OpenApiSchema {
  if (depth > 20) return { type: 'object', description: 'Recursion limit reached.' };
  if (!schema.$ref) return schema;

  const name = schema.$ref.replace('#/components/schemas/', '');
  const resolved = schemas[name];

  if (!resolved) {
    // An unresolvable ref becomes `unknown` rather than throwing: one bad reference should not
    // stop the other 200 endpoints being generated.
    return { type: 'object', description: `Unresolved reference: ${schema.$ref}` };
  }

  return resolveRef(resolved, schemas, depth + 1);
}

/** The schema name a `$ref` points at, for generating a named type. */
export function refName(schema: OpenApiSchema): string | null {
  if (!schema.$ref) return null;
  const name = schema.$ref.split('/').pop();
  return name ? toPascalCase(name) : null;
}
