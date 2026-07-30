# @trustos/module-file-storage

**File Storage** · v0.1.0 · stable · owned by TrustOS Platform Engineering

Provider-abstracted object storage with checksums, versioning and per-organization key namespaces. Ships a local filesystem provider.

```bash
trustos add-module file-storage --path ../my-app --framework-path .
```

Object storage behind a provider port. The module owns the organization key
namespace, version history, checksums and the audit trail; a provider owns only the
bytes. That split is what lets a provider be swapped without re-proving tenant
isolation.

```ts
const stored = await files.store(
  { name: 'contract.pdf', content: buffer, contentType: 'application/pdf' },
  organizationId,
);
// storageKey === 'org/<organizationId>/contract.pdf/v1'

const { blob } = await files.read(stored.id, organizationId); // checksum verified twice
```

## Providers

`LocalStorageProvider` writes to disk, contained under a configured root, with a
`.meta` sidecar per object holding the content type and checksum. A sidecar rather
than an extended attribute, because extended attributes do not survive a copy, a
container build, or most backup tools — and a checksum that vanishes during a
restore is worse than no checksum.

`InMemoryStorageProvider` is for tests and local development.

To move to object storage, implement `StorageProvider` and pass it to
`createFileStorage`. Nothing else changes.

## Keys

A caller supplies a _name_; the module builds the key. Names are validated against a
narrow grammar (letters, digits, dot, underscore, hyphen, single slashes, no leading
dot) and the resolved path is re-checked against the storage root. Both controls
apply, because neither is sufficient alone — see `src/keys.ts`.

Two organizations may both store `contract.pdf`; the namespace keeps them apart.

## Permissions

| Key                        | Description                                      | Suggested roles                                      |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| `file-storage.file.list`   | List stored objects in the current organization. | organization_owner, administrator, operator, auditor |
| `file-storage.file.read`   | Read an object and its metadata.                 | organization_owner, administrator, operator, auditor |
| `file-storage.file.write`  | Store a new object or a new version of one.      | organization_owner, administrator                    |
| `file-storage.file.delete` | Retire an object.                                | organization_owner, administrator                    |

Nothing grants these. Seed them onto roles in the application; a module that could
grant its own permissions would be a privilege-escalation path in a package.

## Routes

| Route                     | Permission                 |
| ------------------------- | -------------------------- |
| `GET /files`              | `file-storage.file.list`   |
| `POST /files`             | `file-storage.file.write`  |
| `GET /files/:id`          | `file-storage.file.read`   |
| `GET /files/:id/content`  | `file-storage.file.read`   |
| `GET /files/:id/versions` | `file-storage.file.read`   |
| `DELETE /files/:id`       | `file-storage.file.delete` |

## Configuration

Application-wide defaults go in `apps/api/src/modules/module-config.ts`. Every field
has a safe default, so the module works with none, and every field is validated when
the application starts. Per-organization overrides go through the SDK's tenant
settings and are validated by the same schema.

| Environment variable     | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `FILE_STORAGE_ROOT`      | Directory the local provider writes into. Relative paths resolve from cwd. |
| `FILE_STORAGE_MAX_BYTES` | Largest object accepted, in bytes.                                         |

### Feature flags

- `file-storage.versioning` (default on) — Keep previous versions when an object is overwritten.

## Database

- `prisma/schema/20-file-storage.prisma` — StoredObject and StoredObjectVersion tables.

The module ships the fragment; `npm run db:migrate` in the application generates the
SQL against its real schema.

## Extension points

| Port                | Purpose                                                                                              | Ships                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `StorageProvider`   | Where bytes live. Implement this to move from local disk to object storage without touching callers. | `LocalStorageProvider`, `InMemoryStorageProvider` |
| `StoredObjectStore` | Where object rows live. The Prisma implementation is tenant-scoped.                                  | `PrismaStoredObjectStore`                         |

## Depends on

None.

## Out of scope

- Cloud object storage (S3, GCS, Azure Blob) — implement `StorageProvider`
- Signed URLs and direct-to-provider uploads
- Streaming; content crosses the wire base64 encoded
- Server-side encryption key management
- Virus scanning

Each of these is a product decision with operational consequences. The extension
point is the seam; the decision is yours.

## Tests

```bash
npx vitest run packages/modules/file-storage
```

Unit, tenant isolation, RBAC where this module makes its own authorization decisions,
configuration validation and lifecycle. Isolation tests drive the Prisma store over
`FakeModelDelegate`, so they exercise `@trustos/tenancy` rather than a test double.

## Changes

### 0.1.0

Initial release.

## See also

- `AGENTS.md` — the invariants in this module that must not be weakened
- `docs/modules.md` — the module system
- `docs/module-development.md` — writing one
- `docs/module-versioning.md` — what counts as a breaking change
