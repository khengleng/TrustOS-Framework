# @trustos/module-document

**Document** · v0.1.0 · experimental · owned by TrustOS Platform Engineering

Categorised documents with metadata, append-only version history, soft delete and per-organization ownership. Bytes are held by the file-storage module.

```bash
trustos add-module document --path ../my-app --framework-path .
```

Categorised documents with metadata, append-only version history, soft delete and
per-organization ownership. Content is held through the file-storage module's
`StorageProvider` port, which is why this module depends on it: containment — the
code that turns a caller-supplied name into a filesystem path — exists once in the
framework rather than twice.

```ts
const document = await documents.upload(
  {
    title: 'Merchant agreement',
    name: 'agreement.pdf',
    content: buffer,
    contentType: 'application/pdf',
    categoryKey: 'contracts',
  },
  organizationId,
);

await documents.addVersion(
  document.id,
  { content: revised, contentType: 'application/pdf' },
  organizationId,
);
const history = await documents.versions(document.id, organizationId); // v1 still readable
```

## The content-type list is an allow-list

Unlike file-storage, which holds whatever an application puts in it, a document is
something a person uploads and a person later opens. The default list contains only
formats that are inert when opened; HTML and SVG are not on it, because an HTML
document served back from a customer-facing endpoint is stored cross-site scripting.
An application can widen the list per organization, deliberately.

## Deleting

Soft delete, and the bytes stay. A document filed against a case may be subject to a
retention period the module knows nothing about, and deleting content would make the
version history a list of things that cannot be opened.

## Downloads are audited

`document.document.downloaded` is written on every read. "Who opened this contract"
is the question asked afterwards, and it is cheap to record next to the upload.

## Permissions

| Key                        | Description                                    | Suggested roles                                      |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `document.document.read`   | List and read document metadata.               | organization_owner, administrator, operator, auditor |
| `document.document.upload` | Upload a document or a new version of one.     | organization_owner, administrator                    |
| `document.document.update` | Change a document title, category or metadata. | organization_owner, administrator                    |
| `document.document.delete` | Retire a document.                             | organization_owner, administrator                    |
| `document.version.read`    | Read a document version history.               | organization_owner, administrator, operator, auditor |
| `document.category.read`   | List document categories.                      | organization_owner, administrator, operator, auditor |
| `document.category.manage` | Create or retire a document category.          | organization_owner, administrator                    |

Nothing grants these. Seed them onto roles in the application; a module that could
grant its own permissions would be a privilege-escalation path in a package.

## Routes

| Route                          | Permission                 |
| ------------------------------ | -------------------------- |
| `GET /documents`               | `document.document.read`   |
| `GET /documents/categories`    | `document.category.read`   |
| `POST /documents/categories`   | `document.category.manage` |
| `GET /documents/:id`           | `document.document.read`   |
| `POST /documents`              | `document.document.upload` |
| `POST /documents/:id/versions` | `document.document.upload` |
| `GET /documents/:id/content`   | `document.document.read`   |
| `GET /documents/:id/versions`  | `document.version.read`    |
| `PUT /documents/:id`           | `document.document.update` |
| `DELETE /documents/:id`        | `document.document.delete` |

## Configuration

Application-wide defaults go in `apps/api/src/modules/module-config.ts`. Every field
has a safe default, so the module works with none, and every field is validated when
the application starts. Per-organization overrides go through the SDK's tenant
settings and are validated by the same schema.

| Environment variable          | Purpose                                      |
| ----------------------------- | -------------------------------------------- |
| `DOCUMENT_MAX_UPLOAD_BYTES`   | Largest document accepted, in bytes.         |
| `DOCUMENT_ALLOWED_MIME_TYPES` | Comma-separated allow-list of content types. |

### Feature flags

- `document.versioning` (default on) — Keep previous versions when a document is replaced.

## Database

- `prisma/schema/22-document.prisma` — DocumentCategory, Document and DocumentVersion tables.

The module ships the fragment; `npm run db:migrate` in the application generates the
SQL against its real schema.

## Extension points

| Port              | Purpose                                                                                              | Ships                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `DocumentStore`   | Where documents, versions and categories live.                                                       | `PrismaDocumentStore`                             |
| `StorageProvider` | Supplied by the file-storage module. Swapping it changes where document bytes live and nothing else. | `LocalStorageProvider`, `InMemoryStorageProvider` |

## Depends on

`file-storage` ^0.1.0

## Out of scope

- Cloud storage backends — supplied through `StorageProvider`
- Streaming; content crosses the wire base64 encoded
- Text extraction, OCR and thumbnails
- Digital signatures and PDF manipulation
- Retention policy enforcement

Each of these is a product decision with operational consequences. The extension
point is the seam; the decision is yours.

## Tests

```bash
npx vitest run packages/modules/document
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
