import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigurationError, loadConfig, loadDotenv, redactSecrets } from '@trustos/config';
import { AllExceptionsFilter } from '@trustos/errors/nest';
import { NestPinoLogger, createLogger, requestContextMiddleware } from '@trustos/logging';
import {
  SecurityPolicyError,
  loadSecurityPolicy,
  securityPolicySummary,
} from '@trustos/security-policy';
import { securityHeadersMiddleware } from '@trustos/session-security';
import { tenantScopeMiddleware } from '@trustos/tenancy';
import { SecurityAdminModule } from './security-admin.module';

/**
 * Startup for the security administration API.
 *
 * The order below is the phase's security posture expressed as code, and each step
 * is here because skipping it fails open:
 *
 *   1. Load and validate the security policy *before* anything binds a port. A
 *      production deployment with a five-hour access token, a wildcard CORS origin or
 *      a placeholder signing secret refuses to start; the alternative is that it
 *      starts and nobody notices for a quarter.
 *   2. Security headers first among the middleware, so they are present on error
 *      responses and on 404s as well as on handled routes.
 *   3. Request context before the guards, so an authentication failure still has a
 *      request id to correlate with a security event.
 *   4. The tenant scope before the guards, for the same reason it is middleware in
 *      the API example: `TenantGuard` fills in a scope that must already be open.
 */
async function bootstrap(): Promise<void> {
  loadDotenv();

  const config = loadConfig();

  /*
   * The identity mode is one environment variable, and it is read once, here.
   * `allowedIdentityProviders` is a list rather than a flag because a deployment
   * migrating to OIDC runs both for a while — but the loader refuses `local`
   * alongside `oidc` in production, so no deployment ends up accepting a
   * development credential next to a real one by accident.
   */
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
      // Passed so their *strength* can be checked. The loader reads a length and
      // compares against a placeholder list; it retains nothing and prints nothing.
      localJwtSecret: config.auth.jwtSecret,
      localJwtRefreshSecret: config.auth.jwtRefreshSecret,
      ...(oidcIssuerUrl ? { oidcIssuerUrl } : {}),
      ...(oidcClientId ? { oidcClientId } : {}),
      // An escape hatch that has to be typed out, so running the local provider in
      // production is a recorded decision rather than an oversight.
      allowLocalIdentityInProduction:
        process.env.SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION === 'true',
    },
  );

  const logger = createLogger(config);

  const app = await NestFactory.create(
    SecurityAdminModule.forRoot({
      config,
      policy,
      logger,
      correlationSalt: config.auth.jwtSecret,
      ...(identityProvider === 'oidc'
        ? {
            oidc: {
              issuerUrl: oidcIssuerUrl,
              clientId: oidcClientId,
              ...(process.env.OIDC_ROLE_MAP
                ? { roleMap: JSON.parse(process.env.OIDC_ROLE_MAP) as Record<string, string> }
                : {}),
              ...(process.env.OIDC_END_SESSION_ENDPOINT
                ? { endSessionEndpoint: process.env.OIDC_END_SESSION_ENDPOINT }
                : {}),
            },
          }
        : {}),
    }),
    { logger: new NestPinoLogger(logger), bufferLogs: true },
  );

  // First among the middleware, so the headers are present on 404s and on error
  // responses too — the responses a misconfigured client is most likely to see.
  // `/docs` is the one relaxed path, because Swagger UI needs inline styles, and it
  // is disabled in production by the framework's own configuration anyway.
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
    }),
  );

  app.use(tenantScopeMiddleware());

  app.useGlobalFilters(new AllExceptionsFilter({ environment: config.env, logger }));
  app.setGlobalPrefix(config.http.globalPrefix, { exclude: ['health', 'ready'] });

  if (config.http.corsOrigins.length > 0) {
    // The origins were already checked by the policy loader, which refuses `*` and
    // plain http in production. Nest only ever sees a vetted list.
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
        .setTitle('TrustOS Security Administration')
        .setDescription(
          'Identity status, sessions and devices, API keys, service accounts and the ' +
            'security event trail. No route in this API returns a credential value, a ' +
            'token, or a secret configuration value.',
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
      // Both are projections that enumerate safe fields rather than removing unsafe
      // ones, so neither can start leaking when a setting is added.
      config: redactSecrets(config),
      securityPolicy: securityPolicySummary(policy),
    },
    'trustos security-admin-example started',
  );
}

bootstrap().catch((error) => {
  if (error instanceof SecurityPolicyError) {
    // The whole point of the startup check: a readable list of what is wrong, with no
    // secret values in it, in the deploy log where somebody will see it.
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
  console.error('Failed to start security-admin-example:', error);
  process.exit(1);
});
