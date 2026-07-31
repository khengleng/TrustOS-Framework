import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { isValidVersion, satisfies } from '@trustos/version-manager';

/**
 * Plugin manifests and the permissions a plugin may hold.
 *
 * A plugin is third-party code running inside a host application, and the manifest is the only
 * thing standing between "extends the CLI" and "reads the database". Three decisions shape it.
 *
 * **Permissions are declared, coarse and finite.** A plugin lists what it needs; the host grants
 * or refuses at install time, once, visibly. There is no runtime request — a prompt during
 * execution is a prompt somebody clicks through, and a permission granted mid-run cannot be
 * reviewed before the run.
 *
 * **The dangerous permissions are named as dangerous.** `filesystem:write`, `network`,
 * `process:spawn` and `database` are the four that turn a plugin into arbitrary code. They are
 * separated from the rest so an install prompt can say so, and so a policy can forbid them
 * outright without enumerating everything else.
 *
 * **Extension points are a closed list.** A plugin may extend the CLI, templates, agents,
 * modules, providers, UI components and documentation — and nothing else. An open extension
 * surface is one where the next release cannot change anything without breaking a plugin nobody
 * knew existed.
 *
 * What this file does *not* do is sandbox anything. Node has no usable in-process sandbox, and
 * pretending otherwise would be the most dangerous thing in the phase. The security model is:
 * signature, declared permissions, review, and a host that can refuse. That is stated in
 * `docs/plugin-development.md` rather than implied.
 */

export const PLUGIN_EXTENSION_POINTS = [
  'cli',
  'template',
  'agent',
  'module',
  'provider',
  'ui',
  'documentation',
] as const;

export type PluginExtensionPoint = (typeof PLUGIN_EXTENSION_POINTS)[number];

/**
 * Everything a plugin may ask for.
 *
 * Coarse on purpose. A permission system with sixty entries is one nobody reads, and a reviewer
 * who does not read the permissions is a reviewer who approves anything.
 */
export const PLUGIN_PERMISSIONS = [
  /** Read the host's configuration, excluding secrets. */
  'config:read',
  /** Read the module and template catalogs. */
  'registry:read',
  /** Read files under the project directory. */
  'filesystem:read',
  /** Write files under the project directory. Dangerous. */
  'filesystem:write',
  /** Any outbound network access. Dangerous. */
  'network',
  /** Spawn a process. Dangerous, and effectively equivalent to everything else. */
  'process:spawn',
  /** Query the application database. Dangerous. */
  'database',
  /** Register CLI commands. */
  'cli:register',
  /** Contribute templates. */
  'template:register',
  /** Emit telemetry through the host. */
  'telemetry:emit',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/**
 * The four that make a plugin arbitrary code.
 *
 * Grouped so an installer can say "this plugin can write to your disk and open network
 * connections" in one sentence, and so a policy can refuse the group.
 */
export const DANGEROUS_PERMISSIONS: readonly PluginPermission[] = [
  'filesystem:write',
  'network',
  'process:spawn',
  'database',
];

export const pluginManifestSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]{2,48}$/,
        'Lowercase letters, digits and hyphens; 3 to 49 characters.',
      ),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    version: z.string().refine(isValidVersion, 'Must be a semantic version.'),
    /** Who to contact. A plugin with no author is a plugin nobody can be asked about. */
    author: z.string().min(1).max(120),
    license: z.string().min(1).max(60),
    homepage: z.string().max(200).optional(),

    /** Framework range. `^0.4.0`, not `>=0.1.0` — see the note on `assertCompatible`. */
    frameworkRange: z.string().min(2).max(40),

    extensionPoints: z.array(z.enum(PLUGIN_EXTENSION_POINTS)).min(1),
    permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).default([]),

    /** Other plugins this one needs. */
    dependencies: z
      .array(
        z
          .object({
            pluginId: z.string().min(1).max(60),
            versionRange: z.string().min(1).max(40),
          })
          .strict(),
      )
      .default([]),

    /** The entry module, relative to the plugin root. */
    main: z.string().min(1).max(200).default('dist/index.js'),

    /**
     * What the plugin deliberately does not do.
     *
     * Same reason templates and modules carry one: a stated exclusion is reviewable, and a plugin
     * that later grows the thing it said it would not is a visible change rather than a drift.
     */
    outOfScope: z.array(z.string().min(1).max(160)).default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    /*
     * A plugin that only extends documentation has no business spawning a process. The check is
     * one-directional — it does not try to guess what each extension point *should* need, only to
     * catch the combination that is always wrong.
     */
    const onlyDocs =
      manifest.extensionPoints.length === 1 && manifest.extensionPoints[0] === 'documentation';

    if (onlyDocs) {
      const dangerous = manifest.permissions.filter((permission) =>
        DANGEROUS_PERMISSIONS.includes(permission),
      );

      if (dangerous.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permissions'],
          message:
            `A documentation-only plugin is asking for ${dangerous.join(', ')}. Either it does ` +
            'more than it says, or it needs less than it asks.',
        });
      }
    }

    if (
      manifest.extensionPoints.includes('cli') &&
      !manifest.permissions.includes('cli:register')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions'],
        message: 'A plugin extending the CLI must declare cli:register.',
      });
    }

    if (
      manifest.extensionPoints.includes('template') &&
      !manifest.permissions.includes('template:register')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions'],
        message: 'A plugin contributing templates must declare template:register.',
      });
    }
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export function parsePluginManifest(raw: unknown): PluginManifest {
  return pluginManifestSchema.parse(raw);
}

/** The dangerous permissions a manifest asks for. Empty is the common case. */
export function dangerousPermissionsOf(manifest: PluginManifest): PluginPermission[] {
  return manifest.permissions.filter((permission) => DANGEROUS_PERMISSIONS.includes(permission));
}

/**
 * A sentence an installer can show before asking for consent.
 *
 * Written in terms of what the plugin can *do to you*, not in terms of permission names. "Can
 * read and write files in this project" is a decision somebody can make; "requests
 * filesystem:write" is a string they scroll past.
 */
export function describePermissions(manifest: PluginManifest): string[] {
  const descriptions: Record<PluginPermission, string> = {
    'config:read': 'Read this project’s configuration (not its secrets).',
    'registry:read': 'Read the module and template catalogs.',
    'filesystem:read': 'Read files in this project.',
    'filesystem:write': 'Create and modify files in this project.',
    network: 'Open network connections to anywhere.',
    'process:spawn': 'Run other programs on this machine.',
    database: 'Query this application’s database.',
    'cli:register': 'Add commands to the trustos CLI.',
    'template:register': 'Add templates to the catalog.',
    'telemetry:emit': 'Record usage events through the host.',
  };

  return manifest.permissions.map((permission) => descriptions[permission]);
}

export interface PermissionPolicy {
  /** Permissions a deployment refuses outright, whatever the plugin says. */
  denied?: readonly PluginPermission[];
  /** Permissions that need a human to confirm. Defaults to the dangerous four. */
  requiresConsent?: readonly PluginPermission[];
}

/**
 * Refuses a plugin whose declared permissions the deployment does not allow.
 *
 * Denied wins over consent: a permission a policy forbids cannot be granted by consenting to it,
 * because the person clicking is not the person who wrote the policy.
 */
export function assertPermissionsAllowed(
  manifest: PluginManifest,
  policy: PermissionPolicy = {},
  granted: readonly PluginPermission[] = [],
): void {
  const denied = manifest.permissions.filter((permission) =>
    (policy.denied ?? []).includes(permission),
  );

  if (denied.length > 0) {
    throw ApiError.forbidden(
      `Plugin "${manifest.id}" requests ${denied.join(', ')}, which this deployment forbids.`,
    );
  }

  const needsConsent = policy.requiresConsent ?? DANGEROUS_PERMISSIONS;
  const ungranted = manifest.permissions.filter(
    (permission) => needsConsent.includes(permission) && !granted.includes(permission),
  );

  if (ungranted.length > 0) {
    throw ApiError.forbidden(
      `Plugin "${manifest.id}" requests ${ungranted.join(', ')}, which needs explicit consent. ` +
        `It would be able to: ${describePermissions({ ...manifest, permissions: ungranted }).join(' ')}`,
    );
  }
}

/**
 * Refuses a plugin that does not declare compatibility with this framework.
 *
 * A plugin declaring `>=0.1.0` is declaring nothing — it claims compatibility with versions that
 * do not exist yet, which is a claim its author cannot have tested. Caret and tilde ranges say
 * "up to the next breaking boundary", which is a claim that can be true.
 */
export function assertCompatible(manifest: PluginManifest, frameworkVersion: string): void {
  if (manifest.frameworkRange.startsWith('>=')) {
    throw ApiError.validation(
      [
        {
          path: 'frameworkRange',
          message:
            `Plugin "${manifest.id}" declares "${manifest.frameworkRange}", which claims ` +
            'compatibility with framework versions that do not exist yet. Use a caret or tilde ' +
            'range, which bounds the claim at the next breaking boundary.',
          code: 'unbounded_framework_range',
        },
      ],
      'Unbounded framework range.',
    );
  }

  if (satisfies(frameworkVersion, manifest.frameworkRange)) return;

  throw ApiError.validation(
    [
      {
        path: 'frameworkRange',
        message: `Plugin "${manifest.id}" needs framework ${manifest.frameworkRange}; this is ${frameworkVersion}.`,
        code: 'framework_incompatible',
      },
    ],
    'Incompatible plugin.',
  );
}
