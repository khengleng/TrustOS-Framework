-- External identity for a user account.
--
-- `externalId` is the identity provider's subject. Matched on rather than email
-- because an email can be reassigned inside a directory while `sub` is stable, and
-- matching on a reassignable value is how one person inherits another's access.
--
-- `passwordHash` becomes nullable so an account provisioned through a provider can
-- exist without a local password. Widening a NOT NULL column is not destructive: every
-- existing row keeps its value, and nothing is dropped or rewritten.
ALTER TABLE "User" ADD COLUMN "externalId" TEXT;
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

CREATE UNIQUE INDEX "User_externalId_key" ON "User"("externalId");
