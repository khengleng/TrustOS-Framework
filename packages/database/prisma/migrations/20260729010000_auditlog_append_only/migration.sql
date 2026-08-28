-- Enforce append-only semantics on "AuditLog" at the database level.
--
-- Why a trigger rather than a GRANT.
--
-- The obvious control is:
--
--   REVOKE UPDATE, DELETE ON "AuditLog" FROM trustos_app;
--
-- That works only when the application connects as a role which does *not* own
-- the table. PostgreSQL grants the owner implicit rights on its own objects, so
-- when the application connects as the owner — which is the default on Railway
-- and on most single-role deployments — the REVOKE succeeds and then changes
-- nothing. This was verified against a live deployment: after the REVOKE, an
-- UPDATE still reported "UPDATE 1".
--
-- A BEFORE trigger applies to the owner too, so it holds under the deployment
-- topology we actually have.
--
-- What this does NOT protect against: a superuser can drop the trigger. It is a
-- control against application bugs, a compromised application role, and
-- well-meaning manual edits — not against a fully compromised database
-- administrator. Defending against that requires shipping records off-host to
-- append-only storage, which is a later phase.
--
-- Defence in depth: if you do run the application as a non-owner role, apply
-- the REVOKE as well. The two controls are complementary.

CREATE OR REPLACE FUNCTION trustos_auditlog_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auditlog_append_only ON "AuditLog";

CREATE TRIGGER auditlog_append_only
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION trustos_auditlog_append_only();
