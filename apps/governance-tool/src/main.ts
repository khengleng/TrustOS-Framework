import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigurationError, loadConfig, loadDotenv, redactSecrets } from '@trustos/config';
import { AllExceptionsFilter } from '@trustos/errors/nest';
import {
  NO_APPLICATION_EVIDENCE,
  consoleCatalogFor,
  type ApplicationEvidenceIndex,
} from '@trustos/governance-tool-core';
import { OidcIdentityProvider, type IdentityProvider } from '@trustos/identity';
import { NestPinoLogger, createLogger, requestContextMiddleware } from '@trustos/logging';
import { InMemoryMetricsRecorder, recordHttpRequest } from '@trustos/observability';
import {
  SecurityPolicyError,
  loadSecurityPolicy,
  securityPolicySummary,
  type SecurityPolicy,
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
  /** Scheme and host of the issuer, for the one CSP directive the portal needs. */
  const oidcOrigin = originOf(oidcIssuerUrl);

  const policy = loadSecurityPolicy(
    {
      environment: config.env,
      allowedIdentityProviders: [identityProvider],
      tokens: {
        issuer: process.env.SECURITY_TOKEN_ISSUER ?? 'trustos',
        audience: process.env.SECURITY_TOKEN_AUDIENCE ?? 'trustos-api',
      },
      http: {
        corsOrigins: config.http.corsOrigins,
        /*
         * The portal fetches two things from the identity provider: the discovery
         * document, and the token endpoint during the code exchange. Both are
         * cross-origin, and `connect-src 'self'` blocked them — the browser reported
         * "Refused to connect because it violates the document's Content Security
         * Policy" and the sign-in never started.
         *
         * The origin is derived from the issuer rather than configured separately, so
         * it cannot drift from the provider actually in use, and only the origin is
         * allowed — not a wildcard, and nothing else is added to the policy.
         */
        ...(oidcOrigin ? { contentSecurityPolicyExtras: { 'connect-src': [oidcOrigin] } } : {}),
      },
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

  const app = await NestFactory.create<NestExpressApplication>(
    GovernanceToolModule.forRoot({
      config,
      policy,
      logger,
      environment,
      overrides: {
        ...buildIdentityOverrides({ identityProvider, oidcIssuerUrl, oidcClientId, policy }),
        /*
         * The ten console templates, so this gateway serves something on a fresh
         * deployment rather than an empty catalog.
         *
         * These are descriptors — what a console contains, who owns it, how its data
         * is classified — not credentials and not data. Registering them is safe in a
         * way that registering *resources* is not, which is why the warning below
         * about resources still stands.
         */
        apps: consoleCatalogFor(environment),

        /*
         * Validation evidence, when the deployment ships it.
         *
         * Read from the repository rather than compiled in, so that a status can only be
         * as current as the validation run that produced it — and so that an image built
         * without it reports every application as `not_tested` rather than carrying a
         * stale pass forward.
         */
        applicationEvidence: loadApplicationEvidence(logger),

        /*
         * What the browser needs before it holds a token: where to send the user and
         * which client it is. Null without OIDC, and the portal then says so rather
         * than offering a sign-in button that cannot work.
         */
        ...(identityProvider === 'oidc' && oidcIssuerUrl && oidcClientId
          ? {
              portal: {
                issuerUrl: oidcIssuerUrl,
                clientId: process.env.OIDC_WEB_CLIENT_ID ?? 'trustos-web',
                acrValues: process.env.OIDC_ACR_VALUES ?? 'mfa',
              },
            }
          : {}),
      },
    }),
    { logger: new NestPinoLogger(logger), bufferLogs: true },
  );

  /*
   * Turn the banner off at the source.
   *
   * `securityHeadersMiddleware` also removes `X-Powered-By`, and that is the portable
   * belt for any server this framework is mounted on. This is the braces: Express sets
   * the header in its own initialisation middleware, and disabling the setting means it
   * is never written in the first place rather than written and then unwritten — which
   * does not depend on this middleware running before anything that sends a response.
   */
  app.disable('x-powered-by');

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

  /*
   * The portal.
   *
   * Served from this application rather than a separate one because it is this
   * application's own surface: it renders the descriptors these controllers return, and
   * a same-origin portal needs no CORS and no second deployable.
   *
   * Mounted before the global prefix is set, so the assets sit at `/` while the API
   * stays under `/api`. `index.html` is served for `/`, which is also the OIDC redirect
   * target — the browser comes back to `/?code=…` and the portal completes the exchange
   * there. A path that matches no file falls through to the router and still 404s as
   * JSON, so the API's behaviour is unchanged.
   */
  app.useStaticAssets(join(__dirname, '..', 'public'));

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
/**
 * The identity wiring, or nothing.
 *
 * With `IDENTITY_PROVIDER=oidc` this builds the provider and the bearer authenticator
 * the guards need. Without it the module keeps its default — `refusingIdentityProvider()`
 * — and every request is refused. That default is deliberate and this function does not
 * soften it: an application that fell back to something permissive when its identity
 * configuration was missing would be at its most permissive exactly when somebody had
 * misconfigured it.
 *
 * The role map is configuration rather than code because provider role names belong to
 * whoever runs the provider. `OIDC_ROLE_MAP` is `provider-role=trustos-role`, comma
 * separated; `OIDC_SUPER_ADMIN_ROLES` names the provider roles that mean platform staff.
 */
function buildIdentityOverrides(input: {
  identityProvider: 'local' | 'oidc';
  oidcIssuerUrl: string;
  oidcClientId: string;
  policy: SecurityPolicy;
}): { identityProvider: IdentityProvider } | undefined {
  if (input.identityProvider !== 'oidc') return undefined;

  if (!input.oidcIssuerUrl || !input.oidcClientId) {
    throw new ConfigurationError([
      'IDENTITY_PROVIDER=oidc requires OIDC_ISSUER_URL and OIDC_CLIENT_ID. Refusing to start ' +
        'with an identity provider that cannot verify a token.',
    ]);
  }

  const provider = new OidcIdentityProvider(
    {
      issuerUrl: input.oidcIssuerUrl,
      clientId: input.oidcClientId,
      ...(process.env.OIDC_END_SESSION_ENDPOINT
        ? { endSessionEndpoint: process.env.OIDC_END_SESSION_ENDPOINT }
        : {}),
      /*
       * Clients permitted to obtain a token for this API, beyond its own id.
       *
       * Keycloak puts the resource server in `aud` and the client that asked for the
       * token in `azp`, and the provider checks both — a deployment checking only one
       * accepts tokens minted for a different client. So the browser client has to be
       * named here: its tokens carry `aud: trustos-api` and `azp: trustos-web`, and
       * without this the portal's own token is refused with
       * `oidc_authorized_party_rejected`.
       *
       * This is an allow-list, not a relaxation. Naming trustos-web says the portal may
       * call this API; a token from any client not listed is still refused.
       */
      additionalAudiences: parseList(process.env.OIDC_ADDITIONAL_AUDIENCES),
      groupsClaim: 'groups',
      organizationClaim: 'trustos_organization',
      roleMap: parsePairs(process.env.OIDC_ROLE_MAP),
      superAdminRoles: parseList(process.env.OIDC_SUPER_ADMIN_ROLES),
    },
    // The token and MFA rules are the security policy's, not this file's. Passing
    // them keeps one source of truth for how long a token may live and what
    // authentication strength a route can demand.
    input.policy.tokens,
    input.policy.mfa,
  );

  /*
   * Only the provider. The bearer authenticator and its access resolver are assembled in
   * the module, where the Prisma client lives — this file configures, the module wires.
   */
  return { identityProvider: provider };
}

/** `a=b,c=d` into an object. Empty or malformed pairs are dropped rather than guessed at. */
function parsePairs(value: string | undefined): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const entry of parseList(value)) {
    const [from, to] = entry.split('=');
    if (from && to) pairs[from.trim()] = to.trim();
  }
  return pairs;
}

/**
 * Loads validation evidence written by the validation suites.
 *
 * Absent, unreadable or malformed all resolve to no evidence, which reports every
 * application as `not_tested`. That is the honest failure direction: a catalog that
 * cannot read its evidence should claim nothing, not claim the last thing it remembered.
 */
function loadApplicationEvidence(logger: {
  warn: (message: string, context?: Record<string, unknown>) => void;
}): ApplicationEvidenceIndex {
  const path = join(process.cwd(), 'docs/validation/application-evidence.json');

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as ApplicationEvidenceIndex;
  } catch (error) {
    // Not an error condition: most deployments ship without it.
    logger.warn('No application validation evidence found; every application reports not_tested.', {
      reason: error instanceof Error ? error.message : 'unreadable',
    });
    return NO_APPLICATION_EVIDENCE;
  }
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The origin of a URL, or null when there is no usable URL to take one from. */
function originOf(url: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    // A malformed issuer is caught properly by loadSecurityPolicy, which reports it
    // with the other configuration problems rather than throwing from here.
    return null;
  }
}

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
