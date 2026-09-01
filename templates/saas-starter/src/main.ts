import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigurationError, loadConfig, loadDotenv } from '@trustsystem/config';
import { AllExceptionsFilter } from '@trustsystem/errors/nest';
import { NestPinoLogger, createLogger, requestContextMiddleware } from '@trustsystem/logging';
import { InMemoryMetricsRecorder, recordHttpRequest } from '@trustsystem/observability';
import { tenantScopeMiddleware } from '@trustsystem/tenancy';
import { AppModule } from './app.module';

/**
 * Entry point for a new TrustOS product.
 *
 * Copy this file as-is. The only thing worth changing is `SERVICE_NAME` in the
 * environment and the Swagger title below — the startup sequence itself is the
 * framework contract:
 *
 *   validate configuration -> build the logger -> install request context ->
 *   install the error filter -> listen
 */
async function bootstrap(): Promise<void> {
  loadDotenv();

  const config = loadConfig();
  const logger = createLogger(config);
  const metrics = new InMemoryMetricsRecorder();

  const app = await NestFactory.create(AppModule.forRoot({ config, logger, metrics }), {
    logger: new NestPinoLogger(logger),
    bufferLogs: true,
  });

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
  app.setGlobalPrefix(config.http.globalPrefix, { exclude: ['health', 'ready'] });

  if (config.http.corsOrigins.length > 0) {
    app.enableCors({ origin: config.http.corsOrigins, credentials: true });
  }

  if (config.observability.openApiEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('TrustOS SaaS Starter')
        .setVersion(config.serviceVersion)
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }

  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');

  logger.info({ port: config.port, service: config.serviceName }, 'service started');
}

bootstrap().catch((error) => {
  if (error instanceof ConfigurationError) {
    // eslint-disable-next-line no-console -- bootstrap failure, before the logger exists
    console.error(error.message);
    process.exit(1);
  }
  // eslint-disable-next-line no-console -- bootstrap failure, before the logger exists
  console.error('Failed to start:', error);
  process.exit(1);
});
