import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigurationError, loadConfig, loadDotenv, redactSecrets } from '@trustos/config';
import { AllExceptionsFilter } from '@trustos/errors/nest';
import { NestPinoLogger, createLogger, requestContextMiddleware } from '@trustos/logging';
import { InMemoryMetricsRecorder, recordHttpRequest } from '@trustos/observability';
import {
  SecurityPolicyError,
  loadSecurityPolicy,
  securityPolicySummary,
} from '@trustos/security-policy';
import { securityHeadersMiddleware } from '@trustos/session-security';
import { tenantScopeMiddleware } from '@trustos/tenancy';
import { WorkflowAdminModule } from './workflow-admin.module';

/**
 * Startup for the workflow administration API.
 *
 * The same order as the security administration example, for the same reasons — the
 * security policy is validated before a port is bound, headers go on first so they appear
 * on 404s, and the tenant scope is open before any guard runs.
 *
 * One thing specific to this application: it registers **no business-object validators**.
 * That is deliberate and it means `POST /workflow/instances` refuses in production, because
 * without a validator an instance could be started against a record in another
 * organization. A real deployment passes `objectValidators` for the types its workflows
 * govern; the example cannot, because it does not know what a `Merchant` is.
 */
async function bootstrap(): Promise<void> {
  loadDotenv();

  const config = loadConfig();

  const identityProvider = process.env.IDENTITY_PROVIDER === 'oidc' ? 'oidc' : 'local';
  const oidcIssuerUrl = process.env.OIDC_ISSUER_URL ?? '';
  const oidcClientId = process.env.OIDC_CLIENT_ID ?? '';

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
      ...(oidcIssuerUrl ? { oidcIssuerUrl } : {}),
      ...(oidcClientId ? { oidcClientId } : {}),
      allowLocalIdentityInProduction:
        process.env.SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION === 'true',
    },
  );

  const logger = createLogger(config);
  const metrics = new InMemoryMetricsRecorder();

  const app = await NestFactory.create(
    WorkflowAdminModule.forRoot({ config, policy, logger, metrics }),
    { logger: new NestPinoLogger(logger), bufferLogs: true },
  );

  // First among the middleware, so the headers are present on 404s and on error responses —
  // the responses a misconfigured client is most likely to see.
  app.use(
    securityHeadersMiddleware({
      policy: policy.http,
      environment: config.env,
      relaxedPaths: ['/docs'],
    }),
  );

  app.use(
    requestContextMiddleware({
      config,
      logger,
      ignorePaths: ['/health', '/ready'],
      onComplete: (completion) => recordHttpRequest(metrics, completion),
    }),
  );

  // Opens the per-request tenant scope that TenantGuard fills in. Middleware rather than an
  // interceptor, because it has to run before the guards.
  app.use(tenantScopeMiddleware());

  app.useGlobalFilters(new AllExceptionsFilter({ environment: config.env, logger }));
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
        .setTitle('TrustOS Workflow Administration')
        .setDescription(
          'Workflow definitions and their governance, instances and transitions, task queues, ' +
            'SLA state, escalations and cases. No route sets a workflow state directly — every ' +
            'move goes through an action the definition declares.',
        )
        .setVersion(config.serviceVersion)
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
        .build(),
    );
    SwaggerModule.setup('docs', app, document, { swaggerOptions: { persistAuthorization: true } });
  }

  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');

  logger.info(
    {
      port: config.port,
      config: redactSecrets(config),
      securityPolicy: securityPolicySummary(policy),
      // Stated at start-up rather than discovered at the first request. A deployment that
      // has not registered validators should know before somebody tries to start a workflow.
      businessObjectValidators: 0,
    },
    'trustos workflow-admin-example started',
  );

  logger.warn(
    {},
    'No business-object validators are registered. Starting a workflow instance will be ' +
      'refused in production — pass objectValidators to WorkflowAdminModule.forRoot for the ' +
      'object types your workflows govern.',
  );
}

bootstrap().catch((error) => {
  if (error instanceof SecurityPolicyError) {
    // eslint-disable-next-line no-console -- bootstrap failure, before the logger exists
    console.error(`Refusing to start. ${error.message}`);
    process.exit(1);
  }
  if (error instanceof ConfigurationError) {
    // eslint-disable-next-line no-console -- bootstrap failure, before the logger exists
    console.error(error.message);
    process.exit(1);
  }
  // eslint-disable-next-line no-console -- bootstrap failure, before the logger exists
  console.error('Failed to start workflow-admin-example:', error);
  process.exit(1);
});
