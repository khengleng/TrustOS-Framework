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
import { FinancialProductAdminModule } from './financial-product-admin.module';

/**
 * Startup for the Financial Product Designer.
 *
 * The same order as the other administration examples, for the same reasons — the security
 * policy is validated before a port is bound, headers go on first so they appear on 404s, and
 * the tenant scope is open before any guard runs.
 *
 * Two things specific to this application, both stated at start-up rather than discovered at
 * the first request:
 *
 * **No block handlers are registered.** The framework ships none, deliberately — the catalog
 * knows what a debit means and stays out of deciding which account it lands in. Until a
 * deployment binds them, every product execution fails at its first block, loudly, rather than
 * skipping a control.
 *
 * **The product store is in memory.** Phase 11 adds no Prisma models: which shape a product
 * definition takes in a database is a decision a deployment makes against its own retention and
 * access rules. Everything composed here is lost on restart, and the log line says so.
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
  void metrics;

  const app = await NestFactory.create(
    FinancialProductAdminModule.forRoot({ config, policy, logger }),
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
        .setTitle('TrustOS Financial Product Designer')
        .setDescription(
          'The product catalog, the composer and its designer data, the block and connector ' +
            'catalogs, the sandbox, the simulator, approvals, deployments and monitoring. No ' +
            'route writes a lifecycle state directly — every move goes through the registry, ' +
            'which resolves the transition before it consults authorization.',
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
      // Stated at start-up rather than discovered at the first request.
      blockHandlers: 0,
      productStore: 'in-memory',
    },
    'trustos financial-product-admin started',
  );

  logger.warn(
    {},
    'No block handlers are registered. Every product execution will fail at its first block — ' +
      'pass `handlers` to FinancialProductAdminModule.forRoot, binding each approved block to ' +
      'an implementation. The framework ships none: the seam is the deliverable.',
  );

  logger.warn(
    {},
    'The product store is in memory. Everything composed here is lost on restart — pass ' +
      '`productStore` to FinancialProductAdminModule.forRoot with a persistent implementation ' +
      'of the ProductStore port.',
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
