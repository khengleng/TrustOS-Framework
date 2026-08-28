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
import { GovernanceToolModule } from './governance-tool.module';

/**
 * Startup for the Governance Tool.
 *
 * The same order as the other applications, for the same reasons — the security policy is
 * validated before a port is bound, headers go on first so they appear on 404s, and the tenant
 * scope is open before any guard runs.
 *
 * Three things specific to this one, all stated at start-up rather than discovered at the first
 * request:
 *
 * **The environment is fixed at boot.** DEV, UAT and PROD run separate instances of this
 * gateway with separate credentials, and an instance cannot be persuaded to serve another
 * environment's resources — there is no request field that selects one.
 *
 * **No resources are registered.** Until a deployment registers its own, every read is refused
 * with "no approved resource". That is the honest answer: a gateway shipping a populated
 * registry would be shipping somebody's database credentials.
 *
 * **The gateway forwards nothing.** It plans, checks and returns what would be called. A
 * deployment wires the forwarder, and it forwards with the *actor's* credential.
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

  /*
   * The environment, read once at start-up and never from a request.
   *
   * `TRUSTOS_ENVIRONMENT` rather than `NODE_ENV`: a UAT gateway runs with `NODE_ENV=production`
   * because that is what turns on production behaviour in the runtime, and conflating the two is
   * how a UAT instance ends up believing it is production or the reverse.
   */
  const environment = readEnvironment();

  const app = await NestFactory.create(
    GovernanceToolModule.forRoot({ config, policy, logger, environment }),
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
        .setTitle('TrustOS Governance Tool')
        .setDescription(
          'The internal application catalog, the ten console templates, the resource registry ' +
            'and the governed promotion between environments. This surface serves descriptors ' +
            'and carries no traffic — reads and actions go through the internal app gateway.',
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
      trustosEnvironment: environment,
      registeredResources: 0,
      appCatalog: 'in-memory',
    },
    'trustos governance-tool started',
  );

  logger.warn(
    {},
    'No resources are registered. Every read will be refused with "no approved resource" until ' +
      'a deployment registers its own — pass `resources` to GovernanceToolModule.forRoot.',
  );

  logger.warn(
    {},
    'The internal application catalog is in memory. Applications created here are lost on ' +
      'restart — pass `apps` to GovernanceToolModule.forRoot with a persistent catalog.',
  );
}

/**
 * Which environment this gateway serves.
 *
 * Deliberately its own variable rather than derived from `NODE_ENV`. A UAT gateway runs with
 * `NODE_ENV=production` — that is what turns on production behaviour in the runtime — and
 * conflating the two is how a UAT instance decides it is production, or the reverse.
 *
 * Refused rather than defaulted. A gateway that defaulted to `dev` in a misconfigured production
 * deployment would be a gateway serving production traffic under development rules.
 */
function readEnvironment(): 'dev' | 'uat' | 'prod' {
  /* eslint-disable no-restricted-properties -- read once at start-up, before the container binds */
  const value = process.env.TRUSTOS_ENVIRONMENT;
  /* eslint-enable no-restricted-properties */

  if (value === 'dev' || value === 'uat' || value === 'prod') return value;

  throw new ConfigurationError([
    'TRUSTOS_ENVIRONMENT must be one of dev, uat or prod. It is deliberately separate from ' +
      'NODE_ENV: a UAT gateway runs with NODE_ENV=production, and conflating the two is how an ' +
      'instance decides it is production when it is not.',
  ]);
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
