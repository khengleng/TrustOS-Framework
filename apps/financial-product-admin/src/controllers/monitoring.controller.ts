import { Controller, Get, Inject, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { RequirePermissions } from '@trustos/rbac';
import { FINANCIAL_PRODUCT_PERMISSIONS } from '@trustos/financial-product-core';
import {
  PRODUCT_DASHBOARDS,
  PRODUCT_METRIC_CATALOG,
  findDashboard,
  type MetricCollector,
} from '@trustos/financial-product-observability';
import { METRIC_COLLECTOR } from '../tokens';

/**
 * Monitoring.
 *
 * The dashboards are descriptors and the numbers come from whatever the deployment wired as its
 * metric sink. The in-memory collector behind this controller is the default, and it is honest
 * about what it is: per-process, bounded, and reset on restart. A deployment with more than one
 * process wires an exporter, and this controller then serves the descriptors while the numbers
 * come from the deployment's own system.
 *
 * `dropped` is exposed rather than hidden. A non-zero value means the collector hit its series
 * cap and the dashboard is incomplete — which somebody needs to know, because an incomplete
 * dashboard that does not say so is worse than no dashboard.
 */
@ApiTags('Monitoring')
@ApiBearerAuth()
@Controller('financial-products/monitoring')
export class MonitoringController {
  constructor(@Inject(METRIC_COLLECTOR) private readonly collector: MetricCollector) {}

  @Get('catalog')
  @ApiOperation({ summary: 'The metrics this layer emits, and the dimensions they may carry' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  catalog() {
    return { metrics: PRODUCT_METRIC_CATALOG, dashboards: PRODUCT_DASHBOARDS };
  }

  @Get('dashboards/:id')
  @ApiOperation({ summary: 'One dashboard, with the series behind each panel' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  dashboard(@Param('id') id: string) {
    const dashboard = findDashboard(id);
    if (!dashboard) return { dashboard: null, counters: [], histograms: [], dropped: 0 };

    const metrics = new Set(dashboard.panels.map((panel) => panel.metric));

    return {
      dashboard,
      counters: this.collector.counterSnapshots().filter((entry) => metrics.has(entry.name)),
      histograms: this.collector.histogramSnapshots().filter((entry) => metrics.has(entry.name)),
      /* Non-zero means the dashboard is incomplete. Somebody needs to know. */
      dropped: this.collector.dropped(),
    };
  }
}
