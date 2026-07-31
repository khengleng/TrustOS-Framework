import { ApiError } from '@trustos/errors';
import { satisfies } from '@trustos/version-manager';
import {
  assertCompatible,
  assertPermissionsAllowed,
  DANGEROUS_PERMISSIONS,
  parsePluginManifest,
  type PermissionPolicy,
  type PluginExtensionPoint,
  type PluginManifest,
  type PluginPermission,
} from './manifest';
import { assertTrusted, verifyArtifact, type ArtifactSignature, type TrustedKey } from './signing';

/**
 * The installed plugins, and what each is allowed to contribute.
 *
 * The registry is a gate, not a loader. It decides whether a plugin may be installed and what
 * extension points it may claim; it never imports plugin code. That separation is deliberate:
 * importing a module runs its top-level code, so a registry that loaded plugins in order to
 * inspect them would have already run every plugin it was about to reject.
 *
 * Loading is the host's job, after this has said yes.
 */

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** Which key vouched for it, or null when installed with --allow-unsigned. */
  signedBy: string | null;
  /** The dangerous permissions a human consented to. */
  grantedPermissions: PluginPermission[];
  installedAt: string;
  enabled: boolean;
}

export interface InstallPluginOptions {
  manifest: unknown;
  content: Buffer | string;
  signature?: ArtifactSignature | null;
  trustedKeys?: readonly TrustedKey[];
  frameworkVersion: string;
  policy?: PermissionPolicy;
  grantedPermissions?: readonly PluginPermission[];
  /**
   * Permits an unsigned plugin. Never permits a *bad* signature — see `assertTrusted`.
   *
   * Recorded on the installed record, so "why is this plugin unsigned" has an answer that is not
   * archaeology.
   */
  allowUnsigned?: boolean;
  now?: () => Date;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, InstalledPlugin>();

  constructor(private readonly options: { trustedKeys?: readonly TrustedKey[] } = {}) {}

  /**
   * Installs a plugin, in the order that fails cheapest first.
   *
   * Manifest, then compatibility, then permissions, then signature. The signature check is last
   * because it is the expensive one, and because a plugin that fails the manifest schema is not
   * worth verifying — but nothing is *installed* until all four pass.
   */
  install(options: InstallPluginOptions): InstalledPlugin {
    const manifest = parsePluginManifest(options.manifest);

    if (this.plugins.has(manifest.id)) {
      throw ApiError.conflict(
        `Plugin "${manifest.id}" is already installed. Remove it first, or update it.`,
      );
    }

    assertCompatible(manifest, options.frameworkVersion);
    assertPermissionsAllowed(manifest, options.policy, options.grantedPermissions ?? []);
    this.assertDependenciesPresent(manifest);

    const outcome = verifyArtifact({
      content: options.content,
      signature: options.signature,
      trustedKeys: options.trustedKeys ?? this.options.trustedKeys ?? [],
    });

    assertTrusted(outcome, { artifact: manifest.id, allowUnsigned: options.allowUnsigned });

    const record: InstalledPlugin = {
      manifest,
      signedBy: outcome.trusted ? outcome.keyId : null,
      grantedPermissions: [...(options.grantedPermissions ?? [])],
      installedAt: (options.now?.() ?? new Date()).toISOString(),
      enabled: true,
    };

    this.plugins.set(manifest.id, record);
    return record;
  }

  /**
   * Removes a plugin, refusing while another depends on it.
   *
   * Cascading would be friendlier and wrong: removing one plugin and silently taking three others
   * with it is a change nobody reviewed.
   */
  remove(id: string): void {
    const plugin = this.plugins.get(id);
    if (!plugin) throw ApiError.notFound(`No plugin "${id}" is installed.`);

    const dependants = [...this.plugins.values()].filter((candidate) =>
      candidate.manifest.dependencies.some((dependency) => dependency.pluginId === id),
    );

    if (dependants.length > 0) {
      throw ApiError.conflict(
        `Cannot remove "${id}": ${dependants.map((entry) => entry.manifest.id).join(', ')} ` +
          'depend on it. Remove them first.',
      );
    }

    this.plugins.delete(id);
  }

  /** Disables without removing. The right move when a plugin is suspected rather than proven bad. */
  setEnabled(id: string, enabled: boolean): InstalledPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) throw ApiError.notFound(`No plugin "${id}" is installed.`);

    plugin.enabled = enabled;
    return plugin;
  }

  list(): InstalledPlugin[] {
    return [...this.plugins.values()].sort((a, b) =>
      a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0,
    );
  }

  find(id: string): InstalledPlugin | null {
    return this.plugins.get(id) ?? null;
  }

  /**
   * The enabled plugins claiming an extension point.
   *
   * The host calls this to know what to load. A disabled plugin is absent from the answer rather
   * than filtered by the caller — one place decides, so a caller that forgets cannot load it.
   */
  contributorsTo(point: PluginExtensionPoint): InstalledPlugin[] {
    return this.list().filter(
      (plugin) => plugin.enabled && plugin.manifest.extensionPoints.includes(point),
    );
  }

  /** Plugins holding any of the four permissions that make a plugin arbitrary code. */
  privileged(): InstalledPlugin[] {
    return this.list().filter((plugin) =>
      plugin.manifest.permissions.some((permission) => DANGEROUS_PERMISSIONS.includes(permission)),
    );
  }

  /** Plugins installed without a signature. The list a security review asks for first. */
  unsigned(): InstalledPlugin[] {
    return this.list().filter((plugin) => plugin.signedBy === null);
  }

  private assertDependenciesPresent(manifest: PluginManifest): void {
    for (const dependency of manifest.dependencies) {
      const installed = this.plugins.get(dependency.pluginId);

      if (!installed) {
        throw ApiError.validation(
          [
            {
              path: 'dependencies',
              message: `Plugin "${manifest.id}" needs plugin "${dependency.pluginId}", which is not installed.`,
              code: 'plugin_dependency_missing',
            },
          ],
          'Missing plugin dependency.',
        );
      }

      if (!satisfies(installed.manifest.version, dependency.versionRange)) {
        throw ApiError.validation(
          [
            {
              path: 'dependencies',
              message:
                `Plugin "${manifest.id}" needs "${dependency.pluginId}" ` +
                `${dependency.versionRange}; ${installed.manifest.version} is installed.`,
              code: 'plugin_dependency_incompatible',
            },
          ],
          'Incompatible plugin dependency.',
        );
      }
    }
  }
}
