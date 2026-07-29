/**
 * OpenTelemetry-ready tracing interfaces.
 *
 * Deliberately *not* a dependency on `@opentelemetry/*`. The shapes below are
 * a subset of the OTel API chosen so that a real tracer can be dropped in with
 * a thin adapter, while a service that never adopts tracing pays nothing —
 * no SDK, no exporter, no startup cost.
 *
 * When OTel is adopted: implement `Tracer` over `trace.getTracer(...)`, provide
 * it in place of `NoopTracer`, and delete nothing.
 */

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export type SpanStatus = 'unset' | 'ok' | 'error';

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: SpanStatus, message?: string): void;
  recordException(error: unknown): void;
  end(): void;
}

export interface SpanOptions {
  attributes?: SpanAttributes;
  kind?: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
}

export class NoopSpan implements Span {
  setAttribute(): void {}
  setStatus(): void {}
  recordException(): void {}
  end(): void {}
}

export class NoopTracer implements Tracer {
  startSpan(): Span {
    return new NoopSpan();
  }
}

/**
 * Runs `fn` inside a span, ending it exactly once and marking failures.
 *
 * Using this instead of manual start/end is what keeps a thrown error from
 * leaving an unclosed span behind.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  const span = tracer.startSpan(name, options);
  try {
    const result = await fn(span);
    span.setStatus('ok');
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus('error', error instanceof Error ? error.message : 'unknown error');
    throw error;
  } finally {
    span.end();
  }
}
