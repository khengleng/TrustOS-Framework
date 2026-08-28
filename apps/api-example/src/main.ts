import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigurationError, loadConfig, loadDotenv, redactSecrets } from '@trustos/config';
import { AllExceptionsFilter } from '@trustos/errors/nest';
import { NestPinoLogger, createLogger, requestContextMiddleware } from '@trustos/logging';
import { InMemoryMetricsRecorder, recordHttpRequest } from '@trustos/observability';
import { SecurityPolicyError, loadSecurityPolicy } from '@trustos/security-policy';
import { securityHeadersMiddleware } from '@trustos/session-security';
import { tenantScopeMiddleware } from '@trustos/tenancy';
import { AppModule } from './app.module';

/**
 * Startup order matters here:
 *
 *   1. Load `.env` (development only) and validate configuration. Anything
 *      invalid aborts before a port is bound, so a misconfigured deploy fails
 *      immediately and visibly rather than serving broken traffic.
 *   2. Build the logger, so every later step is observable.
 *   3. Install the security headers first among the middleware, so they are
 *      present on 404s and on error responses — the responses a misconfigured
 *      client is most likely to see.
 *   4. Install the request-context middleware, so even a failure inside a guard
 *      has a request id.
 */
async function bootstrap(): Promise<void> {
  loadDotenv();

  const config = loadConfig();

  /*
   * The security policy, validated before a port is bound.
   *
   * This application predates `@trustos/security-policy` and went without it until a smoke test
   * against a running instance found no `X-Content-Type-Options` and no `X-Frame-Options` on any
   * response. Every other application in the repository mounts the headers; the reference API —
   * the one people copy — did not.
   */
  const identityProvider = process.env.IDENTITY_PROVIDER === 'oidc' ? 'oidc' : 'local';

  const policy = loadSecurityPolicy(
    {
      environment: config.env,
      allowedIdentityProviders: [identityProvider],
      tokens: {
        issuer: process.env.SECURITY_TOKEN_ISSUER ?? 'trustos',
        audience: process.env.SECURITY_TOKEN_AUDIENCE ?? 'trustos-api',
      },
      http: { corsOrigins: config.http.corsOrigins },
    },
    {
      localJwtSecret: config.auth.jwtSecret,
      localJwtRefreshSecret: config.auth.jwtRefreshSecret,
      ...(process.env.OIDC_ISSUER_URL ? { oidcIssuerUrl: process.env.OIDC_ISSUER_URL } : {}),
      ...(process.env.OIDC_CLIENT_ID ? { oidcClientId: process.env.OIDC_CLIENT_ID } : {}),
      allowLocalIdentityInProduction:
        process.env.SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION === 'true',
    },
  );

  const logger = createLogger(config);
  const metrics = new InMemoryMetricsRecorder();

  const app = await NestFactory.create(AppModule.forRoot({ config, logger, metrics }), {
    logger: new NestPinoLogger(logger),
    bufferLogs: true,
  });

  // First among the middleware, so the headers are present on 404s and on error responses — the
  // responses a misconfigured client is most likely to see.
  app.use(
    securityHeadersMiddleware({
      policy: policy.http,
      environment: config.env,
      relaxedPaths: ['/docs'],
    }),
  );

  // Registered with app.use rather than a MiddlewareConsumer so that it runs
  // ahead of Nest's routing, giving 404s and guard failures a request id too.
  app.use(
    requestContextMiddleware({
      config,
      logger,
      ignorePaths: ['/health', '/ready'],
      onComplete: (completion) => recordHttpRequest(metrics, completion),
    }),
  );

  // Opens the per-request tenant scope that TenantGuard fills in. It must run
  // before the guards, which is why it is middleware and not an interceptor.
  app.use(tenantScopeMiddleware());

  app.useGlobalFilters(new AllExceptionsFilter({ environment: config.env, logger }));

  // Health probes stay at the root so a platform check does not need to know
  // the API prefix.
  app.setGlobalPrefix(config.http.globalPrefix, { exclude: ['health', 'ready'] });

  if (config.http.corsOrigins.length > 0) {
    app.enableCors({
      origin: config.http.corsOrigins,
      credentials: true,
      exposedHeaders: [config.http.requestIdHeader],
    });
  }

  if (config.observability.openApiEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('TrustOS Example API')
        .setDescription(
          'Reference API for the TrustOS Engineering Framework. Demonstrates authentication, ' +
            'organization tenancy, RBAC and audit logging.',
        )
        .setVersion(config.serviceVersion)
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
        .build(),
    );
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');

  logger.info(
    {
      port: config.port,
      docs: config.observability.openApiEnabled ? '/docs' : null,
      // Secrets are stripped; the rest is exactly what an operator needs when
      // asking "what is this instance actually running with?".
      config: redactSecrets(config),
    },
    'trustos api-example started',
  );
}

bootstrap().catch((error) => {
  if (error instanceof SecurityPolicyError) {
    // eslint-disable-next-line no-console -- bootstrap failure, before the logger exists
    console.error(`Refusing to start. ${error.message}`);
    process.exit(1);
  }
  if (error instanceof ConfigurationError) {
    // No logger yet, and this must be readable in a deploy log.
    // eslint-disable-next-line no-console -- bootstrap failure, before the logger exists
    console.error(error.message);
    process.exit(1);
  }
  // eslint-disable-next-line no-console -- bootstrap failure, before the logger exists
  console.error('Failed to start api-example:', error);
  process.exit(1);
});
