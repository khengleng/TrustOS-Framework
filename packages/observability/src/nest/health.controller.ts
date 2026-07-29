import { Controller, Get, Inject, Res } from '@nestjs/common';
import { SetMetadata } from '@nestjs/common';
import { HealthRegistry, healthHttpStatus, type HealthReport } from '../health';

export const HEALTH_REGISTRY = Symbol.for('trustos.health-registry');

/** Health endpoints must be reachable without a token. */
const PublicProbe = () => SetMetadata('trustos:public', true);

interface ResponseLike {
  status: (code: number) => { json: (body: unknown) => void };
}

/**
 * `GET /health` and `GET /ready`.
 *
 * Mounted outside the API's global prefix so a platform probe does not have to
 * know the version path. Both are public: an unauthenticated probe is the
 * point, and neither response contains anything worth protecting.
 */
@Controller()
export class HealthController {
  constructor(@Inject(HEALTH_REGISTRY) private readonly registry: HealthRegistry) {}

  @Get('health')
  @PublicProbe()
  liveness(): HealthReport {
    return this.registry.liveness();
  }

  @Get('ready')
  @PublicProbe()
  async readiness(@Res() response: ResponseLike): Promise<void> {
    const report = await this.registry.readiness();
    response.status(healthHttpStatus(report)).json(report);
  }
}
