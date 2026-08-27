import { productError } from '@trustos/financial-product-core';
import {
  connectorDefinitionSchema,
  type ConnectorDefinition,
} from './schema';
import {
  FRAMEWORK_FORBIDDEN_PROVIDER_NAMES,
  PROVIDER_INTERFACE_NAMES,
  type ProviderInterfaceName,
} from './interfaces';

/**
 * The connector registry.
 *
 * Tenant-scoped, because connectors are a deployment's own: two organizations on one platform
 * integrate with different counterparties, and a registry that returned every organization's
 * connectors would let one tenant's product bind to another's integration. `organizationId` is
 * `string | null` rather than optional so a caller cannot omit it, and null is the platform
 * tenant rather than a wildcard — the same convention every store in this framework uses.
 *
 * **The framework's own registry is empty and stays empty.** `FRAMEWORK_CONNECTORS` is a frozen
 * empty list, and `assertNoFrameworkProvider` is what keeps it that way under pressure: a
 * connector named after a bank in this repository is a bank every deployment carries.
 */
export interface ConnectorRecord {
  organizationId: string | null;
  connector: ConnectorDefinition;
}

export class ConnectorRegistry {
  private readonly records = new Map<string, ConnectorRecord>();

  constructor(records: readonly ConnectorRecord[] = []) {
    for (const record of records) this.register(record.organizationId, record.connector);
  }

  register(organizationId: string | null, input: unknown): ConnectorDefinition {
    const connector = connectorDefinitionSchema.parse(input);
    const key = keyOf(organizationId, connector.connectorId, connector.version);

    if (this.records.has(key)) {
      throw productError(
        'product_definition_invalid',
        `Connector ${connector.connectorId}@${connector.version} is already registered for this ` +
          'tenant. A second registration means load order decides which timeout applies.',
        { connectorId: connector.connectorId },
      );
    }

    this.records.set(key, { organizationId, connector });
    return connector;
  }

  find(
    organizationId: string | null,
    connectorId: string,
    version?: string,
  ): ConnectorDefinition | undefined {
    if (version) return this.records.get(keyOf(organizationId, connectorId, version))?.connector;

    const candidates = [...this.records.values()]
      .filter(
        (record) =>
          record.organizationId === organizationId && record.connector.connectorId === connectorId,
      )
      .map((record) => record.connector);

    return candidates[candidates.length - 1];
  }

  /**
   * The connector, or a refusal.
   *
   * A connector belonging to another tenant is reported as *not approved* rather than as
   * forbidden, for the reason every tenant boundary in this framework gives: a distinguishable
   * refusal confirms the connector exists, and the confirmation is the enumeration primitive.
   */
  require(
    organizationId: string | null,
    connectorId: string,
    version?: string,
  ): ConnectorDefinition {
    const connector = this.find(organizationId, connectorId, version);
    if (!connector) {
      throw productError(
        'product_connector_not_approved',
        `No approved connector "${connectorId}" for this tenant. Register and approve it before ` +
          'a product binds to it.',
        { connectorId },
      );
    }
    return connector;
  }

  /**
   * The connector, refusing one that may not be bound into a product.
   *
   * A draft or withdrawn connector is refused; a deprecated one is permitted with the same
   * reasoning the block registry gives — refusing it would break every published product that
   * binds to it on the day somebody deprecates it.
   */
  requireBindable(
    organizationId: string | null,
    connectorId: string,
    providerInterface: string,
    version?: string,
  ): ConnectorDefinition {
    const connector = this.require(organizationId, connectorId, version);

    if (connector.lifecycleStatus === 'draft' || connector.lifecycleStatus === 'withdrawn') {
      throw productError(
        'product_connector_not_approved',
        `Connector "${connectorId}" is ${connector.lifecycleStatus} and may not be bound into a ` +
          'product.',
        { connectorId, expected: 'approved', actual: connector.lifecycleStatus },
      );
    }

    if (connector.providerInterface !== providerInterface) {
      throw productError(
        'product_provider_unbound',
        `Connector "${connectorId}" implements ${connector.providerInterface}, and the block ` +
          `needs ${providerInterface}. Binding it anyway would call an operation the block does ` +
          'not have a contract for.',
        { connectorId, expected: providerInterface, actual: connector.providerInterface },
      );
    }

    return connector;
  }

  /** Every connector implementing an interface, for this tenant. */
  byInterface(
    organizationId: string | null,
    providerInterface: ProviderInterfaceName,
  ): ConnectorDefinition[] {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.organizationId === organizationId &&
          record.connector.providerInterface === providerInterface,
      )
      .map((record) => record.connector)
      .sort((left, right) => left.connectorId.localeCompare(right.connectorId));
  }

  all(organizationId: string | null): ConnectorDefinition[] {
    return [...this.records.values()]
      .filter((record) => record.organizationId === organizationId)
      .map((record) => record.connector)
      .sort((left, right) => left.connectorId.localeCompare(right.connectorId));
  }

  /** Interfaces this tenant has at least one approved connector for. */
  coveredInterfaces(organizationId: string | null): ProviderInterfaceName[] {
    return PROVIDER_INTERFACE_NAMES.filter((name) =>
      this.byInterface(organizationId, name).some(
        (connector) => connector.lifecycleStatus === 'approved',
      ),
    );
  }

  size(): number {
    return this.records.size;
  }
}

function keyOf(organizationId: string | null, connectorId: string, version: string): string {
  return `${organizationId ?? 'platform'}|${connectorId}|${version}`;
}

/**
 * The framework's own connectors.
 *
 * Empty, permanently. The seam is the deliverable; an adapter shipped here is an adapter every
 * deployment carries whether or not it integrates with that counterparty.
 */
export const FRAMEWORK_CONNECTORS: readonly ConnectorDefinition[] = Object.freeze([]);

/**
 * Refuses a connector that names one of the vendors this framework stays away from.
 *
 * Called by the architecture check over this repository, not by a deployment's registry — a
 * deployment's connectors *should* name their providers, because that is what a connector is
 * for. This guards the framework's catalog against the reasonable-sounding first exception.
 */
export function assertNoFrameworkProvider(connector: ConnectorDefinition): void {
  const document = `${connector.connectorId} ${connector.name} ${connector.description}`.toLowerCase();

  for (const vendor of FRAMEWORK_FORBIDDEN_PROVIDER_NAMES) {
    if (new RegExp(`\\b${vendor}\\b`).test(document)) {
      throw productError(
        'product_connector_not_approved',
        `Connector "${connector.connectorId}" names "${vendor}". The framework ships no provider ` +
          'integrations: register this connector in the deployment that needs it.',
        { connectorId: connector.connectorId, actual: vendor },
      );
    }
  }
}
