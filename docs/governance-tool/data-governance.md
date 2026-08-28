# Data governance in the Governance Tool

What data an internal tool may hold, show, reveal and export — and where each decision lives.

> Phase 13 adds the platform-wide data governance layer: classification, catalog, lineage,
> retention, masking policy and access reviews. This document covers what phase 12 enforces
> _inside the Governance Tool_, which is narrower and lands earlier.

## Classification

Every internal application declares one:

| Classification      | Consequence in this layer                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `public`            | No masking, no export ceiling worth the name                                                                 |
| `internal`          | 100,000-row export ceiling, 72-hour expiry                                                                   |
| `confidential`      | 25,000 rows, approval above 5,000, 24-hour expiry                                                            |
| `restricted`        | 5,000 rows, approval above 500, 8-hour expiry                                                                |
| `highly_restricted` | 100 rows, **always** approved, 4-hour expiry, and a security review is required before it runs in production |

The classification drives the export policy automatically. There is no separate export
configuration to get out of step with it.

## Masking

Server-side, from a `MaskPolicy`, applied on the way out of the runtime.

| Field            | Strategy                 | Revealable    |
| ---------------- | ------------------------ | ------------- |
| phone, mobile    | last 3                   | yes           |
| email            | first character + domain | yes           |
| accountNumber    | last 4                   | yes           |
| cardNumber, iban | last 4                   | with approval |
| address          | redacted                 | with approval |
| fullName         | first character          | yes           |
| **governmentId** | full                     | **never**     |
| **dateOfBirth**  | full                     | **never**     |

Suffix rather than prefix for everything except email: a support agent reads a number _back_ to a
customer, and the first four digits of a card identify the issuer.

The two never-revealable fields are verified or matched rather than read. A field nobody needs to
read needs no reveal path at all.

### Pass-through, and why it is acceptable

`maskRow` masks every field with a rule and passes everything else through. An allow-list would be
safer and would mean a new column is invisible until somebody adds a rule — which is how a console
silently loses a field and somebody works around it by exporting instead.

What makes pass-through acceptable is `isForbiddenField`: credential-shaped columns are refused at
registration, so what passes through unmasked is business data, not a secret.

## Ownership

Every application: an owner, a business owner and a technical owner. Every resource: the same
three plus an approver. All required — an optional owner field is an empty owner field, and the
question is asked during an incident.

## Review

Both applications and resources carry a `nextReviewDate`.
`GET /governance/apps/reviews/overdue` lists what has passed, for both. That endpoint is what a
periodic governance review opens with.

## Where the data actually lives

Nowhere in this layer. The Governance Tool holds definitions; the gateway holds nothing at all —
it produces a plan and a deployment's executor runs it. There is no cache, no materialized view
and no local copy, because a copy is a second thing to classify, retain, mask and delete.
