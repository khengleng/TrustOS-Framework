import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigurationError, loadConfig, loadDotenv, redactSecrets } from '@trustsystem/config';
import { AllExceptionsFilter } from '@trustsystem/errors/nest';
import { NestPinoLogger, createLogger, requestContextMiddleware } from '@trustsystem/logging';
import { InMemoryMetricsRecorder, recordHttpRequest } from '@trustsystem/observability';
import {
  SecurityPolicyError,
  loadSecurityPolicy,
  securityPolicySummary,
} from '@trustsystem/security-policy';
import { securityHeadersMiddleware } from '@trustsystem/session-security';
import { tenantScopeMiddleware } from '@trustsystem/tenancy';
import { EnterpriseGovernanceAdminModule } from './enterprise-governance-admin.module';

/**
 * Startup for the Enterprise Governance Console backend.
 *
 * The same order as every other TrustOS application, for the same reasons — the security policy is
 * validated before a port is bound, headers go on first so they appear on 404s, and the tenant
 * scope is open before any guard runs.
 *
 * Two things specific to this application, both stated at start-up rather than discovered at the
 * first request:
 *
 * **Every governance registry is empty and in memory.** A catalog entry, a policy document, a
 * service registration and a DR plan are documents; phase 13 adds no Prisma models for them, and
 * which shape they take in a database is a deployment's decision. Everything loaded here is lost
 * on restart, and the log line says so.
 *
 * **No obligation kinds are declared.** A policy carrying an obligation therefore denies, which is
 * the correct default: a caller silently ignoring an obligation it does not understand converts a
 * conditional permission into an unconditional one.
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
    EnterpriseGovernanceAdminModule.forRoot({ config, policy, logger }),
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
        .setTitle('TrustOS Enterprise Governance Console')
        .setDescription(
          'Data governance, policy-as-code, SRE, API management and continuity. Simulating a ' +
            'policy and deciding with one are separate routes rather than one route with a flag, ' +
            'and no route edits an active policy version — a version whose contents can change ' +
            'makes every decision record unre-derivable.',
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
      governanceRegistries: 'in-memory',
      supportedObligations: 0,
      policyDecisionLog: 'in-memory',
    },
    'trustos enterprise-governance-admin started',
  );

  logger.warn(
    {},
    'Every governance registry is empty and in memory. Load the catalog, policies, services, APIs, ' +
      'backups and DR plans through EnterpriseGovernanceAdminModule.forRoot overrides — nothing ' +
      'recorded through this application survives a restart except the audit trail.',
  );

  logger.warn(
    {},
    'The policy decision log is in memory. A decision log that does not survive a restart cannot ' +
      'answer an auditor; bind a persistent PolicyDecisionSink before this is used for anything ' +
      'that has to be re-derived later.',
  );

  logger.warn(
    {},
    'No obligation kinds are declared, so any policy carrying an obligation will deny. Declare what ' +
      'this deployment can honour through `supportedObligations`.',
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
  console.error('Failed to start enterprise-governance-admin:', error);
  process.exit(1);
});
