-- Provenance on the audit trail.
--
-- The Governance Tool's whole value is that a record saying "usr_7 froze wallet wlt_3" becomes
-- "…from the customer support console, in production, because of case cas_9, correlated to
-- req_abc". Without somewhere to put that, an enrichment layer either drops it or smuggles it
-- into `after` — and `after` means "state after the change", which provenance is not.
--
-- Nullable, so every existing row stays valid and no backfill is needed. A backfill would be a
-- guess, and a guessed audit record is worse than an absent field.
ALTER TABLE "AuditLog" ADD COLUMN "metadata" JSONB;
