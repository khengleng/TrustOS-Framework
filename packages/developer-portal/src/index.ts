/**
 * @trustsystem/developer-portal
 *
 * A self-contained developer site: guides, generated reference, modules, templates, an API
 * explorer, SDK downloads and release notes.
 *
 * It is a static site generated from the repository — no server, no database, no build step beyond
 * writing files. That works offline and air-gapped, which is where the developers with the
 * strictest requirements are; it cannot drift, because every reference page comes from the same
 * source as the thing it documents; and it has no attack surface, because a portal with a search
 * backend and a session is a service to operate, patch and audit — for documentation.
 *
 * The API explorer generates the request rather than sending it. That is most of the value with
 * none of the "why does the docs site have my production token".
 */
export * from './portal';
